import { swallow, swallowAs } from "../util/errors.ts";
import bolt from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { createDeduper, createThreadTracker } from "./lib.ts";
import { registerSlackBotIdentity } from "./message-gating.ts";
import { installDevIntrospection } from "./dev-introspection.ts";
import { setDefaultBotIdentity, createSurfaceHeaderEnsurer, type SurfaceHeaderClient } from "./delivery.ts";
import { NO_RETRY, type SlackPluginConfig, normalizeSlackApiUrl, slackPluginConfigFromEnv } from "./config.ts";
import { createCoreBridge } from "./core-bridge.ts";
import { createAckEmojiPicker } from "./ack-emoji.ts";
import { type BotIdentity, createDirectory } from "./directory.ts";
import { createMirror } from "./mirror.ts";
import { createConversationSerializer } from "./conversation-view.ts";
import { createApprovals } from "./approvals.ts";
import { createTurnHandler } from "./turn-handler.ts";
import { registerSlackEvents } from "./events.ts";
import { createSurfaceContextFulfiller } from "./surface-context.ts";
import { createDeliveryPoller } from "./deliveries.ts";
import { createDeferredAckReceiver } from "./deferred-ack.ts";
import { createHttpEventsReceiver } from "./http-events.ts";
import type { SlackCoreClient, SurfaceContextRequest } from "../api/slack-core-client.ts";
const { App, LogLevel } = bolt;

export type { SlackCoreClient };
export type { SlackPluginConfig };
export { normalizeSlackApiUrl, slackPluginConfigFromEnv };

export async function startSlackPlugin(
  cfg: SlackPluginConfig,
  core: SlackCoreClient,
): Promise<{ stop(): Promise<void> }> {
  const EVENTS_MODE = cfg.eventsMode ?? "socket";
  if (!cfg.botToken) {
    throw new Error("Slack plugin needs botToken (SLACK_BOT_TOKEN, xoxb-…)");
  }
  if (EVENTS_MODE === "socket" && !cfg.appToken) {
    throw new Error("Slack plugin needs appToken (SLACK_APP_TOKEN, xapp-…) in socket events mode");
  }
  if (EVENTS_MODE === "http" && (!cfg.signingSecret || !cfg.eventsPort)) {
    throw new Error(
      "Slack plugin needs signingSecret (SLACK_SIGNING_SECRET) and eventsPort (SLACK_EVENTS_PORT) in http events mode",
    );
  }
  const BOT_TOKEN = cfg.botToken;
  const APP_TOKEN = cfg.appToken;
  const SLACK_API_URL = cfg.apiUrl ? normalizeSlackApiUrl(cfg.apiUrl) : undefined;
  const TRUSTED_FILE_HOST = SLACK_API_URL ? new URL(SLACK_API_URL).hostname : undefined;
  const CLIENT_OPTIONS = { ...NO_RETRY, ...(SLACK_API_URL ? { slackApiUrl: SLACK_API_URL } : {}) } as const;
  const IDENTITY_TOKENS: Record<string, string | undefined> = {
    copilot: cfg.copilotBotToken,
  };
  const identityClients = new Map<string, WebClient>();
  function clientForIdentity(identity: string): WebClient {
    const token = IDENTITY_TOKENS[identity];
    if (!token) throw new Error(`no token for post identity "${identity}" (set its *_BOT_TOKEN env)`);
    let c = identityClients.get(identity);
    if (!c) {
      c = new WebClient(token, { ...CLIENT_OPTIONS });
      identityClients.set(identity, c);
    }
    return c;
  }
  let stopped = false;

  const ids: BotIdentity = {
    ownTeamId: "",
    botUserId: "",
    ownBotId: "",
    botHandle: "",
    ownWorkspaceUrl: "",
    identityMode: cfg.identityEmail === "0" ? "slack-id" : "email",
  };

  const EXTERNAL_PARTICIPANTS_CACHE_MS = 30_000;
  let externalParticipantsCache: { on: boolean; fetchedAt: number } | undefined;
  async function externalParticipantsEnabled(): Promise<boolean> {
    if (
      externalParticipantsCache &&
      Date.now() - externalParticipantsCache.fetchedAt < EXTERNAL_PARTICIPANTS_CACHE_MS
    ) {
      return externalParticipantsCache.on;
    }
    try {
      const on = await core.externalSlackParticipants();
      externalParticipantsCache = { on, fetchedAt: Date.now() };
      return on;
    } catch (err) {
      swallow("slack: surface-config read", err);
      return externalParticipantsCache?.on ?? false;
    }
  }

  const app = new App({
    token: BOT_TOKEN,
    receiver:
      EVENTS_MODE === "http"
        ? createHttpEventsReceiver({ signingSecret: cfg.signingSecret!, port: cfg.eventsPort! })
        : createDeferredAckReceiver({
            appToken: APP_TOKEN!,
            ...(cfg.logLevel ? { logLevel: cfg.logLevel } : {}),
            ...(SLACK_API_URL ? { slackApiUrl: SLACK_API_URL } : {}),
          }),
    logLevel: (cfg.logLevel as any) ?? LogLevel.INFO,
    clientOptions: { ...CLIENT_OPTIONS },
  });
  // Process-global: only the primary instance owns the outbound username/icon override, so a
  // second bot starting up cannot clear or replace the first one's identity.
  if (!cfg.secondary) setDefaultBotIdentity(cfg.botIdentity);
  const devIntrospection = installDevIntrospection(
    app,
    cfg.devIntrospection && !cfg.secondary ? { enabled: true, port: cfg.devIntrospection.port } : {},
  );

  const deduper = createDeduper(1000);
  const threads = createThreadTracker();

  const bridge = createCoreBridge(core);
  const ackEmoji = createAckEmojiPicker(core);
  const directory = createDirectory({
    core,
    ids,
    ...(cfg.userSnapshotTtlMs ? { userSnapshotTtlMs: cfg.userSnapshotTtlMs } : {}),
    ...(cfg.channelMembersTtlMs ? { channelMembersTtlMs: cfg.channelMembersTtlMs } : {}),
    ...(cfg.maxPrivateChannels ? { maxPrivateChannels: cfg.maxPrivateChannels } : {}),
    ...(cfg.userCacheTtlMs ? { userCacheTtlMs: cfg.userCacheTtlMs } : {}),
    // `pushDirectory` REPLACES the org's channel list; a secondary bot sees only the channels
    // it was invited to, so letting it push would truncate the primary's directory.
    ...(cfg.secondary ? { syncDirectory: false } : {}),
  });
  const mirror = createMirror({ core, ids, directory, externalParticipantsEnabled });
  const serializer = createConversationSerializer({
    ids,
    directory,
    externalParticipantsEnabled,
    ...(cfg.recentMessages ? { recentMessages: cfg.recentMessages } : {}),
  });
  const approvals = createApprovals({ core, bridge, directory, threads });
  const ensureHeader = createSurfaceHeaderEnsurer({
    headerFacts: (scope) => core.surfaceHeaderFacts(scope as Parameters<typeof core.surfaceHeaderFacts>[0]),
    webUiPublicUrl: cfg.webUiPublicUrl,
    ids,
  });
  core.onScopeModelChanged((scope) => {
    const channel = scope.startsWith("channel:") ? scope.slice("channel:".length) : "";
    if (channel) ensureHeader(app.client as unknown as SurfaceHeaderClient, channel, scope, "channel");
  });
  const handler = createTurnHandler({
    bridge,
    directory,
    mirror,
    serializer,
    approvals,
    ackEmoji,
    ids,
    threads,
    deduper,
    externalParticipantsEnabled,
    ...(devIntrospection ? { markEvent: () => devIntrospection.markEvent() } : {}),
    botToken: BOT_TOKEN,
    ...(TRUSTED_FILE_HOST ? { trustedFileHost: TRUSTED_FILE_HOST } : {}),
    ensureHeader,
    ...(cfg.personaId ? { personaId: cfg.personaId } : {}),
  });
  approvals.registerActions(app);
  registerSlackEvents(app, {
    handler,
    mirror,
    directory,
    ids,
    deduper,
    ...(cfg.webUiPublicUrl ? { webUiPublicUrl: cfg.webUiPublicUrl } : {}),
    ensureHeader,
  });
  const surfaceContext = createSurfaceContextFulfiller({
    core,
    bridge,
    directory,
    serializer,
    botToken: BOT_TOKEN,
    ...(TRUSTED_FILE_HOST ? { trustedFileHost: TRUSTED_FILE_HOST } : {}),
    ...(cfg.userToken ? { userToken: cfg.userToken } : {}),
    clientOptions: CLIENT_OPTIONS,
  });
  // `claimDeliveries("slack")` and `pendingContextRequests("slack")` are ORG-WIDE queues with no
  // per-bot ownership. Running them on more than one instance would hand a reply to whichever
  // bot claimed it first, so it would arrive under an arbitrary identity. Only the primary
  // instance services them; a secondary bot's recovery-path delivery is therefore posted by the
  // default bot (documented in docs/slack-multi-bot.md).
  const servicesQueues = !cfg.secondary;
  const deliveries = servicesQueues
    ? createDeliveryPoller({ core, bridge, mirror, threads, clientForIdentity })
    : undefined;

  let auth: any;
  try {
    auth = (await app.client.auth.test()) as any;
    ids.ownTeamId = auth.team_id ?? "";
    ids.botUserId = auth.user_id ?? "";
    ids.ownBotId = auth.bot_id ?? "";
    ids.botHandle = typeof auth.user === "string" ? auth.user : "";
    ids.ownWorkspaceUrl = typeof auth.url === "string" ? auth.url.replace(/\/+$/, "") : "";
    if (!ids.ownTeamId || !ids.botUserId) {
      throw new Error("auth.test returned no team_id/user_id — refusing to start (cannot classify members safely)");
    }
    if (!cfg.identityEmail) {
      ids.identityMode = await directory.resolveAutoIdentityMode(app.client);
      if (ids.identityMode === "slack-id") {
        console.warn(
          "[slack] no member emails visible (users:read.email scope missing?) — keying principals on Slack ids; add the scope or set SLACK_IDENTITY_EMAIL=1 to force email keying",
        );
      }
    }
    await app.start();
  } catch (err) {
    stopped = true;
    await devIntrospection?.close().catch(swallowAs("slack: dev-introspection close on failed start", undefined));
    await app.stop().catch(swallowAs("slack: app.stop on failed start", undefined));
    throw err;
  }
  // Sibling qm bots must not answer each other: both hold stake in a shared thread, so an
  // unguarded exchange would ping-pong forever. Third-party bots are unaffected.
  const unregisterIdentity = registerSlackBotIdentity({ botUserId: ids.botUserId, ownBotId: ids.ownBotId });
  devIntrospection?.ready({ connectedAs: auth.user ?? "", botUserId: ids.botUserId, teamId: ids.ownTeamId });
  const instanceNote = cfg.instanceLabel ? ` [${cfg.instanceLabel}]` : "";
  const personaNote = cfg.personaId ? `; speaking as persona ${cfg.personaId}` : "";
  console.log(
    `[slack-plugin]${instanceNote} connected as @${auth.user} (bot ${ids.botUserId}) in team ${auth.team} (${ids.ownTeamId}); in-process core${personaNote}`,
  );
  void directory.getUserSnapshot(app.client).catch(swallowAs("slack: initial user snapshot", undefined));
  ackEmoji.refreshAckEmoji(app.client);

  let deliveriesPollInFlight = false;
  let deliveriesPollAgain = false;
  const drainDeliveries = (): void => {
    if (stopped || !deliveries) return;
    if (deliveriesPollInFlight) {
      deliveriesPollAgain = true;
      return;
    }
    deliveriesPollInFlight = true;
    // `.finally()` re-throws, so without the catch a Slack-side failure here is an unhandled
    // rejection rather than a logged one. Same shape as the context-request drain below.
    void deliveries
      .pollDeliveries(app.client)
      .catch(swallowAs("slack: deliveries poll", undefined))
      .finally(() => {
      deliveriesPollInFlight = false;
      if (deliveriesPollAgain) {
        deliveriesPollAgain = false;
        drainDeliveries();
      }
    });
  };
  const unsubscribeDeliveries = deliveries ? core.onDeliveryEnqueued(drainDeliveries) : undefined;
  const deliveriesTimer = deliveries ? setInterval(drainDeliveries, 60_000) : undefined;
  drainDeliveries();

  const contextRequestsInFlight = new Set<string>();

  const serviceContextRequest = (r: SurfaceContextRequest): void => {
    if (stopped || !r?.id || contextRequestsInFlight.has(r.id)) return;
    contextRequestsInFlight.add(r.id);
    void surfaceContext
      .fulfillSurfaceContext(app.client, r)
      .catch(swallowAs("slack: surface context fulfil", undefined))
      .finally(() => contextRequestsInFlight.delete(r.id));
  };
  const unsubscribeContextRequests = servicesQueues ? core.onContextRequest(serviceContextRequest) : undefined;
  if (servicesQueues) {
    void core
      .pendingContextRequests()
      .then((pending) => pending.forEach(serviceContextRequest))
      .catch(swallowAs("slack: context request drain", undefined));
  }

  return {
    async stop(): Promise<void> {
      if (stopped) {
        await app.stop();
        return;
      }
      stopped = true;
      unregisterIdentity();
      if (deliveriesTimer) clearInterval(deliveriesTimer);
      unsubscribeDeliveries?.();
      unsubscribeContextRequests?.();
      try {
        await app.stop();
      } finally {
        await devIntrospection?.close();
      }
    },
  };
}

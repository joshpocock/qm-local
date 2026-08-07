import {
  agentRoomsEnabled,
  baseModelProviders,
  configuredModelForHarness,
  loadConfig,
  providerKeysPresent,
} from "./config.ts";
import { buildApp, stopWithBackstop } from "./wiring.ts";
import { createServer } from "./api/server.ts";
import { errMessage } from "./util/errors.ts";
import { defaultModelForHarness, modelProviderAvailabilityFor } from "./model/pi-models.ts";
import { effectiveEgressEnforcement } from "./sandbox/sandbox.ts";
import { slackPluginConfigFromEnv, startSlackPlugin, type SlackPluginConfig } from "./slack/index.ts";
import { createSlackMultiRuntimeReconciler, type DesiredSlackInstance } from "./surfaces/slack-runtime.ts";

const config = loadConfig();

const built = buildApp(config);
const envSlackConfig = slackPluginConfigFromEnv(process.env);
const slackConfig = envSlackConfig;
const envSlackAttempted = Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN);
let slackEnvironmentState: "absent" | "configured" | "partial" = "absent";
if (slackConfig) slackEnvironmentState = "configured";
else if (envSlackAttempted) slackEnvironmentState = "partial";
const server = createServer(built.app, {
  production: config.production,
  allowUnauthenticatedCore: config.allowUnauthenticatedCore,
  ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
  ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
  ...(config.portalIdentitySecret ? { portalIdentitySecret: config.portalIdentitySecret } : {}),
  ...(config.requireSignedPortalIdentity ? { requireSignedPortalIdentity: true } : {}),
  ...(built.replayDedupe ? { replayDedupe: built.replayDedupe } : {}),
  config: built.config,
  baseModelDefault: defaultModelForHarness(
    config.harness,
    configuredModelForHarness(config, config.harness),
    baseModelProviders(config),
  ),
  modelProviders: modelProviderAvailabilityFor(config.harness, providerKeysPresent(config)),
  providerKeys: providerKeysPresent(config),
  modelCredentials: built.modelCredentials,
  ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
  harnessId: config.harness,
  connectorTokens: built.connectorTokens,
  slackInstallation: built.slackInstallation,
  slackBots: built.slackBots,
  slackEnvironmentState,
  slackEventsMode: process.env.SLACK_EVENTS_MODE?.trim() === "http" ? "http" : "socket",
  resolveClient: built.resolveClient,
  consentLinks: built.consentLinks,
  secretDrops: built.secretDrops,
  ...(built.fireDropResolution ? { fireDropResolution: built.fireDropResolution } : {}),
  ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
  ...(config.publicWebUrl ? { portalUrl: config.publicWebUrl } : {}),
  admin: built.admin,
  rateLimiter: built.rateLimiter,
  acl: built.acl,
  credentialUsage: built.credentialUsage,
  deviceFlowCutover: built.deviceFlowCutover,
  egressAudit: built.egressAudit,
  sessions: built.sessions,
  auditLog: built.auditLog,
  errors: built.errors,
  metrics: built.metrics,
  crons: built.crons,
  brokeredServices: () => built.brokeredTools.map((tool) => tool.service),
  deploymentLayer: built.deploymentLayerStore,
  deployDialTimeoutMs: config.deployDialTimeoutMs,
  ...(config.awsDeploy.appsDomain ? { deployAppsDomain: config.awsDeploy.appsDomain } : {}),
  ...(config.awsDeploy.gateSecret ? { deployGateSecret: config.awsDeploy.gateSecret } : {}),
  ...(config.deployAppsSessionSecret ? { deployAppsSessionSecret: config.deployAppsSessionSecret } : {}),
  ...(config.deployAppsLoginUrl ? { deployAppsLoginUrl: config.deployAppsLoginUrl } : {}),
  scheduler: built.scheduler,
  identity: built.identity,
  ...(built.keychain ? { keychain: built.keychain } : {}),
  serviceCreds: built.serviceCreds,
  deliveries: built.deliveries,
  ...(built.fireAskResolution ? { fireAskResolution: built.fireAskResolution } : {}),
  runs: built.runs,
  workspace: built.workspace,
  files: built.files,
  memory: built.memory,
  blobTransfer: built.blobTransfer,
  sandboxBackend: built.sandbox.profile.backend,
  egressDeclaredEnforcement: built.sandbox.profile.egressEnforcement ?? "none",
  egressEnforcement: effectiveEgressEnforcement(built.sandbox.profile, {
    signingSecret: config.signingSecret,
    apiBaseUrl: config.apiBaseUrl,
  }),
  sandbox: built.sandbox,
  advisoryLock: built.advisoryLock,
  ...(built.processes ? { processes: built.processes } : {}),
  ...(built.browserSessionStore ? { browserSessionStore: built.browserSessionStore } : {}),
  directory: built.directory,
  ...(built.ambientJudgments ? { ambientJudgments: built.ambientJudgments } : {}),
  ...(built.ackEmojiPicks ? { ackEmojiPicks: built.ackEmojiPicks } : {}),
  channelPolicy: built.channelPolicy,
  environments: built.environments,
  sandboxMigration: built.sandboxMigration,
});

await built.config.hydrate?.();
await built.identity.hydrate();
await built.deploymentLayerReady;
built.deploymentLayerRefresh.start();
built.runtime.start();

server.listen(config.port, () => {
  console.log(
    `[qm] listening on :${config.port} (org=${config.orgId}, store=${config.sessionStore}, ` +
      `runStore=${config.runStore}, workers=${config.workers}, backgroundWork=${config.backgroundWorkEnabled})`,
  );
});

if (config.backgroundWorkEnabled) {
  built.scheduler.start(1000);
} else {
  console.log("[qm] background work disabled; scheduler and runtime loops will not start");
}

/** Registry bots run their own Socket Mode connection; http mode has one events port only. */
const slackEventsHttp = process.env.SLACK_EVENTS_MODE?.trim() === "http";

/**
 * The set of Slack bots this process should be running: the DEFAULT installation (env or the
 * singular admin-managed record, exactly as before) plus every enabled registry record. With an
 * empty registry this is one entry keyed "default" and the reconciler behaves exactly as the
 * single-instance one always has.
 */
async function desiredSlackInstances(): Promise<Array<DesiredSlackInstance<SlackPluginConfig>>> {
  const wanted: Array<DesiredSlackInstance<SlackPluginConfig>> = [];

  const status = await built.slackInstallation.status();
  const stored = await built.slackInstallation.get();
  if (stored) {
    const dynamic = slackPluginConfigFromEnv({
      ...process.env,
      SLACK_BOT_TOKEN: stored.botToken,
      SLACK_APP_TOKEN: stored.appToken,
    });
    if (dynamic) wanted.push({ key: "default", version: stored.version, config: dynamic });
  } else if (!status.managed && slackConfig) {
    wanted.push({ key: "default", version: "environment", config: slackConfig });
  }

  let registered;
  try {
    registered = await built.slackBots.listWithTokens();
  } catch (error) {
    console.error(`[qm] slack bot registry read failed: ${errMessage(error)}`);
    return wanted;
  }
  for (const bot of registered) {
    if (!bot.enabled) continue;
    if (slackEventsHttp) {
      void built.slackBots
        .recordError(bot.id, "additional Slack bots need Socket Mode; this deployment runs SLACK_EVENTS_MODE=http")
        .catch(() => undefined);
      continue;
    }
    if (bot.personaId && !agentRoomsEnabled()) {
      // Not a start failure: the bot runs, it just cannot speak as its persona. Persona turns
      // ride the agent-rooms path, so without the flag there is nothing to run them through.
      console.warn(
        `[qm] slack bot ${bot.label} is bound to a persona but QM_AGENT_ROOMS is off — it will answer as the default org agent`,
      );
    }
    // Socket Mode is forced regardless of SLACK_EVENTS_MODE: a registry bot has no port or
    // signing secret of its own, and every other knob is inherited from the process env.
    const config = slackPluginConfigFromEnv({
      ...process.env,
      SLACK_EVENTS_MODE: "socket",
      SLACK_BOT_TOKEN: bot.botToken,
      SLACK_APP_TOKEN: bot.appToken,
      SLACK_SIGNING_SECRET: undefined,
      SLACK_EVENTS_PORT: undefined,
      DEV_INTROSPECTION: undefined,
    });
    if (!config) continue;
    wanted.push({
      key: bot.id,
      version: bot.version,
      backoff: true,
      config: {
        ...config,
        secondary: true,
        instanceLabel: bot.label,
        ...(bot.personaId && agentRoomsEnabled() ? { personaId: bot.personaId } : {}),
      },
    });
  }
  return wanted;
}

const slackRuntime = createSlackMultiRuntimeReconciler<SlackPluginConfig>({
  load: desiredSlackInstances,
  startPlugin: (desired) => startSlackPlugin(desired, built.slackCore),
  onError: (error) => console.error(`[qm] slack plugin reconciliation failed: ${errMessage(error)}`),
  onStartFailed: (key, error) => {
    if (key === "default") return;
    void built.slackBots.recordError(key, errMessage(error)).catch(() => undefined);
  },
  onStarted: (key) => {
    if (key === "default") return;
    void built.slackBots.clearError(key).catch(() => undefined);
  },
});
slackRuntime.start();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm] ${signal} received, shutting down`);
  void slackRuntime.stop().catch((e: unknown) => console.error("[qm] slack plugin stop failed:", errMessage(e)));
  built.scheduler.stop();
  built.deploymentLayerRefresh.stop();
  server.close();
  server.closeIdleConnections();
  stopWithBackstop(built.runtime, config.shutdownDrainMs, "qm", () => server.closeAllConnections());
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

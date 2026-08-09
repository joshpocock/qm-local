import {
  type SlackFile,
  channelPrivacyChange,
  createDeduper,
  dedupeKey,
  isGroupMembershipMessage,
  isSelfOrSiblingAuthored,
  isThreadReply,
  mentionsBot,
  onBotJoinedChannel,
  type SurfaceHeaderClient,
  shouldProcessMessage,
} from "./lib.ts";
import type { AckGate } from "./deferred-ack.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import type { Mirror } from "./mirror.ts";
import type { SlackReactionEvent, TurnHandler } from "./turn-handler.ts";

export function registerSlackEvents(
  app: {
    event(name: string, handler: (args: any) => Promise<void>): void;
    message(handler: (args: any) => Promise<void>): void;
  },
  deps: {
    handler: TurnHandler;
    mirror: Mirror;
    directory: Directory;
    ids: BotIdentity;
    deduper: ReturnType<typeof createDeduper>;
    webUiPublicUrl?: string;
    ensureHeader?: (client: SurfaceHeaderClient, channel: string, scopeId: string, kind: "dm" | "channel") => void;
  },
): void {
  const { handler, mirror, directory, ids, deduper } = deps;
  const { dispatch, handleReactionEvent, botHasStakeInThread } = handler;
  const { mirrorMessageEvent, pushSurfaceEvents } = mirror;
  const { knownPublicChannels, syncForUnseenGroup, forceDirectorySync } = directory;

  app.event("app_mention", async ({ event, body, client, context }: any) => {
    const e = event as any;
    // A mention written by this bot or by a sibling qm bot is an ECHO of something this process
    // just posted, not somebody addressing it. `app.message` has always dropped those; this path
    // had not, and a panel reply naming the next persona (`<@U…>` pills are how the debate reads)
    // fans an `app_mention` out to that sibling, which dispatched an addressed turn on the
    // panel's own threadRef and got folded into the in-flight persona run as a mid-turn steer —
    // stalling the debate for a whole turn wall clock. Humans and third-party bots are untouched,
    // so a real reply mid-debate still steers exactly as before.
    if (isSelfOrSiblingAuthored(e, ids.botUserId, ids.ownBotId)) return;
    const key = dedupeKey({
      event_id: (body as any)?.event_id,
      client_msg_id: e.client_msg_id,
      channel: e.channel,
      ts: e.ts,
    });
    await dispatch(
      key,
      {
        kind: "channel",
        channel: e.channel,
        userId: e.user,
        rawText: e.text ?? "",
        files: (e.files as SlackFile[]) ?? [],
        threadTs: e.thread_ts,
        ts: e.ts,
        ackGate: context.ackGate as AckGate | undefined,
      },
      client,
    );
  });

  app.message(async ({ message, body, client, context }: any) => {
    const m = message as any;
    const privacyChange = channelPrivacyChange(m);
    if (privacyChange) {
      if (privacyChange.isPrivate) knownPublicChannels.delete(privacyChange.channel);
      else knownPublicChannels.add(privacyChange.channel);
      await forceDirectorySync(client);
      return;
    }
    if (isGroupMembershipMessage(m)) {
      await forceDirectorySync(client);
      return;
    }
    const ackGate = context.ackGate as AckGate | undefined;
    if (m.subtype === "message_changed" && m.message) {
      if (shouldProcessMessage(m.message, ids.botUserId, ids.ownBotId))
        await mirrorMessageEvent({ ...m.message, channel: m.channel, channel_type: m.channel_type }, client, {
          editedAt: Date.now(),
          ...(m.channel_type === "im" ? { kind: "dm" as const } : {}),
        });
      return;
    }
    if (m.subtype === "message_deleted" && m.deleted_ts) {
      const type = m.channel_type;
      const prev = m.previous_message;
      const selfDelete = Boolean(
        prev && ((ids.botUserId && prev.user === ids.botUserId) || (ids.ownBotId && prev.bot_id === ids.ownBotId)),
      );
      if (m.channel && (type === "channel" || type === "group" || type === "mpim" || type === "im"))
        await pushSurfaceEvents([
          {
            container: String(m.channel),
            ts: String(m.deleted_ts),
            deleted: true,
            ...(selfDelete ? { self: true } : {}),
          },
        ]);
      return;
    }
    if (!shouldProcessMessage(m, ids.botUserId, ids.ownBotId)) return;

    if (m.channel_type === "im") {
      const key = dedupeKey({
        event_id: (body as any)?.event_id,
        client_msg_id: m.client_msg_id,
        channel: m.channel,
        ts: m.ts,
      });
      await dispatch(
        key,
        {
          kind: "dm",
          channel: m.channel,
          userId: m.user,
          ...(m.bot_profile?.name || m.username ? { authorName: String(m.bot_profile?.name || m.username) } : {}),
          rawText: m.text ?? "",
          files: (m.files as SlackFile[]) ?? [],
          threadTs: m.thread_ts,
          ts: m.ts,
          ackGate,
        },
        client,
      );
      return;
    }

    if (m.channel_type === "channel" || m.channel_type === "group" || m.channel_type === "mpim") {
      if (m.channel_type === "mpim" && m.channel) syncForUnseenGroup(client, String(m.channel));
      const threadReply = isThreadReply(m);
      const isMention = mentionsBot(m.text ?? "", ids.botUserId);
      const willDispatch = threadReply && !isMention && (await botHasStakeInThread(client, m.channel, m.thread_ts));
      await mirrorMessageEvent(m, client, willDispatch ? { handled: true } : {});
      if (!threadReply) return;
      if (isMention) return;
      if (!willDispatch) {
        console.error(
          `[slack-plugin] thread-follow skipped: no bot stake detected in thread ch=${m.channel} thread_ts=${m.thread_ts} ts=${m.ts}`,
        );
        return;
      }
      const key = dedupeKey({
        event_id: (body as any)?.event_id,
        client_msg_id: m.client_msg_id,
        channel: m.channel,
        ts: m.ts,
      });
      await dispatch(
        key,
        {
          kind: "channel",
          channel: m.channel,
          userId: m.user,
          ...(m.bot_profile?.name || m.username ? { authorName: String(m.bot_profile?.name || m.username) } : {}),
          rawText: m.text ?? "",
          files: (m.files as SlackFile[]) ?? [],
          threadTs: m.thread_ts,
          ts: m.ts,
          unprompted: true,
          ...(m.bot_id || m.subtype === "bot_message" ? { botAuthored: true } : {}),
          ackGate,
        },
        client,
      );
    }
  });

  app.event("member_joined_channel", async ({ event, body, client }: any) => {
    const e = event as { user?: string; channel?: string; event_ts?: string };
    if (
      deduper.seen(
        dedupeKey({ event_id: (body as { event_id?: string })?.event_id, channel: e.channel, ts: e.event_ts }),
      )
    )
      return;
    if (e.user === ids.botUserId) {
      await onBotJoinedChannel({
        client,
        channel: e.channel,
        joinerUserId: e.user,
        botUserId: ids.botUserId,
        webUiPublicUrl: deps.webUiPublicUrl,
        syncDirectory: () => forceDirectorySync(client),
        ...(deps.ensureHeader
          ? {
              ensureHeader: (channel: string) =>
                deps.ensureHeader!(client as SurfaceHeaderClient, channel, `channel:${channel}`, "channel"),
            }
          : {}),
      });
    } else if (!e.channel || !knownPublicChannels.has(e.channel)) {
      await forceDirectorySync(client);
    }
  });

  app.event("member_left_channel", async ({ event, body, client }: any) => {
    const e = event as { channel?: string; event_ts?: string };
    if (
      deduper.seen(
        dedupeKey({ event_id: (body as { event_id?: string })?.event_id, channel: e.channel, ts: e.event_ts }),
      )
    )
      return;
    if (!e.channel || !knownPublicChannels.has(e.channel)) await forceDirectorySync(client);
  });

  app.event("reaction_added", async ({ event, body, client }: any) => {
    await handleReactionEvent(event as SlackReactionEvent, body as any, client, true);
  });
  app.event("reaction_removed", async ({ event, body, client }: any) => {
    await handleReactionEvent(event as SlackReactionEvent, body as any, client, false);
  });
}

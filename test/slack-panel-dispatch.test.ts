import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { SlackCoreClient } from "../src/slack/index.ts";
import type { TurnResult } from "../src/types.ts";

type Handler = (args: any) => Promise<void>;

class FakeSocketModeClient {
  on(): void {}
  async start(): Promise<void> {}
  async disconnect(): Promise<void> {}
}

/** Set by the test immediately before `startSlackPlugin`; `auth.test` runs before the caller
 *  gets control back, so the identity cannot be assigned onto the client after the fact. */
let nextIdentity = { user_id: "UQM", bot_id: "BQM", user: "qm" };

class FakeSlackClient {
  readonly posts: any[] = [];
  readonly ephemerals: any[] = [];
  readonly usersById = new Map<string, any>();
  readonly channelsById = new Map<string, any>();
  readonly membersByChannel = new Map<string, string[]>();
  readonly identity = nextIdentity;
  private postSequence = 0;

  readonly auth = {
    test: async () => ({
      team_id: "T1",
      team: "Acme",
      url: "https://acme.slack.com/",
      ...this.identity,
    }),
  };
  readonly emoji = { list: async () => ({ emoji: {} }) };
  readonly users = {
    info: async ({ user }: { user: string }) => ({ user: this.usersById.get(user) }),
    lookupByEmail: async () => ({ user: undefined }),
  };
  readonly conversations = {
    info: async ({ channel }: { channel: string }) => ({ channel: this.channelsById.get(channel) }),
    // Widened so a test can hand back a thread the bot has a stake in.
    replies: async (): Promise<{ messages: any[]; has_more: boolean }> => ({ messages: [], has_more: false }),
    history: async () => ({ messages: [], has_more: false }),
    open: async () => ({ channel: { id: "DOPEN" } }),
    setTopic: async () => ({ ok: true }),
    setPurpose: async () => ({ ok: true }),
  };
  readonly chat = {
    postMessage: async (body: any) => {
      this.posts.push(body);
      return { ok: true, ts: `posted-${++this.postSequence}` };
    },
    postEphemeral: async (body: any) => {
      this.ephemerals.push(body);
      return { ok: true, message_ts: `ephemeral-${this.ephemerals.length}` };
    },
    update: async (body: any) => ({ ok: true, ts: body.ts }),
    delete: async () => ({ ok: true }),
  };
  readonly reactions = {
    add: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
    get: async () => ({}),
  };
  readonly files = { uploadV2: async () => ({ ok: true }), info: async () => ({ file: {} }) };
  readonly bots = { info: async () => ({ bot: {} }) };

  async *paginate(method: string, args: any): AsyncGenerator<any> {
    if (method === "users.list") {
      yield { members: [...this.usersById.values()] };
      return;
    }
    if (method === "conversations.list") {
      yield { channels: [...this.channelsById.values()].filter((c) => !c.is_mpim) };
      return;
    }
    if (method === "conversations.members") {
      yield { members: this.membersByChannel.get(args.channel) ?? [] };
      return;
    }
    throw new Error(`unexpected pagination method: ${method}`);
  }
}

class FakeApp {
  static instances: FakeApp[] = [];
  readonly client = new FakeSlackClient();
  readonly eventHandlers = new Map<string, Handler[]>();
  started = false;

  constructor(_opts: any) {
    FakeApp.instances.push(this);
  }

  readonly messageHandlers: Handler[] = [];
  message(handler: Handler): void {
    this.messageHandlers.push(handler);
  }
  event(name: string, handler: Handler): void {
    this.eventHandlers.set(name, [...(this.eventHandlers.get(name) ?? []), handler]);
  }
  action(): void {}
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
  }

  async mention(event: any): Promise<void> {
    for (const handler of this.eventHandlers.get("app_mention") ?? []) {
      await handler({ event, body: { event_id: `Ev-${event.channel}-${event.ts}` }, client: this.client, context: {} });
    }
  }

  async dm(message: any): Promise<void> {
    for (const handler of this.messageHandlers) {
      await handler({
        message,
        body: { event_id: `Ev-${message.channel}-${message.ts}` },
        client: this.client,
        context: {},
      });
    }
  }
}

mock.module("@slack/bolt", { defaultExport: { App: FakeApp, LogLevel: { INFO: "info" } } });
mock.module("@slack/socket-mode", { namedExports: { SocketModeClient: FakeSocketModeClient } });
mock.module("@slack/web-api", { namedExports: { WebClient: class {} } });

const { startSlackPlugin } = await import("../src/slack/index.ts");
const { resetSlackPanelClaims } = await import("../src/slack/message-gating.ts");

/** One core shared by every instance, so "exactly one dispatch" is one assertion. */
class FakeCore implements SlackCoreClient {
  readonly turns: any[] = [];
  readonly personaNames = new Map<string, string>();
  result: TurnResult = { status: "ok", reply: "agent reply" };

  async externalSlackParticipants(): Promise<boolean> {
    return false;
  }
  async surfaceHeaderFacts(): Promise<{ modelName: string }> {
    return { modelName: "Claude Opus 4.8" };
  }
  onScopeModelChanged(): void {}
  async stageBlob(): Promise<{ blobId: string; sizeBytes: number }> {
    return { blobId: "b", sizeBytes: 0 };
  }
  async readBlob(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async readFileArtifact(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async pickAckEmoji(): Promise<undefined> {
    return undefined;
  }
  async recordAckPick(): Promise<void> {}
  async personaName(personaId: string): Promise<string | undefined> {
    return this.personaNames.get(personaId);
  }
  async personaHeader(personaId: string): Promise<{ name: string; modelName: string } | undefined> {
    const name = this.personaNames.get(personaId);
    return name ? { name, modelName: `${name}-model` } : undefined;
  }
  readonly ingested: any[] = [];
  async ingestSurfaceEvents(events: any[]): Promise<void> {
    this.ingested.push(...events);
  }
  /** Per-channel debate-rounds overrides; absent means "follow the admin default". */
  readonly debateRoundsByChannel = new Map<string, number>();
  readonly debateRoundsReads: string[] = [];
  async channelDebateRounds(container: string): Promise<number | undefined> {
    this.debateRoundsReads.push(container);
    return this.debateRoundsByChannel.get(container);
  }
  async submitTurn(body: any): Promise<TurnResult> {
    this.turns.push(body);
    return this.result;
  }
  async waitRun(): Promise<TurnResult | null> {
    return this.result;
  }
  async activeRunForThread(): Promise<undefined> {
    return undefined;
  }
  async signalRunAbort(): Promise<void> {}
  async ackRunDelivery(): Promise<void> {}
  async reportTurnMetrics(): Promise<void> {}
  async reportRunEditRef(): Promise<void> {}
  async getApproval(): Promise<null> {
    return null;
  }
  async pushDirectory(): Promise<void> {}
  async claimDeliveries(): Promise<[]> {
    return [];
  }
  async ackDelivery(): Promise<void> {}
  onDeliveryEnqueued(): () => void {
    return () => {};
  }
  async pendingContextRequests(): Promise<[]> {
    return [];
  }
  onContextRequest(): () => void {
    return () => {};
  }
  async fulfillContextRequest(): Promise<void> {}
}

const internalUser = (id: string, name: string) => ({
  id,
  team_id: "T1",
  name: name.toLowerCase(),
  real_name: name,
  profile: { display_name: name, real_name: name, email: `${name.toLowerCase()}@example.com` },
});

interface BotSpec {
  userId: string;
  botId: string;
  handle: string;
  personaId?: string;
  /** A persona this bot puts on ONLY inside a panel; the default bot's mode. */
  panelPersonaId?: string;
  personaName?: string;
  secondary?: boolean;
  panelRounds?: number;
}

const SCOUT: BotSpec = {
  userId: "USCOUT",
  botId: "BSCOUT",
  handle: "scout",
  personaId: "p-scout",
  personaName: "Scout",
  secondary: true,
};
const CRITIC: BotSpec = {
  userId: "UCRITIC",
  botId: "BCRITIC",
  handle: "critic",
  personaId: "p-critic",
  personaName: "Critic",
  secondary: true,
};
const DEFAULT_BOT: BotSpec = { userId: "UQM", botId: "BQM", handle: "qm" };
/**
 * The same default bot, now carrying a PANEL persona: still the org's neutral assistant on
 * every turn of its own, but eligible for a seat in a debate.
 */
const PANEL_DEFAULT_BOT: BotSpec = {
  userId: "UQM",
  botId: "BQM",
  handle: "qm",
  panelPersonaId: "p-host",
  personaName: "Host",
};

async function fleet(specs: BotSpec[], panelRounds = 1) {
  resetSlackPanelClaims();
  const core = new FakeCore();
  for (const spec of specs) {
    const personaId = spec.personaId ?? spec.panelPersonaId;
    if (personaId && spec.personaName) core.personaNames.set(personaId, spec.personaName);
  }

  const bots: Array<{ spec: BotSpec; app: FakeApp; stop: () => Promise<void> }> = [];
  for (const spec of specs) {
    nextIdentity = { user_id: spec.userId, bot_id: spec.botId, user: spec.handle };
    const started = startSlackPlugin(
      {
        botToken: `xoxb-${spec.handle}`,
        appToken: `xapp-${spec.handle}`,
        identityEmail: "0",
        panelRounds: spec.panelRounds ?? panelRounds,
        ...(spec.personaId ? { personaId: spec.personaId } : {}),
        ...(spec.panelPersonaId ? { panelPersonaId: spec.panelPersonaId } : {}),
        ...(spec.secondary ? { secondary: true } : {}),
      },
      core,
    );
    const app = FakeApp.instances.at(-1)!;
    app.client.usersById.set("U1", internalUser("U1", "Alice"));
    app.client.channelsById.set("C1", { id: "C1", name: "engineering", is_member: true, is_private: false });
    app.client.membersByChannel.set("C1", ["U1", spec.userId]);
    const plugin = await started;
    bots.push({ spec, app, stop: () => plugin.stop() });
  }
  await new Promise((resolve) => setImmediate(resolve));
  const stop = async (): Promise<void> => {
    for (const bot of bots.reverse()) await bot.stop();
  };
  const of = (spec: BotSpec): FakeApp => bots.find((b) => b.spec.userId === spec.userId)!.app;
  return { core, bots, of, stop };
}

const mention = (text: string, ts: string) => ({ channel: "C1", user: "U1", text, ts });

test("two mentioned persona bots run ONE panel, rostered in mention order at the configured rounds", async () => {
  const f = await fleet([SCOUT, CRITIC], 2);
  try {
    f.core.result = { status: "ok", reply: "opening", panelPersona: { id: "p-critic", name: "Critic" } };
    // Slack delivers app_mention to EVERY mentioned app: both instances see this message.
    const evt = mention("<@UCRITIC> <@USCOUT> debate this", "500.1");
    await Promise.all([f.of(SCOUT).mention(evt), f.of(CRITIC).mention(evt)]);

    assert.equal(f.core.turns.length, 1, "exactly one instance dispatches; the loser stands down entirely");
    assert.deepEqual(f.core.turns[0].room, { personaIds: ["p-critic", "p-scout"], rounds: 2 });
    assert.equal(
      f.core.turns[0].text,
      "@Critic @Scout debate this",
      "both bots are named for the driver — including the claiming bot's own persona",
    );
    assert.equal(f.core.turns[0].conversation.threadRef, "ch:C1:500.1");
    assert.equal(f.core.turns[0].deliveryTarget, "C1:500.1");
  } finally {
    await f.stop();
  }
});

test("a panel reply is posted by the bot whose persona wrote it, with the other personas as real pills", async () => {
  const f = await fleet([SCOUT, CRITIC]);
  try {
    // Critic speaks first even though only Scout's instance is handed the event, so the reply
    // has to travel to Critic's bot rather than going out under whoever claimed the message.
    f.core.result = {
      status: "ok",
      reply: "I disagree with @Scout, and @Scoutmaster is nobody",
      panelPersona: { id: "p-critic", name: "Critic" },
    };
    await f.of(SCOUT).mention(mention("<@USCOUT> <@UCRITIC> go", "501.1"));

    assert.equal(f.of(SCOUT).client.posts.length, 0, "the claiming bot does not speak for another persona");
    const posted = f.of(CRITIC).client.posts;
    assert.equal(posted.length, 1);
    assert.equal(posted[0].channel, "C1");
    assert.equal(posted[0].thread_ts, "501.1", "every panel reply lands in the triggering message's thread");
    assert.equal(posted[0].text, "I disagree with <@USCOUT>, and @Scoutmaster is nobody");
  } finally {
    await f.stop();
  }
});

test("a reply whose persona bot is gone falls back to the claiming bot rather than being dropped", async () => {
  const f = await fleet([SCOUT, CRITIC]);
  try {
    // p-ghost is on the roster in core but has no bot running here any more.
    f.core.result = { status: "ok", reply: "still worth saying", panelPersona: { id: "p-ghost", name: "Ghost" } };
    await f.of(SCOUT).mention(mention("<@USCOUT> <@UCRITIC> go", "502.1"));

    assert.deepEqual(
      f.of(SCOUT).client.posts.map((p: any) => p.text),
      ["still worth saying"],
      "a reply posted by the wrong bot beats a reply nobody sees",
    );
    assert.equal(f.of(CRITIC).client.posts.length, 0);
  } finally {
    await f.stop();
  }
});

test("the default qm bot can claim the message but never joins the roster and never speaks", async () => {
  const f = await fleet([DEFAULT_BOT, SCOUT, CRITIC]);
  try {
    f.core.result = { status: "ok", reply: "opening", panelPersona: { id: "p-scout", name: "Scout" } };
    // Addressed to the default bot AND two persona bots; only the default bot is handed the
    // event, so it is the one that claims and dispatches.
    await f.of(DEFAULT_BOT).mention(mention("<@UQM> <@USCOUT> <@UCRITIC> settle this", "503.1"));

    assert.equal(f.core.turns.length, 1);
    assert.deepEqual(f.core.turns[0].room, { personaIds: ["p-scout", "p-critic"], rounds: 1 });
    assert.equal(f.core.turns[0].text, "@Scout @Critic settle this", "the default bot's own mention is stripped");
    assert.equal(f.of(DEFAULT_BOT).client.posts.length, 0, "the default bot stays silent");
    assert.deepEqual(
      f.of(SCOUT).client.posts.map((p: any) => p.text),
      ["opening"],
    );
    assert.equal(f.of(CRITIC).client.posts.length, 0);
  } finally {
    await f.stop();
  }
});

test("one persona bot mentioned is not a panel: the single-persona path is unchanged", async () => {
  const f = await fleet([SCOUT, CRITIC], 5);
  try {
    // Core answers as it does for any single-persona bot; `panelPersona` rides along because
    // core runs every persona turn through the panel path, and must change nothing here.
    f.core.result = {
      status: "ok",
      reply: "just me — @Critic stays text",
      panelPersona: { id: "p-scout", name: "Scout" },
    };
    await f.of(SCOUT).mention(mention("<@USCOUT> only you", "504.1"));

    assert.equal(f.core.turns.length, 1);
    assert.deepEqual(f.core.turns[0].room, { personaIds: ["p-scout"], rounds: 1 }, "one member, one round, as before");
    assert.equal(f.core.turns[0].text, "only you", "the self-mention is stripped, not renamed");
    assert.deepEqual(
      f.of(SCOUT).client.posts.map((p: any) => p.text),
      ["just me — @Critic stays text"],
      "no outbound mention rewriting outside a panel",
    );
  } finally {
    await f.stop();
  }
});

test("a 1:1 DM is never a panel — the other personas are not in it", async () => {
  const f = await fleet([SCOUT, CRITIC]);
  try {
    f.core.result = { status: "ok", reply: "dm reply", panelPersona: { id: "p-scout", name: "Scout" } };
    await f.of(SCOUT).dm({ channel: "D1", channel_type: "im", user: "U1", text: "<@UCRITIC> and you", ts: "506.1" });

    assert.equal(f.core.turns.length, 1);
    assert.deepEqual(f.core.turns[0].room, { personaIds: ["p-scout"], rounds: 1 }, "the DM's own bot answers alone");
    assert.equal(f.core.turns[0].text, "<@UCRITIC> and you", "no inbound rewriting off the panel path");
    assert.deepEqual(
      f.of(SCOUT).client.posts.map((p: any) => p.text),
      ["dm reply"],
    );
    assert.equal(f.of(CRITIC).client.posts.length, 0);
  } finally {
    await f.stop();
  }
});

// --- the default bot's PANEL persona -----------------------------------------------------

test("a panel persona changes nothing about a turn the default bot takes on its own", async () => {
  const f = await fleet([PANEL_DEFAULT_BOT, SCOUT]);
  try {
    f.core.result = { status: "ok", reply: "default agent reply" };
    await f.of(PANEL_DEFAULT_BOT).mention(mention("<@UQM> just you", "600.1"));

    assert.equal(f.core.turns.length, 1);
    assert.equal(
      f.core.turns[0].room,
      undefined,
      "no roster: the default bot still runs the org's default agent on the admin runtime choice",
    );
    assert.equal(f.core.turns[0].text, "just you", "its own mention is stripped, not renamed");
    assert.deepEqual(
      f.of(PANEL_DEFAULT_BOT).client.posts.map((p: any) => p.text),
      ["default agent reply"],
    );
  } finally {
    await f.stop();
  }
});

test("a panel persona makes the default bot count toward the panel threshold, in mention order", async () => {
  const f = await fleet([PANEL_DEFAULT_BOT, SCOUT]);
  try {
    f.core.result = { status: "ok", reply: "opening", panelPersona: { id: "p-scout", name: "Scout" } };
    // One agent bot plus the default bot is now TWO personas, so it is a panel — and Slack
    // hands the event to both apps, so exactly one of them may dispatch it.
    const evt = mention("<@USCOUT> <@UQM> settle this", "601.1");
    await Promise.all([f.of(PANEL_DEFAULT_BOT).mention(evt), f.of(SCOUT).mention(evt)]);

    assert.equal(f.core.turns.length, 1);
    assert.deepEqual(f.core.turns[0].room, { personaIds: ["p-scout", "p-host"], rounds: 1 });
    assert.equal(
      f.core.turns[0].text,
      "@Scout @Host settle this",
      "the default bot is named for the driver instead of being stripped out of its own panel",
    );
  } finally {
    await f.stop();
  }
});

test("a panel reply written by the default bot's persona is posted by the default bot", async () => {
  const f = await fleet([PANEL_DEFAULT_BOT, SCOUT]);
  try {
    f.core.result = { status: "ok", reply: "@Scout, your move", panelPersona: { id: "p-host", name: "Host" } };
    // Scout's instance claims and dispatches; the reply still has to travel to the default bot.
    await f.of(SCOUT).mention(mention("<@USCOUT> <@UQM> go", "602.1"));

    assert.equal(f.of(SCOUT).client.posts.length, 0, "the claiming bot does not speak for another persona");
    assert.deepEqual(
      f.of(PANEL_DEFAULT_BOT).client.posts.map((p: any) => p.text),
      ["<@USCOUT>, your move"],
    );
  } finally {
    await f.stop();
  }
});

test("a default bot with no panel persona is still kept out of every roster (regression)", async () => {
  const f = await fleet([DEFAULT_BOT, SCOUT]);
  try {
    f.core.result = { status: "ok", reply: "default agent reply" };
    await f.of(DEFAULT_BOT).mention(mention("<@USCOUT> <@UQM> settle this", "603.1"));

    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].room, undefined, "one persona bot is not a panel; the default bot answers alone");
    assert.equal(
      f.core.turns[0].text,
      "<@USCOUT>  settle this",
      "Scout's mention is left raw, not translated to @Scout: nothing about the off-panel path moved",
    );
    assert.deepEqual(
      f.of(DEFAULT_BOT).client.posts.map((p: any) => p.text),
      ["default agent reply"],
    );
    assert.equal(f.of(SCOUT).client.posts.length, 0);
  } finally {
    await f.stop();
  }
});

test("a follow-up in the same thread is judged fresh: one mention runs one persona, two run a new panel", async () => {
  const f = await fleet([SCOUT, CRITIC]);
  try {
    f.core.result = { status: "ok", reply: "a", panelPersona: { id: "p-scout", name: "Scout" } };
    await f.of(SCOUT).mention({ ...mention("<@USCOUT> <@UCRITIC> round one", "505.1") });
    await f.of(SCOUT).mention({ ...mention("<@USCOUT> now just you", "505.2"), thread_ts: "505.1" });

    assert.equal(f.core.turns.length, 2);
    assert.deepEqual(f.core.turns[0].room, { personaIds: ["p-scout", "p-critic"], rounds: 1 });
    assert.deepEqual(f.core.turns[1].room, { personaIds: ["p-scout"], rounds: 1 });
    assert.equal(
      f.core.turns[1].conversation.threadRef,
      f.core.turns[0].conversation.threadRef,
      "both messages share one session, so the room carries the context either way",
    );
  } finally {
    await f.stop();
  }
});

// --- the admin-chosen rounds ---------------------------------------------------------------

test("the configured rounds ride EVERY panel dispatch, including a follow-up in a thread that already panelled", async () => {
  // `panelRounds` is what `src/index.ts` resolves from the admin setting (then
  // QM_SLACK_PANEL_ROUNDS, then 1). The plugin must put it on every dispatch, not only the
  // first: core prefers a persisted room's roster, and takes the ROUNDS from the request
  // precisely because this value can change between two messages in one thread.
  const f = await fleet([SCOUT, CRITIC], 4);
  try {
    f.core.result = { status: "ok", reply: "opening", panelPersona: { id: "p-scout", name: "Scout" } };
    await f.of(SCOUT).mention(mention("<@USCOUT> <@UCRITIC> round one", "700.1"));
    await f.of(SCOUT).mention({ ...mention("<@USCOUT> <@UCRITIC> keep going", "700.2"), thread_ts: "700.1" });

    assert.equal(f.core.turns.length, 2);
    assert.deepEqual(f.core.turns[0].room, { personaIds: ["p-scout", "p-critic"], rounds: 4 });
    assert.deepEqual(
      f.core.turns[1].room,
      { personaIds: ["p-scout", "p-critic"], rounds: 4 },
      "the second message in the same thread still names the rounds, so a changed setting reaches it",
    );
    assert.equal(f.core.turns[1].conversation.threadRef, f.core.turns[0].conversation.threadRef);
  } finally {
    await f.stop();
  }
});

test("a bot started with a different rounds value dispatches that value, with nothing else moving", async () => {
  // The reconciler restarts the default instance on a version bump and hands it the new
  // number; this is the same instance, restarted, seen from the dispatch side.
  for (const rounds of [1, 20]) {
    const f = await fleet([SCOUT, CRITIC], rounds);
    try {
      f.core.result = { status: "ok", reply: "opening", panelPersona: { id: "p-scout", name: "Scout" } };
      await f.of(SCOUT).mention(mention("<@USCOUT> <@UCRITIC> go", `70${rounds}.1`));
      assert.deepEqual(f.core.turns[0].room, { personaIds: ["p-scout", "p-critic"], rounds });
      assert.equal(f.core.turns[0].text, "@Scout @Critic go", "the rounds knob changes nothing else about a dispatch");
    } finally {
      await f.stop();
    }
  }
});

// --- a message spoken for by a sibling bot --------------------------------------------------

/** A plain channel message, as Slack's `message.channels` event delivers it. */
const channelMessage = (text: string, ts: string, threadTs?: string) => ({
  channel: "C1",
  channel_type: "channel",
  user: "U1",
  text,
  ts,
  ...(threadTs ? { thread_ts: threadTs } : {}),
});

test("a top-level message naming only a sibling bot is mirrored as HANDLED, so ambient never judges it", async () => {
  // The default bot is in the channel and sees every message. This one names Scout and not
  // it — Scout has it. Left unmarked, the ambient judge (which by design only ever looks at
  // messages this bot was NOT tagged in) had the org's neutral bot answer a question put to
  // an agent by name. The sibling's own mirror marks the same row, but that write races this
  // one, so each instance stands itself down instead of waiting to see the sibling's flag.
  const f = await fleet([DEFAULT_BOT, SCOUT]);
  try {
    await f.of(DEFAULT_BOT).dm(channelMessage("<@USCOUT> hey how are u", "800.1"));

    assert.equal(f.core.turns.length, 0, "a top-level message this bot was not tagged in never runs a turn here");
    const row = f.core.ingested.find((e) => e.ts === "800.1");
    assert.ok(row, "the message is still mirrored — the cache is how the room is read later");
    assert.equal(row.handled, true, "and it is recorded as already spoken for");
    assert.equal(row.mentionsSelf, undefined, "this bot was not the one addressed");
  } finally {
    await f.stop();
  }
});

test("true ambient is untouched: a message naming nobody is mirrored unhandled", async () => {
  const f = await fleet([DEFAULT_BOT, SCOUT]);
  try {
    await f.of(DEFAULT_BOT).dm(channelMessage("has anyone looked at the pricing page?", "801.1"));
    await f.of(DEFAULT_BOT).dm(channelMessage("<@U1> what do you reckon?", "801.2"));

    for (const ts of ["801.1", "801.2"]) {
      const row = f.core.ingested.find((e) => e.ts === ts);
      assert.ok(row, ts);
      assert.equal(row.handled, undefined, `${ts} is nobody's message; ambient must still be free to judge it`);
    }
  } finally {
    await f.stop();
  }
});

test("an UNPROMPTED thread turn stands down when the message names a sibling, and runs when it names nobody", async () => {
  const f = await fleet([DEFAULT_BOT, SCOUT]);
  try {
    const qm = f.of(DEFAULT_BOT);
    // The default bot posted in this thread earlier, so it follows it.
    qm.client.conversations.replies = async () => ({ messages: [{ user: "UQM", text: "earlier" }], has_more: false });

    await qm.dm(channelMessage("<@USCOUT> hey how are u", "802.2", "802.1"));
    assert.equal(f.core.turns.length, 0, "Scout was asked; the default bot does not volunteer over it");

    await qm.dm(channelMessage("still stuck on this one", "802.3", "802.1"));
    assert.equal(f.core.turns.length, 1, "an unaddressed follow-up in a followed thread still runs");
    assert.equal(f.core.turns[0].unprompted, true);
  } finally {
    await f.stop();
  }
});

test("an explicit mention of THIS bot still runs, even alongside a sibling's", async () => {
  const f = await fleet([DEFAULT_BOT, SCOUT]);
  try {
    // Both named: the default bot is persona-less, so this is not a panel — it is an ordinary
    // addressed turn, and being addressed always wins over standing down.
    await f.of(DEFAULT_BOT).mention(mention("<@UQM> <@USCOUT> who wants this?", "803.1"));
    assert.equal(f.core.turns.length, 1, "an addressed turn is never suppressed");

    await f.of(DEFAULT_BOT).mention(mention("<@UQM> just you then", "803.2"));
    assert.equal(f.core.turns.length, 2);
  } finally {
    await f.stop();
  }
});

// --- a persona's own reply echoed back as an app_mention ------------------------------------

/**
 * A panel reply as Slack re-delivers it: the driver renders the next persona as a real `<@U…>`
 * pill, and Slack fans an `app_mention` out to every app named in the text — including the qm
 * bot that wrote it and the qm bot it names.
 */
const botMention = (author: BotSpec, text: string, ts: string, threadTs?: string) => ({
  channel: "C1",
  user: author.userId,
  bot_id: author.botId,
  text,
  ts,
  ...(threadTs ? { thread_ts: threadTs } : {}),
});

test("a persona's panel reply echoed back as an app_mention never dispatches a turn", async () => {
  // The regression: Critic's round-1 reply names Scout as a pill, so Slack delivered an
  // app_mention to Scout's instance (and to Critic's own). That echo dispatched an ADDRESSED
  // turn on the panel's threadRef, which core folded into the persona run still in flight as a
  // mid-turn steer — the run then answered its own echo and sat open until the turn wall clock
  // expired, so the panel, blocked awaiting it, never reached round 2.
  const f = await fleet([SCOUT, CRITIC], 2);
  try {
    f.core.result = { status: "ok", reply: "opening", panelPersona: { id: "p-critic", name: "Critic" } };
    await f.of(SCOUT).mention(mention("<@USCOUT> <@UCRITIC> debate this", "900.1"));
    assert.equal(f.core.turns.length, 1, "the human message is the only dispatch so far");

    const echo = botMention(CRITIC, "_1/2: my case_ — <@USCOUT>, your move.", "900.2", "900.1");
    // Every instance that can see it: the sibling it names, and the author's own.
    await f.of(SCOUT).mention(echo);
    await f.of(CRITIC).mention(echo);

    assert.equal(f.core.turns.length, 1, "a sibling qm bot's post is an echo, not somebody addressing this bot");
    assert.equal(f.of(SCOUT).client.posts.length, 0, "and nothing is said about it either");
  } finally {
    await f.stop();
  }
});

test("a genuine human reply on a panel thread still dispatches exactly as before", async () => {
  const f = await fleet([SCOUT, CRITIC], 2);
  try {
    f.core.result = { status: "ok", reply: "opening", panelPersona: { id: "p-critic", name: "Critic" } };
    await f.of(SCOUT).mention(mention("<@USCOUT> <@UCRITIC> debate this", "901.1"));
    assert.equal(f.core.turns.length, 1);

    // The steer/interrupt semantics a person gets mid-debate are deliberate and must survive.
    await f.of(SCOUT).mention({ ...mention("<@USCOUT> actually, narrow it to CSS", "901.2"), thread_ts: "901.1" });

    assert.equal(f.core.turns.length, 2, "a person on the thread is still heard mid-panel");
    assert.deepEqual(f.core.turns[1].room, { personaIds: ["p-scout"], rounds: 1 });
    assert.equal(f.core.turns[1].conversation.threadRef, f.core.turns[0].conversation.threadRef);
    assert.equal(f.core.turns[1].liveActor, true, "and it is an addressed turn, not an echo");
  } finally {
    await f.stop();
  }
});

test("a third-party bot that @mentions the bot is untouched by the sibling gate", async () => {
  const f = await fleet([DEFAULT_BOT, SCOUT]);
  try {
    // GitHub, PagerDuty and friends are not qm bots, so nothing about them moved.
    for (const bot of [f.of(DEFAULT_BOT), f.of(SCOUT)]) {
      bot.client.usersById.set("UGITHUB", {
        ...internalUser("UGITHUB", "GitHub"),
        is_bot: true,
      });
      bot.client.membersByChannel.set("C1", ["U1", "UGITHUB", "UQM", "USCOUT"]);
    }
    await f.of(DEFAULT_BOT).mention({
      channel: "C1",
      user: "UGITHUB",
      bot_id: "BGITHUB",
      text: "<@UQM> deploy failed on main",
      ts: "902.1",
    });

    assert.equal(f.core.turns.length, 1, "a third-party bot naming this bot still runs a turn");
  } finally {
    await f.stop();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimSlackPanel,
  mentionedPersonaBots,
  personaBotForId,
  personaBotForUserId,
  registerSlackBotIdentity,
  registeredPersonaBots,
  registeredSlackBotIdentities,
  resetSlackPanelClaims,
  shouldProcessMessage,
  type SlackBotIdentity,
} from "../src/slack/message-gating.ts";
import { translateInboundMentions, translateOutboundMentions } from "../src/slack/panel-mentions.ts";
import { panelAddressed, panelMentions } from "../src/agents/panel-driver.ts";
import { personaIdFromIdentity, personaPostIdentity } from "../src/delivery/persona-identity.ts";
import { runResultDelivery } from "../src/delivery/run-result-delivery.ts";
import { resolveSlackPanelRounds, slackPanelRounds, slackPluginConfigFromEnv } from "../src/slack/config.ts";
import {
  resolveSlackPanelRounds as resolveSlackPanelRoundsFromConfig,
  slackPanelRounds as slackPanelRoundsFromConfig,
} from "../src/config.ts";
import { ROOM_MAX_ROUNDS } from "../src/types.ts";
import type { Run } from "../src/runs/run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal, TurnResult } from "../src/types.ts";
import { mentionsSiblingBot } from "../src/slack/message-gating.ts";

const stubClient = (): SlackBotIdentity["postClient"] => ({
  chat: { postMessage: async () => ({}), update: async () => ({}) },
  conversations: { history: async () => ({}), replies: async () => ({}) },
});

/** Registers a set of bots and hands back a single release for all of them. */
function withBots(bots: SlackBotIdentity[]): () => void {
  const release = bots.map((bot) => registerSlackBotIdentity(bot));
  return () => release.forEach((fn) => fn());
}

const SCOUT: SlackBotIdentity = {
  botUserId: "USCOUT",
  ownBotId: "BSCOUT",
  personaId: "p-scout",
  personaName: "Scout",
};
const CRITIC: SlackBotIdentity = {
  botUserId: "UCRITIC",
  ownBotId: "BCRITIC",
  personaId: "p-critic",
  personaName: "Critic",
};
/** The default qm bot: running, registered, and deliberately persona-less. */
const DEFAULT_BOT: SlackBotIdentity = { botUserId: "UQM", ownBotId: "BQM" };
/** The same default bot carrying a PANEL persona: a persona it wears only inside a panel. */
const PANEL_DEFAULT_BOT: SlackBotIdentity = {
  botUserId: "UQM",
  ownBotId: "BQM",
  personaId: "p-host",
  personaName: "Host",
  alwaysPersona: false,
};

// --- sibling directory -------------------------------------------------------------------

test("registration round-trips the persona fields and the post client, and releases all of them", () => {
  const client = stubClient();
  const release = withBots([{ ...SCOUT, postClient: client }, DEFAULT_BOT]);
  try {
    const scout = personaBotForId("p-scout");
    assert.equal(scout?.botUserId, "USCOUT");
    assert.equal(scout?.personaName, "Scout");
    assert.equal(scout?.postClient, client, "the post client is the seam the panel posts through");
    assert.equal(personaBotForUserId("USCOUT")?.personaId, "p-scout");

    // The persona-less default bot is a sibling for gating purposes and nothing more.
    assert.equal(personaBotForUserId("UQM")?.personaId, undefined);
    assert.deepEqual(
      registeredPersonaBots().map((b) => b.personaId),
      ["p-scout"],
      "a bot with no persona never appears in a panel roster",
    );

    // The gate contract is unchanged: both id kinds are registered, siblings are ignored.
    assert.ok(registeredSlackBotIdentities().has("USCOUT"));
    assert.ok(registeredSlackBotIdentities().has("BQM"));
    assert.equal(shouldProcessMessage({ bot_id: "BSCOUT" }, "UOTHER", "BOTHER"), false);
  } finally {
    release();
  }
  assert.equal(registeredSlackBotIdentities().size, 0, "a stopped bot releases everything it registered");
  assert.equal(personaBotForId("p-scout"), undefined);
  assert.equal(registeredPersonaBots().length, 0);
});

test("mentionedPersonaBots keeps mention order, drops repeats, and ignores everyone who is not a persona bot", () => {
  const release = withBots([SCOUT, CRITIC, DEFAULT_BOT]);
  try {
    assert.deepEqual(
      mentionedPersonaBots("<@UCRITIC> and <@USCOUT> — go. <@UCRITIC> again").map((b) => b.personaId),
      ["p-critic", "p-scout"],
    );
    // Humans, third-party bots and the default qm bot all match nothing.
    assert.deepEqual(
      mentionedPersonaBots("<@U1> <@UQM> <@UGITHUB> ping").map((b) => b.personaId),
      [],
    );
    // A single persona bot is not a panel; the caller keeps today's single-persona path.
    assert.equal(mentionedPersonaBots("<@USCOUT> hi").length, 1);
    // Slack's labelled mention form resolves the same way.
    assert.deepEqual(
      mentionedPersonaBots("<@USCOUT|scout> <@UCRITIC|critic>").map((b) => b.personaName),
      ["Scout", "Critic"],
    );
  } finally {
    release();
  }
});

test("a PANEL-only persona is a full roster member, and its record says the persona is panel-only", () => {
  const release = withBots([{ ...SCOUT, alwaysPersona: true }, PANEL_DEFAULT_BOT]);
  try {
    // Every panel path deliberately reads only `personaId`, so a panel-only persona joins
    // rosters exactly like a registry bot's.
    assert.deepEqual(
      mentionedPersonaBots("<@UQM> <@USCOUT> settle this").map((b) => b.personaId),
      ["p-host", "p-scout"],
      "the default bot now counts toward the two-persona threshold, in mention order",
    );
    assert.deepEqual(
      registeredPersonaBots().map((b) => b.personaId),
      ["p-scout", "p-host"],
    );
    // …and the flag is what tells a reader the two are not the same kind of binding.
    assert.equal(personaBotForId("p-scout")?.alwaysPersona, true, "a registry bot is its persona on every turn");
    assert.equal(personaBotForId("p-host")?.alwaysPersona, false, "the default bot wears its persona in panels only");
    assert.equal(personaBotForUserId("UQM")?.personaName, "Host");
  } finally {
    release();
  }
  // Unchanged for a persona-less default bot: no persona, no flag, no roster seat.
  const plain = withBots([SCOUT, DEFAULT_BOT]);
  try {
    assert.equal(personaBotForUserId("UQM")?.alwaysPersona, undefined);
    assert.deepEqual(mentionedPersonaBots("<@UQM> <@USCOUT> settle this").length, 1);
  } finally {
    plain();
  }
});

// --- the claim ---------------------------------------------------------------------------

test("two instances seeing one message produce exactly one dispatch, and the claim expires", () => {
  resetSlackPanelClaims();
  const at = 1_000_000;
  // Both bots were mentioned, so both receive the message; only the first caller dispatches.
  assert.equal(claimSlackPanel("C1", "100.1", { now: at }), true);
  assert.equal(claimSlackPanel("C1", "100.1", { now: at + 5 }), false, "the loser stands down entirely");
  // A different message in the same channel is its own panel.
  assert.equal(claimSlackPanel("C1", "100.2", { now: at + 5 }), true);
  // Same ts in another channel is a different message.
  assert.equal(claimSlackPanel("C2", "100.1", { now: at + 5 }), true);
  // Still claimed just before the TTL, swept once past it.
  assert.equal(claimSlackPanel("C1", "100.1", { now: at + 5 * 60_000 - 1 }), false);
  assert.equal(claimSlackPanel("C1", "100.1", { now: at + 5 * 60_000 }), true);
  resetSlackPanelClaims();
});

// --- mention translation, both directions ------------------------------------------------

test("inbound translation rewrites persona bots in place and leaves every other mention alone", () => {
  const release = withBots([SCOUT, CRITIC, DEFAULT_BOT]);
  try {
    const raw = "<@UCRITIC> <@USCOUT> <@U1> <@UQM> <@UGITHUB> debate <@UCRITIC|critic>";
    const out = translateInboundMentions(raw);
    assert.equal(out, "@Critic @Scout <@U1> <@UQM> <@UGITHUB> debate @Critic");

    // The whole point: core's own matcher now sees the room, in the order it was addressed.
    const members = [
      { id: "p-scout", name: "Scout", harnessId: "pi", modelId: "m" },
      { id: "p-critic", name: "Critic", harnessId: "pi", modelId: "m" },
    ];
    assert.deepEqual(
      panelAddressed(out, members).map((m) => m.id),
      ["p-critic", "p-scout"],
      "tag order in the text wins over roster order",
    );
    assert.equal(translateInboundMentions("nothing to do here"), "nothing to do here");
  } finally {
    release();
  }
});

test("outbound translation pills only running roster personas, never the speaker, on core's word boundary", () => {
  const bots = [SCOUT, CRITIC, DEFAULT_BOT];
  const say = (text: string, self?: string): string => translateOutboundMentions(text, bots, self);

  assert.equal(say("@Critic, that misses the point", "Scout"), "<@UCRITIC>, that misses the point");
  // A persona talking about itself is not inviting itself, exactly as `panelMentions` reads it.
  assert.equal(say("@Scout here — @Critic?", "Scout"), "@Scout here — <@UCRITIC>?");
  assert.deepEqual(panelMentions("@Scout here — @Critic?", ["Scout", "Critic"], "Scout"), ["Critic"]);
  // `@Scoutmaster` does not summon Scout, and neither does `@Scout-9`: core's exact rule.
  assert.equal(say("@Scoutmaster and @Critic-9 stay put", "Nobody"), "@Scoutmaster and @Critic-9 stay put");
  // Case-insensitive, every occurrence, and names with no running bot are left as text.
  assert.equal(say("@critic then @CRITIC", "Scout"), "<@UCRITIC> then <@UCRITIC>");
  assert.equal(say("@Stranger has no bot", "Scout"), "@Stranger has no bot");
  assert.equal(say("no at-signs at all", "Scout"), "no at-signs at all");
});

// --- the delivery seam -------------------------------------------------------------------

test("persona post identities round-trip and never collide with a surface identity", () => {
  assert.equal(personaIdFromIdentity(personaPostIdentity("p-scout")), "p-scout");
  assert.equal(personaIdFromIdentity("copilot"), undefined);
  assert.equal(personaIdFromIdentity(undefined), undefined);
  assert.equal(personaIdFromIdentity("persona:"), undefined);
});

const actor: Principal = { id: "internal:U1", type: "internal" };
const panelTurn = (over: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
  surface: "slack",
  deliveryTarget: "C1:100.1",
  actor,
  conversation: { kind: "channel", threadRef: "ch:C1:100.1", audience: [actor] },
  origin: { kind: "human" },
  text: "your turn",
  ...over,
});

function fakeRun(request: OrchestratorInput, reply: string): Run {
  return {
    id: "r-9",
    sessionId: "ch:C1:100.1",
    status: "done",
    request,
    result: { status: "ok", reply },
    deliveryState: null,
    dedupKey: null,
    attempts: 1,
    errorAttempts: 0,
    maxAttempts: 3,
    leaseToken: null,
    leaseExpiresAt: null,
    workerId: null,
    createdAt: 1,
    startedAt: 1,
    finishedAt: 2,
  };
}

test("a panel continuation's delivery names its author; the first turn's recovery copy does not", () => {
  const persona = { id: "p-critic", name: "Critic" };
  const continuation = runResultDelivery(
    fakeRun(panelTurn({ panel: { persona, continuation: true } }), "I disagree with @Scout"),
  );
  assert.equal(
    continuation?.destination.identity,
    "persona:p-critic",
    "the only route this reply has to Slack must carry its author",
  );

  // The first persona's reply is posted inline by the handler that submitted the turn; this
  // copy is pure recovery and keeps today's identity semantics untouched.
  const first = runResultDelivery(fakeRun(panelTurn({ panel: { persona, continuation: false } }), "opening"));
  assert.equal(first?.destination.identity, undefined);

  // Nothing outside Slack grows an identity it cannot use.
  const web = runResultDelivery(fakeRun(panelTurn({ surface: "web", panel: { persona, continuation: true } }), "hi"));
  assert.equal(web?.destination.identity, undefined);

  // An ordinary turn is byte-unchanged.
  const plain = runResultDelivery(fakeRun(panelTurn(), "hi"));
  assert.equal(plain?.destination.identity, undefined);
});

test("a persona that PASSed produces no delivery at all", () => {
  const persona = { id: "p-scout", name: "Scout" };
  assert.equal(runResultDelivery(fakeRun(panelTurn({ panel: { persona, continuation: true } }), "PASS")), null);
  assert.equal(runResultDelivery(fakeRun(panelTurn({ panel: { persona, continuation: false } }), "PASS")), null);
  // Only the exact token is a pass — a reply that merely mentions it is a real reply.
  assert.ok(runResultDelivery(fakeRun(panelTurn({ panel: { persona, continuation: true } }), "PASS is fine")));
  // Outside a panel PASS is just a word.
  assert.ok(runResultDelivery(fakeRun(panelTurn(), "PASS")));
});

test("a quiet panel turn produces no delivery however the quiet is spelled", () => {
  const persona = { id: "p-scout", name: "Scout" };
  const panel = { persona, continuation: true };
  const withResult = (result: TurnResult): Run => ({ ...fakeRun(panelTurn({ panel }), ""), result });

  // The harness emits its own trailing whitespace; the driver's matcher trims, and this must
  // match the driver exactly or the panel and the surface disagree about who was quiet.
  for (const variant of ["PASS\n", " PASS ", "PASS\r\n", "\n\tPASS\n"]) {
    assert.equal(
      runResultDelivery(fakeRun(panelTurn({ panel }), variant)),
      null,
      `PASS variant ${JSON.stringify(variant)} must not reach Slack`,
    );
  }

  // What a spine-routed Slack panel turn ACTUALLY stores: silent, and no reply field at all.
  assert.equal(runResultDelivery(withResult({ status: "silent", sessionId: "s-1" })), null);
  // Even if a silent result somehow carried text, silent means nothing was said.
  assert.equal(runResultDelivery(withResult({ status: "silent", sessionId: "s-1", reply: "PASS" })), null);
  // An ok result with no reply text is the same non-event.
  assert.equal(runResultDelivery(withResult({ status: "ok", sessionId: "s-1", reply: "   " })), null);

  // A turn that BROKE is not quiet — the failure notice still goes out.
  const failed: Run = { ...fakeRun(panelTurn({ panel }), ""), status: "failed", result: { status: "failed" } };
  assert.match(runResultDelivery(failed)?.text ?? "", /couldn't finish/);

  // A persona that uploaded a file said something, whatever its reply text was.
  const atts = [{ name: "r.csv", mimetype: "text/csv", sizeBytes: 4, blobId: "b1" }];
  assert.ok(runResultDelivery(withResult({ status: "ok", sessionId: "s-1", reply: "PASS", attachments: atts })));

  // Outside a panel none of this applies: a silent non-panel run is handled by the paths that
  // already owned it, and this guard never sees it.
  const soloSilent: Run = { ...fakeRun(panelTurn(), ""), result: { status: "silent", sessionId: "s-1" } };
  assert.equal(runResultDelivery(soloSilent), null, "a silent non-panel run was already no-delivery");
});

test("mentionsSiblingBot sees other qm bots by either id, never this bot, never a stranger", () => {
  const release = withBots([SCOUT, CRITIC, DEFAULT_BOT]);
  try {
    assert.equal(mentionsSiblingBot("<@USCOUT> hey", "UQM"), true, "the default bot sees a sibling was addressed");
    assert.equal(mentionsSiblingBot("<@USCOUT|scout> hey", "UQM"), true, "the labelled mention form too");
    assert.equal(mentionsSiblingBot("<@BCRITIC> hey", "UQM"), true, "either registered id counts");
    assert.equal(mentionsSiblingBot("<@USCOUT> hey", "USCOUT"), false, "a bot is not its own sibling");
    assert.equal(mentionsSiblingBot("<@U1> <@UGITHUB> hey", "UQM"), false, "humans and third-party bots are not qm");
    assert.equal(mentionsSiblingBot("no mentions at all", "UQM"), false);
    assert.equal(mentionsSiblingBot("<@USCOUT> and <@UQM>", "UQM"), true, "still true when this bot is named too");
  } finally {
    release();
  }
  assert.equal(mentionsSiblingBot("<@USCOUT> hey", "UQM"), false, "nothing registered, nothing to stand down for");
});

// --- the delivery poller: how every panel turn AFTER the first reaches Slack ---------------

interface PostedMessage {
  by: string;
  channel: string;
  thread_ts?: string;
  text: string;
}

function pollerFixture(deliveries: any[]) {
  const posted: PostedMessage[] = [];
  const acked: string[] = [];
  const mirrored: Array<{ ts?: string; text: string }> = [];
  const clientFor = (by: string) => ({
    chat: {
      postMessage: async (args: any) => {
        posted.push({ by, channel: args.channel, thread_ts: args.thread_ts, text: args.text });
        return { ok: true, ts: `ts-${posted.length}` };
      },
      update: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
    },
    reactions: { add: async () => ({ ok: true }) },
  });
  const primary = clientFor("primary");
  const personaClients = new Map<string, any>();
  const deps = {
    core: {
      claimDeliveries: async (type: string) => (type === "slack" ? deliveries.splice(0) : []),
      ackDelivery: async (id: string) => void acked.push(id),
    } as any,
    bridge: {
      inFlightRuns: { add() {}, delete() {}, has: (id: string) => inFlight.has(id) },
      fetchBlobFromCore: async () => Buffer.alloc(0),
      fetchFileArtifactFromCore: async () => Buffer.alloc(0),
    } as any,
    mirror: {
      mirrorSelfPost: (_c: string, ts: string | undefined, text: string) => void mirrored.push({ ts, text }),
    } as any,
    threads: { get: () => undefined, mark: () => {} } as any,
    clientForIdentity: (identity: string) => {
      const personaId = personaIdFromIdentity(identity);
      return (personaId && personaClients.get(personaId)) || primary;
    },
  };
  const inFlight = new Set<string>();
  return { deps, posted, acked, mirrored, primary, personaClients, clientFor, inFlight };
}

const panelDelivery = (over: Record<string, unknown> = {}) => ({
  id: "d-1",
  idempotencyKey: "run:r-9",
  createdAt: Date.now(),
  text: "I disagree with @Scout",
  destination: { type: "slack", target: "C1:500.1", identity: "persona:p-critic" },
  ...over,
});

test("a panel continuation is posted immediately, by its author's bot, with @Name turned into a pill", async () => {
  const { createDeliveryPoller } = await import("../src/slack/deliveries.ts");
  const release = withBots([SCOUT, CRITIC]);
  const f = pollerFixture([panelDelivery()]);
  f.personaClients.set("p-critic", f.clientFor("critic"));
  try {
    await createDeliveryPoller(f.deps).pollDeliveries(f.primary);
    assert.deepEqual(f.posted, [
      { by: "critic", channel: "C1", thread_ts: "500.1", text: "I disagree with <@USCOUT>" },
    ]);
    assert.deepEqual(f.acked, ["d-1"]);
    assert.equal(f.mirrored.length, 1, "a panel reply is this deployment's own message and is mirrored");
  } finally {
    release();
  }
});

test("the recovery grace and the in-flight pin do not hold a panel continuation back", async () => {
  const { createDeliveryPoller } = await import("../src/slack/deliveries.ts");
  const release = withBots([SCOUT, CRITIC]);
  try {
    // Freshly created (well inside the 15s recovery grace) and pinned as in-flight: both guards
    // exist to let an OWNING handler post first, and a continuation has no owner.
    const f = pollerFixture([panelDelivery({ createdAt: Date.now() })]);
    f.inFlight.add("r-9");
    f.personaClients.set("p-critic", f.clientFor("critic"));
    await createDeliveryPoller(f.deps).pollDeliveries(f.primary);
    assert.equal(f.posted.length, 1, "a continuation is not made to wait out a grace it cannot benefit from");

    // The same delivery WITHOUT a persona identity is an ordinary recovery copy and still waits.
    const g = pollerFixture([panelDelivery({ destination: { type: "slack", target: "C1:500.1" } })]);
    await createDeliveryPoller(g.deps).pollDeliveries(g.primary);
    assert.equal(g.posted.length, 0, "ordinary recovery semantics are untouched");
  } finally {
    release();
  }
});

test("a panel continuation whose bot has stopped is posted by the primary client, not dropped", async () => {
  const { createDeliveryPoller } = await import("../src/slack/deliveries.ts");
  const release = withBots([SCOUT]);
  const f = pollerFixture([panelDelivery()]);
  try {
    // No client registered for p-critic: the fallback is the poller's own (primary) client.
    await createDeliveryPoller(f.deps).pollDeliveries(f.primary);
    assert.equal(f.posted.length, 1);
    assert.equal(f.posted[0]!.by, "primary");
    assert.equal(f.posted[0]!.text, "I disagree with <@USCOUT>", "the pill is right even under the wrong bot");
  } finally {
    release();
  }
});

// --- the rounds knob ---------------------------------------------------------------------

test("QM_SLACK_PANEL_ROUNDS defaults to 1 and clamps to core's 1..ROOM_MAX_ROUNDS", () => {
  assert.equal(slackPanelRounds({}), 1);
  assert.equal(slackPanelRounds({ QM_SLACK_PANEL_ROUNDS: "" }), 1);
  assert.equal(slackPanelRounds({ QM_SLACK_PANEL_ROUNDS: "not a number" }), 1);
  assert.equal(slackPanelRounds({ QM_SLACK_PANEL_ROUNDS: "3" }), 3);
  assert.equal(slackPanelRounds({ QM_SLACK_PANEL_ROUNDS: "2.7" }), 2);
  assert.equal(slackPanelRounds({ QM_SLACK_PANEL_ROUNDS: "0" }), 1);
  assert.equal(slackPanelRounds({ QM_SLACK_PANEL_ROUNDS: "-5" }), 1);
  assert.equal(slackPanelRounds({ QM_SLACK_PANEL_ROUNDS: "999" }), ROOM_MAX_ROUNDS);
  assert.equal(slackPanelRoundsFromConfig, slackPanelRounds, "re-exported from src/config.ts");

  // Absent from the plugin config unless it was actually set, so nothing else moves.
  assert.equal(slackPluginConfigFromEnv({ SLACK_BOT_TOKEN: "xoxb", SLACK_APP_TOKEN: "xapp" })?.panelRounds, undefined);
  assert.equal(
    slackPluginConfigFromEnv({ SLACK_BOT_TOKEN: "xoxb", SLACK_APP_TOKEN: "xapp", QM_SLACK_PANEL_ROUNDS: "4" })
      ?.panelRounds,
    4,
  );
});

test("the admin setting beats QM_SLACK_PANEL_ROUNDS beats 1, and clearing it falls back", () => {
  const env3 = { QM_SLACK_PANEL_ROUNDS: "3" };

  // (a) admin > env > default.
  assert.equal(resolveSlackPanelRounds(7, env3), 7, "the admin setting wins over the env var");
  assert.equal(resolveSlackPanelRounds(7, {}), 7, "…and over the default with no env var at all");
  assert.equal(resolveSlackPanelRounds(undefined, env3), 3, "no admin setting falls back to the env var");
  assert.equal(resolveSlackPanelRounds(undefined, {}), 1, "…and then to 1");

  // null is how the admin API clears the setting; it must fall back, not become 0 or NaN.
  assert.equal(resolveSlackPanelRounds(null, env3), 3, "null clears back to the env var");
  assert.equal(resolveSlackPanelRounds(null, {}), 1, "…and with no env var, back to the default");

  // An installation record written before this field existed is exactly "no admin setting".
  const legacy = { orgId: "o", disabled: false as const } as { panelRounds?: number | null };
  assert.equal(resolveSlackPanelRounds(legacy.panelRounds, env3), 3, "a record with no panelRounds behaves as today");

  // Clamped on the way out however it got in — the route rejects out-of-range values, so this
  // only ever fires for a record written by an older or hand-edited client.
  assert.equal(resolveSlackPanelRounds(0, env3), 1);
  assert.equal(resolveSlackPanelRounds(-5, {}), 1);
  assert.equal(resolveSlackPanelRounds(999, {}), ROOM_MAX_ROUNDS);
  assert.equal(resolveSlackPanelRounds(2.7, {}), 2);
  assert.equal(resolveSlackPanelRounds(Number.NaN, env3), 3, "a corrupt value degrades to the env var, not a crash");
  assert.equal(resolveSlackPanelRounds(Number.POSITIVE_INFINITY, {}), 1);

  assert.equal(resolveSlackPanelRoundsFromConfig, resolveSlackPanelRounds, "re-exported from src/config.ts");
});

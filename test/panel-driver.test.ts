import "./support/agent-rooms-flag.ts";
import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { findRoute } from "../src/api/routes/route.ts";
import { apiRoutes } from "../src/api/routes/index.ts";
import { roomRoutes } from "../src/api/routes/rooms.ts";
import { testConfig } from "./support/test-config.ts";
import { ROOM_MAX_ROUNDS, type RoomConfig, type SessionEntry, type TurnRequest } from "../src/types.ts";
import type { AgentPersona } from "../src/agents/persona-store.ts";
import {
  PANEL_CONTINUATION_NUDGE,
  panelTurnCeiling,
  PANEL_PASS,
  isPanelPass,
  panelAddressed,
  panelMembersFrom,
  panelMentions,
  renderPanelSystemBlock,
  runPanel,
  type PanelMember,
  type PanelTurnSpec,
} from "../src/agents/panel-driver.ts";

// ---------------------------------------------------------------------------
// The loop itself: scripted replies, no harness in the way.
// ---------------------------------------------------------------------------

const ALICE: PanelMember = { id: "ap_a", name: "Alfa", harnessId: "mock", modelId: "claude-opus-4-8" };
const BRAVO: PanelMember = { id: "ap_b", name: "Bravo", harnessId: "mock", modelId: "claude-sonnet-5" };
const CHARLIE: PanelMember = { id: "ap_c", name: "Charlie", harnessId: "mock", modelId: "claude-sonnet-5" };

const fakePersona = (over: Partial<AgentPersona> = {}): AgentPersona => ({
  id: "ap_x",
  scopeId: "personal:U1",
  name: "X",
  color: "#ba9926",
  glyph: "X",
  harnessId: "mock",
  modelId: "claude-opus-4-8",
  instructions: "",
  enabled: true,
  createdBy: "U1",
  createdAt: 1,
  version: 1,
  ...over,
});

function scripted(replies: Record<string, string | string[]>) {
  const taken: PanelTurnSpec[] = [];
  const cursor = new Map<string, number>();
  const run = async (spec: PanelTurnSpec): Promise<{ reply?: string }> => {
    taken.push(spec);
    const scriptedReply = replies[spec.persona.name];
    if (scriptedReply === undefined) return { reply: `${spec.persona.name} says something` };
    if (typeof scriptedReply === "string") return { reply: scriptedReply };
    const i = cursor.get(spec.persona.name) ?? 0;
    cursor.set(spec.persona.name, i + 1);
    return { reply: scriptedReply[Math.min(i, scriptedReply.length - 1)] };
  };
  return { taken, run };
}

test("one round of a two-agent room: roster order, human text on the first turn, nudge after that", async () => {
  const s = scripted({});
  await runPanel({
    members: [ALICE, BRAVO],
    rounds: 1,
    text: "what do you two think?",
    state: { abort: false },
    run: s.run,
  });

  assert.deepEqual(
    s.taken.map((t) => t.persona.name),
    ["Alfa", "Bravo"],
  );
  assert.deepEqual(
    s.taken.map((t) => t.continuation),
    [false, true],
    "only the first turn carries the human's message; the rest are continuations",
  );
  assert.equal(s.taken[0]!.text, "what do you two think?");
  assert.equal(s.taken[1]!.text, PANEL_CONTINUATION_NUDGE);
  assert.deepEqual(
    s.taken.map((t) => t.harness),
    ["mock", "mock"],
  );
  assert.deepEqual(
    s.taken.map((t) => t.model),
    ["claude-opus-4-8", "claude-sonnet-5"],
    "each persona turn rides its own persona's runtime override",
  );
});

test("an @mention grants the mentioned agent one bonus turn in the same round", async () => {
  const s = scripted({ Alfa: "@Bravo what do you make of it?", Bravo: "nothing further" });
  await runPanel({ members: [ALICE, BRAVO], rounds: 1, text: "go", state: { abort: false }, run: s.run });

  assert.deepEqual(
    s.taken.map((t) => t.persona.name),
    ["Alfa", "Bravo", "Bravo"],
    "Bravo speaks in roster order and again on Alfa's invitation",
  );
});

test("a mention grants at most one bonus turn per agent per round, and never to itself", async () => {
  const s = scripted({ Alfa: "@Bravo and again @Bravo and also @Alfa", Bravo: "ok" });
  await runPanel({ members: [ALICE, BRAVO], rounds: 1, text: "go", state: { abort: false }, run: s.run });

  assert.deepEqual(
    s.taken.map((t) => t.persona.name),
    ["Alfa", "Bravo", "Bravo"],
    "repeat mentions dedupe and a self-mention grants nothing",
  );
});

test("a mention chain stops at the computed turn ceiling", async () => {
  const s = scripted({ Alfa: "@Bravo keep going", Bravo: "@Alfa keep going" });
  await runPanel({ members: [ALICE, BRAVO], rounds: 3, text: "go", state: { abort: false }, run: s.run });

  assert.equal(
    s.taken.length,
    panelTurnCeiling(2, 3),
    "members x rounds x 2 (one bonus turn each per round) is what ends this panel",
  );
});

test("a reply of exactly PASS grants nothing", async () => {
  const s = scripted({ Alfa: PANEL_PASS, Bravo: "fine" });
  await runPanel({ members: [ALICE, BRAVO], rounds: 1, text: "go", state: { abort: false }, run: s.run });
  assert.deepEqual(
    s.taken.map((t) => t.persona.name),
    ["Alfa", "Bravo"],
  );

  assert.equal(isPanelPass(" PASS "), true, "trimmed");
  assert.equal(isPanelPass("pass"), false, "case-sensitive");
  assert.equal(isPanelPass("PASS for now"), false);
  assert.deepEqual(panelMentions(PANEL_PASS, ["Alfa", "Bravo"], "Alfa"), []);
});

test("a round in which every agent PASSes ends the panel; the next round never runs", async () => {
  const s = scripted({ Alfa: PANEL_PASS, Bravo: PANEL_PASS });
  await runPanel({ members: [ALICE, BRAVO], rounds: 3, text: "go", state: { abort: false }, run: s.run });

  assert.deepEqual(
    s.taken.map((t) => `${t.persona.name}@${t.round}`),
    ["Alfa@1", "Bravo@1"],
    "a settled room stops after the round it settled in",
  );
});

test("a round with one PASS and one substantive reply continues to the next round", async () => {
  const s = scripted({ Alfa: PANEL_PASS, Bravo: "there is still the pricing table" });
  await runPanel({ members: [ALICE, BRAVO], rounds: 2, text: "go", state: { abort: false }, run: s.run });

  assert.deepEqual(
    s.taken.map((t) => `${t.persona.name}@${t.round}`),
    ["Alfa@1", "Bravo@1", "Alfa@2", "Bravo@2"],
    "one voice still talking keeps the room open",
  );
});

test("a mention-granted bonus turn counts as a turn of its round, and a later all-PASS round still ends the panel", async () => {
  // Round 1: Alfa invites Bravo, so Bravo takes a bonus turn — a round with a substantive
  // reply in it, which by construction can never be all-PASS. Round 2: both PASS, and the
  // panel ends there even though round 1 carried an extra turn (the tally resets per round).
  const s = scripted({
    Alfa: ["@Bravo does that match what you saw?", PANEL_PASS, "should never be reached"],
    Bravo: [PANEL_PASS, PANEL_PASS, PANEL_PASS],
  });
  await runPanel({ members: [ALICE, BRAVO], rounds: 4, text: "go", state: { abort: false }, run: s.run });

  assert.deepEqual(
    s.taken.map((t) => `${t.persona.name}@${t.round}`),
    ["Alfa@1", "Bravo@1", "Bravo@1", "Alfa@2", "Bravo@2"],
    "round 1 had a bonus turn and a substantive reply so it continued; round 2 was all-PASS and ended the panel",
  );
});

test("an all-PASS round ends the panel for an agent that only ever spoke on an invitation", async () => {
  // Charlie is invited by Alfa in round 1; in round 2 nobody has anything left, including the
  // agents that only spoke because they were mentioned.
  const s = scripted({
    Alfa: ["@Charlie your read?", PANEL_PASS],
    Bravo: [PANEL_PASS, PANEL_PASS],
    Charlie: [PANEL_PASS, PANEL_PASS, PANEL_PASS],
  });
  await runPanel({
    members: [ALICE, BRAVO, CHARLIE],
    rounds: 5,
    text: "go",
    state: { abort: false },
    run: s.run,
  });

  assert.deepEqual(
    s.taken.map((t) => `${t.persona.name}@${t.round}`),
    ["Alfa@1", "Bravo@1", "Charlie@1", "Charlie@1", "Alfa@2", "Bravo@2", "Charlie@2"],
  );
});

test("a room with rounds: 7 runs all seven rounds while the agents keep talking", async () => {
  const s = scripted({ Alfa: "still thinking out loud", Bravo: "and here is another angle" });
  await runPanel({ members: [ALICE, BRAVO], rounds: 7, text: "go", state: { abort: false }, run: s.run });

  assert.equal(s.taken.length, 14, "two agents x seven rounds, no bonus turns, no early exit");
  assert.deepEqual([...new Set(s.taken.map((t) => t.round))], [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    s.taken.map((t) => t.rounds),
    Array.from({ length: 14 }, () => 7),
    "every turn carries the panel's full budget",
  );
});

test("renderPanelSystemBlock states the round position, and says so plainly on the last round", () => {
  const speaker = fakePersona({ id: "ap_1", name: "Scout", glyph: "SC", instructions: "You are Scout." });
  const roster = [speaker, fakePersona({ id: "ap_2", name: "Critic", glyph: "CR" })];

  const mid = renderPanelSystemBlock(speaker, roster, { round: 2, rounds: 5 });
  assert.match(mid, /This is round 2 of 5\./);
  assert.doesNotMatch(mid, /final round/);

  const last = renderPanelSystemBlock(speaker, roster, { round: 5, rounds: 5 });
  assert.equal(
    last.endsWith("This is round 5 of 5 — the final round. State your conclusion; do not defer it to a later turn."),
    true,
    last,
  );

  const none = renderPanelSystemBlock(speaker, roster);
  assert.doesNotMatch(none, /round/i, "no round line at all when the driver did not supply one");
  assert.equal(renderPanelSystemBlock(speaker, roster, {}), none, "an empty opts object is the same as none");
  assert.equal(renderPanelSystemBlock(speaker, roster, { round: 2 }), none, "a half-known position says nothing");
  assert.equal(renderPanelSystemBlock(speaker, roster, { rounds: 5 }), none);
  assert.equal(
    mid.slice(0, none.length),
    none,
    "the round line is appended; every other word of the block is unchanged",
  );
});

test("mention matching is case-insensitive and respects name boundaries", () => {
  const roster = ["Alfa", "Bravo"];
  assert.deepEqual(panelMentions("hey @bravo", roster, "Alfa"), ["Bravo"]);
  assert.deepEqual(panelMentions("@Bravos are plural", roster, "Alfa"), [], "no partial-name summons");
  assert.deepEqual(panelMentions("email bravo@example.com", roster, "Alfa"), [], "an address is not a mention");
  assert.deepEqual(panelMentions("@Alfa @Bravo", roster, "Alfa"), ["Bravo"], "self-mentions are dropped");
  assert.deepEqual(panelMentions(undefined, roster, "Alfa"), []);
});

// ---------------------------------------------------------------------------
// @tagging: the human picks who answers this one message.
// ---------------------------------------------------------------------------

/** What app-turn does with a human message: tags pick the speakers, no tags means everyone. */
function speakersFor(text: string, members: readonly PanelMember[]): readonly PanelMember[] {
  const addressed = panelAddressed(text, members);
  return addressed.length ? addressed : members;
}

async function panelForHuman(text: string, members: readonly PanelMember[], replies: Record<string, string> = {}) {
  const s = scripted(replies);
  await runPanel({
    members: speakersFor(text, members),
    invitable: members,
    rounds: 1,
    text,
    state: { abort: false },
    run: s.run,
  });
  return s.taken.map((t) => t.persona.name);
}

const ROOM = [ALICE, BRAVO, CHARLIE];

test("a human message that @tags one agent is answered by that agent alone", async () => {
  assert.deepEqual(await panelForHuman("@Bravo does this pricing table read right?", ROOM), ["Bravo"]);
});

test("two @tags run exactly those two, in the order the human tagged them", async () => {
  assert.deepEqual(
    await panelForHuman("@Charlie first, then @Alfa", ROOM),
    ["Charlie", "Alfa"],
    "tag order, not roster order",
  );
  assert.deepEqual(await panelForHuman("@Alfa first, then @Charlie", ROOM), ["Alfa", "Charlie"]);
});

test("a tag for someone outside the room is ignored, and a message of only those runs the whole room", async () => {
  assert.deepEqual(await panelForHuman("@Delta and @Bravo, thoughts?", ROOM), ["Bravo"], "the stranger is dropped");
  assert.deepEqual(
    await panelForHuman("@Delta @Echo anyone?", ROOM),
    ["Alfa", "Bravo", "Charlie"],
    "no tag matched, so nobody was addressed in particular",
  );

  const live = panelMembersFrom([
    fakePersona({ id: "ap_1", name: "Awake" }),
    fakePersona({ id: "ap_2", name: "Dormant", enabled: false }),
    fakePersona({ id: "ap_3", name: "Filed", archivedAt: 2 }),
  ]);
  assert.deepEqual(panelAddressed("@Dormant @Filed you two", live), [], "a disabled or archived tag matches nothing");
  assert.deepEqual(await panelForHuman("@Dormant you two", live), ["Awake"], "and falls back to the room");
});

test("an untagged human message still runs the whole roster, in roster order", async () => {
  assert.deepEqual(panelAddressed("what do you all make of this?", ROOM), []);
  assert.deepEqual(await panelForHuman("what do you all make of this?", ROOM), ["Alfa", "Bravo", "Charlie"]);
});

test("a tagged agent can still pull an untagged room member into the round", async () => {
  assert.deepEqual(
    await panelForHuman("@Alfa take this one", ROOM, { Alfa: "@Charlie you saw this last week, no?" }),
    ["Alfa", "Charlie"],
    "the mention pool is the whole room even when only part of it was addressed",
  );
});

test("human tags are case-insensitive and respect name boundaries", () => {
  const named = (members: readonly PanelMember[]) => members.map((m) => m.name);
  assert.deepEqual(named(panelAddressed("hey @bravo", ROOM)), ["Bravo"]);
  assert.deepEqual(named(panelAddressed("@BRAVO", ROOM)), ["Bravo"]);
  assert.deepEqual(panelAddressed("@Bravos are plural", ROOM), [], "no partial-name summons");
  assert.deepEqual(panelAddressed("mail bravo@example.com", ROOM), [], "an address is not a tag");
  assert.deepEqual(panelAddressed("no tags here", ROOM), []);
  assert.deepEqual(panelAddressed(undefined, ROOM), []);

  const scout: PanelMember = { id: "ap_s", name: "Scout", harnessId: "mock", modelId: "claude-opus-4-8" };
  const master: PanelMember = { id: "ap_m", name: "Scoutmaster", harnessId: "mock", modelId: "claude-opus-4-8" };
  assert.deepEqual(named(panelAddressed("@Scoutmaster your call", [scout, master])), ["Scoutmaster"]);
  assert.deepEqual(named(panelAddressed("@Scout your call", [scout, master])), ["Scout"]);
});

test("a one-agent speaking set still has budget for the agents it invites", async () => {
  // The ceiling comes from the larger of the speaking set and the invitable pool, so a message
  // addressed to one agent of three is not capped at that one agent's own turns.
  const s = scripted({ Alfa: "@Bravo @Charlie you two should weigh in" });
  await runPanel({
    members: [ALICE],
    invitable: ROOM,
    rounds: 1,
    text: "@Alfa start us off",
    state: { abort: false },
    run: s.run,
  });
  assert.deepEqual(
    s.taken.map((t) => t.persona.name),
    ["Alfa", "Bravo", "Charlie"],
  );
  assert.equal(panelTurnCeiling(1, 1), 2, "the speaking set alone would have cut Charlie off");
});

test("the abort flag stops the queue between persona turns", async () => {
  const state = { abort: false };
  const taken: string[] = [];
  await runPanel({
    members: [ALICE, BRAVO],
    rounds: 3,
    text: "go",
    state,
    run: async (spec) => {
      taken.push(spec.persona.name);
      state.abort = true; // a new human message landed while this turn was running
      return { reply: "…" };
    },
  });
  assert.deepEqual(taken, ["Alfa"], "the running turn finishes, then the queue stops");
});

test("panelMembersFrom drops disabled, archived, and missing agents and never caps the roster", () => {
  const persona = fakePersona;
  const members = panelMembersFrom([
    persona({ id: "ap_1", name: "One" }),
    persona({ id: "ap_2", name: "Two", enabled: false }),
    persona({ id: "ap_3", name: "Three", archivedAt: 2 }),
    null,
    persona({ id: "ap_4", name: "Four" }),
  ]);
  assert.deepEqual(
    members.map((m) => m.name),
    ["One", "Four"],
  );
  assert.equal(panelMembersFrom(Array.from({ length: 9 }, () => persona({}))).length, 9);
});

// ---------------------------------------------------------------------------
// End to end through App.turn, the orchestrator, and the mock harness.
// ---------------------------------------------------------------------------

function freshApp(): BuiltApp {
  return buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qm-panel-")), harness: "mock", seedSkills: false }),
  );
}

const ACTOR = { externalId: "U1" };

function webTurn(threadRef: string, text: string): TurnRequest {
  return {
    surface: "web",
    actor: ACTOR,
    conversation: { kind: "dm", threadRef, audience: [ACTOR] },
    text,
  };
}

async function makePersona(built: BuiltApp, name: string, over: Partial<AgentPersona> = {}): Promise<AgentPersona> {
  const persona = await built.personas.create({
    scopeId: "personal:U1",
    name,
    color: "#ba9926",
    glyph: name.slice(0, 2).toUpperCase(),
    harnessId: "mock",
    modelId: "claude-opus-4-8",
    instructions: `You are ${name}. Answer in one line.`,
    createdBy: "U1",
  });
  if (over.enabled === false) await built.personas.update(persona.id, { enabled: false });
  return persona;
}

/** Opens the conversation with an ordinary turn so a session exists to hang a room off. */
async function openRoom(built: BuiltApp, threadRef: string, room: (ids: string[]) => RoomConfig, names: string[]) {
  await built.app.turn(webTurn(threadRef, "hello"));
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);
  const personas = [];
  for (const name of names) personas.push(await makePersona(built, name));
  await built.sessions.setRoom(session.id, room(personas.map((p) => p.id)));
  return { session, personas };
}

const personaOf = (e: SessionEntry): { id: string; name: string } | undefined =>
  (e.payload as { persona?: { id: string; name: string } } | null)?.persona;

test("a human message into a two-agent room runs exactly two persona turns, attributed, with one user entry", async () => {
  const built = freshApp();
  const threadRef = "web:U1:room-1";
  const { session, personas } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 1 }), [
    "Scout",
    "Critic",
  ]);

  const before = await built.sessions.getEntries(session.id);
  const result = await built.app.turn(webTurn(threadRef, "what is wrong with the pricing page?"));
  assert.notEqual(result.status, "refused", result.reason);

  const added = (await built.sessions.getEntries(session.id)).filter((e) => e.seq > (before.at(-1)?.seq ?? -1));
  const users = added.filter((e) => e.type === "user");
  const assistants = added.filter((e) => e.type === "assistant");

  assert.equal(users.length, 1, "the human message is written once, by the first persona's turn");
  assert.equal(
    (users[0]!.payload as { text?: string }).text,
    "what is wrong with the pricing page?",
    "and it is the human's text, never the driver's nudge",
  );
  assert.equal(assistants.length, 2, "one reply per persona for rounds=1");
  assert.deepEqual(
    assistants.map((e) => personaOf(e)?.name),
    ["Scout", "Critic"],
  );
  assert.deepEqual(
    assistants.map((e) => personaOf(e)?.id),
    personas.map((p) => p.id),
  );

  const nudges = users.filter((e) =>
    String((e.payload as { text?: string }).text ?? "").includes("your turn to speak"),
  );
  assert.equal(nudges.length, 0, "the continuation nudge never lands in the transcript as a user message");
});

test("a human message that @tags one agent of a two-agent room is answered by that agent alone", async () => {
  const built = freshApp();
  const threadRef = "web:U1:room-tagged";
  const { session, personas } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 1 }), [
    "Scout",
    "Critic",
  ]);

  const before = await built.sessions.getEntries(session.id);
  const result = await built.app.turn(webTurn(threadRef, "@Critic what is wrong with the pricing page?"));
  assert.notEqual(result.status, "refused", result.reason);

  const added = (await built.sessions.getEntries(session.id)).filter((e) => e.seq > (before.at(-1)?.seq ?? -1));
  const users = added.filter((e) => e.type === "user");
  const assistants = added.filter((e) => e.type === "assistant");

  assert.equal(users.length, 1, "still one user entry for the human's message");
  assert.equal(
    (users[0]!.payload as { text?: string }).text,
    "@Critic what is wrong with the pricing page?",
    "and it keeps the tag the human typed",
  );
  assert.equal(assistants.length, 1, "only the tagged agent took a turn");
  assert.deepEqual(
    assistants.map((e) => personaOf(e)?.name),
    ["Critic"],
  );
  assert.equal(personaOf(assistants[0]!)?.id, personas[1]!.id);

  assert.deepEqual(
    (await built.sessions.get(session.id))!.room,
    { personaIds: personas.map((p) => p.id), rounds: 1 },
    "tagging is per message; the stored roster is untouched",
  );

  const untagged = await built.app.turn(webTurn(threadRef, "and both of you on the copy?"));
  assert.notEqual(untagged.status, "refused", untagged.reason);
  const laterAssistants = (await built.sessions.getEntries(session.id))
    .filter((e) => e.seq > (added.at(-1)?.seq ?? -1))
    .filter((e) => e.type === "assistant");
  assert.deepEqual(
    laterAssistants.map((e) => personaOf(e)?.name),
    ["Scout", "Critic"],
    "the next untagged message runs the whole room again",
  );
});

const lastSeq = async (built: BuiltApp, sessionId: string) =>
  (await built.sessions.getEntries(sessionId)).at(-1)?.seq ?? -1;

const addedSince = async (built: BuiltApp, sessionId: string, seq: number) =>
  (await built.sessions.getEntries(sessionId)).filter((e) => e.seq > seq);

const ofType = (entries: readonly SessionEntry[], type: SessionEntry["type"]) => entries.filter((e) => e.type === type);

// ---------------------------------------------------------------------------
// @tag-to-join: tagging a visible agent the room does not hold adds it to the room.
// ---------------------------------------------------------------------------

/** Assistant entries added to `sessionId` after `seq`, in order, by persona name. */
const spokeSince = async (built: BuiltApp, sessionId: string, seq: number) =>
  (await addedSince(built, sessionId, seq)).filter((e) => e.type === "assistant").map((e) => personaOf(e)?.name);

const roomOf = async (built: BuiltApp, sessionId: string) => (await built.sessions.get(sessionId))!.room;

test("an @tag for a visible agent outside the room adds it to the room and it answers that message", async () => {
  const built = freshApp();
  const threadRef = "web:U1:join-1";
  const { session, personas } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 1 }), [
    "Scout",
    "Critic",
  ]);
  const nomad = await makePersona(built, "Nomad");
  assert.deepEqual(
    (await roomOf(built, session.id))!.personaIds,
    personas.map((p) => p.id),
    "Nomad starts outside the room",
  );

  const before = await lastSeq(built, session.id);
  const result = await built.app.turn(webTurn(threadRef, "@Nomad take a look at the pricing page"));
  assert.notEqual(result.status, "refused", result.reason);

  assert.deepEqual(
    await roomOf(built, session.id),
    { personaIds: [...personas.map((p) => p.id), nomad.id], rounds: 1 },
    "the tag added Nomad to the stored roster, appended after the members already there",
  );
  assert.deepEqual(await spokeSince(built, session.id, before), ["Nomad"], "and it spoke on the message that added it");
});

test("a joiner speaks in tag order alongside an existing member when both are tagged", async () => {
  // `!think ...` is the mock harness's fixed-reply command. Without it the mock echoes the
  // human's text back, and the echoed tags would hand out mention-granted bonus turns —
  // real driver behaviour, but noise that has nothing to do with tag ORDER. Each order gets
  // its own app because persona names are unique per scope.
  for (const [thread, text, order] of [
    ["web:U1:join-order-a", "!think @Nomad first, then @Critic", ["Nomad", "Critic"]],
    ["web:U1:join-order-b", "!think @Critic first, then @Nomad", ["Critic", "Nomad"]],
  ] as const) {
    const built = freshApp();
    const { session, personas } = await openRoom(built, thread, (ids) => ({ personaIds: ids, rounds: 1 }), [
      "Scout",
      "Critic",
    ]);
    const nomad = await makePersona(built, "Nomad");

    const before = await lastSeq(built, session.id);
    const result = await built.app.turn(webTurn(thread, text));
    assert.notEqual(result.status, "refused", result.reason);

    assert.deepEqual(await spokeSince(built, session.id, before), [...order], `tag order, not roster order: ${text}`);
    assert.deepEqual(
      (await roomOf(built, session.id))!.personaIds,
      [...personas.map((p) => p.id), nomad.id],
      "and the joiner lands at the end of the roster however early it was tagged",
    );
  }
});

test("a tag for an agent that is invisible, disabled, or archived joins nobody and changes nothing", async () => {
  const built = freshApp();
  const threadRef = "web:U1:join-2";
  const { session, personas } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 1 }), [
    "Scout",
    "Critic",
  ]);
  const stored = { personaIds: personas.map((p) => p.id), rounds: 1 };

  const dormant = await makePersona(built, "Dormant");
  await built.personas.update(dormant.id, { enabled: false });
  const filed = await makePersona(built, "Filed");
  await built.personas.archive(filed.id);
  // Another principal's personal scope: real, enabled, and none of U1's business.
  await built.personas.create({
    scopeId: "personal:U2",
    name: "Hidden",
    color: "#ba9926",
    glyph: "HI",
    harnessId: "mock",
    modelId: "claude-opus-4-8",
    instructions: "You are Hidden.",
    createdBy: "U2",
  });

  for (const text of ["@Nobody anyone?", "@Dormant anyone?", "@Filed anyone?", "@Hidden anyone?"]) {
    const before = await lastSeq(built, session.id);
    const result = await built.app.turn(webTurn(threadRef, text));
    assert.notEqual(result.status, "refused", result.reason);
    assert.deepEqual(await roomOf(built, session.id), stored, `the roster is untouched by "${text}"`);
    assert.deepEqual(
      await spokeSince(built, session.id, before),
      ["Scout", "Critic"],
      `no tag matched, so "${text}" runs the whole room exactly as it does today`,
    );
  }
});

test("tagging an agent already in the room does not duplicate it in personaIds", async () => {
  const built = freshApp();
  const threadRef = "web:U1:join-3";
  const { session, personas } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 1 }), [
    "Scout",
    "Critic",
  ]);

  const before = await lastSeq(built, session.id);
  const result = await built.app.turn(webTurn(threadRef, "@Critic and again @Critic"));
  assert.notEqual(result.status, "refused", result.reason);

  assert.deepEqual(
    await roomOf(built, session.id),
    { personaIds: personas.map((p) => p.id), rounds: 1 },
    "a member is not re-added, and the roster keeps its length",
  );
  assert.deepEqual(await spokeSince(built, session.id, before), ["Critic"], "and it is still an ordinary tag");
});

test("a roster enlarged by a tag persists: the next untagged message runs the whole enlarged room", async () => {
  const built = freshApp();
  const threadRef = "web:U1:join-4";
  const { session, personas } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 1 }), [
    "Scout",
    "Critic",
  ]);
  const nomad = await makePersona(built, "Nomad");

  assert.notEqual((await built.app.turn(webTurn(threadRef, "@Nomad you should see this"))).status, "refused");

  const before = await lastSeq(built, session.id);
  const followUp = await built.app.turn(webTurn(threadRef, "so what do you all make of it?"));
  assert.notEqual(followUp.status, "refused", followUp.reason);

  assert.deepEqual(
    await spokeSince(built, session.id, before),
    ["Scout", "Critic", "Nomad"],
    "the join outlived the message that made it; the room is three agents now",
  );
  assert.deepEqual((await roomOf(built, session.id))!.personaIds, [...personas.map((p) => p.id), nomad.id]);
});

test("a conversation with no room is untouched by a message containing an @tag", async () => {
  const built = freshApp();
  const threadRef = "web:U1:join-plain";
  await built.app.turn(webTurn(threadRef, "hello"));
  const session = (await built.sessions.getByThread(threadRef))!;
  await makePersona(built, "Nomad");

  const before = await lastSeq(built, session.id);
  const result = await built.app.turn(webTurn(threadRef, "@Nomad are you there?"));
  assert.notEqual(result.status, "refused", result.reason);

  const assistants = ofType(await addedSince(built, session.id, before), "assistant");
  assert.equal(assistants.length, 1, "one plain turn, not a panel");
  assert.equal(personaOf(assistants[0]!), undefined, "and it is unattributed");
  assert.equal(await roomOf(built, session.id), undefined, "a tag never conjures a room out of nothing");
});

test("a two-round room tells each persona turn where in the panel it is", async () => {
  const built = freshApp();
  const threadRef = "web:U1:room-rounds";
  const { session } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 2 }), ["Scout", "Critic"]);

  const before = await built.runs.list();
  const result = await built.app.turn(webTurn(threadRef, "two rounds on this, please"));
  assert.notEqual(result.status, "refused", result.reason);

  const seen = new Set(before.map((r) => r.id));
  const panelRuns = (await built.runs.list())
    .filter((r) => !seen.has(r.id) && r.sessionId === threadRef && r.request.panel)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  assert.deepEqual(
    panelRuns.map((r) => `${r.request.panel!.persona.name}@${r.request.panel!.round}/${r.request.panel!.rounds}`),
    ["Scout@1/2", "Critic@1/2", "Scout@2/2", "Critic@2/2"],
    "every persona turn carries its round position and the panel's budget",
  );
  assert.equal(
    (await built.sessions.getEntries(session.id)).filter((e) => e.type === "assistant" && personaOf(e)).length,
    4,
  );
});

// ---------------------------------------------------------------------------
// Threading: a panel's replies hang off the human message that started it.
// ---------------------------------------------------------------------------

test("a one-round room threads both replies under the human message that opened the panel", async () => {
  const built = freshApp();
  const threadRef = "web:U1:thread-1";
  const { session } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 1 }), ["Scout", "Critic"]);

  const before = await lastSeq(built, session.id);
  const result = await built.app.turn(webTurn(threadRef, "what is wrong with the pricing page?"));
  assert.notEqual(result.status, "refused", result.reason);

  const added = await addedSince(built, session.id, before);
  const users = ofType(added, "user");
  const assistants = ofType(added, "assistant");
  assert.equal(users.length, 1, "one human message");
  assert.equal(assistants.length, 2, "one reply per persona");
  assert.deepEqual(
    assistants.map((e) => e.parentSeq),
    [users[0]!.seq, users[0]!.seq],
    "both replies point at the human message, not at each other",
  );
});

test("a two-round room threads all four replies under the one human message, not under each other", async () => {
  const built = freshApp();
  const threadRef = "web:U1:thread-2";
  const { session } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 2 }), ["Scout", "Critic"]);

  const before = await lastSeq(built, session.id);
  const result = await built.app.turn(webTurn(threadRef, "two rounds on this, please"));
  assert.notEqual(result.status, "refused", result.reason);

  const added = await addedSince(built, session.id, before);
  const users = ofType(added, "user");
  const assistants = ofType(added, "assistant");
  assert.equal(users.length, 1, "continuation turns still write no user entry");
  assert.equal(assistants.length, 4, "two personas over two rounds");
  assert.deepEqual(
    assistants.map((e) => e.parentSeq),
    Array(4).fill(users[0]!.seq),
    "the whole panel is one thread hanging off one message",
  );
  const assistantSeqs = new Set(assistants.map((e) => e.seq));
  assert.ok(
    assistants.every((e) => !assistantSeqs.has(e.parentSeq as number)),
    "no reply is parented to another reply",
  );
});

test("a second human message opens a second thread; the first one is not extended", async () => {
  const built = freshApp();
  const threadRef = "web:U1:thread-3";
  const { session } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 1 }), ["Scout", "Critic"]);

  const beforeFirst = await lastSeq(built, session.id);
  assert.notEqual((await built.app.turn(webTurn(threadRef, "first question"))).status, "refused");
  const first = await addedSince(built, session.id, beforeFirst);

  const beforeSecond = await lastSeq(built, session.id);
  assert.notEqual((await built.app.turn(webTurn(threadRef, "second question"))).status, "refused");
  const second = await addedSince(built, session.id, beforeSecond);

  const firstUser = ofType(first, "user")[0]!;
  const secondUser = ofType(second, "user")[0]!;
  assert.notEqual(firstUser.seq, secondUser.seq);
  assert.deepEqual(
    ofType(first, "assistant").map((e) => e.parentSeq),
    [firstUser.seq, firstUser.seq],
  );
  assert.deepEqual(
    ofType(second, "assistant").map((e) => e.parentSeq),
    [secondUser.seq, secondUser.seq],
    "the second panel threads under the second message, never under the first",
  );
});

test("an @tagged single-agent message threads the same way", async () => {
  const built = freshApp();
  const threadRef = "web:U1:thread-4";
  const { session } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 1 }), ["Scout", "Critic"]);

  const before = await lastSeq(built, session.id);
  const result = await built.app.turn(webTurn(threadRef, "@Critic what is wrong with the pricing page?"));
  assert.notEqual(result.status, "refused", result.reason);

  const added = await addedSince(built, session.id, before);
  const users = ofType(added, "user");
  const assistants = ofType(added, "assistant");
  assert.equal(assistants.length, 1, "only the tagged agent spoke");
  assert.equal(personaOf(assistants[0]!)?.name, "Critic");
  assert.equal(assistants[0]!.parentSeq, users[0]!.seq, "and its reply hangs off the human message");
});

test("a conversation with no room keeps the linear parent chain it has today", async () => {
  const built = freshApp();
  const threadRef = "web:U1:thread-plain";

  // Control: no room anywhere in this session. `!preamble` makes the mock harness emit a
  // tool_call/tool_result pair before the reply, so the linear chain and a thread parent
  // are genuinely different numbers here.
  await built.app.turn(webTurn(threadRef, "hello"));
  const session = (await built.sessions.getByThread(threadRef))!;
  const before = await lastSeq(built, session.id);
  assert.notEqual((await built.app.turn(webTurn(threadRef, "!preamble looking now"))).status, "refused");

  const added = await addedSince(built, session.id, before);
  const user = ofType(added, "user")[0]!;
  const assistants = ofType(added, "assistant");
  assert.ok(assistants.length >= 1, "the plain turn still replies");
  assert.ok(ofType(added, "tool_call").length >= 1, "and it used a tool on the way");
  for (const entry of added) {
    assert.equal(entry.parentSeq, entry.seq - 1, `entry ${entry.seq} (${entry.type}) keeps the linear parent`);
  }
  assert.notEqual(
    assistants.at(-1)!.parentSeq,
    user.seq,
    "which is emphatically not the threaded parent a room would have stamped",
  );
});

test("a room whose agents are all disabled falls back to a single ordinary turn", async () => {
  const built = freshApp();
  const threadRef = "web:U1:room-2";
  await built.app.turn(webTurn(threadRef, "hello"));
  const session = (await built.sessions.getByThread(threadRef))!;
  const off = await makePersona(built, "Dormant");
  await built.personas.update(off.id, { enabled: false });
  await built.sessions.setRoom(session.id, { personaIds: [off.id], rounds: 2 });

  const before = await built.sessions.getEntries(session.id);
  await built.app.turn(webTurn(threadRef, "anyone home?"));
  const added = (await built.sessions.getEntries(session.id)).filter((e) => e.seq > (before.at(-1)?.seq ?? -1));

  assert.equal(added.filter((e) => e.type === "user").length, 1);
  const assistants = added.filter((e) => e.type === "assistant");
  assert.equal(assistants.length, 1, "one plain turn, not a panel");
  assert.equal(personaOf(assistants[0]!), undefined, "and it is unattributed, exactly like today");
});

test("with the flag off a room is inert: the turn behaves exactly as it does without one", async () => {
  const built = freshApp();
  const threadRef = "web:U1:room-3";
  const { session } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 2 }), [
    "Watcher",
    "Waiter",
  ]);

  const before = await built.sessions.getEntries(session.id);
  process.env.QM_AGENT_ROOMS = "0";
  try {
    await built.app.turn(webTurn(threadRef, "flag is off"));
  } finally {
    process.env.QM_AGENT_ROOMS = "1";
  }
  const added = (await built.sessions.getEntries(session.id)).filter((e) => e.seq > (before.at(-1)?.seq ?? -1));

  assert.equal(added.filter((e) => e.type === "user").length, 1);
  const assistants = added.filter((e) => e.type === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(personaOf(assistants[0]!), undefined);
});

test("PUT /v1/sessions/:id/room validates the roster and round-trips through the session store", async () => {
  const built = freshApp();
  const server = createInsecureTestServer(built.app, { config: built.config, harnessId: "mock" });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const threadRef = "web:U1:room-4";
  try {
    assert.deepEqual(roomRoutes({}), [], "the route does not exist with the flag off");
    assert.ok(findRoute(roomRoutes({ QM_AGENT_ROOMS: "1" }), "PUT", "/v1/sessions/s1/room"));
    assert.ok(findRoute(apiRoutes, "PUT", "/v1/sessions/s1/room"), "and it is live in this process");

    await built.app.turn(webTurn(threadRef, "hello"));
    const session = (await built.sessions.getByThread(threadRef))!;
    const scout = await makePersona(built, "Scout");
    const critic = await makePersona(built, "Critic");
    const dormant = await makePersona(built, "Dormant");
    await built.personas.update(dormant.id, { enabled: false });

    const put = (room: unknown) =>
      fetch(`${base}/v1/sessions/${session.id}/room`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principalId: "U1", room }),
      });

    const ok = await put({ personaIds: [scout.id, critic.id], rounds: 2 });
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as { session: { room: RoomConfig } }).session.room, {
      personaIds: [scout.id, critic.id],
      rounds: 2,
    });
    assert.deepEqual((await built.sessions.get(session.id))!.room, {
      personaIds: [scout.id, critic.id],
      rounds: 2,
    });

    for (const [label, room] of [
      ["too many agents", { personaIds: [scout.id, critic.id, scout.id, critic.id, scout.id], rounds: 1 }],
      ["no agents", { personaIds: [], rounds: 1 }],
      ["duplicate agents", { personaIds: [scout.id, scout.id], rounds: 1 }],
      ["zero rounds", { personaIds: [scout.id], rounds: 0 }],
      ["fractional rounds", { personaIds: [scout.id], rounds: 3.5 }],
      ["negative rounds", { personaIds: [scout.id], rounds: -1 }],
      ["over the ceiling", { personaIds: [scout.id], rounds: ROOM_MAX_ROUNDS + 1 }],
      ["unknown agent", { personaIds: ["ap_nope"], rounds: 1 }],
      ["disabled agent", { personaIds: [dormant.id], rounds: 1 }],
    ] as const) {
      assert.equal((await put(room)).status, 400, label);
    }

    assert.equal(ROOM_MAX_ROUNDS, 20, "the documented ceiling");
    for (const rounds of [1, ROOM_MAX_ROUNDS]) {
      const accepted = await put({ personaIds: [scout.id], rounds });
      assert.equal(accepted.status, 200, `rounds: ${rounds} is in range`);
      assert.equal((await built.sessions.get(session.id))!.room!.rounds, rounds, "and it round-trips");
    }

    assert.equal((await put(null)).status, 200);
    assert.equal((await built.sessions.get(session.id))!.room, undefined, "room: null clears the roster");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a session with no room is untouched by the driver", async () => {
  const built = freshApp();
  const threadRef = "web:U1:plain";
  await built.app.turn(webTurn(threadRef, "hello"));
  const session = (await built.sessions.getByThread(threadRef))!;
  assert.equal(session.room, undefined);

  const before = await built.sessions.getEntries(session.id);
  await built.app.turn(webTurn(threadRef, "still just me"));
  const added = (await built.sessions.getEntries(session.id)).filter((e) => e.seq > (before.at(-1)?.seq ?? -1));
  assert.equal(added.filter((e) => e.type === "assistant").length, 1);
  assert.equal(personaOf(added.find((e) => e.type === "assistant")!), undefined);
});

test("a first message carrying room config panels immediately and persists the roster", async () => {
  const built = freshApp();
  const threadRef = "web:U1:room-first-msg";
  const scout = await makePersona(built, "Scout");
  const critic = await makePersona(built, "Critic");

  const result = await built.app.turn({
    ...webTurn(threadRef, "kick it around, you two"),
    room: { personaIds: [scout.id, critic.id], rounds: 1 },
  });
  assert.notEqual(result.status, "refused", result.reason);

  const session = (await built.sessions.getByThread(threadRef))!;
  assert.ok(session, "the first persona turn created the session");
  assert.deepEqual(
    session.room,
    { personaIds: [scout.id, critic.id], rounds: 1 },
    "the request-borne roster was persisted onto the session",
  );

  const entries = await built.sessions.getEntries(session.id);
  const users = entries.filter((e) => e.type === "user");
  const assistants = entries.filter((e) => e.type === "assistant");
  assert.equal(users.length, 1, "one user entry for the human's message");
  assert.equal(assistants.length, 2, "both personas spoke on the very first message");
  assert.deepEqual(
    assistants.map((e) => personaOf(e)?.name),
    ["Scout", "Critic"],
  );

  const followup = await built.app.turn(webTurn(threadRef, "and round two?"));
  assert.notEqual(followup.status, "refused", followup.reason);
  const after = await built.sessions.getEntries(session.id);
  assert.equal(
    after.filter((e) => e.type === "assistant").length,
    4,
    "the persisted roster panels later messages without the request carrying room again",
  );
});

test("an invalid request-borne room is refused, not silently degraded", async () => {
  const built = freshApp();
  const scout = await makePersona(built, "Scout");

  const unknown = await built.app.turn({
    ...webTurn("web:U1:room-bad-1", "hi"),
    room: { personaIds: [scout.id, "ap_nope"], rounds: 1 },
  });
  assert.equal(unknown.status, "refused");
  assert.match(unknown.reason ?? "", /unknown agent/);

  let seq = 0;
  for (const rounds of [0, 3.5, -1, ROOM_MAX_ROUNDS + 1]) {
    const badRounds = await built.app.turn({
      ...webTurn(`web:U1:room-bad-2-${(seq += 1)}`, "hi"),
      room: { personaIds: [scout.id], rounds },
    });
    assert.equal(badRounds.status, "refused", `rounds: ${rounds}`);
    assert.match(badRounds.reason ?? "", /room\.rounds must be 1-20/);
  }

  const wide = await built.app.turn({
    ...webTurn("web:U1:room-wide", "hi"),
    room: { personaIds: [scout.id], rounds: ROOM_MAX_ROUNDS },
  });
  assert.notEqual(wide.status, "refused", wide.reason);
  assert.equal(
    (await built.sessions.getByThread("web:U1:room-wide"))!.room!.rounds,
    ROOM_MAX_ROUNDS,
    "the ceiling itself is a legal room",
  );

  assert.equal(
    await built.sessions.getByThread("web:U1:room-bad-1"),
    null,
    "a refused first message creates no session",
  );
});

test("a PASS reply never reaches the transcript — it is a signal, not something anyone said", async () => {
  const built = freshApp();
  const threadRef = "web:U1:room-pass";
  const { session } = await openRoom(built, threadRef, (ids) => ({ personaIds: ids, rounds: 1 }), ["Quiet", "Talker"]);

  // The mock harness echoes the turn input, so a room whose agents are told to reply PASS
  // gives us a real PASS-shaped turn through the whole emit path.
  const before = await built.sessions.getEntries(session.id);
  await built.app.turn(webTurn(threadRef, PANEL_PASS));
  const added = (await built.sessions.getEntries(session.id)).filter((e) => e.seq > (before.at(-1)?.seq ?? -1));

  const assistantTexts = added
    .filter((e) => e.type === "assistant")
    .map((e) => String((e.payload as { text?: string }).text ?? "").trim());
  assert.equal(
    assistantTexts.some((t) => t === PANEL_PASS),
    false,
    "no stored assistant entry is the bare word PASS",
  );
});

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
import type { RoomConfig, SessionEntry, TurnRequest } from "../src/types.ts";
import type { AgentPersona } from "../src/agents/persona-store.ts";
import {
  PANEL_CONTINUATION_NUDGE,
  panelTurnCeiling,
  PANEL_PASS,
  isPanelPass,
  panelMembersFrom,
  panelMentions,
  runPanel,
  type PanelMember,
  type PanelTurnSpec,
} from "../src/agents/panel-driver.ts";

// ---------------------------------------------------------------------------
// The loop itself: scripted replies, no harness in the way.
// ---------------------------------------------------------------------------

const ALICE: PanelMember = { id: "ap_a", name: "Alfa", harnessId: "mock", modelId: "claude-opus-4-8" };
const BRAVO: PanelMember = { id: "ap_b", name: "Bravo", harnessId: "mock", modelId: "claude-sonnet-5" };

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

test("mention matching is case-insensitive and respects name boundaries", () => {
  const roster = ["Alfa", "Bravo"];
  assert.deepEqual(panelMentions("hey @bravo", roster, "Alfa"), ["Bravo"]);
  assert.deepEqual(panelMentions("@Bravos are plural", roster, "Alfa"), [], "no partial-name summons");
  assert.deepEqual(panelMentions("email bravo@example.com", roster, "Alfa"), [], "an address is not a mention");
  assert.deepEqual(panelMentions("@Alfa @Bravo", roster, "Alfa"), ["Bravo"], "self-mentions are dropped");
  assert.deepEqual(panelMentions(undefined, roster, "Alfa"), []);
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
  const persona = (over: Partial<AgentPersona>): AgentPersona => ({
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
      ["out-of-range rounds", { personaIds: [scout.id], rounds: 4 }],
      ["unknown agent", { personaIds: ["ap_nope"], rounds: 1 }],
      ["disabled agent", { personaIds: [dormant.id], rounds: 1 }],
    ] as const) {
      assert.equal((await put(room)).status, 400, label);
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

  const badRounds = await built.app.turn({
    ...webTurn("web:U1:room-bad-2", "hi"),
    room: { personaIds: [scout.id], rounds: 9 },
  });
  assert.equal(badRounds.status, "refused");
  assert.match(badRounds.reason ?? "", /rounds/);

  assert.equal(
    await built.sessions.getByThread("web:U1:room-bad-1"),
    null,
    "a refused first message creates no session",
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ApiError,
  entriesToMessages,
  personaFromPayload,
  refusalReason,
  type AssistantWork,
  type SessionEntry,
} from "../src/core-bridge.ts";
import {
  cachePersonas,
  clearPersonaCache,
  holdPendingRoom,
  isRoomThread,
  MAX_ROOM_PERSONAS,
  noteRoom,
  pendingRoomFor,
  clearPendingRoom,
  clearRoomRefusal,
  noteRoomRefusal,
  personaChipFor,
  personaRowKey,
  resetRoomState,
  roomConfigError,
  roomFor,
  roomRefusalFor,
  toggleRosterMember,
} from "../src/room-state.ts";
import type { AgentItem } from "../src/agent-registry.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Parameters<
  typeof entriesToMessages
>[1];

function makeAgent(id: string, name: string, over: Partial<AgentItem> = {}): AgentItem {
  return {
    id,
    name,
    color: "#2563eb",
    glyph: "SC",
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
    instructions: "",
    enabled: true,
    scope: "personal",
    scopeId: "personal:alice",
    createdBy: "alice",
    createdAt: 1,
    version: 1,
    editable: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Roster rules
// ---------------------------------------------------------------------------

test("a roster holds 1-4 unique agents over 1-3 rounds", () => {
  assert.equal(roomConfigError({ personaIds: ["a"], rounds: 1 }), null);
  assert.equal(roomConfigError({ personaIds: ["a", "b", "c", "d"], rounds: 3 }), null);
  assert.ok(roomConfigError({ personaIds: [], rounds: 1 }), "an empty roster is not a room");
  assert.ok(roomConfigError({ personaIds: ["a", "b", "c", "d", "e"], rounds: 1 }), "past the cap");
  assert.ok(roomConfigError({ personaIds: ["a", "a"], rounds: 1 }), "an agent cannot be in a room twice");
  assert.ok(roomConfigError({ personaIds: ["a"], rounds: 0 }));
  assert.ok(roomConfigError({ personaIds: ["a"], rounds: 4 }));
});

test("toggling roster membership preserves order and refuses to grow past the cap", () => {
  let ids: string[] = [];
  for (const id of ["a", "b", "c", "d"]) ids = toggleRosterMember(ids, id);
  assert.deepEqual(ids, ["a", "b", "c", "d"], "picks keep the order they were made in");
  assert.deepEqual(toggleRosterMember(ids, "e"), ids, `a fifth pick is refused at ${MAX_ROOM_PERSONAS}`);
  assert.deepEqual(toggleRosterMember(ids, "b"), ["a", "c", "d"], "deselecting always works, full or not");
});

// ---------------------------------------------------------------------------
// Persona identity
// ---------------------------------------------------------------------------

test("a cached persona supplies the colour and glyph the chip needs", () => {
  resetRoomState();
  cachePersonas([makeAgent("ap_1", "Scout", { color: "#c2410c", glyph: "🔭" })]);
  assert.deepEqual(personaChipFor({ id: "ap_1", name: "Scout" }), {
    id: "ap_1",
    name: "Scout",
    color: "#c2410c",
    glyph: "🔭",
  });
});

test("an archived persona still gets a chip — the name from the entry, no colour invented", () => {
  resetRoomState();
  const chip = personaChipFor({ id: "ap_gone", name: "Critic" });
  assert.deepEqual(chip, { id: "ap_gone", name: "Critic" });
  assert.equal(chip?.color, undefined, "an unknown id must not borrow another persona's colour");
});

test("no persona means no chip, which is how every non-room message renders", () => {
  resetRoomState();
  assert.equal(personaChipFor(undefined), null);
  assert.equal(personaChipFor(null), null);
  assert.equal(personaChipFor({ id: "", name: "Scout" }), null);
  assert.equal(personaRowKey(undefined), "");
});

test("the row key changes when the cache fills in, so a memoised label cannot go stale", () => {
  resetRoomState();
  const persona = { id: "ap_1", name: "Scout" };
  const beforeCache = personaRowKey(persona);
  cachePersonas([makeAgent("ap_1", "Scout", { color: "#15803d", glyph: "SC" })]);
  const afterCache = personaRowKey(persona);
  assert.notEqual(beforeCache, afterCache, "colour/glyph arriving must invalidate the settled-row cache");
  clearPersonaCache();
  assert.equal(personaRowKey(persona), beforeCache);
});

// ---------------------------------------------------------------------------
// Pending vs applied rooms
// ---------------------------------------------------------------------------

test("a roster picked before the session exists is held against the thread and marks it a room", () => {
  resetRoomState();
  const config = { personaIds: ["ap_1", "ap_2"], rounds: 2 as const };
  holdPendingRoom("web:alice:t1", config);
  assert.deepEqual(pendingRoomFor("web:alice:t1"), config, "held until a session id exists");
  assert.equal(isRoomThread("web:alice:t1"), true, "the composer must already treat it as a room");
  clearPendingRoom("web:alice:t1");
  assert.equal(pendingRoomFor("web:alice:t1"), null, "applied once, never re-sent");
  assert.equal(isRoomThread("web:alice:t1"), true, "…but the thread is still a room");
});

test("a session read is what tells an unseen thread it is (or is not) a room", () => {
  resetRoomState();
  assert.equal(isRoomThread("web:alice:t2"), false);
  noteRoom("web:alice:t2", { personaIds: ["ap_1"], rounds: 1 });
  assert.deepEqual(roomFor("web:alice:t2"), { personaIds: ["ap_1"], rounds: 1 });
  noteRoom("web:alice:t2", null);
  assert.equal(isRoomThread("web:alice:t2"), false, "a cleared roster stops being a room");
});

test("a session read that has not caught up yet cannot drop a roster still awaiting apply", () => {
  resetRoomState();
  holdPendingRoom("web:alice:t3", { personaIds: ["ap_1"], rounds: 1 });
  noteRoom("web:alice:t3", null);
  assert.equal(isRoomThread("web:alice:t3"), true, "the pending roster wins over a stale read");
});

// ---------------------------------------------------------------------------
// Refused rosters
// ---------------------------------------------------------------------------

test("only a refused turn carrying a reason counts as a roster refusal", () => {
  assert.equal(
    refusalReason(new ApiError("HTTP 403", 403, { status: "refused", reason: "agent Critic is disabled" })),
    "agent Critic is disabled",
  );
  assert.equal(refusalReason(new ApiError("HTTP 403", 403, { status: "refused" })), null, "no reason to show");
  assert.equal(refusalReason(new ApiError("HTTP 403", 403, { error: "forbidden_scope" })), null, "not a refusal");
  assert.equal(refusalReason(new ApiError("HTTP 500", 500, { status: "refused", reason: "x" })), null, "wrong status");
  assert.equal(refusalReason(new Error("network down")), null);
  assert.equal(refusalReason(null), null);
});

test("a refusal is remembered per thread and stays dismissible", () => {
  resetRoomState();
  assert.equal(roomRefusalFor("web:alice:t4"), null);
  noteRoomRefusal("web:alice:t4", "unknown agent: ap_9");
  assert.equal(roomRefusalFor("web:alice:t4"), "unknown agent: ap_9");
  assert.equal(roomRefusalFor("web:alice:other"), null, "a refusal belongs to one thread only");
  clearRoomRefusal("web:alice:t4");
  assert.equal(roomRefusalFor("web:alice:t4"), null);
});

test("a refused roster stays parked so fixing the agent and resending retries it", () => {
  resetRoomState();
  holdPendingRoom("web:alice:t5", { personaIds: ["ap_1"], rounds: 1 });
  noteRoomRefusal("web:alice:t5", "agent Critic is disabled");
  assert.deepEqual(pendingRoomFor("web:alice:t5"), { personaIds: ["ap_1"], rounds: 1 });
});

// ---------------------------------------------------------------------------
// Attribution through the transcript
// ---------------------------------------------------------------------------

test("only a complete {id, name} counts as an author", () => {
  assert.deepEqual(personaFromPayload({ persona: { id: "ap_1", name: "Scout" } }), { id: "ap_1", name: "Scout" });
  assert.equal(personaFromPayload({ text: "hi" }), undefined);
  assert.equal(personaFromPayload({ persona: null }), undefined);
  assert.equal(personaFromPayload({ persona: { id: "ap_1" } }), undefined);
  assert.equal(personaFromPayload({ persona: { name: "Scout" } }), undefined);
  assert.equal(personaFromPayload(null), undefined);
});

test("each persona's turn carries its own author through entriesToMessages", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "who has thoughts?" }, createdAt: 100 },
    { type: "assistant", payload: { text: "I do.", persona: { id: "ap_1", name: "Scout" } }, createdAt: 110 },
    { type: "assistant", payload: { text: "I disagree.", persona: { id: "ap_2", name: "Critic" } }, createdAt: 120 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 3);
  assert.deepEqual((msgs[1] as AssistantWork).persona, { id: "ap_1", name: "Scout" });
  assert.deepEqual((msgs[2] as AssistantWork).persona, { id: "ap_2", name: "Critic" });
});

test("a persona's tool work stays on that persona's message", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "look it up" }, createdAt: 100 },
    { type: "tool_call", payload: { tool: "execute", command: "ls" }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 115, seq: 3, parentSeq: 2 },
    { type: "assistant", payload: { text: "found it", persona: { id: "ap_1", name: "Scout" } }, createdAt: 120 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const reply = msgs[1] as AssistantWork;
  assert.deepEqual(reply.persona, { id: "ap_1", name: "Scout" });
  assert.equal(reply.work?.activity.length, 2, "the work block is still folded in");
});

test("entries written before rooms existed produce messages with no author at all", () => {
  const msgs = entriesToMessages(
    [
      { type: "user", payload: { text: "hi" }, createdAt: 100 },
      { type: "assistant", payload: { text: "hello" }, createdAt: 110 },
    ],
    MODEL,
  );
  assert.equal((msgs[1] as AssistantWork).persona, undefined);
  assert.equal("persona" in (msgs[1] as object), false, "no key at all, so nothing renders a chip");
});

// ---------------------------------------------------------------------------
// Wiring the renderers cannot get wrong silently
// ---------------------------------------------------------------------------

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("the settled-row cache key includes the author, or a room's labels go stale", () => {
  assert.match(chat, /const persona = personaRowKey\(msg\.persona\);/);
  assert.ok(chat.includes("hit.persona === persona"), "the cache must compare the author identity");
  assert.match(chat, /persona,\s*tpl,\s*\}\);/, "and store it alongside the memoised template");
});

test("the author chip renders in the assistant branch only, above the bubble", () => {
  assert.match(chat, /\$\{personaAuthorChip\(\(msg as AssistantWork\)\.persona\)\}/);
  const assistantBranch = chat.slice(chat.indexOf('if (role === "assistant")'));
  const chipAt = assistantBranch.indexOf("personaAuthorChip");
  const contentAt = assistantBranch.indexOf("assistantContent(msg");
  assert.ok(chipAt > 0 && chipAt < contentAt, "the chip must come before the message content");
});

test("a room's header shows the roster and its composer hides the per-thread runtime pickers", () => {
  assert.match(chat, /\$\{roomRosterChips\(roomFor\(chatState\.threadRef\)\)\}/);
  assert.match(
    composer,
    /function roomThread\(\): boolean \{\s*\n\s*return isRoomThread\(ctx\.chat\.state\.threadRef\);/,
  );
  assert.match(composer, /: roomThread\(\)\s*\n\s*\? nothing/, "the composer's model/harness pickers drop out");
  assert.match(composer, /\$\{\s*\n?\s*roomThread\(\)\s*\n?\s*\? nothing/, "…and so do the ones in the settings menu");
});

test("a held roster is still applied if a thread gets a session id without carrying it on a turn", () => {
  const adopt = chat.slice(chat.indexOf("function adoptActiveSessionFromList"));
  const body = adopt.slice(0, adopt.indexOf("\n  }"));
  assert.match(body, /void applyPendingRoom\(chatState\.threadRef, chatState\.sessionId\);/);
  assert.ok(
    body.indexOf("chatState.sessionId = match.id") < body.indexOf("applyPendingRoom"),
    "the id must be adopted before the roster is applied",
  );
});

const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");

test("a new room's roster rides in on its first turn, and not on openers or approvals", () => {
  assert.match(bridge, /const roomForTurn = opener \|\| approval \? null : pendingRoomFor\(threadRef\);/);
  assert.match(bridge, /\.\.\.\(roomForTurn \? \{ room: roomForTurn \} : \{\}\),/, "the turn body carries it");
  const submitAt = bridge.indexOf('api<{ status?: string; runId?: string; reply?: string }>("/api/turn"');
  assert.ok(bridge.indexOf("const roomForTurn") < submitAt, "resolved before the turn is submitted");
});

test("an accepted roster stops being pending, so the deferred PUT never fires for that path", () => {
  assert.match(bridge, /if \(roomForTurn\) clearPendingRoom\(threadRef\);/);
  const clearAt = bridge.indexOf("if (roomForTurn) clearPendingRoom(threadRef);");
  const followAt = bridge.indexOf("await followRun(stream, partial, submit.runId");
  assert.ok(clearAt > 0 && clearAt < followAt, "cleared only after the submit came back without throwing");
});

test("a refused roster leaves no failed assistant turn in the transcript", () => {
  const drive = bridge.slice(bridge.indexOf("const roomForTurn"));
  const body = drive.slice(0, drive.indexOf("\n}\n"));
  assert.match(body, /const refused = roomForTurn \? refusalReason\(e\) : null;/, "only a room turn can refuse a room");
  assert.match(body, /noteRoomRefusal\(threadRef, refused\);/);
  assert.ok(
    body.indexOf("noteRoomRefusal") < body.indexOf("fail(stream, partial"),
    "the refusal path must return before the ordinary failure path",
  );
  assert.match(body, /clearRoomRefusal\(threadRef\);/, "each new send clears the previous refusal");
});

test("the refusal is surfaced at the composer, with its reason and a way to dismiss it", () => {
  assert.match(composer, /const refusal = roomRefusalFor\(ctx\.chat\.state\.threadRef\);/);
  assert.match(composer, /composer-error room-refusal/, "it renders in the composer's own error slot");
  assert.match(composer, /This room could not start: \$\{refusal\}/);
  assert.match(composer, /clearRoomRefusal\(ctx\.chat\.state\.threadRef\);/, "and can be dismissed");
});

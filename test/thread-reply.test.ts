// Reply in thread: a client names the message it is answering with `TurnRequest.replyToSeq`,
// core resolves that ref to the thread ROOT, and the turn's own `user` entry is written under
// it. The reply to that message then threads under the user entry exactly as it always has,
// which is what makes a whole exchange read as one thread instead of a run of siblings.
import "./support/agent-rooms-flag.ts";
import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { resolveThreadRootSeq } from "../src/sessions/session-store.ts";
import type { RoomConfig, SessionEntry, TurnRequest } from "../src/types.ts";
import type { AgentPersona } from "../src/agents/persona-store.ts";

// ---------------------------------------------------------------------------
// The walk itself, over hand-built logs: no store, no app.
// ---------------------------------------------------------------------------

type WalkEntry = Pick<SessionEntry, "seq" | "type" | "parentSeq">;

/** A linear log: every entry parented at `seq - 1`, the shape the store writes by default. */
function linear(types: SessionEntry["type"][]): WalkEntry[] {
  return types.map((type, seq) => ({ seq, type, parentSeq: seq === 0 ? null : seq - 1 }));
}

test("replying to an assistant resolves to the user message it answered", () => {
  // 0 user, 1 tool_call, 2 tool_result, 3 assistant threaded under 0 — the shape core writes.
  const entries: WalkEntry[] = [
    ...linear(["user", "tool_call", "tool_result"]),
    { seq: 3, type: "assistant", parentSeq: 0 },
  ];
  assert.equal(resolveThreadRootSeq(entries, 3), 0, "the reply's own thread parent is the root");
});

test("replying to a thread root is the identity", () => {
  const entries: WalkEntry[] = [...linear(["user", "assistant"]), { seq: 2, type: "user", parentSeq: 1 }];
  assert.equal(resolveThreadRootSeq(entries, 0), 0);
  assert.equal(resolveThreadRootSeq(entries, 2), 2, "a user entry whose parent is not a user entry is a root");
});

test("replying to a message already in a thread extends that thread, never nests inside it", () => {
  // 0 root, 1 reply-in-thread, 2 the answer to it, 3 a second reply-in-thread.
  const entries: WalkEntry[] = [
    { seq: 0, type: "user", parentSeq: null },
    { seq: 1, type: "user", parentSeq: 0 },
    { seq: 2, type: "assistant", parentSeq: 1 },
    { seq: 3, type: "user", parentSeq: 0 },
  ];
  assert.equal(resolveThreadRootSeq(entries, 1), 0, "a threaded user entry resolves to its root");
  assert.equal(resolveThreadRootSeq(entries, 2), 0, "…and so does the answer to it, one hop further up");
  assert.equal(resolveThreadRootSeq(entries, 3), 0);
});

test("an old transcript resolves through its linear chain to the message being answered", () => {
  // Written before threading existed: the assistant's parent is the previous entry.
  const entries = linear(["user", "assistant", "user", "tool_call", "assistant"]);
  assert.equal(resolveThreadRootSeq(entries, 4), 2, "the nearest user entry up the chain, not the first one");
  assert.equal(resolveThreadRootSeq(entries, 1), 0);
});

test("a seq nobody wrote, and a chain with no message in it, resolve to nothing", () => {
  assert.equal(resolveThreadRootSeq(linear(["user", "assistant"]), 9), undefined);
  assert.equal(resolveThreadRootSeq([], 0), undefined);
  assert.equal(
    resolveThreadRootSeq(linear(["system", "assistant"]), 1),
    undefined,
    "an assistant nobody asked for hangs off no message",
  );
});

test("a cycle in parentSeq ends the walk instead of hanging it", () => {
  const cyclic: WalkEntry[] = [
    { seq: 0, type: "user", parentSeq: 2 },
    { seq: 1, type: "assistant", parentSeq: 0 },
    { seq: 2, type: "user", parentSeq: 0 },
  ];
  assert.equal(resolveThreadRootSeq(cyclic, 1), 2, "the best root found before the walk closed on itself");
  const selfParent: WalkEntry[] = [{ seq: 0, type: "assistant", parentSeq: 0 }];
  assert.equal(resolveThreadRootSeq(selfParent, 0), undefined);
});

// ---------------------------------------------------------------------------
// End to end through App.turn, the orchestrator, and the mock harness.
// ---------------------------------------------------------------------------

function freshApp(): BuiltApp {
  return buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qm-thread-")), harness: "mock", seedSkills: false }),
  );
}

const ACTOR = { externalId: "U1" };

function webTurn(threadRef: string, text: string, over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    surface: "web",
    actor: ACTOR,
    conversation: { kind: "dm", threadRef, audience: [ACTOR] },
    text,
    ...over,
  };
}

const entriesOf = (built: BuiltApp, sessionId: string) => built.sessions.getEntries(sessionId);
const lastSeq = async (built: BuiltApp, sessionId: string) => (await entriesOf(built, sessionId)).at(-1)?.seq ?? -1;
const addedSince = async (built: BuiltApp, sessionId: string, seq: number) =>
  (await entriesOf(built, sessionId)).filter((e) => e.seq > seq);
const ofType = (entries: readonly SessionEntry[], type: SessionEntry["type"]) => entries.filter((e) => e.type === type);
const personaOf = (e: SessionEntry): { id: string; name: string } | undefined =>
  (e.payload as { persona?: { id: string; name: string } } | null)?.persona;

/** Opens a conversation and returns its session plus the root user entry of the first turn. */
async function openThread(built: BuiltApp, threadRef: string) {
  const first = await built.app.turn(webTurn(threadRef, "what should we do about the pricing page?"));
  assert.notEqual(first.status, "refused", first.reason);
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);
  const entries = await entriesOf(built, session.id);
  const root = ofType(entries, "user")[0]!;
  const answer = ofType(entries, "assistant").at(-1)!;
  return { session, root, answer };
}

async function makePersona(built: BuiltApp, name: string): Promise<AgentPersona> {
  return built.personas.create({
    scopeId: "personal:U1",
    name,
    color: "#ba9926",
    glyph: name.slice(0, 2).toUpperCase(),
    harnessId: "mock",
    modelId: "claude-opus-4-8",
    instructions: `You are ${name}. Answer in one line.`,
    createdBy: "U1",
  });
}

test("a reply in thread writes its message under the root, and its answer under the message", async () => {
  const built = freshApp();
  const threadRef = "web:U1:reply-chain";
  const { session, root } = await openThread(built, threadRef);

  const before = await lastSeq(built, session.id);
  const result = await built.app.turn(
    webTurn(threadRef, "!preamble say more about the headline", { replyToSeq: root.seq }),
  );
  assert.notEqual(result.status, "refused", result.reason);

  const added = await addedSince(built, session.id, before);
  const reply = ofType(added, "user")[0]!;
  const answer = ofType(added, "assistant").at(-1)!;

  assert.equal(reply.parentSeq, root.seq, "the human's reply hangs off the thread root");
  assert.notEqual(reply.seq - 1, root.seq, "and that is not simply the linear parent it would have had");
  assert.equal(answer.parentSeq, reply.seq, "the agent's answer hangs off the reply, as it does in any turn");
  for (const entry of added.filter((e) => e.type !== "user" && e.type !== "assistant")) {
    assert.equal(entry.parentSeq, entry.seq - 1, `${entry.type} keeps the linear chain, so the working order reads`);
  }
});

test("replying to the agent's answer joins the same thread, rather than opening one inside it", async () => {
  const built = freshApp();
  const threadRef = "web:U1:reply-to-assistant";
  const { session, root, answer } = await openThread(built, threadRef);
  assert.equal(answer.parentSeq, root.seq, "the opening answer already threads under the opening message");

  const before = await lastSeq(built, session.id);
  assert.notEqual(
    (await built.app.turn(webTurn(threadRef, "and the subhead?", { replyToSeq: answer.seq }))).status,
    "refused",
  );
  const reply = ofType(await addedSince(built, session.id, before), "user")[0]!;
  assert.equal(reply.parentSeq, root.seq, "resolved through the answer to the message it answered");
});

test("a second reply in thread lands beside the first, never underneath it", async () => {
  const built = freshApp();
  const threadRef = "web:U1:reply-sibling";
  const { session, root } = await openThread(built, threadRef);

  const beforeFirst = await lastSeq(built, session.id);
  assert.notEqual(
    (await built.app.turn(webTurn(threadRef, "first follow-up", { replyToSeq: root.seq }))).status,
    "refused",
  );
  const first = ofType(await addedSince(built, session.id, beforeFirst), "user")[0]!;

  const beforeSecond = await lastSeq(built, session.id);
  assert.notEqual(
    (await built.app.turn(webTurn(threadRef, "second follow-up", { replyToSeq: first.seq }))).status,
    "refused",
  );
  const second = ofType(await addedSince(built, session.id, beforeSecond), "user")[0]!;

  assert.equal(first.parentSeq, root.seq);
  assert.equal(second.parentSeq, root.seq, "pointing at a message inside the thread still extends the thread");
});

test("a seq that names nothing, the wrong kind of entry, or no conversation at all is refused", async () => {
  const built = freshApp();
  const threadRef = "web:U1:reply-refusals";
  const { session, root } = await openThread(built, threadRef);

  const before = await entriesOf(built, session.id);
  for (const [seq, why] of [
    [9999, "a seq nobody wrote"],
    [-1, "a negative seq"],
    [1.5, "a fractional seq"],
  ] as const) {
    const refused = await built.app.turn(webTurn(threadRef, "into the void", { replyToSeq: seq }));
    assert.equal(refused.status, "refused", `${why} must be refused, not silently unthreaded`);
    assert.ok(refused.reason, "with a reason a composer can show");
  }

  const nonMessage = before.find((e) => e.type !== "user" && e.type !== "assistant");
  if (nonMessage) {
    const refused = await built.app.turn(webTurn(threadRef, "under a tool call", { replyToSeq: nonMessage.seq }));
    assert.equal(refused.status, "refused", `a ${nonMessage.type} entry is not a message anyone can reply to`);
  }

  const noSession = await built.app.turn(webTurn("web:U1:never-opened", "hello?", { replyToSeq: root.seq }));
  assert.equal(noSession.status, "refused", "there is no conversation to reply into yet");

  assert.deepEqual(
    (await entriesOf(built, session.id)).map((e) => e.seq),
    before.map((e) => e.seq),
    "a refused reply writes nothing at all",
  );
});

test("a room panel threads the whole panel under the reply, and the reply under the root", async () => {
  const built = freshApp();
  const threadRef = "web:U1:reply-room";
  const { session, root } = await openThread(built, threadRef);
  const personas = [await makePersona(built, "Scout"), await makePersona(built, "Critic")];
  const room: RoomConfig = { personaIds: personas.map((p) => p.id), rounds: 1 };
  await built.sessions.setRoom(session.id, room);

  const before = await lastSeq(built, session.id);
  const result = await built.app.turn(webTurn(threadRef, "both of you on this, please", { replyToSeq: root.seq }));
  assert.notEqual(result.status, "refused", result.reason);

  const added = await addedSince(built, session.id, before);
  const users = ofType(added, "user");
  const assistants = ofType(added, "assistant");
  assert.equal(users.length, 1, "the continuation turns still write no user entry of their own");
  assert.equal(users[0]!.parentSeq, root.seq, "the human's message threads under the root it named");
  assert.deepEqual(
    assistants.map((e) => personaOf(e)?.name),
    ["Scout", "Critic"],
  );
  assert.deepEqual(
    assistants.map((e) => e.parentSeq),
    [users[0]!.seq, users[0]!.seq],
    "and every persona answers the message of THIS turn, which is now the threaded one",
  );
});

test("an @tag inside a reply still promotes the conversation to a room, threading unchanged", async () => {
  const built = freshApp();
  const threadRef = "web:U1:reply-tag-join";
  const { session, root } = await openThread(built, threadRef);
  await makePersona(built, "Nomad");

  const before = await lastSeq(built, session.id);
  const result = await built.app.turn(webTurn(threadRef, "@Nomad thoughts?", { replyToSeq: root.seq }));
  assert.notEqual(result.status, "refused", result.reason);

  const added = await addedSince(built, session.id, before);
  const user = ofType(added, "user")[0]!;
  const assistants = ofType(added, "assistant");
  assert.equal(personaOf(assistants.at(-1)!)?.name, "Nomad", "the tag still joined and answered");
  assert.equal(user.parentSeq, root.seq, "panel membership changes never fight the explicit root");
  assert.equal(assistants.at(-1)!.parentSeq, user.seq);
});

test("with no replyToSeq an ordinary turn is linear end to end", async () => {
  const built = freshApp();
  const threadRef = "web:U1:reply-absent";
  const { session } = await openThread(built, threadRef);

  const before = await lastSeq(built, session.id);
  assert.notEqual((await built.app.turn(webTurn(threadRef, "!preamble looking now"))).status, "refused");

  const added = await addedSince(built, session.id, before);
  const user = ofType(added, "user")[0]!;
  assert.equal(user.parentSeq, user.seq - 1, "the human's message stays on the linear chain");
  assert.ok(ofType(added, "tool_call").length >= 1, "the turn did tool work worth checking");
  for (const entry of added) {
    // Nothing threads: one agent answering one person is a conversation, not a thread of
    // one. A thread is only shaped by a panel, or by a human replying into one.
    assert.equal(entry.parentSeq, entry.seq - 1, `${entry.type} keeps the linear parent`);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  groupRoomTranscript,
  isUserRole,
  threadKeyFor,
  UNSENT_THREAD_KEY,
  type ThreadableMessage,
} from "../src/thread-group.ts";
import { entriesToMessages, type AssistantWork, type SessionEntry } from "../src/core-bridge.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Parameters<
  typeof entriesToMessages
>[1];

function user(seq: number): ThreadableMessage {
  return { role: "user", seq, parentSeq: seq - 1 };
}

function reply(seq: number, parentSeq: number | null): ThreadableMessage {
  return { role: "assistant", seq, parentSeq };
}

/** Every message renders exactly once, in index order — threaded or not. */
function coverage(rows: ReturnType<typeof groupRoomTranscript>): number[] {
  const seen: number[] = [];
  for (const row of rows) {
    seen.push(row.index);
    for (const i of row.replies) seen.push(i);
  }
  return seen.sort((a, b) => a - b);
}

test("in a room, assistant replies group under the user turn their parentSeq names", () => {
  const messages = [user(10), reply(12, 10), reply(14, 10)];
  const rows = groupRoomTranscript(messages, { isRoom: true });
  assert.deepEqual(rows, [{ index: 0, replies: [1, 2], live: false }]);
});

test("a non-room conversation never groups, however its parentSeqs read", () => {
  const messages = [user(10), reply(11, 10), reply(12, 11)];
  const rows = groupRoomTranscript(messages, { isRoom: false });
  assert.deepEqual(
    rows,
    messages.map((_, index) => ({ index, replies: [], live: false })),
  );
});

test("a reply whose parent is not on screen stays a row of its own", () => {
  // The shape a room from before core stamped room parenting has: parentSeq points at the
  // previous activity entry, not at the human turn.
  const messages = [user(10), reply(13, 12), reply(16, 15)];
  const rows = groupRoomTranscript(messages, { isRoom: true });
  assert.deepEqual(rows, [
    { index: 0, replies: [], live: false },
    { index: 1, replies: [], live: false },
    { index: 2, replies: [], live: false },
  ]);
  assert.deepEqual(coverage(rows), [0, 1, 2]);
});

test("a thread paged so its parent is above the window keeps its replies visible", () => {
  const messages = [reply(4, 1), reply(6, 1), user(9), reply(11, 9)];
  const rows = groupRoomTranscript(messages, { isRoom: true });
  assert.deepEqual(rows, [
    { index: 0, replies: [], live: false },
    { index: 1, replies: [], live: false },
    { index: 2, replies: [3], live: false },
  ]);
  assert.deepEqual(coverage(rows), [0, 1, 2, 3]);
});

test("each thread in a conversation collects only its own replies", () => {
  const messages = [user(10), reply(12, 10), reply(14, 10), user(20), reply(22, 20), reply(24, 20), reply(26, 20)];
  const rows = groupRoomTranscript(messages, { isRoom: true });
  assert.deepEqual(rows, [
    { index: 0, replies: [1, 2], live: false },
    { index: 3, replies: [4, 5, 6], live: false },
  ]);
  assert.deepEqual(coverage(rows), [0, 1, 2, 3, 4, 5, 6]);
});

test("replies inside a thread are ordered by seq, not by arrival", () => {
  const messages = [user(10), reply(30, 10), reply(12, 10), reply(21, 10)];
  const rows = groupRoomTranscript(messages, { isRoom: true });
  assert.deepEqual(rows[0]!.replies, [2, 3, 1]);
});

test("a user turn nobody answered carries no thread at all", () => {
  const messages = [user(10), user(20), reply(22, 20)];
  const rows = groupRoomTranscript(messages, { isRoom: true });
  assert.deepEqual(rows[0], { index: 0, replies: [], live: false });
  assert.equal(rows[1]!.replies.length, 1);
});

test("a reply can never be pulled backwards under a later user turn", () => {
  const messages = [reply(22, 20), user(20)];
  const rows = groupRoomTranscript(messages, { isRoom: true });
  assert.deepEqual(rows, [
    { index: 0, replies: [], live: false },
    { index: 1, replies: [], live: false },
  ]);
});

test("a user turn with no seq still anchors nothing by seq", () => {
  const messages: ThreadableMessage[] = [{ role: "user-with-attachments" }, reply(12, 10)];
  const rows = groupRoomTranscript(messages, { isRoom: true });
  assert.deepEqual(rows, [
    { index: 0, replies: [], live: false },
    { index: 1, replies: [], live: false },
  ]);
});

// ---------------------------------------------------------------------------
// The in-flight reply
// ---------------------------------------------------------------------------

test("the streaming reply lands in the thread of the turn it is answering", () => {
  // Neither the just-typed user message nor the client-side partial has a seq yet.
  const messages: ThreadableMessage[] = [user(10), reply(12, 10), { role: "user" }, { role: "assistant" }];
  const rows = groupRoomTranscript(messages, { isRoom: true, liveIndex: 3 });
  assert.deepEqual(rows, [
    { index: 0, replies: [1], live: false },
    { index: 2, replies: [3], live: true },
  ]);
});

test("the streaming reply joins a thread that already has settled replies, last", () => {
  const messages: ThreadableMessage[] = [user(10), reply(12, 10), reply(14, 10), { role: "assistant" }];
  const rows = groupRoomTranscript(messages, { isRoom: true, liveIndex: 3 });
  assert.deepEqual(rows[0], { index: 0, replies: [1, 2, 3], live: true });
});

test("a streaming reply with no user turn above it renders flat rather than vanishing", () => {
  const messages: ThreadableMessage[] = [{ role: "assistant" }];
  const rows = groupRoomTranscript(messages, { isRoom: true, liveIndex: 0 });
  assert.deepEqual(rows, [{ index: 0, replies: [], live: false }]);
});

test("an out-of-range or absent liveIndex is ignored", () => {
  const messages: ThreadableMessage[] = [user(10), { role: "assistant" }];
  for (const liveIndex of [null, undefined, -1, 7]) {
    const rows = groupRoomTranscript(messages, { isRoom: true, liveIndex });
    assert.deepEqual(rows, [
      { index: 0, replies: [], live: false },
      { index: 1, replies: [], live: false },
    ]);
  }
});

test("the streaming reply is not grouped outside a room", () => {
  const messages: ThreadableMessage[] = [user(10), { role: "assistant" }];
  const rows = groupRoomTranscript(messages, { isRoom: false, liveIndex: 1 });
  assert.deepEqual(rows, [
    { index: 0, replies: [], live: false },
    { index: 1, replies: [], live: false },
  ]);
});

test("an empty transcript groups to nothing", () => {
  assert.deepEqual(groupRoomTranscript([], { isRoom: true }), []);
});

// ---------------------------------------------------------------------------
// Fold-state identity
// ---------------------------------------------------------------------------

test("a thread's fold state is keyed by the parent's seq, so it survives a refresh", () => {
  assert.equal(threadKeyFor({ role: "user", seq: 41 }), 41);
});

test("a turn that has not reached core yet folds under the shared sentinel", () => {
  assert.equal(threadKeyFor({ role: "user" }), UNSENT_THREAD_KEY);
  assert.equal(threadKeyFor(undefined), UNSENT_THREAD_KEY);
  assert.ok(UNSENT_THREAD_KEY < 0, "the sentinel must not collide with a real seq");
});

test("both composer roles count as a human turn", () => {
  assert.ok(isUserRole("user"));
  assert.ok(isUserRole("user-with-attachments"));
  assert.ok(!isUserRole("assistant"));
  assert.ok(!isUserRole(undefined));
});

// ---------------------------------------------------------------------------
// End to end off real entries
// ---------------------------------------------------------------------------

function entry(seq: number, type: SessionEntry["type"], payload: unknown, parentSeq: number | null): SessionEntry {
  return { type, payload, createdAt: 1_700_000_000_000 + seq, seq, parentSeq };
}

test("a room's entries thread once core parents its replies at the human turn", () => {
  const entries: SessionEntry[] = [
    entry(1, "user", { text: "what do you all think?" }, 0),
    entry(2, "assistant", { text: "Ship it.", persona: { id: "a1", name: "Scout" } }, 1),
    entry(3, "assistant", { text: "Not yet.", persona: { id: "a2", name: "Critic" } }, 1),
  ];
  const messages = entriesToMessages(entries, MODEL) as unknown as Array<AssistantWork & ThreadableMessage>;
  assert.equal(messages.length, 3);
  assert.equal(messages[0]!.seq, 1);
  assert.equal(messages[1]!.parentSeq, 1);
  assert.equal(messages[2]!.parentSeq, 1);
  const rows = groupRoomTranscript(messages, { isRoom: true });
  assert.deepEqual(rows, [{ index: 0, replies: [1, 2], live: false }]);
  assert.equal(messages[1]!.persona?.name, "Scout");
});

test("the same entries under the old linear parentSeq chain stay flat", () => {
  const entries: SessionEntry[] = [
    entry(1, "user", { text: "what do you all think?" }, 0),
    entry(2, "text", { text: "Ship it." }, 1),
    entry(3, "assistant", { text: "Ship it.", persona: { id: "a1", name: "Scout" } }, 2),
    entry(4, "text", { text: "Not yet." }, 3),
    entry(5, "assistant", { text: "Not yet.", persona: { id: "a2", name: "Critic" } }, 4),
  ];
  const messages = entriesToMessages(entries, MODEL) as unknown as ThreadableMessage[];
  const rows = groupRoomTranscript(messages, { isRoom: true });
  assert.deepEqual(coverage(rows), [0, 1, 2]);
  assert.ok(
    rows.every((row) => row.replies.length === 0),
    "nothing may group when replies point at the previous entry rather than the human turn",
  );
});

// ---------------------------------------------------------------------------
// Wiring (there is no browser rig, so the call sites are asserted on source)
// ---------------------------------------------------------------------------

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("the transcript only groups when the mounted conversation is a room", () => {
  assert.match(chat, /isRoom: isRoomThread\(chatState\.threadRef\)/);
});

test("the streaming partial is handed to the grouper as the live reply", () => {
  assert.match(chat, /liveIndex: liveIndex >= 0 \? liveIndex : null/);
});

test("expanded replies render inside the thread, not at the end of the transcript", () => {
  assert.match(chat, /<div\s*\n?\s*class="thread-replies"/);
  assert.match(
    chat,
    /row\.replies\.map\(\(i\) => settledChatMessage\(messages\[i\]!, i, messages\[i\] === streaming\)\)/,
  );
});

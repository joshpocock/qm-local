import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  groupRoomTranscript,
  isUserRole,
  threadKeyFor,
  threadMembers,
  threadParentSeq,
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

test("assistant replies group under the user turn their parentSeq names", () => {
  const messages = [user(10), reply(12, 10), reply(14, 10)];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows, [{ index: 0, replies: [1, 2], live: false }]);
});

// ---------------------------------------------------------------------------
// Grouping is no longer room-only: it runs on any transcript whose entries
// carry a human-turn-targeted parentSeq, room or not.
// ---------------------------------------------------------------------------

test("a 1:1 conversation groups the same way a room does, once its replies name the human turn", () => {
  const messages = [user(10), reply(12, 10), reply(14, 10)];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows, [{ index: 0, replies: [1, 2], live: false }]);
});

test("a reply that only chains off the previous entry, rather than naming the human turn, stays flat", () => {
  // reply(11, 10) points straight at the user's seq — the new shape — and groups. reply(12, 11)
  // points at the previous assistant reply's seq instead, the old entry-to-entry chain, and
  // that never resolves to a user row.
  const messages = [user(10), reply(11, 10), reply(12, 11)];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows, [
    { index: 0, replies: [1], live: false },
    { index: 2, replies: [], live: false },
  ]);
  assert.deepEqual(coverage(rows), [0, 1, 2]);
});

test("a transcript with no parentSeq at all renders exactly as before — flat", () => {
  const messages: ThreadableMessage[] = [
    { role: "user", seq: 10 },
    { role: "assistant", seq: 11 },
    { role: "assistant", seq: 12 },
  ];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(
    rows,
    messages.map((_, index) => ({ index, replies: [], live: false })),
  );
});

test("a reply whose parent is not on screen stays a row of its own", () => {
  // The shape a room from before core stamped room parenting has: parentSeq points at the
  // previous activity entry, not at the human turn. The same shape appears in any old
  // session that predates core parenting replies at the human turn generally.
  const messages = [user(10), reply(13, 12), reply(16, 15)];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows, [
    { index: 0, replies: [], live: false },
    { index: 1, replies: [], live: false },
    { index: 2, replies: [], live: false },
  ]);
  assert.deepEqual(coverage(rows), [0, 1, 2]);
});

test("a thread paged so its parent is above the window keeps its replies visible", () => {
  const messages = [reply(4, 1), reply(6, 1), user(9), reply(11, 9)];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows, [
    { index: 0, replies: [], live: false },
    { index: 1, replies: [], live: false },
    { index: 2, replies: [3], live: false },
  ]);
  assert.deepEqual(coverage(rows), [0, 1, 2, 3]);
});

test("each thread in a conversation collects only its own replies", () => {
  const messages = [user(10), reply(12, 10), reply(14, 10), user(20), reply(22, 20), reply(24, 20), reply(26, 20)];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows, [
    { index: 0, replies: [1, 2], live: false },
    { index: 3, replies: [4, 5, 6], live: false },
  ]);
  assert.deepEqual(coverage(rows), [0, 1, 2, 3, 4, 5, 6]);
});

test("replies inside a thread are ordered by seq, not by arrival", () => {
  const messages = [user(10), reply(30, 10), reply(12, 10), reply(21, 10)];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows[0]!.replies, [2, 3, 1]);
});

test("a user turn nobody answered carries no thread at all", () => {
  const messages = [user(10), user(20), reply(22, 20)];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows[0], { index: 0, replies: [], live: false });
  assert.equal(rows[1]!.replies.length, 1);
});

test("a reply can never be pulled backwards under a later user turn", () => {
  const messages = [reply(22, 20), user(20)];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows, [
    { index: 0, replies: [], live: false },
    { index: 1, replies: [], live: false },
  ]);
});

test("a user turn with no seq still anchors nothing by seq", () => {
  const messages: ThreadableMessage[] = [{ role: "user-with-attachments" }, reply(12, 10)];
  const rows = groupRoomTranscript(messages);
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
  const rows = groupRoomTranscript(messages, { liveIndex: 3 });
  assert.deepEqual(rows, [
    { index: 0, replies: [1], live: false },
    { index: 2, replies: [3], live: true },
  ]);
});

test("the streaming reply joins a thread that already has settled replies, last", () => {
  const messages: ThreadableMessage[] = [user(10), reply(12, 10), reply(14, 10), { role: "assistant" }];
  const rows = groupRoomTranscript(messages, { liveIndex: 3 });
  assert.deepEqual(rows[0], { index: 0, replies: [1, 2, 3], live: true });
});

test("a streaming reply with no user turn above it renders flat rather than vanishing", () => {
  const messages: ThreadableMessage[] = [{ role: "assistant" }];
  const rows = groupRoomTranscript(messages, { liveIndex: 0 });
  assert.deepEqual(rows, [{ index: 0, replies: [], live: false }]);
});

test("an out-of-range or absent liveIndex is ignored", () => {
  const messages: ThreadableMessage[] = [user(10), { role: "assistant" }];
  for (const liveIndex of [null, undefined, -1, 7]) {
    const rows = groupRoomTranscript(messages, { liveIndex });
    assert.deepEqual(rows, [
      { index: 0, replies: [], live: false },
      { index: 1, replies: [], live: false },
    ]);
  }
});

test("the streaming reply groups under the pending turn outside a room too", () => {
  const messages: ThreadableMessage[] = [user(10), { role: "assistant" }];
  const rows = groupRoomTranscript(messages, { liveIndex: 1 });
  assert.deepEqual(rows, [{ index: 0, replies: [1], live: true }]);
});

test("an empty transcript groups to nothing", () => {
  assert.deepEqual(groupRoomTranscript([]), []);
});

test("opts is optional — no options behaves like no live reply", () => {
  const messages = [user(10), reply(12, 10)];
  assert.deepEqual(groupRoomTranscript(messages), groupRoomTranscript(messages, {}));
});

// ---------------------------------------------------------------------------
// A human turn typed into a thread
// ---------------------------------------------------------------------------

/** A reply typed into the thread rooted at `parentSeq` — not the linear default chain. */
function userReply(seq: number, parentSeq: number): ThreadableMessage {
  return { role: "user", seq, parentSeq };
}

test("a human reply into a thread folds under the root, and so does the answer it draws", () => {
  const messages = [user(10), reply(12, 10), userReply(20, 10), reply(24, 20)];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows, [{ index: 0, replies: [1, 2, 3], live: false }]);
  assert.deepEqual(coverage(rows), [0, 1, 2, 3]);
});

test("two messages typed back to back are two turns, not a thread", () => {
  // Core stamps `parentSeq = seq - 1` on every entry it is not told otherwise about, so a
  // consecutive pair would otherwise read as one replying into the other.
  const messages: ThreadableMessage[] = [
    { role: "user", seq: 10, parentSeq: 9 },
    { role: "user", seq: 11, parentSeq: 10 },
    reply(13, 11),
  ];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows, [
    { index: 0, replies: [], live: false },
    { index: 1, replies: [2], live: false },
  ]);
});

test("threadParentSeq reads the default chain as no link at all — for a human turn only", () => {
  assert.equal(threadParentSeq({ role: "user", seq: 11, parentSeq: 10 }), null);
  assert.equal(threadParentSeq({ role: "user", seq: 20, parentSeq: 10 }), 10);
  assert.equal(threadParentSeq({ role: "user", parentSeq: 10 }), 10, "a turn with no seq yet still links");
  // An assistant's final entry is always separated from the turn it answers by the run's
  // own activity entries, so `seq - 1` is meaningful there and must keep grouping.
  assert.equal(threadParentSeq({ role: "assistant", seq: 2, parentSeq: 1 }), 1);
  assert.equal(threadParentSeq({ role: "user", seq: 11 }), null);
});

test("the live partial follows the thread the reply it answers was typed into", () => {
  const messages: ThreadableMessage[] = [user(10), reply(12, 10), { role: "user", parentSeq: 10 }, { role: "assistant" }];
  const rows = groupRoomTranscript(messages, { liveIndex: 3 });
  assert.deepEqual(rows, [{ index: 0, replies: [1, 2, 3], live: true }]);
});

// ---------------------------------------------------------------------------
// threadMembers — what the panel shows
// ---------------------------------------------------------------------------

test("threadMembers walks the chain: root, its answers, replies into it, and their answers", () => {
  const messages = [user(10), reply(12, 10), userReply(20, 10), reply(24, 20), userReply(30, 24), reply(34, 30)];
  assert.deepEqual(threadMembers(messages, 0), [1, 2, 3, 4, 5]);
});

test("threadMembers agrees with the transcript's own grouping", () => {
  const messages = [user(10), reply(12, 10), userReply(20, 10), reply(24, 20), user(40), reply(42, 40)];
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(threadMembers(messages, 0), rows[0]!.replies);
  assert.deepEqual(threadMembers(messages, 4), rows[1]!.replies);
});

test("threadMembers collects nothing for a turn nobody answered", () => {
  assert.deepEqual(threadMembers([user(10), user(20), reply(22, 20)], 0), []);
});

test("threadMembers never reaches backwards, or into a neighbouring thread", () => {
  const messages = [user(10), reply(12, 10), user(20), reply(22, 20)];
  assert.deepEqual(threadMembers(messages, 2), [3], "the later thread cannot claim the earlier one's replies");
  assert.deepEqual(threadMembers(messages, 0), [1]);
});

test("threadMembers refuses a root that is not a human turn", () => {
  const messages = [user(10), reply(12, 10), reply(14, 12)];
  assert.deepEqual(threadMembers(messages, 1), []);
  assert.deepEqual(threadMembers(messages, 9), [], "and an index off the end");
});

test("threadMembers orders by seq, not by arrival", () => {
  const messages = [user(10), reply(30, 10), reply(12, 10), reply(21, 10)];
  assert.deepEqual(threadMembers(messages, 0), [2, 3, 1]);
});

test("threadMembers terminates on a cycle rather than spinning", () => {
  // Two entries naming each other, and one naming itself. Every hop must land strictly
  // earlier in the array, so neither can be followed round.
  const messages: ThreadableMessage[] = [
    user(10),
    { role: "assistant", seq: 12, parentSeq: 14 },
    { role: "assistant", seq: 14, parentSeq: 12 },
    { role: "assistant", seq: 16, parentSeq: 16 },
    reply(18, 10),
  ];
  assert.deepEqual(threadMembers(messages, 0), [4]);
});

test("threadMembers ignores a parentSeq naming a message further down the transcript", () => {
  const messages: ThreadableMessage[] = [user(10), { role: "assistant", seq: 12, parentSeq: 99 }, reply(99, 10)];
  assert.deepEqual(threadMembers(messages, 0), [2]);
});

test("threadMembers takes the live partial when the turn it answers is in the thread", () => {
  const messages: ThreadableMessage[] = [user(10), reply(12, 10), { role: "user", parentSeq: 10 }, { role: "assistant" }];
  assert.deepEqual(threadMembers(messages, 0, { liveIndex: 3 }), [1, 2, 3]);
});

test("threadMembers leaves the live partial out when it is answering a different turn", () => {
  const messages: ThreadableMessage[] = [user(10), reply(12, 10), { role: "user", seq: 20, parentSeq: 19 }, { role: "assistant" }];
  assert.deepEqual(threadMembers(messages, 0, { liveIndex: 3 }), [1]);
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
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows, [{ index: 0, replies: [1, 2], live: false }]);
  assert.equal(messages[1]!.persona?.name, "Scout");
});

test("a 1:1 session's entries thread the same way once its final reply is parented at the human turn", () => {
  const entries: SessionEntry[] = [
    entry(1, "user", { text: "what's the plan?" }, 0),
    entry(2, "assistant", { text: "Ship it." }, 1),
  ];
  const messages = entriesToMessages(entries, MODEL) as unknown as Array<AssistantWork & ThreadableMessage>;
  assert.equal(messages[1]!.parentSeq, 1);
  const rows = groupRoomTranscript(messages);
  assert.deepEqual(rows, [{ index: 0, replies: [1], live: false }]);
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
  const rows = groupRoomTranscript(messages);
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

test("the transcript grouper is no longer gated on room mode", () => {
  assert.match(
    chat,
    /groupRoomTranscript\(messages as unknown as readonly ThreadableMessage\[\], \{\s*\n\s*liveIndex: liveIndexIn\(agent, messages\),\s*\n\s*\}\)/,
  );
});

test("the streaming partial is handed to the grouper as the live reply", () => {
  const live = chat.slice(chat.indexOf("function liveIndexIn"));
  const body = live.slice(0, live.indexOf("\n  }"));
  assert.match(body, /agent\.state\.isStreaming \? agent\.state\.streamingMessage : null/);
  assert.match(body, /return index >= 0 \? index : null;/);
});

test("a thread's contents render in the panel, never inline in the transcript", () => {
  assert.equal(chat.includes("thread-replies"), false, "the inline expansion is gone");
  assert.equal(chat.includes("threadToggles"), false, "and so is the fold-state it was keyed by");
  const rows = chat.slice(chat.indexOf("  function transcriptRows("));
  const body = rows.slice(0, rows.indexOf("\n  }"));
  assert.equal(body.includes("row.replies.map"), false, "a folded message is not drawn by the transcript");
  assert.match(
    chat,
    /open\.members\.map\(\(i\) => settledChatMessage\(messages\[i\]!, i, messages\[i\] === streaming\)\)/,
    "it is drawn by the panel instead",
  );
});

test("the affordance opens the panel rather than unfolding in place", () => {
  assert.match(chat, /@click=\$\{\(\) => \(thread\.open \? closeThreadPanel\(\) : openThreadPanel\(thread\.key\)\)\}/);
  assert.match(chat, /open: threadPanel\.rootSeq === key,/, "and reads open as 'the panel is showing this one'");
});

test("the panel's membership is the root-walking helper, fed the live partial", () => {
  const resolve = chat.slice(chat.indexOf("function resolveOpenThread"));
  const body = resolve.slice(0, resolve.indexOf("\n  }"));
  assert.match(body, /threadMembers\(messages as unknown as readonly ThreadableMessage\[\], row\.index, \{/);
  assert.match(body, /liveIndex: liveIndexIn\(agent, messages\),/);
});

test("the panel renders from the transcript's own message array — no fetch of its own", () => {
  const draw = chat.slice(chat.indexOf("function drawActiveChat"));
  const body = draw.slice(0, draw.indexOf("\n  }"));
  assert.match(body, /const rows = messages\.length \? buildTranscriptRows\(agent, messages\) : \[\];/);
  assert.match(body, /resolveOpenThread\(agent, messages, rows\)/);
  assert.match(body, /\$\{openThread \? threadPanelView\(agent, messages, openThread\) : nothing\}/);
  assert.equal(/api\(|fetchTranscript\(/.test(body), false, "the open panel never triggers a load");
});

test("a thread reply goes through the composer's send path with the root attached", () => {
  const send = chat.slice(chat.indexOf("async function sendThreadReply"));
  const body = send.slice(0, send.indexOf("\n  }"));
  assert.match(body, /await ctx\.composer\.sendPrompt\(agent, \{ text, replyToSeq: key \}\);/);
  assert.match(body, /threadPanel\.draft = text;/, "a failed send hands the text back");
});

test("the panel closes with the conversation it belongs to", () => {
  const reset = chat.slice(chat.indexOf("function resetThreadFolds"));
  const body = reset.slice(0, reset.indexOf("\n  }"));
  assert.match(body, /threadPanel\.rootSeq = null;/);
  assert.match(body, /threadPanel\.draft = "";/);
  for (const caller of ["function teardownActiveChat", "function mountReadOnly"]) {
    const at = chat.indexOf(caller);
    assert.ok(at > 0, `${caller} must exist`);
    assert.ok(chat.slice(at, chat.indexOf("\n  }", at)).includes("resetThreadFolds()"), `${caller} resets the panel`);
  }
  // mountContinuable is the switch-sessions path and resets it too.
  const mount = chat.indexOf("function mountContinuable");
  assert.ok(chat.slice(mount, chat.indexOf("\n  }", mount)).includes("resetThreadFolds()"));
});

// ---------------------------------------------------------------------------
// The turn body
// ---------------------------------------------------------------------------

const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("replyToSeq rides the turn body only when the send named a thread", () => {
  assert.match(bridge, /\.\.\.\(typeof turnOptions\.replyToSeq === "number" \? \{ replyToSeq: turnOptions\.replyToSeq \} : \{\}\)/);
  const options = chat.slice(chat.indexOf("function currentTurnOptions"));
  const body = options.slice(0, options.indexOf("\n  }"));
  assert.match(body, /\.\.\.\(chatState\.replyToSeq !== null \? \{ replyToSeq: chatState\.replyToSeq \} : \{\}\)/);
});

test("the send path threads replyToSeq through as an option, and clears it after the turn", () => {
  const send = composer.slice(composer.indexOf("async function sendPrompt"));
  const body = send.slice(0, send.indexOf("\n  }"));
  assert.match(body, /async function sendPrompt\(agent: Agent, opts: SendOptions = \{\}\)/, "one path, not two");
  assert.match(body, /ctx\.chat\.state\.replyToSeq = opts\.replyToSeq \?\? null;/);
  assert.match(body, /\} finally \{\s*\n\s*ctx\.chat\.state\.replyToSeq = null;/);
  assert.match(
    body,
    /const link = typeof opts\.replyToSeq === "number" \? \{ parentSeq: opts\.replyToSeq \} : \{\};/,
    "and the outgoing message carries the link so it folds before the refresh",
  );
});

test("an aside send spends none of the main composer's state", () => {
  const send = composer.slice(composer.indexOf("async function sendPrompt"));
  const body = send.slice(0, send.indexOf("\n  }"));
  assert.match(body, /const aside = typeof opts\.text === "string";/);
  assert.match(body, /if \(!aside\) \{\s*\n\s*clearActiveDraft\(\);\s*\n\s*resetComposer\(\);\s*\n\s*\}/);
  assert.match(body, /if \(!aside\) clearComposerDom\(agent\);/);
  assert.match(body, /if \(agent\.state\.isStreaming\) return aside \? undefined : sendSteer\(agent\);/);
});

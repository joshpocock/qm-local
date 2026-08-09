import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("the transcript renders rows through the settled-row cache", () => {
  // Every row the transcript paints — a plain turn, a thread parent — goes through the
  // memo, and so does every message the thread panel paints under the root.
  assert.match(chat, /out\.push\(settledChatMessage\(message, row\.index, message === streaming\)\)/);
  assert.match(
    chat,
    /out\.push\(settledChatMessage\(message, row\.index, message === streaming, threadSummary\(messages, row\)\)\)/,
  );
  assert.match(
    chat,
    /open\.members\.map\(\(i\) => settledChatMessage\(messages\[i\]!, i, messages\[i\] === streaming\)\)/,
  );
});

test("the thread panel's copy of the root deliberately bypasses the cache", () => {
  // The root is the one message on screen twice, with an affordance in the transcript and
  // without one in the panel. Memoising both would make each draw evict the other's entry.
  assert.match(chat, /\$\{chatMessage\(root, open\.rootIndex, root === streaming\)\}/);
});

test("live or approval-paused rows bypass the cache (their render reads mutable state)", () => {
  assert.match(
    chat,
    /const cacheable =\s*!isStreaming &&\s*\(!work \|\| \(\(work\.status === "complete" \|\| work\.status === "failed"\) && !work\.pendingApprovals\?\.length\)\)/,
  );
  assert.match(chat, /if \(!cacheable\) return chatMessage\(message, index, isStreaming, thread\);/);
});

test("the cache key covers every mutable render input of a settled row", () => {
  for (const field of [
    "hit.index === index",
    "hit.activity === work?.activity",
    "hit.status === work?.status",
    "hit.stale === work?.stale",
    "hit.deliveredFiles === msg.deliveredFiles",
    "hit.stopReason === msg.stopReason",
    "hit.errorMessage === msg.errorMessage",
    "hit.approvalDecision === msg.approvalDecision",
    "hit.forkable === forkable",
    "hit.persona === persona",
    // A thread parent is a settled message whose row keeps changing while its agents
    // answer; without this it would freeze at whatever count it was first drawn with.
    "hit.thread === threadKey",
  ]) {
    assert.ok(chat.includes(field), `cache key must compare: ${field}`);
  }
});

test("the thread key covers reply count, fold state and who replied", () => {
  const key = chat.slice(chat.indexOf("function threadRowKey"), chat.indexOf("function settledChatMessage"));
  for (const part of ["thread.key", "thread.count", 'thread.open ? "open" : "shut"', "thread.lastAt", "thread.chips"]) {
    assert.ok(key.includes(part), `thread cache key must cover: ${part}`);
  }
});

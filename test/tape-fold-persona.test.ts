import assert from "node:assert/strict";
import { test } from "node:test";
import { foldTape, foldTapeForPersona, lintFold } from "../src/harness/tape-fold.ts";
import type { TapeRecord } from "../src/sessions/session-store.ts";
import type { ScopeId } from "../src/types.ts";

const scope = "channel:C1" as ScopeId;
const scout = { id: "ap_1", name: "Scout" };

let seq = 0;
function row(partial: Partial<TapeRecord> & Pick<TapeRecord, "kind" | "payload">): TapeRecord {
  return { sessionId: "s", seq: seq++, scopeLabel: scope, createdAt: 1000 + seq, ...partial } as TapeRecord;
}
const user = (text: string, extra: Partial<TapeRecord> = {}) =>
  row({ kind: "message", payload: { role: "user", content: [{ type: "text", text }], timestamp: 1 }, ...extra });
const assistantBy = (author: string | undefined, blocks: unknown[], extra: Partial<TapeRecord> = {}) =>
  row({
    kind: "message",
    payload: { role: "assistant", content: blocks, timestamp: 2, stopReason: "stop" },
    ...(author ? { meta: { author } } : {}),
    ...extra,
  });
const toolResult = (id: string, text: string) =>
  row({
    kind: "message",
    payload: {
      role: "toolResult",
      toolCallId: id,
      toolName: "exec",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 3,
    },
  });
const turnEnd = (entrySeq: number) => row({ kind: "annotation", payload: { turnEnd: true }, entrySeq });
const call = (id: string) => ({ type: "toolCall", id, name: "exec", arguments: {} });
const text = (t: string) => ({ type: "text", text: t });

type Msg = { role: string; content: Array<{ type: string; text?: string }> };
const shape = (out: readonly unknown[]) =>
  (out as Msg[]).map((m) => `${m.role}: ${m.content.map((b) => b.text ?? `<${b.type}>`).join(" | ")}`);
const clean = (out: readonly unknown[], why: string) => {
  const lint = lintFold(out);
  assert.ok(lint.ok, `${why}: ${lint.problems.join("; ")}`);
  return out;
};

test("a persona's own assistant rows stay assistant-role, verbatim", () => {
  seq = 0;
  const rows = [user("hi"), assistantBy("Scout", [text("mine")]), turnEnd(2)];
  const out = foldTapeForPersona(rows, scout);
  assert.deepEqual(out, [rows[0]!.payload, rows[1]!.payload]);
  clean(out, "own rows");
});

test("another persona's assistant row becomes a prefixed user row", () => {
  seq = 0;
  const rows = [
    user("hi"),
    assistantBy("Critic", [text("that pricing page is weak")]),
    assistantBy("Scout", [text("agreed")]),
  ];
  const out = foldTapeForPersona(rows, scout);
  assert.deepEqual(shape(out), ["user: hi", "user: [Critic]: that pricing page is weak", "assistant: agreed"]);
  clean(out, "cross-persona speech");
  assert.equal((out[1] as { timestamp?: number }).timestamp, 2, "timestamp survives the rewrite");
  assert.deepEqual(
    rows[1]!.payload,
    { role: "assistant", content: [text("that pricing page is weak")], timestamp: 2, stopReason: "stop" },
    "the durable tape row is never mutated",
  );
});

test("unattributed pre-room assistant history arrives as [Assistant]", () => {
  seq = 0;
  const rows = [user("hi"), assistantBy(undefined, [text("old single-agent answer")]), user("follow up")];
  const out = foldTapeForPersona(rows, scout);
  assert.deepEqual(shape(out), ["user: hi", "user: [Assistant]: old single-agent answer", "user: follow up"]);
  clean(out, "unattributed history");
});

test("another persona's tool call and its result are dropped, leaving a used-tools note", () => {
  seq = 0;
  const rows = [
    user("q"),
    assistantBy("Critic", [text("let me check"), call("c2")]),
    toolResult("c2", "secret internals of Critic's tool run"),
    assistantBy("Critic", [text("done")]),
    assistantBy("Scout", [text("ok")]),
  ];
  const out = foldTapeForPersona(rows, scout);
  assert.deepEqual(shape(out), [
    "user: q",
    "user: [Critic]: let me check\n[Critic used tools]",
    "user: [Critic]: done",
    "assistant: ok",
  ]);
  assert.ok(!JSON.stringify(out).includes("secret internals"), "another persona's tool output never leaks");
  clean(out, "dropped cross-persona tool pair");
});

test("the persona's own tool call/result pair survives intact and lint-clean", () => {
  seq = 0;
  const rows = [
    user("q"),
    assistantBy("Scout", [call("c1")]),
    toolResult("c1", "my own output"),
    assistantBy("Critic", [call("c2")]),
    toolResult("c2", "not mine"),
    assistantBy("Scout", [text("answer")]),
  ];
  const out = foldTapeForPersona(rows, scout);
  assert.deepEqual(shape(out), [
    "user: q",
    "assistant: <toolCall>",
    "toolResult: my own output",
    "user: [Critic]: \n[Critic used tools]",
    "assistant: answer",
  ]);
  clean(out, "own tool pair kept while the other persona's is dropped");
});

test("a compaction event still splices its summary in through the persona fold", () => {
  seq = 0;
  const rows = [
    user("old q"),
    assistantBy("Critic", [text("old a")]),
    turnEnd(1),
    user("recent q"),
    assistantBy("Critic", [text("recent a")]),
    assistantBy("Scout", [text("recent mine")]),
    turnEnd(3),
    row({ kind: "context_event", payload: { event: "compaction", text: "the old stuff" }, coversEntrySeq: 1 }),
    user("post q"),
  ];
  const out = foldTapeForPersona(rows, scout);
  assert.deepEqual(shape(out), [
    "user: [Earlier conversation summary]\nthe old stuff",
    "user: recent q",
    "user: [Critic]: recent a",
    "assistant: recent mine",
    "user: post q",
  ]);
  clean(out, "compacted room fold");
});

test("an interrupt still heals the persona's own dangling call, and never a dropped one", () => {
  seq = 0;
  const rows = [
    user("q"),
    assistantBy("Critic", [call("c2")]),
    assistantBy("Scout", [call("c1")]),
    row({ kind: "context_event", payload: { event: "interrupt" } }),
  ];
  const out = foldTapeForPersona(rows, scout);
  const healed = out.filter((m) => (m as { role?: string }).role === "toolResult") as Array<{ toolCallId: string }>;
  assert.deepEqual(
    healed.map((m) => m.toolCallId),
    ["c1"],
    "only the surviving call needs a synthetic result",
  );
  clean(out, "interrupt heal under a persona fold");
});

test("a fold opening on another persona's turn still satisfies the user-first invariant", () => {
  seq = 0;
  const rows = [assistantBy("Critic", [text("I'll start")]), assistantBy("Scout", [text("then me")])];
  assert.ok(!lintFold(foldTape(rows)).ok, "the raw fold is assistant-first, which is provider-fatal");
  const out = foldTapeForPersona(rows, scout);
  assert.equal((out[0] as { role: string }).role, "user");
  clean(out, "assistant-first tape rewritten for a persona");
});

test("consecutive rewritten rows are left separate and lint accepts them", () => {
  seq = 0;
  const rows = [
    user("q"),
    assistantBy("Critic", [text("one")]),
    assistantBy("Editor", [text("two")]),
    assistantBy(undefined, [text("three")]),
  ];
  const out = foldTapeForPersona(rows, scout);
  assert.deepEqual(shape(out), ["user: q", "user: [Critic]: one", "user: [Editor]: two", "user: [Assistant]: three"]);
  clean(out, "adjacent converted user rows");
});

test("no persona means byte-for-byte foldTape", () => {
  seq = 0;
  const rows = [
    user("q1"),
    assistantBy("Critic", [text("a1"), call("c1")]),
    toolResult("c1", "ok"),
    turnEnd(1),
    assistantBy(undefined, [text("a2")]),
    row({ kind: "context_event", payload: { event: "compaction", text: "sum" }, coversEntrySeq: 1 }),
    user("q2"),
  ];
  assert.deepEqual(foldTapeForPersona(rows, undefined), foldTape(rows));
  assert.deepEqual(foldTapeForPersona(rows), foldTape(rows));
});

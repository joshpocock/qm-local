import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import {
  decorateMentions,
  hasMention,
  mentionSegments,
  mentionTargetsKey,
  undecorateMentions,
  viewerMentionName,
  type MentionTarget,
} from "../src/mentions.ts";
import { dropRoomPassReplies, ROOM_PASS_REPLY, groupRoomTranscript } from "../src/thread-group.ts";

const SCOUT: MentionTarget = { kind: "agent", id: "ap_scout", name: "Scout", color: "#2563eb", glyph: "S" };
const CRITIC: MentionTarget = { kind: "agent", id: "ap_critic", name: "Critic", color: "#be185d", glyph: "C" };
const SCOUTMASTER: MentionTarget = { kind: "agent", id: "ap_sm", name: "Scoutmaster", color: "#15803d", glyph: "M" };
const ROSTER = [SCOUT, CRITIC];

function hits(text: string, targets: readonly MentionTarget[] = ROSTER): string[] {
  return mentionSegments(text, targets)
    .filter((seg) => seg.target)
    .map((seg) => seg.text);
}

function rebuilds(text: string, targets: readonly MentionTarget[] = ROSTER): boolean {
  return (
    mentionSegments(text, targets)
      .map((seg) => seg.text)
      .join("") === text
  );
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test("a roster name chips and an unknown name does not", () => {
  assert.deepEqual(hits("hey @Scout can you look at this"), ["@Scout"]);
  assert.deepEqual(hits("hey @Nobody can you look at this"), []);
  assert.deepEqual(hits("@Scout and @Critic both"), ["@Scout", "@Critic"]);
});

test("matching is case-insensitive but the chip carries the roster's own name", () => {
  assert.deepEqual(hits("ping @scout and @CRITIC"), ["@scout", "@CRITIC"]);
  const seg = mentionSegments("ping @scout", ROSTER).find((s) => s.target);
  assert.equal(seg?.target?.name, "Scout");
  assert.equal(seg?.text, "@scout");
});

test("the token must not be followed by a name character (@Scoutmaster is not @Scout)", () => {
  assert.deepEqual(hits("ask @Scoutmaster"), []);
  assert.deepEqual(hits("ask @Scout-2"), []);
  assert.deepEqual(hits("ask @Scout9"), []);
  // Punctuation, whitespace and end-of-string all close the token.
  assert.deepEqual(hits("@Scout, @Critic. @Scout"), ["@Scout", "@Critic", "@Scout"]);
});

test("a longer roster name wins over a shorter prefix of it", () => {
  const both = [SCOUT, SCOUTMASTER];
  const seg = mentionSegments("ask @Scoutmaster please", both).find((s) => s.target);
  assert.equal(seg?.target?.name, "Scoutmaster");
  assert.equal(seg?.text, "@Scoutmaster");
  assert.deepEqual(hits("ask @Scout please", both), ["@Scout"]);
});

test("email addresses are left alone", () => {
  assert.deepEqual(hits("mail scout@example.com about it"), []);
  assert.deepEqual(hits("mail me at hi@scout.example"), []);
  assert.deepEqual(hits("josh@critic.dev"), []);
  assert.ok(rebuilds("mail me at hi@scout.example"));
});

test("a bare @ and a non-roster handle stay literal", () => {
  assert.deepEqual(hits("@here everyone"), []);
  assert.deepEqual(hits("cost @ 5 dollars"), []);
  assert.deepEqual(hits("@@Scout"), []);
  assert.ok(rebuilds("@here everyone @@Scout cost @ 5"));
});

test("segments always rebuild the input exactly", () => {
  for (const text of ["", "@Scout", "a@Scout", "@Scout@Critic", "@@", "x @Scout y @Nobody z"]) {
    assert.ok(rebuilds(text), `did not rebuild: ${JSON.stringify(text)}`);
  }
});

test("hasMention and mentionTargetsKey are value-based", () => {
  assert.equal(hasMention("hi @Scout", ROSTER), true);
  assert.equal(hasMention("hi @Scout", [CRITIC]), false);
  assert.equal(mentionTargetsKey(ROSTER), mentionTargetsKey([...ROSTER]));
  assert.notEqual(mentionTargetsKey(ROSTER), mentionTargetsKey([SCOUT]));
});

test("viewerMentionName accepts only agent-name-shaped handles", () => {
  assert.equal(viewerMentionName("josh@executivestride.com"), "josh");
  assert.equal(viewerMentionName("dev-user"), "dev-user");
  assert.equal(viewerMentionName("josh.pocock@example.com"), null);
  assert.equal(viewerMentionName("9lives"), null);
  assert.equal(viewerMentionName("  "), null);
  assert.equal(viewerMentionName(null), null);
});

// ---------------------------------------------------------------------------
// The paint, over real rendered markdown
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><body><div id=root></div></body>");
const rootFor = (markdown: string): HTMLElement => {
  const el = dom.window.document.createElement("div");
  el.innerHTML = marked.parse(markdown, { async: false });
  return el;
};

test("chips a mention in prose, with the persona's colour, glyph and name", () => {
  const root = rootFor("hey @Scout have a look");
  assert.equal(decorateMentions(root, ROSTER), 1);
  const chip = root.querySelector(".mention-chip");
  assert.ok(chip);
  assert.equal(chip.getAttribute("data-mention-id"), "ap_scout");
  assert.match(chip.getAttribute("style") ?? "", /#2563eb/);
  assert.equal(chip.querySelector(".persona-dot")?.textContent, "S");
  assert.equal(chip.querySelector(".persona-name")?.textContent, "@Scout");
  assert.equal(root.textContent?.includes("hey "), true);
});

test("@Scout inside inline code stays literal text", () => {
  const root = rootFor("run `@Scout --help` first");
  assert.equal(decorateMentions(root, ROSTER), 0);
  assert.equal(root.querySelector(".mention-chip"), null);
  assert.equal(root.querySelector("code")?.textContent, "@Scout --help");
});

test("@Scout inside a fenced block stays literal text", () => {
  const root = rootFor("```\nping @Scout\n```");
  assert.equal(decorateMentions(root, ROSTER), 0);
  assert.equal(root.querySelector(".mention-chip"), null);
  assert.match(root.textContent ?? "", /ping @Scout/);
});

test("link text and hrefs are never chipped", () => {
  const root = rootFor("see [@Scout](https://example.com/@Scout)");
  assert.equal(decorateMentions(root, ROSTER), 0);
  assert.equal(root.querySelector("a")?.getAttribute("href"), "https://example.com/@Scout");
});

test("only prose next to code is chipped, not the code itself", () => {
  const root = rootFor("@Critic please run `@Scout` now");
  assert.equal(decorateMentions(root, ROSTER), 1);
  assert.equal(root.querySelector(".mention-chip")?.getAttribute("data-mention-id"), "ap_critic");
  assert.equal(root.querySelector("code")?.textContent, "@Scout");
});

test("painting is idempotent and reversible", () => {
  const root = rootFor("hey @Scout and @Critic");
  assert.equal(decorateMentions(root, ROSTER), 2);
  assert.equal(decorateMentions(root, ROSTER), 0);
  assert.equal(root.querySelectorAll(".mention-chip").length, 2);
  assert.equal(undecorateMentions(root), 2);
  assert.equal(root.querySelector(".mention-chip"), null);
  assert.equal(root.textContent?.trim(), "hey @Scout and @Critic");
  // …and the restored text can be repainted, which is how a late-arriving roster lands.
  assert.equal(decorateMentions(root, ROSTER), 2);
});

test("an empty roster paints nothing at all", () => {
  const root = rootFor("hey @Scout");
  assert.equal(decorateMentions(root, []), 0);
  assert.equal(root.textContent?.trim(), "hey @Scout");
});

test("the viewer chips in a distinct neutral style", () => {
  const me: MentionTarget = { kind: "viewer", id: "", name: "josh" };
  const root = rootFor("thanks @josh");
  assert.equal(decorateMentions(root, [...ROSTER, me]), 1);
  const chip = root.querySelector(".mention-chip");
  assert.ok(chip?.classList.contains("mention-viewer"));
  assert.ok(chip?.classList.contains("neutral"));
  assert.equal(chip?.getAttribute("data-mention-id"), null);
});

// ---------------------------------------------------------------------------
// Stored PASS replies
// ---------------------------------------------------------------------------

interface Row {
  role: string;
  seq: number;
  parentSeq?: number | null;
  text: string;
}
const textOf = (m: Row): string => m.text;

const TRANSCRIPT: Row[] = [
  { role: "user", seq: 1, parentSeq: null, text: "what do you think?" },
  { role: "assistant", seq: 2, parentSeq: 1, text: "I think we ship it." },
  { role: "assistant", seq: 3, parentSeq: 1, text: "PASS" },
  { role: "assistant", seq: 4, parentSeq: 1, text: "  PASS\n" },
  { role: "assistant", seq: 5, parentSeq: 1, text: "One caveat." },
];

test("a room drops stored PASS replies, however they were whitespaced", () => {
  const kept = dropRoomPassReplies(TRANSCRIPT, { isRoom: true, textOf });
  assert.deepEqual(
    kept.map((m) => m.seq),
    [1, 2, 5],
  );
  assert.equal(ROOM_PASS_REPLY, "PASS");
});

test("a non-room transcript is untouched", () => {
  const kept = dropRoomPassReplies(TRANSCRIPT, { isRoom: false, textOf });
  assert.deepEqual(
    kept.map((m) => m.seq),
    [1, 2, 3, 4, 5],
  );
});

test("a human message that says PASS is kept, and so is the live partial", () => {
  const rows: Row[] = [
    { role: "user", seq: 1, text: "PASS" },
    { role: "assistant", seq: 2, parentSeq: 1, text: "PASS" },
  ];
  const live = rows[1]!;
  assert.deepEqual(
    dropRoomPassReplies(rows, { isRoom: true, textOf }).map((m) => m.seq),
    [1],
  );
  assert.deepEqual(
    dropRoomPassReplies(rows, { isRoom: true, textOf, keep: (m) => m === live }).map((m) => m.seq),
    [1, 2],
  );
});

test("dropped PASS replies do not count toward a thread's reply count", () => {
  const before = groupRoomTranscript(TRANSCRIPT, { isRoom: true });
  assert.equal(before[0]?.replies.length, 4);
  const after = groupRoomTranscript(dropRoomPassReplies(TRANSCRIPT, { isRoom: true, textOf }), { isRoom: true });
  assert.equal(after.length, 1);
  assert.equal(after[0]?.replies.length, 2);
});

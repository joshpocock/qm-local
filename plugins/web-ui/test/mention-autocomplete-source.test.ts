import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const mentions = readFileSync(new URL("../src/mentions.ts", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// mentionQuery: the @ token detection/filtering logic itself.
//
// composer.ts cannot be imported live here — it pulls in bundler-resolved, extensionless
// imports (e.g. "./folder-drop") that node:test's plain ESM loader cannot follow, which is
// why nothing else in this suite live-imports it either (see composer-source.test.ts,
// pane-composer-source.test.ts). The regex is pinned byte-for-byte against the source below,
// then re-declared here so its actual matching behaviour is still exercised for real —
// a change to either the source literal or this copy fails the pin test.
// ---------------------------------------------------------------------------

const MENTION_TOKEN_SOURCE = "const MENTION_TOKEN = /(^|\\s)@([A-Za-z0-9 ._-]*)$/;";

test("MENTION_TOKEN in composer.ts is exactly what mentionQuery is exercised against below", () => {
  assert.ok(composer.includes(MENTION_TOKEN_SOURCE), "the regex literal in composer.ts changed — update it here too");
});

const MENTION_TOKEN = /(^|\s)@([A-Za-z0-9 ._-]*)$/;
function mentionQuery(draft: string): string | null {
  const m = MENTION_TOKEN.exec(draft);
  return m ? (m[2] ?? "") : null;
}

test("mentionQuery captures the partial name after a trailing @", () => {
  assert.equal(mentionQuery("hey @Sco"), "Sco");
  assert.equal(mentionQuery("@Scout"), "Scout");
});

test("an @ alone arms the token with an empty query — every candidate should show", () => {
  assert.equal(mentionQuery("@"), "");
  assert.equal(mentionQuery("hi there @"), "");
});

test("no @ at all never arms the token", () => {
  assert.equal(mentionQuery(""), null);
  assert.equal(mentionQuery("hello there"), null);
});

test("only the token at the very end of the draft counts, the same trailing-token trick as /skill", () => {
  assert.equal(mentionQuery("@Scout is around, ask "), null);
  // Re-arms on a fresh @ later in the same draft — only the newest token is live.
  assert.equal(mentionQuery("@Scout @Cri"), "Cri");
});

test("the @ must start a word — an email-shaped run never arms it", () => {
  assert.equal(mentionQuery("mail scout@example"), null);
  assert.equal(mentionQuery("mail scout@example.com"), null);
  // Whitespace right before the @ is what makes it a token, not a mid-word symbol.
  assert.equal(mentionQuery("mail me @scout"), "scout");
});

test("a doubled @ never arms the token", () => {
  assert.equal(mentionQuery("@@Scout"), null);
});

// ---------------------------------------------------------------------------
// Wiring (the candidate list, ordering, keyboard nav, and insertion format all live
// inside the composer's closure and are not exported — asserted on source, same pattern
// as the rest of test/composer-source.test.ts and test/thread-group.test.ts's wiring block).
// ---------------------------------------------------------------------------

test("the composer warms the full agent cache so @mention has more than the room roster to offer", () => {
  assert.match(composer, /void ensureRoomPersonas\(\)\.then\(/);
});

test("candidates are built room roster first, then every other enabled agent, then the viewer", () => {
  const fn = composer.slice(
    composer.indexOf("function mentionCandidatesFor"),
    composer.indexOf("function mentionTargetsFor"),
  );
  const roomLoop = fn.indexOf("room?.personaIds");
  const agentsLoop = fn.indexOf("cachedAgents()");
  const viewerLine = fn.indexOf("viewerMentionName(appState.me?.user)");
  assert.ok(roomLoop >= 0 && agentsLoop >= 0 && viewerLine >= 0, "all three candidate sources must be present");
  assert.ok(roomLoop < agentsLoop, "the room roster must be gathered before the rest of the agent cache");
  assert.ok(agentsLoop < viewerLine, "the viewer is offered last");
  // Agents already counted (room roster) must not be offered a second time.
  assert.match(fn, /if \(!agent\.enabled \|\| seen\.has\(agent\.id\)\) continue;/);
});

test("an agent not in the room is flagged in its row, an agent already in the room is not", () => {
  assert.match(composer, /const showHint = target\.kind === "agent" && roomThread\(\) && !inRoom;/);
  assert.match(composer, /not in room — will be added/);
});

test("selecting a candidate inserts the exact persona name plus a trailing space", () => {
  assert.match(
    composer,
    /composerState\.draft\.replace\(MENTION_TOKEN, \(_m, pre: string\) => `\$\{pre\}@\$\{name\} `\)/,
  );
});

test("ArrowUp/ArrowDown/Enter/Tab/Escape drive the mention menu the same way they drive the slash menu", () => {
  const fn = composer.slice(
    composer.indexOf("function onComposerKeydown"),
    composer.indexOf("function stopStreaming"),
  );
  assert.match(fn, /const mention = currentMentionMenu\(\);/);
  assert.match(fn, /if \(mention\.open\) \{/);
  assert.match(fn, /return closeMentionMenu\(agent\);/);
  assert.match(fn, /mentionActiveIndex = \(clampedMentionActive\(count\) \+ 1\) % count;/);
  assert.match(fn, /mentionActiveIndex = \(clampedMentionActive\(count\) - 1 \+ count\) % count;/);
  assert.match(fn, /return acceptMention\(mention\.matches\[clampedMentionActive\(count\)\]!\.candidate, agent\);/);
});

test("filtering is case-insensitive substring matching, same shape as the skill matcher", () => {
  assert.match(composer, /candidate\.target\.name\.toLowerCase\(\)\.indexOf\(q\)/);
});

test("the highlight overlay resolves tokens off the same candidate list the autocomplete uses", () => {
  assert.match(composer, /mirrorTemplate\(composerState\.draft, mentionTargetsFor\(ctx\.chat\.state\.threadRef\)\)/);
  assert.match(composer, /mentionSegments\(text, targets\)/);
});

test("DO NOT change the mention grammar: matchesAt in mentions.ts is untouched by this feature", () => {
  assert.match(
    mentions,
    /const end = at \+ 1 \+ name\.length;/,
    "matchesAt's boundary rule must still be exactly what mention-markdown.ts renders against",
  );
});

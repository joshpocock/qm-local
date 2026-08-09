import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * `agents.ts` cannot be imported here — it pulls in bundler-only extensionless imports that
 * node:test will not resolve — so these assert on the source, the same way
 * `mention-autocomplete-source.test.ts` and `pane-composer-source.test.ts` do.
 */
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/agents.ts"), "utf8");
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/shell.css"), "utf8");

test("the Slack binding read never breaks the page when Slack is absent or the call fails", () => {
  assert.match(
    src,
    /api<\{ bindings\?: SlackBinding\[\] \}>\("\/api\/slack-bindings"\)\.catch\(\(\) => \(\{ bindings: \[\] \}\)\)/,
    "a failed read leaves the badges off rather than throwing the Agents page away",
  );
});

test("an agent with no binding renders no chip at all", () => {
  assert.match(src, /const binding = slackBindings\.get\(a\.id\);\s*\n\s*if \(!binding\) return nothing;/);
});

test("the chip shows the bot handle, falling back to the operator's label", () => {
  assert.match(src, /binding\.botHandle \? `@\$\{binding\.botHandle\}` : binding\.label/);
});

test("a dedicated bot and a debate persona are distinguishable, not just differently worded", () => {
  // Class, marker text and tooltip all differ — the two bindings mean genuinely different things.
  assert.match(src, /binding\.kind === "panel" \? "panel" : ""/);
  assert.match(src, /speaks as this agent in Slack debates/);
  assert.match(src, /answers as this agent in Slack/);
  assert.match(css, /\.agent-slack-chip\.panel \{/);
});

test("the chip reuses the shared Slack glyph rather than a second copy of the mark", () => {
  assert.match(src, /import \{ slackLogo \} from "\.\/sessions"/);
  assert.match(src, /\$\{slackLogo\(11\)\}/);
});

test("a dedicated bot wins over a debate persona when an agent carries both", () => {
  // Sorting panel-first and building the Map second means the "bot" entry overwrites it.
  assert.match(src, /a\.kind === "panel" \? -1 : 1/);
});

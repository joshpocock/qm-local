import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

/**
 * Why a Slack-mirrored room's `@qm-cc` stayed flat text while the very same roster painted
 * as chips in the header above it.
 *
 * Chips resolve their roster from a `data-mention-thread` attribute on the message stack
 * (see `mention-markdown.ts`). The live transcript stamps it; the read-only pane — the one
 * every Slack-mirrored session mounts through — drew a bare `<div class="message-stack">`,
 * so `stackFor()` found nothing, `targetsForNode()` returned an empty roster, and the paint
 * declined. The header was never affected because `chatHeader` is handed `s.room` directly.
 *
 * Two halves below: the mechanism, proved against real DOM, and the wiring, asserted on the
 * source (chat.ts pulls in bundler-only extensionless imports, so it cannot be imported by
 * node:test — same reason `agent-slack-chip-source.test.ts` reads source).
 */

// ---------------------------------------------------------------------------
// The mechanism: an attributed stack paints, an unattributed one does not
// ---------------------------------------------------------------------------

interface MentionModules {
  roomState: {
    cachePersonas: (agents: unknown[]) => void;
    noteRoom: (threadRef: string, config: { personaIds: string[]; rounds: number } | null) => void;
    resetRoomState: () => void;
  };
  mentionMarkdown: {
    MENTION_THREAD_ATTR: string;
    syncMentionTargets: (host: Element | null | undefined) => void;
    mentionTargetsForThread: (threadRef: string | null) => Array<{ name: string }>;
  };
}

async function withMentionModules(run: (mods: MentionModules) => Promise<void> | void) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/web-ui/" });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    appState.me = { user: "owner", org: "acme" };
    const roomState = (await vite.ssrLoadModule("/src/room-state.ts")) as unknown as MentionModules["roomState"];
    const mentionMarkdown = (await vite.ssrLoadModule(
      "/src/mention-markdown.ts",
    )) as unknown as MentionModules["mentionMarkdown"];
    roomState.resetRoomState();
    await run({ roomState, mentionMarkdown });
  } finally {
    await vite.close();
    dom.window.close();
  }
}

/** The stack a mirrored Slack room's transcript is, reduced to the part that matters. */
function stack(threadRef: string | null, attr: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "message-stack";
  if (threadRef !== null) el.setAttribute(attr, threadRef);
  el.innerHTML = "<p>@qm-cc @qm-codex — which is better for this?</p>";
  return el;
}

const SLACK_THREAD = "ch:C0GEN:1712345678.000100";
const ROSTER = [
  { id: "ap_cc", name: "qm-cc", color: "#4f46e5", glyph: "C", enabled: true, instructions: "", harnessId: "h", modelId: "m", scope: "org" },
  { id: "ap_codex", name: "qm-codex", color: "#059669", glyph: "X", enabled: true, instructions: "", harnessId: "h", modelId: "m", scope: "org" },
];

test("a mirrored Slack room's stack paints its roster once it names its thread", async () => {
  await withMentionModules(async ({ roomState, mentionMarkdown }) => {
    roomState.cachePersonas(ROSTER);
    roomState.noteRoom(SLACK_THREAD, { personaIds: ["ap_cc", "ap_codex"], rounds: 2 });
    assert.equal(
      mentionMarkdown.mentionTargetsForThread(SLACK_THREAD).length,
      3,
      "two roster agents plus the viewer — persona resolution works for a Slack threadRef",
    );

    // This is exactly what the read-only pane used to render: no data-mention-thread.
    const bare = stack(null, mentionMarkdown.MENTION_THREAD_ATTR);
    mentionMarkdown.syncMentionTargets(bare);
    assert.equal(bare.querySelectorAll(".mention-chip").length, 0, "the old bug, reproduced");
    assert.match(bare.textContent ?? "", /@qm-cc @qm-codex/, "and the text stayed plain");

    // And this is what it renders now.
    const attributed = stack(SLACK_THREAD, mentionMarkdown.MENTION_THREAD_ATTR);
    mentionMarkdown.syncMentionTargets(attributed);
    const chips = [...attributed.querySelectorAll(".mention-chip")];
    assert.deepEqual(
      chips.map((c) => c.textContent),
      ["@qm-cc", "@qm-codex"],
      "both roster mentions paint, exactly as they do in a web room",
    );
    assert.deepEqual(
      chips.map((c) => c.getAttribute("data-mention-id")),
      ["ap_cc", "ap_codex"],
    );
    assert.match(attributed.textContent ?? "", /which is better for this\?/, "the rest of the line is untouched");
  });
});

test("a Slack session with no room paints nothing, however it is attributed", async () => {
  await withMentionModules(async ({ roomState, mentionMarkdown }) => {
    roomState.cachePersonas(ROSTER);
    // A mirrored DM that is not a room: an `@` means nothing to core there, so it must go on
    // meaning nothing on screen.
    const el = stack("dm:D0BOSS", mentionMarkdown.MENTION_THREAD_ATTR);
    mentionMarkdown.syncMentionTargets(el);
    assert.equal(el.querySelectorAll(".mention-chip").length, 0);
  });
});

test("the paint repeats safely when the roster lands after the first draw", async () => {
  await withMentionModules(async ({ roomState, mentionMarkdown }) => {
    roomState.noteRoom(SLACK_THREAD, { personaIds: ["ap_cc", "ap_codex"], rounds: 2 });
    const el = stack(SLACK_THREAD, mentionMarkdown.MENTION_THREAD_ATTR);
    // Cold persona cache — the state right after a reload, which is why mountReadOnly warms
    // it and syncs again rather than trusting the first pass.
    mentionMarkdown.syncMentionTargets(el);
    assert.equal(el.querySelectorAll(".mention-chip").length, 0, "unresolvable ids are dropped, never guessed at");

    roomState.cachePersonas(ROSTER);
    mentionMarkdown.syncMentionTargets(el);
    assert.equal(el.querySelectorAll(".mention-chip").length, 2, "the warmed cache repaints");
    // A third sync with nothing changed must not double-wrap the chips it already painted.
    mentionMarkdown.syncMentionTargets(el);
    assert.equal(el.querySelectorAll(".mention-chip").length, 2);
  });
});

// ---------------------------------------------------------------------------
// The wiring: the read-only pane satisfies that contract
// ---------------------------------------------------------------------------

const chatSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/chat.ts"), "utf8");
const mountReadOnly = chatSrc.slice(chatSrc.indexOf("function mountReadOnly("));
const mountReadOnlyBody = mountReadOnly.slice(0, mountReadOnly.indexOf("\n  }\n"));

test("the read-only stack names its thread, so a chip can find a roster to resolve against", () => {
  assert.match(
    mountReadOnlyBody,
    /<div class="message-stack" data-mention-thread=\$\{s\.threadRef\}>/,
    "the session's own ref — the read-only pane clears chatState.threadRef before it draws",
  );
});

test("the read-only pane notes the session's room, so it never depends on a sessions refresh", () => {
  assert.match(mountReadOnlyBody, /noteRoom\(s\.threadRef, s\.room \?\? null\);/);
  assert.ok(
    mountReadOnlyBody.indexOf("noteRoom(s.threadRef") < mountReadOnlyBody.indexOf("const draw = () =>"),
    "noted before the first draw, or the first draw resolves an empty roster",
  );
});

test("the read-only pane syncs chips after drawing, and again once the persona cache warms", () => {
  assert.match(mountReadOnlyBody, /syncMentionTargets\(host\);/);
  assert.ok(
    mountReadOnlyBody.indexOf("container.replaceChildren(host)") < mountReadOnlyBody.indexOf("syncMentionTargets(host)"),
    "synced against the attached tree",
  );
  assert.match(
    mountReadOnlyBody,
    /if \(isRoomThread\(s\.threadRef\)\) \{\s*\n\s*void ensureRoomPersonas\(\)\.then\(\(\) => \{/,
    "the same warm-then-repaint the live transcript does at mount",
  );
  assert.match(
    mountReadOnlyBody,
    /if \(readOnlyView\?\.id !== s\.id\) return;/,
    "a pane the viewer has already navigated away from is not repainted",
  );
});

test("the mention grammar itself is untouched: the read-only path only supplies context", () => {
  // Nothing in the fix may reach into how a mention is matched — `matchesAt` mirrors core's
  // `mentionAt`, and the two must not drift.
  assert.equal(/matchesAt|mentionAt/.test(mountReadOnlyBody), false);
  assert.equal(/decorateMentions\(/.test(mountReadOnlyBody), false, "it goes through syncMentionTargets, not the paint");
});

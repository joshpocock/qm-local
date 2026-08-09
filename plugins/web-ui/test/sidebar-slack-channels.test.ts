import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { CoreContext, CoreSession } from "../src/core-bridge.ts";

/**
 * The sidebar's Slack section, drawn for real.
 *
 * The mental model these assert: the CHANNEL is the room and the THREADS inside it are where
 * the context lives, so the sidebar mirrors Slack's own shape. Five debate threads in one
 * channel are one `#channel` heading with five children, not five near-identical rows — and
 * never a second copy of themselves under Rooms.
 *
 * Driven through `renderList()` rather than the grouping helper alone, because the bug this
 * replaces was a *rendering* one: `groupSlackChannels` can be perfect while the list still
 * paints rows flat.
 */

function saved(id: string, threadRef: string, extra: Partial<CoreSession> = {}): CoreSession {
  return {
    id,
    type: "dm",
    scopeId: "",
    threadRef,
    createdAt: 1,
    title: null,
    channelName: null,
    archived: false,
    ...extra,
  };
}

function thread(id: string, channelId: string, ts: string, at: number, title: string, channelName: string): CoreSession {
  return saved(id, `ch:${channelId}:${ts}`, { type: "channel", channelName, title, lastActivityAt: at });
}

interface SessionsModule {
  renderList: () => void;
  sessionsState: { list: CoreSession[]; collapsedSlackChannels: Set<string> };
  contextsState: { list: CoreContext[] };
}

async function withSidebar(run: (mod: SessionsModule) => Promise<void> | void) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/web-ui/" });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    DragEvent: dom.window.DragEvent,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  globalThis.fetch = async (input: RequestInfo | URL) => {
    // A room row warms the persona cache off `/api/agents` as a side effect of rendering its
    // roster dots — irrelevant here, so answer it with an empty roster.
    if (String(input).endsWith("/api/agents")) return Response.json({ agents: [] });
    throw new Error(`Unexpected request in sidebar-slack-channels test: ${String(input)}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const sessionsMod = (await vite.ssrLoadModule("/src/sessions.ts")) as unknown as SessionsModule;
    // Same module graph as sessions.ts's own `import { contextsState } from "./contexts"` —
    // vite dedupes by resolved path, so this is the very same singleton object. The module
    // namespace vite hands back is non-extensible, so build a plain object to pass through
    // rather than mutating it.
    const { contextsState } = await vite.ssrLoadModule("/src/contexts.ts");
    appState.me = { user: "owner", org: "acme" };
    appState.currentView = "chats";
    const app = document.querySelector<HTMLElement>("#app")!;
    appState.mainEl = app;
    appState.topEl = app;
    appState.listEl = app;
    await run({ ...sessionsMod, contextsState });
  } finally {
    await vite.close();
    // renderList arms a timer for the next midnight; closing the window drops it so the
    // test runner's event loop can drain.
    dom.window.close();
  }
}

/** The Slack section as a flat script: headings, and rows at their nesting depth. */
function slackShape(): string[] {
  const head = document.querySelector(".recents-group.slack-head");
  const out: string[] = [];
  for (let el = head?.nextElementSibling ?? null; el; el = el.nextElementSibling) {
    if (el.classList.contains("recents-group") || el.classList.contains("archived-toggle")) break;
    if (el.classList.contains("recent-project")) {
      out.push(`channel:${el.querySelector(".recent-project-name")?.textContent?.trim()}`);
      for (const child of el.querySelectorAll(".recent-project-children .session-row")) {
        out.push(`  thread:${child.querySelector(".tl")?.textContent?.trim()}`);
      }
      continue;
    }
    if (el.classList.contains("session-row")) out.push(`row:${el.querySelector(".tl")?.textContent?.trim()}`);
  }
  return out;
}

test("two channels of threads nest under one heading each, newest channel and thread first", async () => {
  await withSidebar(async ({ renderList, sessionsState }) => {
    sessionsState.list = [
      thread("g1", "C0GEN", "1.1", 10, "Old general thread", "general"),
      thread("r2", "C0RND", "2.2", 40, "Newer random thread", "random"),
      thread("g3", "C0GEN", "1.3", 30, "Middle general thread", "general"),
      thread("r1", "C0RND", "2.1", 20, "Older random thread", "random"),
      thread("g2", "C0GEN", "1.2", 50, "Newest general thread", "general"),
    ];
    renderList();
    assert.deepEqual(slackShape(), [
      "channel:#general",
      "  thread:Newest general thread",
      "  thread:Middle general thread",
      "  thread:Old general thread",
      "channel:#random",
      "  thread:Newer random thread",
      "  thread:Older random thread",
    ]);
    // Five threads across two channels, and not one of them at the top level of the section.
    assert.equal(document.querySelectorAll(".recent-project.slack-channel").length, 2);
    assert.equal(document.querySelectorAll(".recent-project.slack-channel .session-row").length, 5);
  });
});

test("a channel heading carries the thread count and the Slack glyph, not a folder", async () => {
  await withSidebar(async ({ renderList, sessionsState }) => {
    sessionsState.list = [
      thread("g1", "C0GEN", "1.1", 10, "One", "general"),
      thread("g2", "C0GEN", "1.2", 20, "Two", "general"),
    ];
    renderList();
    const group = document.querySelector(".recent-project.slack-channel")!;
    assert.equal(group.querySelector(".recent-project-count")?.textContent?.trim(), "2");
    assert.ok(group.querySelector(".recent-project-toggle .slack-logo"), "the channel is marked as Slack's");
    assert.equal(group.getAttribute("aria-label"), "#general channel");
  });
});

test("Slack debate threads never duplicate into the Rooms section", async () => {
  await withSidebar(async ({ renderList, sessionsState }) => {
    const room = { personaIds: ["ap_1", "ap_2"], rounds: 2 };
    sessionsState.list = [
      // Five near-identical panel threads in one channel — the exact shape that used to
      // produce five Rooms rows *and* five Slack rows.
      ...[1, 2, 3, 4, 5].map((n) => thread(`p${n}`, "C0GEN", `1.${n}`, n * 10, `Debate ${n}`, "general")),
      saved("w1", "web:u:room", { room, title: "Web Room", lastActivityAt: 99 }),
    ].map((s) => (s.threadRef.startsWith("ch:") ? { ...s, room } : s));
    renderList();
    const roomsHead = document.querySelector(".recents-group.rooms-head");
    assert.ok(roomsHead, "the web room still has its Rooms heading");
    const roomsRows: string[] = [];
    for (let el = roomsHead!.nextElementSibling; el && el.classList.contains("session-row"); el = el.nextElementSibling)
      roomsRows.push(el.querySelector(".tl")?.textContent?.trim() ?? "");
    assert.deepEqual(roomsRows, ["Web Room"], "only the web room; the Slack debates live under their channel");
    assert.deepEqual(slackShape(), [
      "channel:#general",
      "  thread:Debate 5",
      "  thread:Debate 4",
      "  thread:Debate 3",
      "  thread:Debate 2",
      "  thread:Debate 1",
    ]);
  });
});

test("Slack DMs stay flat, keeping their place in the section's recency order", async () => {
  await withSidebar(async ({ renderList, sessionsState }) => {
    sessionsState.list = [
      thread("g1", "C0GEN", "1.1", 50, "General thread", "general"),
      saved("dm1", "dm:D0BOSS", { type: "dm", title: "Ada", lastActivityAt: 35 }),
      thread("r1", "C0RND", "2.1", 20, "Random thread", "random"),
    ];
    renderList();
    assert.deepEqual(slackShape(), [
      "channel:#general",
      "  thread:General thread",
      "row:Ada",
      "channel:#random",
      "  thread:Random thread",
    ]);
    // A DM row is a top-level row, so it keeps the private chip a nested thread has no use for.
    const dmRow = [...document.querySelectorAll(".session-row")].find((el) =>
      el.querySelector(".tl")?.textContent?.includes("Ada"),
    )!;
    assert.ok(dmRow.querySelector(".private-chip"), "a DM still says it is private");
    assert.equal(dmRow.classList.contains("project-child"), false, "and it is not nested");
  });
});

test("a channel heading collapses and expands, and starts expanded", async () => {
  await withSidebar(async ({ renderList, sessionsState }) => {
    sessionsState.list = [
      thread("g1", "C0GEN", "1.1", 10, "One", "general"),
      thread("g2", "C0GEN", "1.2", 20, "Two", "general"),
    ];
    renderList();
    const toggle = () => document.querySelector<HTMLElement>(".slack-channel .recent-project-toggle")!;
    const children = () => document.querySelector<HTMLElement>(".slack-channel .recent-project-children")!;
    assert.equal(toggle().getAttribute("aria-expanded"), "true", "default expanded");
    assert.equal(children().hasAttribute("hidden"), false);
    assert.equal(children().id, toggle().getAttribute("aria-controls"), "the heading points at what it controls");

    toggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    assert.equal(toggle().getAttribute("aria-expanded"), "false");
    assert.equal(children().hasAttribute("hidden"), true, "collapsed hides the threads");
    assert.equal(sessionsState.collapsedSlackChannels.has("C0GEN"), true, "collapse state is kept by channel id");

    toggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    assert.equal(toggle().getAttribute("aria-expanded"), "true");
    assert.equal(children().hasAttribute("hidden"), false);
  });
});

test("a nested thread keeps its own root-derived title, unlike an untitled project child", async () => {
  await withSidebar(async ({ renderList, sessionsState }) => {
    sessionsState.list = [thread("g1", "C0GEN", "1.1", 10, "Which model is better for this?", "general")];
    renderList();
    const row = document.querySelector(".slack-channel .session-row")!;
    assert.equal(row.querySelector(".tl")?.textContent?.trim(), "Which model is better for this?");
    // Nested, so it takes the indent rail — but the channel heading above already says
    // "#general", so the row does not repeat it as a context label.
    assert.equal(row.classList.contains("project-child"), true);
    assert.equal(row.querySelector(".row-context"), null);
  });
});

test("no Slack sessions means no Slack heading at all", async () => {
  await withSidebar(async ({ renderList, sessionsState }) => {
    sessionsState.list = [saved("w1", "web:u:chat", { title: "Web Chat", lastActivityAt: 20 })];
    renderList();
    assert.equal(document.querySelector(".recents-group.slack-head"), null);
    assert.equal(document.querySelector(".recent-project.slack-channel"), null);
  });
});

function channelContext(scopeId: string, isPrivate?: boolean): CoreContext {
  return {
    scopeId,
    kind: "channel",
    name: null,
    sessionCount: 0,
    lastActivityAt: null,
    ...(isPrivate !== undefined ? { isPrivate } : {}),
  };
}

test("a private channel's heading carries the lock chip; a public one doesn't", async () => {
  await withSidebar(async ({ renderList, sessionsState, contextsState }) => {
    sessionsState.list = [
      thread("g1", "C0GEN", "1.1", 10, "One", "general"),
      thread("r1", "C0RND", "2.1", 20, "Two", "random"),
    ];
    contextsState.list = [channelContext("channel:C0GEN", true), channelContext("channel:C0RND", false)];
    renderList();
    const groups = [...document.querySelectorAll(".recent-project.slack-channel")];
    const byName = (name: string) => groups.find((g) => g.getAttribute("aria-label")?.startsWith(name))!;
    assert.ok(byName("#general").querySelector(".private-chip"), "isPrivate:true locks the heading");
    assert.equal(byName("#random").querySelector(".private-chip"), null, "isPrivate:false shows no chip");
  });
});

test("a channel heading shows no lock chip while contexts haven't loaded, or when the channel id has no matching scope", async () => {
  await withSidebar(async ({ renderList, sessionsState, contextsState }) => {
    sessionsState.list = [thread("g1", "C0GEN", "1.1", 10, "One", "general")];

    // Contexts not loaded yet: no false positive while the join has nothing to work with.
    contextsState.list = [];
    renderList();
    assert.equal(
      document.querySelector(".slack-channel .private-chip"),
      null,
      "no contexts loaded -> no chip, not a guess",
    );

    // A context list that simply has no scope for this channel (id mismatch) — same result.
    contextsState.list = [channelContext("channel:C0OTHER", true)];
    renderList();
    assert.equal(document.querySelector(".slack-channel .private-chip"), null, "no matching scope -> no chip");

    // Once the matching, private context loads, the same heading picks up the chip on its
    // next paint — exactly how a project heading re-renders once `ensureContexts` resolves.
    contextsState.list = [channelContext("channel:C0GEN", true)];
    renderList();
    assert.ok(document.querySelector(".slack-channel .private-chip"), "loaded + matching + private -> chip appears");
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { CoreContext, CoreSession } from "../src/core-bridge.ts";

/**
 * The Chats page's Slack section, drawn for real.
 *
 * Mirrors `sidebar-slack-channels.test.ts`'s premise on the Chats page instead of the
 * sidebar: Slack sessions get their own "Slack" section (between Rooms and Chats) with a
 * per-channel heading and nested thread rows, DMs stay flat inside that section, and the
 * "Chats" section is left with only non-Slack, non-room sessions.
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

interface SessionsModule {
  drawChatsPage: () => void;
  sessionsState: { list: CoreSession[]; collapsedSlackChannels: Set<string> };
  contextsState: { list: CoreContext[] };
}

async function withChatsPage(run: (mod: SessionsModule) => Promise<void> | void) {
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
    // roster dots — irrelevant to this test's assertions, so answer it with an empty roster
    // rather than mocking every caller's network layer.
    if (String(input).endsWith("/api/agents")) return Response.json({ agents: [] });
    throw new Error(`Unexpected request in chats-page-slack-section test: ${String(input)}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const sessionsMod = (await vite.ssrLoadModule("/src/sessions.ts")) as unknown as SessionsModule;
    // Same module graph as sessions.ts's own `import { contextsState } from "./contexts"` —
    // vite dedupes by resolved path, so this is the very same singleton object. The module
    // namespace vite hands back is non-extensible, so build a plain object to pass through.
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
  }
}

/** The rows list as a flat script: section heads, channel headings, and rows at their depth. */
function pageShape(): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll(".list-rows > *")) {
    if (el.classList.contains("list-section-head")) {
      out.push(`head:${el.querySelector("span")?.textContent}`);
    } else if (el.classList.contains("chat-slack-channel")) {
      out.push(`channel:${el.querySelector(".chat-slack-channel-name")?.textContent?.trim()}`);
      for (const row of el.querySelectorAll(".chat-slack-channel-children .list-row-title")) {
        out.push(`  thread:${row.textContent?.trim()}`);
      }
    } else if (el.classList.contains("chat-row")) {
      out.push(`row:${el.querySelector(".list-row-title")?.textContent?.trim()}`);
    }
  }
  return out;
}

test("drawChatsPage: Slack sessions leave Chats for their own section, with channels nested and DMs flat", async () => {
  await withChatsPage(async ({ drawChatsPage, sessionsState }) => {
    const webChat = saved("c1", "web:u:chat", { title: "Web Chat", lastActivityAt: 5 });
    sessionsState.list = [
      thread("g1", "C0GEN", "1.1", 50, "Newest general thread", "general"),
      thread("g2", "C0GEN", "1.2", 10, "Older general thread", "general"),
      saved("dm1", "dm:D0BOSS", { title: "Ada", lastActivityAt: 30 }),
      thread("r1", "C0RND", "2.1", 20, "Random thread", "random"),
      webChat,
    ];
    drawChatsPage();
    assert.deepEqual(pageShape(), [
      "head:Slack",
      "channel:#general",
      "  thread:Newest general thread",
      "  thread:Older general thread",
      "row:Ada",
      "channel:#random",
      "  thread:Random thread",
      "head:Chats",
      "row:Web Chat",
    ]);
    // Not one Slack row is left flat under "Chats" — the section is Slack-only now.
    const chatsHead = [...document.querySelectorAll(".list-section-head span")].find((s) => s.textContent === "Chats")!;
    let sibling = chatsHead.parentElement!.nextElementSibling;
    const chatsRows: string[] = [];
    while (sibling) {
      chatsRows.push(sibling.querySelector(".list-row-title")?.textContent?.trim() ?? "");
      sibling = sibling.nextElementSibling;
    }
    assert.deepEqual(chatsRows, ["Web Chat"]);
  });
});

test("drawChatsPage: a Slack room still files under Slack, not Rooms — same rule as the sidebar", async () => {
  await withChatsPage(async ({ drawChatsPage, sessionsState }) => {
    const room = { personaIds: ["ap_1", "ap_2"], rounds: 2 };
    const webRoom = saved("w1", "web:u:room", { room, title: "Web Room", lastActivityAt: 99 });
    sessionsState.list = [
      ...[1, 2, 3].map((n) => ({ ...thread(`p${n}`, "C0GEN", `1.${n}`, n * 10, `Debate ${n}`, "general"), room })),
      webRoom,
    ];
    drawChatsPage();
    const heads = [...document.querySelectorAll(".list-section-head span")].map((el) => el.textContent);
    assert.deepEqual(heads, ["Rooms", "Slack"], "no Chats heading — everything left is either a room or Slack");
    assert.deepEqual(pageShape(), [
      "head:Rooms",
      "row:Web Room",
      "head:Slack",
      "channel:#general",
      "  thread:Debate 3",
      "  thread:Debate 2",
      "  thread:Debate 1",
    ]);
  });
});

test("drawChatsPage: a private channel's heading carries the lock chip on the Chats page too", async () => {
  await withChatsPage(async ({ drawChatsPage, sessionsState, contextsState }) => {
    sessionsState.list = [thread("g1", "C0GEN", "1.1", 10, "One", "general")];
    contextsState.list = [channelContext("channel:C0GEN", true)];
    drawChatsPage();
    assert.ok(document.querySelector(".chat-slack-channel .private-chip"), "isPrivate:true locks the heading");
  });
});

test("drawChatsPage: search filters within the Slack section — a channel with no matching threads renders nothing", async () => {
  await withChatsPage(async ({ drawChatsPage, sessionsState }) => {
    sessionsState.list = [
      thread("g1", "C0GEN", "1.1", 10, "Talk about pricing", "general"),
      thread("r1", "C0RND", "2.1", 20, "Weekend plans", "random"),
      saved("dm1", "dm:D0BOSS", { title: "Pricing follow-up", lastActivityAt: 30 }),
    ];
    drawChatsPage();
    // Unfiltered, newest-first: the DM (30), then #random (20), then #general (10).
    assert.deepEqual(pageShape(), [
      "head:Slack",
      "row:Pricing follow-up",
      "channel:#random",
      "  thread:Weekend plans",
      "channel:#general",
      "  thread:Talk about pricing",
    ]);

    const search = document.querySelector<HTMLInputElement>(".list-search input")!;
    search.value = "pricing";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    // #random has no thread matching "pricing" — its whole channel heading disappears rather
    // than rendering empty, and the DM and #general's matching thread both survive.
    assert.deepEqual(pageShape(), ["head:Slack", "row:Pricing follow-up", "channel:#general", "  thread:Talk about pricing"]);
    assert.equal(document.querySelectorAll(".chat-slack-channel").length, 1);
  });
});

test("drawChatsPage: no Slack sessions means no Slack heading at all, and Chats is unaffected", async () => {
  await withChatsPage(async ({ drawChatsPage, sessionsState }) => {
    sessionsState.list = [saved("c1", "web:u:chat", { title: "Web Chat", lastActivityAt: 20 })];
    drawChatsPage();
    const heads = [...document.querySelectorAll(".list-section-head span")].map((el) => el.textContent);
    assert.deepEqual(heads, ["Chats"]);
    assert.equal(document.querySelector(".chat-slack-channel"), null);
  });
});

test("drawChatsPage: a Slack channel heading collapses and expands, sharing state with the sidebar's store", async () => {
  await withChatsPage(async ({ drawChatsPage, sessionsState }) => {
    sessionsState.list = [
      thread("g1", "C0GEN", "1.1", 10, "One", "general"),
      thread("g2", "C0GEN", "1.2", 20, "Two", "general"),
    ];
    drawChatsPage();
    const toggle = () => document.querySelector<HTMLElement>(".chat-slack-channel-head")!;
    const children = () => document.querySelector<HTMLElement>(".chat-slack-channel-children")!;
    assert.equal(toggle().getAttribute("aria-expanded"), "true", "default expanded");
    assert.equal(children().hasAttribute("hidden"), false);

    toggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    assert.equal(toggle().getAttribute("aria-expanded"), "false");
    assert.equal(children().hasAttribute("hidden"), true);
    assert.equal(sessionsState.collapsedSlackChannels.has("C0GEN"), true, "the same store the sidebar reads");

    toggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    assert.equal(toggle().getAttribute("aria-expanded"), "true");
    assert.equal(children().hasAttribute("hidden"), false);
  });
});

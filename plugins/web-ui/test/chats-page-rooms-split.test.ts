import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { CoreSession } from "../src/core-bridge.ts";

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

async function withChatsPage(run: (mod: { drawChatsPage: () => void; sessionsState: { list: CoreSession[] } }) => Promise<void> | void) {
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
    throw new Error(`Unexpected request in chats-page-rooms-split test: ${String(input)}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const sessionsMod = await vite.ssrLoadModule("/src/sessions.ts");
    appState.me = { user: "owner", org: "acme" };
    appState.currentView = "chats";
    const app = document.querySelector<HTMLElement>("#app")!;
    appState.mainEl = app;
    appState.topEl = app;
    appState.listEl = app;
    await run(sessionsMod as { drawChatsPage: () => void; sessionsState: { list: CoreSession[] } });
  } finally {
    await vite.close();
  }
}

test("drawChatsPage: rooms render in their own section ahead of chats, in DOM order", async () => {
  await withChatsPage(async ({ drawChatsPage, sessionsState }) => {
    const room = saved("r1", "web:u:room", {
      room: { personaIds: ["ap_1"], rounds: 1 },
      title: "Room One",
      lastActivityAt: 10,
    });
    const chat = saved("c1", "web:u:chat", { title: "Chat One", lastActivityAt: 20 });
    // List order is deliberately "most-recent-first" with the chat ahead of the room, so a
    // naive recency sort would put the chat first — proving the section split wins over
    // recency, not just that both rows happen to render.
    sessionsState.list = [chat, room];
    drawChatsPage();
    const sequence = [...document.querySelectorAll(".list-rows")[0]!.children].map((el) =>
      el.classList.contains("list-section-head")
        ? `head:${el.querySelector("span")?.textContent}`
        : `row:${el.querySelector(".list-row-title")?.textContent?.trim()}`,
    );
    assert.deepEqual(sequence, ["head:Rooms", "row:Room One", "head:Chats", "row:Chat One"]);
  });
});

test("drawChatsPage: an empty section renders no heading at all", async () => {
  await withChatsPage(async ({ drawChatsPage, sessionsState }) => {
    sessionsState.list = [saved("c1", "web:u:chat", { lastActivityAt: 20 })];
    drawChatsPage();
    const heads = [...document.querySelectorAll(".list-section-head span")].map((el) => el.textContent);
    assert.deepEqual(heads, ["Chats"], "no Rooms heading when there are no rooms");
  });
});

test("drawChatsPage: both sections empty still shows the ordinary empty state", async () => {
  await withChatsPage(async ({ drawChatsPage, sessionsState }) => {
    sessionsState.list = [];
    drawChatsPage();
    assert.equal(document.querySelectorAll(".list-section-head").length, 0);
    const empty = document.querySelector(".empty.compact");
    assert.ok(empty, "empty state renders");
    assert.match(empty!.textContent ?? "", /No conversations yet/);
  });
});

test("drawChatsPage: filters (surface) apply to both the Rooms and Chats sections", async () => {
  await withChatsPage(async ({ drawChatsPage, sessionsState }) => {
    const webRoom = saved("r1", "web:u:room", {
      room: { personaIds: ["ap_1"], rounds: 1 },
      title: "Web Room",
      lastActivityAt: 10,
    });
    const slackRoom = saved("r2", "dm:u:room2", {
      room: { personaIds: ["ap_1"], rounds: 1 },
      title: "Slack Room",
      lastActivityAt: 30,
    });
    const webChat = saved("c1", "web:u:chat", { title: "Web Chat", lastActivityAt: 20 });
    const slackChat = saved("c2", "dm:u:chat2", { title: "Slack Chat", lastActivityAt: 40 });
    sessionsState.list = [webRoom, slackRoom, webChat, slackChat];
    drawChatsPage();
    // Default surface is "all": every row should render across both sections.
    assert.equal(document.querySelectorAll(".chat-row").length, 4);

    const surfaceSelect = document.querySelector<HTMLSelectElement>(".list-select select")!;
    surfaceSelect.value = "web";
    surfaceSelect.dispatchEvent(new Event("change", { bubbles: true }));

    const heads = [...document.querySelectorAll(".list-section-head span")].map((el) => el.textContent);
    assert.deepEqual(heads, ["Rooms", "Chats"], "both sections still present, now web-only");
    const titles = [...document.querySelectorAll(".chat-row .list-row-title")].map((el) => el.textContent?.trim());
    assert.deepEqual(
      titles,
      ["Web Room", "Web Chat"],
      "the Slack room and Slack chat are filtered out of both sections, leaving only the web rows",
    );
  });
});

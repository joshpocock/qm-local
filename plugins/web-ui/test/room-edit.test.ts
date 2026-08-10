/**
 * Editing an existing room: the kebab that offers it, the dialog it opens pre-filled with
 * what the room is today, and the PUT that saving sends.
 *
 * Rendered rather than asserted against source text, because the whole point of the feature
 * is that the *same* dialog serves both create and edit — a pre-fill that silently stopped
 * arriving would leave the create path passing and quietly wipe a roster on every save.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { CoreSession } from "../src/core-bridge.ts";

interface SessionsModule {
  renderList: () => void;
  sessionsState: { list: CoreSession[]; openMenuId: string | null };
}

const AGENTS = [
  {
    id: "ap_scout",
    name: "Scout",
    color: "#2563eb",
    glyph: "SC",
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
    instructions: "",
    enabled: true,
    scope: "personal",
    scopeId: "personal:owner",
    createdBy: "owner",
    createdAt: 1,
    version: 1,
    editable: true,
  },
  {
    id: "ap_critic",
    name: "Critic",
    color: "#ba9926",
    glyph: "CR",
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
    instructions: "",
    enabled: true,
    scope: "personal",
    scopeId: "personal:owner",
    createdBy: "owner",
    createdAt: 1,
    version: 1,
    editable: true,
  },
];

function room(extra: Partial<CoreSession> = {}): CoreSession {
  return {
    id: "s1",
    type: "dm",
    scopeId: "",
    threadRef: "web:owner:room",
    createdAt: 1,
    title: "Pricing review",
    channelName: null,
    archived: false,
    lastActivityAt: 10,
    room: { personaIds: ["ap_scout"], rounds: 3 },
    ...extra,
  } as CoreSession;
}

interface Harness {
  sessions: SessionsModule;
  /** Every request the client made, in order, so a test can assert what saving sent. */
  requests: Array<{ path: string; method: string; body: unknown }>;
}

async function withSidebar(run: (h: Harness) => Promise<void> | void): Promise<void> {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", {
    value(this: HTMLDialogElement) {
      this.open = true;
    },
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
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLDialogElement: dom.window.HTMLDialogElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    DragEvent: dom.window.DragEvent,
    InputEvent: dom.window.InputEvent,
    SubmitEvent: dom.window.SubmitEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const requests: Harness["requests"] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    requests.push({ path, method: init?.method ?? "GET", body });
    if (path.endsWith("/api/agents")) return Response.json({ agents: AGENTS });
    if (path.includes("/room")) return Response.json({ session: room() });
    if (path === "/api/sessions") return Response.json({ sessions: [room()] });
    if (path.startsWith("/api/sessions/")) return Response.json({ session: room() });
    throw new Error(`Unexpected request in room-edit test: ${init?.method ?? "GET"} ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const sessions = (await vite.ssrLoadModule("/src/sessions.ts")) as unknown as SessionsModule;
    appState.me = { user: "owner", org: "acme" };
    appState.currentView = "chats";
    const app = document.querySelector<HTMLElement>("#app")!;
    appState.mainEl = document.querySelector("#main");
    appState.topEl = app;
    appState.listEl = app;
    await run({ sessions, requests });
  } finally {
    document.querySelector(".room-dialog-host")?.remove();
    await vite.close();
    // The sidebar arms a timer for the next midnight so relative times re-render; JSDOM backs
    // it with a real Node timer, which would hold the test runner open for hours.
    dom.window.close();
  }
}

/** Opens the room row's kebab and returns the "Edit room" option in it. */
function editRoomOption(): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>(".session-menu-option")].find((button) =>
    button.textContent?.includes("Edit room"),
  ) ?? null;
}

test("the room row's kebab offers Edit room; an ordinary chat's does not", async () => {
  await withSidebar(async ({ sessions }) => {
    const chat = { ...room(), id: "c1", threadRef: "web:owner:chat", title: "Just a chat", room: undefined };
    sessions.sessionsState.list = [room(), chat as CoreSession];

    sessions.sessionsState.openMenuId = "c1";
    sessions.renderList();
    assert.equal(editRoomOption(), null, "a chat has no room to edit");

    sessions.sessionsState.openMenuId = "s1";
    sessions.renderList();
    const option = editRoomOption();
    assert.ok(option, "the room row offers it, in the kebab every row already has");
    assert.equal(option.getAttribute("role"), "menuitem");
  });
});

test("Edit room opens the create dialog pre-filled with the room's name, roster and rounds", async () => {
  await withSidebar(async ({ sessions }) => {
    sessions.sessionsState.list = [room()];
    sessions.sessionsState.openMenuId = "s1";
    sessions.renderList();
    editRoomOption()!.click();
    // The roster list paints from /api/agents, which the dialog fetches as it opens.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dialog = document.querySelector(".room-dialog");
    assert.ok(dialog, "the same dialog the create path uses");
    assert.equal(dialog.querySelector("#room-dialog-title")?.textContent, "Edit room");
    assert.match(dialog.querySelector(".btn.primary")?.textContent ?? "", /Save room/);

    assert.equal(document.querySelector<HTMLInputElement>("#room-name")!.value, "Pricing review");

    const picked = [...dialog.querySelectorAll(".room-pick")]
      .filter((pick) => pick.getAttribute("aria-checked") === "true")
      .map((pick) => pick.querySelector(".room-pick-name")?.textContent);
    assert.deepEqual(picked, ["@Scout"], "the room's current roster is selected, and only it");

    // 3 is a quick pick, so the select carries it and no custom number input is shown.
    const rounds = dialog.querySelector<HTMLSelectElement>(".room-rounds-field select")!;
    assert.equal(rounds.getAttribute("data-select-value"), "3", "the room's own round count is selected");
    assert.equal(dialog.querySelector(".room-rounds-input"), null, "a quick pick needs no custom field");
  });
});

test("a custom round count opens the dialog on the number input, carrying the room's value", async () => {
  await withSidebar(async ({ sessions }) => {
    sessions.sessionsState.list = [room({ room: { personaIds: ["ap_scout"], rounds: 7 } })];
    sessions.sessionsState.openMenuId = "s1";
    sessions.renderList();
    editRoomOption()!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const custom = document.querySelector<HTMLInputElement>(".room-rounds-input");
    assert.ok(custom, "7 is not a quick pick, so the free number field is the one shown");
    assert.equal(custom.value, "7");
    assert.equal(custom.max, "20", "up to the ceiling core enforces");
  });
});

test("saving PUTs the edited roster and rounds against the room's own session", async () => {
  await withSidebar(async ({ sessions, requests }) => {
    sessions.sessionsState.list = [room()];
    sessions.sessionsState.openMenuId = "s1";
    sessions.renderList();
    editRoomOption()!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Add Critic to the roster, then save.
    const critic = [...document.querySelectorAll<HTMLButtonElement>(".room-pick")].find((pick) =>
      pick.textContent?.includes("@Critic"),
    )!;
    critic.click();
    document
      .querySelector<HTMLFormElement>(".room-dialog form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const put = requests.find((r) => r.method === "PUT" && r.path.endsWith("/room"));
    assert.ok(put, "an edit is a PUT against the session's room");
    assert.equal(put.path, "/api/sessions/s1/room");
    assert.deepEqual(put.body, { room: { personaIds: ["ap_scout", "ap_critic"], rounds: 3 } });
  });
});

test("a member the agent list no longer carries stays in the roster instead of vanishing on save", async () => {
  await withSidebar(async ({ sessions, requests }) => {
    // ap_ghost is archived: /api/agents never mentions it, but it is still in the room.
    sessions.sessionsState.list = [room({ room: { personaIds: ["ap_scout", "ap_ghost"], rounds: 1 } })];
    sessions.sessionsState.openMenuId = "s1";
    sessions.renderList();
    editRoomOption()!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const unavailable = [...document.querySelectorAll(".room-pick")].filter(
      (pick) => pick.querySelector(".badge")?.textContent === "Unavailable",
    );
    assert.equal(unavailable.length, 1, "it is shown, so removing it stays the operator's choice");

    document
      .querySelector<HTMLFormElement>(".room-dialog form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const put = requests.find((r) => r.method === "PUT" && r.path.endsWith("/room"));
    assert.deepEqual(
      (put!.body as { room: { personaIds: string[] } }).room.personaIds,
      ["ap_scout", "ap_ghost"],
      "saving an untouched dialog must not rewrite the roster",
    );
  });
});

// ---------------------------------------------------------------------------
// The live pane's own kebab, and the wiring that closes it
// ---------------------------------------------------------------------------

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const sessionsSrc = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");

test("a live room's banner carries the same kebab, offering the same Edit room", () => {
  const banner = chat.slice(chat.indexOf("function roomBannerMenu"));
  const body = banner.slice(0, banner.indexOf("\n  }"));
  assert.match(body, /if \(!row\?\.id\) return nothing;/, "a room with no session yet has nothing to PUT against");
  assert.match(body, /class="session-menu room-banner-menu/, "it reuses the sidebar kebab's markup and styling");
  assert.match(body, /aria-haspopup="menu"/);
  assert.match(body, /<span>Edit room<\/span>/);
  assert.match(body, /startRoomEdit\(row\)/, "and the one opener both surfaces share");
  assert.match(chat, /\$\{roomRosterChips\(room\)\}\$\{roomBannerMenu\(row\)\}/, "mounted in the banner itself");
});

test("the banner menu closes on a click or an Escape that landed outside it", () => {
  assert.match(chat, /export function closeRoomBannerMenu\(target\?: Element \| null\): boolean \{/);
  assert.match(chat, /if \(!roomMenuClosers\.size \|\| target\?\.closest\("\.room-banner-menu"\)\) return false;/);
  assert.match(main, /closeRoomBannerMenu\(target\);/, "the document click handler");
  assert.match(main, /closeRoomBannerMenu\(null\);/, "and the Escape handler");
  assert.match(chat, /roomMenuClosers\.delete\(closeRoomMenu\);/, "a torn-down pane deregisters itself");
});

/** The top-level function starting at `signature`, CRLF or LF — a Windows checkout is both. */
function functionBody(source: string, signature: string): string {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `${signature} not found`);
  const rest = source.slice(at);
  const end = rest.search(/\r?\n\}\r?\n/);
  assert.ok(end > 0, `${signature} has no closing brace`);
  return rest.slice(0, end);
}

test("saving an edit only persists — core re-reads the room per dispatch", () => {
  const body = functionBody(sessionsSrc, "async function saveRoomEdit");
  assert.match(body, /await updateSessionRoom\(s\.id, config\);/, "the roster and rounds go through the room PUT");
  assert.match(body, /noteRoom\(s\.threadRef \?\? null, config\);/, "the mounted thread's own copy is updated");
  assert.ok(
    body.indexOf("updateSessionRoom") < body.indexOf("noteRoom"),
    "nothing local moves until the write landed",
  );
  assert.match(body, /name === defaultRoomNameFor\(config\) \? null : name/, "a derived name is not stored as a title");
  assert.equal(
    /fetchTranscript|entriesToMessages|forkSession/.test(body),
    false,
    "an edit never reaches for the transcript: what was already said is not its business",
  );
});

/**
 * The debate-rounds ceiling, reached from the channel ROW rather than from inside a thread.
 *
 * The control shipped only under an open conversation's "lives in Slack" banner, and a
 * channel-global setting that can only be found inside one thread teaches that it is a
 * per-thread setting. These assert the second door: the kebab on the `#channel` heading, the
 * dialog it opens, and — the part that actually matters — that the dialog writes to the same
 * policy scope the in-conversation control does, through the same module.
 *
 * Rendered for real rather than asserted on source, because "the row's control and the
 * thread's control are the same control" is a claim about what gets fetched and PUT, not
 * about what the markup looks like.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { CoreSession } from "../src/core-bridge.ts";

interface SessionsModule {
  renderList: () => void;
  sessionsState: { list: CoreSession[]; openMenuId: string | null };
}

interface RoundsModule {
  channelRoundsScopeFor: (sessions: readonly { threadRef: string; scopeId?: string | null }[]) => string | null;
  channelRoundsState: { scope: string | null };
  closeChannelRoundsDialog: () => void;
}

interface Harness {
  sessions: SessionsModule;
  rounds: RoundsModule;
  /** Every request the client made, in order, so a test can assert the scope it hit. */
  requests: Array<{ path: string; method: string; body: Record<string, unknown> | null }>;
  policy: { debateRounds: number | null };
  /** Fail the next policy request with this status, then clear. */
  failNext: (status: number, message: string) => void;
}

function thread(id: string, channelId: string, ts: string, extra: Partial<CoreSession> = {}): CoreSession {
  return {
    id,
    type: "channel",
    scopeId: `channel:${channelId}`,
    threadRef: `ch:${channelId}:${ts}`,
    createdAt: 1,
    title: `Thread ${ts}`,
    channelName: "qm-agents",
    archived: false,
    lastActivityAt: Number(ts),
    ...extra,
  } as CoreSession;
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
  const policy = { orders: "", bots: {}, debateRounds: null as number | null, defaultDebateRounds: 3, updatedAt: 42 };
  let failure: { status: number; message: string } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ path, method: init?.method ?? "GET", body });
    if (path.endsWith("/api/agents")) return Response.json({ agents: [] });
    if (path.includes("/ambient-policy")) {
      if (failure) {
        const { status, message } = failure;
        failure = null;
        return new Response(JSON.stringify({ error: "forbidden", message }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "PUT" && body && "debateRounds" in body) {
        policy.debateRounds = body.debateRounds as number | null;
        policy.updatedAt += 1;
      }
      return Response.json({ policy });
    }
    throw new Error(`Unexpected request in channel-row-rounds test: ${init?.method ?? "GET"} ${path}`);
  }) as typeof fetch;

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const sessions = (await vite.ssrLoadModule("/src/sessions.ts")) as unknown as SessionsModule;
    const rounds = (await vite.ssrLoadModule("/src/channel-rounds.ts")) as unknown as RoundsModule;
    appState.me = { user: "owner", org: "acme" };
    appState.currentView = "chats";
    const app = document.querySelector<HTMLElement>("#app")!;
    appState.mainEl = document.querySelector("#main");
    appState.topEl = app;
    appState.listEl = app;
    await run({ sessions, rounds, requests, policy, failNext: (status, message) => (failure = { status, message }) });
  } finally {
    document.querySelector(".channel-rounds-dialog-host")?.remove();
    await vite.close();
    // The sidebar arms a timer for the next midnight so relative times re-render; JSDOM backs
    // it with a real Node timer, which would hold the test runner open for hours.
    dom.window.close();
  }
}

/**
 * The channel HEADING's kebab, or null when the row offers no options at all. Scoped to the
 * head: every thread nested under the heading carries a kebab of its own, and matching one of
 * those would make "the channel row has no menu" untestable.
 */
function channelKebab(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    ".recent-project.slack-channel > .recent-project-head .session-menu-btn",
  );
}

/** The "Debate rounds…" item, once the kebab is open. */
function roundsOption(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(".session-menu-channel-rounds");
}

/** Opens the kebab and clicks through to the dialog, settling the policy fetch. */
async function openRoundsDialog(sessions: SessionsModule, channelId = "C0AGENTS"): Promise<void> {
  sessions.sessionsState.openMenuId = `slack-channel:${channelId}`;
  sessions.renderList();
  roundsOption()!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// The row's kebab
// ---------------------------------------------------------------------------

test("the channel row carries a kebab whose one item is the debate-rounds editor", async () => {
  await withSidebar(async ({ sessions }) => {
    sessions.sessionsState.list = [thread("t1", "C0AGENTS", "1.1"), thread("t2", "C0AGENTS", "1.2")];
    sessions.renderList();

    const kebab = channelKebab();
    assert.ok(kebab, "the channel heading has the same '…' a project row and a room row have");
    assert.equal(kebab.getAttribute("aria-haspopup"), "menu");
    assert.equal(kebab.getAttribute("aria-expanded"), "false");
    assert.equal(kebab.dataset.menuId, "slack-channel:C0AGENTS", "keyed by channel, not by any one thread");
    assert.equal(roundsOption(), null, "closed until it is opened");

    sessions.sessionsState.openMenuId = "slack-channel:C0AGENTS";
    sessions.renderList();
    const option = roundsOption();
    assert.ok(option, "and it offers the setting the row could not reach before");
    assert.equal(option.getAttribute("role"), "menuitem");
    assert.match(option.textContent ?? "", /Debate rounds/);
    assert.equal(
      document.querySelectorAll(".recent-project.slack-channel .session-menu-option").length,
      1,
      "one item — the row is not a second home for everything a conversation can do",
    );
  });
});

test("a channel whose threads carry no policy scope offers no kebab at all", async () => {
  await withSidebar(async ({ sessions }) => {
    // Same shape, but core stamped no channel scope on these threads — there is nowhere to
    // store a ceiling, and the open conversation shows no control either.
    sessions.sessionsState.list = [thread("t1", "C0AGENTS", "1.1", { scopeId: "" })];
    sessions.renderList();
    assert.equal(channelKebab(), null, "no scope, no setting, no menu");
    assert.equal(
      document.querySelector(".recent-project.slack-channel .recent-project-count")?.textContent?.trim(),
      "1",
      "and the thread count is still shown",
    );
  });
});

test("the scope the row edits is the one its threads carry, by the conversation's own rule", async () => {
  await withSidebar(({ rounds }) => {
    assert.equal(rounds.channelRoundsScopeFor([{ threadRef: "ch:C1:1.1", scopeId: "channel:C1" }]), "channel:C1");
    assert.equal(rounds.channelRoundsScopeFor([{ threadRef: "ch:G1:1.1", scopeId: "group:G1" }]), "group:G1");
    assert.equal(
      rounds.channelRoundsScopeFor([{ threadRef: "ch:C1:1.1", scopeId: "org:acme" }]),
      null,
      "a scope that is not a channel policy scope has nowhere to store a ceiling",
    );
    assert.equal(rounds.channelRoundsScopeFor([{ threadRef: "dm:D1", scopeId: "channel:D1" }]), null);
    assert.equal(rounds.channelRoundsScopeFor([]), null);
    assert.equal(
      rounds.channelRoundsScopeFor([
        { threadRef: "ch:C1:1.1", scopeId: null },
        { threadRef: "ch:C1:1.2", scopeId: "channel:C1" },
      ]),
      "channel:C1",
      "one usable thread is enough — a thread mirrored before its scope resolved is skipped",
    );
  });
});

// ---------------------------------------------------------------------------
// The dialog, and what it writes
// ---------------------------------------------------------------------------

test("the item opens a dialog hosting the very same control, against the channel's scope", async () => {
  await withSidebar(async ({ sessions, rounds, requests }) => {
    sessions.sessionsState.list = [thread("t1", "C0AGENTS", "1.1")];
    await openRoundsDialog(sessions);

    const dialog = document.querySelector(".channel-rounds-dialog");
    assert.ok(dialog, "the row's door opens a dialog, not a second inline card");
    assert.match(dialog.querySelector("#channel-rounds-dialog-title")?.textContent ?? "", /Debate rounds/);
    assert.match(dialog.textContent ?? "", /#qm-agents/, "it names the channel the row named");

    assert.ok(dialog.querySelector(".channel-rounds"), "and hosts channelRoundsControl itself, not a copy of it");
    assert.equal(rounds.channelRoundsState.scope, "channel:C0AGENTS");

    const read = requests.find((r) => r.method === "GET" && r.path.includes("/ambient-policy"));
    assert.ok(read, "the module's own load ran");
    assert.equal(
      read.path,
      "/api/contexts/channel%3AC0AGENTS/ambient-policy",
      "the container is the channel scope the threads carry — the same one the conversation uses",
    );
    assert.equal(
      requests.filter((r) => r.path.includes("/ambient-policy")).length,
      1,
      "one fetch, from the one module — the dialog has no fetch of its own",
    );
  });
});

test("the dialog says whether the number is the channel's own or the org's, and can set both", async () => {
  await withSidebar(async ({ sessions, requests, policy }) => {
    sessions.sessionsState.list = [thread("t1", "C0AGENTS", "1.1")];
    await openRoundsDialog(sessions);

    const summary = (): string =>
      (document.querySelector(".channel-rounds-summary")?.textContent ?? "").replace(/\s+/gu, " ").trim();
    assert.equal(summary(), "3 rounds · org default", "no override yet");

    const select = document.querySelector<HTMLSelectElement>(".channel-rounds-dialog .channel-rounds select")!;
    select.value = "2";
    select.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const put = requests.find((r) => r.method === "PUT")!;
    assert.equal(put.path, "/api/contexts/channel%3AC0AGENTS/ambient-policy", "written to the channel, not a thread");
    assert.equal(put.body!.debateRounds, 2);
    assert.equal(put.body!.baseUpdatedAt, 42, "under the snapshot it loaded, so a concurrent edit 409s");
    assert.equal(summary(), "2 rounds · this channel", "and the origin label flips");

    select.value = "default";
    select.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cleared = requests.filter((r) => r.method === "PUT").at(-1)!;
    assert.equal(cleared.body!.debateRounds, null, "null clears — an omitted key would have preserved the 2");
    assert.equal(policy.debateRounds, null);
    assert.equal(summary(), "3 rounds · org default");
  });
});

test("a channel whose policy the viewer cannot read says so instead of showing an inert dropdown", async () => {
  await withSidebar(async ({ sessions, failNext }) => {
    sessions.sessionsState.list = [thread("t1", "C0AGENTS", "1.1")];
    failNext(403, "forbidden");
    await openRoundsDialog(sessions);

    assert.ok(document.querySelector(".channel-rounds-dialog"), "the dialog still opened");
    assert.equal(document.querySelector(".channel-rounds"), null, "no dropdown that cannot do anything");
    assert.match(document.querySelector(".channel-rounds-unavailable")?.textContent ?? "", /\S/);
  });
});

test("closing hands the shared state back to whatever channel was loaded before", async () => {
  await withSidebar(async ({ sessions, rounds, requests }) => {
    sessions.sessionsState.list = [thread("t1", "C0AGENTS", "1.1"), thread("t2", "C0OTHER", "2.1")];
    // The module holds ONE channel's policy at a time. Load C0OTHER first — standing in for a
    // conversation of that channel being on screen — then borrow the state for C0AGENTS from
    // the row's dialog. Closing has to give it back, or the open conversation's own control
    // would sit blank until its pane remounted.
    await openRoundsDialog(sessions, "C0OTHER");
    assert.equal(rounds.channelRoundsState.scope, "channel:C0OTHER");
    rounds.closeChannelRoundsDialog();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await openRoundsDialog(sessions, "C0AGENTS");
    assert.equal(rounds.channelRoundsState.scope, "channel:C0AGENTS");
    rounds.closeChannelRoundsDialog();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(
      rounds.channelRoundsState.scope,
      "channel:C0OTHER",
      "the channel that owned the state before the dialog opened has it back",
    );
    assert.equal(document.querySelector(".channel-rounds-dialog"), null, "and the dialog is gone");
    assert.ok(
      requests.filter((r) => r.path.includes("/ambient-policy")).length >= 3,
      "restoring re-reads rather than trusting a stale snapshot",
    );
  });
});

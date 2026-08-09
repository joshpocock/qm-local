import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

/**
 * The per-channel debate-rounds ceiling, on the surface a human can actually reach.
 *
 * The control existed before this test — in the admin app's Governance card, which only unhides
 * for a channel scope behind a view with no scope picker, so nobody could open it. What these
 * assert is the reachable placement and the one distinction that makes the number readable at a
 * glance: whether it is THIS CHANNEL's override or the ORG DEFAULT it is inheriting.
 *
 * Rendered for real (lit into JSDOM) rather than asserted on source, because the interesting
 * behaviour is what the control says after a load and what it PUTs after a change. The chat.ts
 * wiring is source-asserted at the bottom — chat.ts uses bundler-only extensionless imports and
 * cannot be imported by node:test, the same reason `readonly-mention-chips.test.ts` reads source.
 */

interface Policy {
  orders: string;
  bots: Record<string, { mode: string; rollupHours?: number }>;
  debateRounds: number | null;
  defaultDebateRounds: number;
  updatedAt: number;
}

interface RoundsModule {
  channelRoundsApplies: (s: { threadRef: string; scopeId?: string | null }) => boolean;
  channelRoundsControl: (scopeId: string) => unknown;
  loadChannelRounds: (scopeId: string, onChange: () => void) => Promise<void>;
  resetChannelRounds: () => void;
  effectiveChannelRounds: () => number;
  channelRoundsSource: () => string;
  channelRoundsState: { saving: boolean; rounds: number | null; defaultRounds: number };
}

interface Harness {
  rounds: RoundsModule;
  render: (scopeId: string) => void;
  host: HTMLElement;
  puts: Array<Record<string, unknown>>;
  policy: Policy;
  /** Fail the next policy request with this status, then clear. */
  failNext: (status: number, message: string) => void;
}

async function withControl(policy: Policy, run: (h: Harness) => Promise<void> | void): Promise<void> {
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
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const puts: Array<Record<string, unknown>> = [];
  let failure: { status: number; message: string } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("/ambient-policy")) throw new Error(`Unexpected request: ${url}`);
    if (failure) {
      const { status, message } = failure;
      failure = null;
      return new Response(JSON.stringify({ error: "forbidden", message }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      puts.push(body);
      // Core's contract: an omitted key preserves, null clears, a number narrows.
      if ("debateRounds" in body) policy.debateRounds = body.debateRounds as number | null;
      if (typeof body.orders === "string") policy.orders = body.orders;
      policy.updatedAt += 1;
    }
    return Response.json({ policy });
  }) as typeof fetch;

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const lit = (await vite.ssrLoadModule("lit")) as { render: (t: unknown, el: HTMLElement) => void };
    const mod = (await vite.ssrLoadModule("/src/channel-rounds.ts")) as unknown as RoundsModule;
    mod.resetChannelRounds();
    const host = document.querySelector<HTMLElement>("#app")!;
    const draw = (scopeId: string): void => void lit.render(mod.channelRoundsControl(scopeId), host);
    await run({
      rounds: mod,
      render: draw,
      host,
      puts,
      policy,
      failNext: (status, message) => (failure = { status, message }),
    });
  } finally {
    await vite.close();
    dom.window.close();
  }
}

function basePolicy(over: Partial<Policy> = {}): Policy {
  return { orders: "", bots: {}, debateRounds: null, defaultDebateRounds: 3, updatedAt: 42, ...over };
}

const SCOPE = "channel:C0BNEDKR7E3";

/** The control's summary line, whitespace-normalised. */
function summary(): string {
  return (document.querySelector(".channel-rounds-summary")?.textContent ?? "").replace(/\s+/gu, " ").trim();
}

function picker(): HTMLSelectElement {
  const el = document.querySelector<HTMLSelectElement>(".channel-rounds select");
  assert.ok(el, "the rounds picker is on screen");
  return el;
}

// ---------------------------------------------------------------------------
// Where it applies
// ---------------------------------------------------------------------------

test("the control belongs to Slack CHANNELS — not DMs, not web chats", async () => {
  await withControl(basePolicy(), ({ rounds }) => {
    assert.equal(rounds.channelRoundsApplies({ threadRef: "ch:C1:1712.0001", scopeId: "channel:C1" }), true);
    assert.equal(rounds.channelRoundsApplies({ threadRef: "ch:G1:1712.0001", scopeId: "group:G1" }), true);
    // A 1:1 DM is one bot taking one round — a ceiling there would have nothing to do.
    assert.equal(rounds.channelRoundsApplies({ threadRef: "dm:D1", scopeId: "channel:D1" }), false);
    assert.equal(rounds.channelRoundsApplies({ threadRef: "web:abc", scopeId: "org:acme" }), false);
    // A channel thread whose scope is not a channel policy scope has nowhere to store one.
    assert.equal(rounds.channelRoundsApplies({ threadRef: "ch:C1:1712.0001", scopeId: "org:acme" }), false);
    assert.equal(rounds.channelRoundsApplies({ threadRef: "ch:C1:1712.0001", scopeId: null }), false);
  });
});

// ---------------------------------------------------------------------------
// Effective value, and where it came from
// ---------------------------------------------------------------------------

test("with no override the channel shows the org default, and says so", async () => {
  await withControl(basePolicy({ debateRounds: null, defaultDebateRounds: 3 }), async (h) => {
    await h.rounds.loadChannelRounds(SCOPE, () => h.render(SCOPE));
    h.render(SCOPE);
    assert.equal(h.rounds.effectiveChannelRounds(), 3);
    assert.equal(h.rounds.channelRoundsSource(), "org default");
    assert.equal(summary(), "3 rounds · org default");
    assert.equal(picker().value, "default", "the picker sits on Inherit, not on a number");
    assert.match(
      picker().textContent ?? "",
      /Org default \(3 rounds\)/,
      "and the inherit option names the number it is inheriting",
    );
  });
});

test("with an override the same number reads as the channel's own", async () => {
  await withControl(basePolicy({ debateRounds: 3, defaultDebateRounds: 3 }), async (h) => {
    await h.rounds.loadChannelRounds(SCOPE, () => h.render(SCOPE));
    h.render(SCOPE);
    assert.equal(h.rounds.effectiveChannelRounds(), 3);
    // The distinction the whole control exists for: 3 because someone set 3 here, versus 3
    // because the org says 3 and this channel never chose.
    assert.equal(h.rounds.channelRoundsSource(), "this channel");
    assert.equal(summary(), "3 rounds · this channel");
    assert.equal(picker().value, "3");
  });
});

test("an override above the quick picks opens on the custom input, filled in", async () => {
  await withControl(basePolicy({ debateRounds: 7, defaultDebateRounds: 1 }), async (h) => {
    await h.rounds.loadChannelRounds(SCOPE, () => h.render(SCOPE));
    h.render(SCOPE);
    assert.equal(picker().value, "custom");
    const input = document.querySelector<HTMLInputElement>(".channel-rounds-input");
    assert.ok(input, "the number input is on screen for an out-of-quick-pick override");
    assert.equal(input.value, "7");
    assert.equal(summary(), "7 rounds · this channel");
  });
});

// ---------------------------------------------------------------------------
// Setting and clearing
// ---------------------------------------------------------------------------

test("picking a number writes an override and flips the label to this channel", async () => {
  await withControl(basePolicy({ debateRounds: null, defaultDebateRounds: 1 }), async (h) => {
    await h.rounds.loadChannelRounds(SCOPE, () => h.render(SCOPE));
    h.render(SCOPE);
    assert.equal(summary(), "1 round · org default");

    const select = picker();
    select.value = "3";
    select.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    h.render(SCOPE);

    assert.equal(h.puts.length, 1);
    assert.equal(h.puts[0]!.debateRounds, 3);
    assert.equal(h.puts[0]!.baseUpdatedAt, 42, "sent under the snapshot it loaded, so a concurrent edit 409s");
    assert.equal(h.puts[0]!.orders, "", "the channel's standing orders are round-tripped, not rewritten");
    assert.equal(summary(), "3 rounds · this channel");
  });
});

test("a rounds change never rewrites the channel's standing orders or bot ledger", async () => {
  const policy = basePolicy({
    orders: "flag anything that could delay the launch",
    bots: { Deploybot: { mode: "rollup", rollupHours: 4 } },
    debateRounds: null,
    defaultDebateRounds: 1,
  });
  await withControl(policy, async (h) => {
    await h.rounds.loadChannelRounds(SCOPE, () => h.render(SCOPE));
    h.render(SCOPE);
    const select = picker();
    select.value = "2";
    select.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(h.puts[0]!.orders, "flag anything that could delay the launch");
    assert.deepEqual(h.puts[0]!.bots, { Deploybot: { mode: "rollup", rollupHours: 4 } });
    assert.equal(policy.orders, "flag anything that could delay the launch");
  });
});

test("choosing the org default clears the override back to inheriting", async () => {
  await withControl(basePolicy({ debateRounds: 3, defaultDebateRounds: 5 }), async (h) => {
    await h.rounds.loadChannelRounds(SCOPE, () => h.render(SCOPE));
    h.render(SCOPE);
    assert.equal(summary(), "3 rounds · this channel");

    const select = picker();
    select.value = "default";
    select.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    h.render(SCOPE);

    assert.equal(h.puts[0]!.debateRounds, null, "null clears — an omitted key would have preserved the 3");
    assert.equal(h.policy.debateRounds, null);
    assert.equal(summary(), "5 rounds · org default");
  });
});

test("a custom pick waits for a committed number before writing anything", async () => {
  await withControl(basePolicy({ debateRounds: null, defaultDebateRounds: 2 }), async (h) => {
    await h.rounds.loadChannelRounds(SCOPE, () => h.render(SCOPE));
    h.render(SCOPE);

    const select = picker();
    select.value = "custom";
    select.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    h.render(SCOPE);
    assert.equal(h.puts.length, 0, "opening the input is not itself an edit");

    const input = document.querySelector<HTMLInputElement>(".channel-rounds-input")!;
    assert.equal(input.value, "2", "it opens on the effective number, not on blank");
    input.value = "12";
    input.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    h.render(SCOPE);
    assert.equal(h.puts.length, 1);
    assert.equal(h.puts[0]!.debateRounds, 12);
    assert.equal(summary(), "12 rounds · this channel");
  });
});

test("an out-of-range custom number is refused locally instead of being sent", async () => {
  await withControl(basePolicy({ debateRounds: 7, defaultDebateRounds: 1 }), async (h) => {
    await h.rounds.loadChannelRounds(SCOPE, () => h.render(SCOPE));
    h.render(SCOPE);
    const input = document.querySelector<HTMLInputElement>(".channel-rounds-input")!;
    input.value = "99";
    input.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    h.render(SCOPE);
    assert.equal(h.puts.length, 0);
    assert.match(document.querySelector(".channel-rounds-status")?.textContent ?? "", /whole number from 1 to 20/);
    assert.equal(summary(), "7 rounds · this channel", "and the stored value is untouched");
  });
});

test("a channel whose policy a member cannot read renders no control at all", async () => {
  await withControl(basePolicy(), async (h) => {
    h.failNext(403, "forbidden");
    await h.rounds.loadChannelRounds(SCOPE, () => h.render(SCOPE));
    h.render(SCOPE);
    assert.equal(document.querySelector(".channel-rounds"), null, "an inert dropdown would be worse than nothing");
  });
});

// ---------------------------------------------------------------------------
// The wiring, on source
// ---------------------------------------------------------------------------

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const control = readFileSync(new URL("../src/channel-rounds.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("the read-only Slack pane mounts the control, gated on it being a channel", () => {
  assert.match(chat, /channelRoundsApplies\(s\) \? channelRoundsControl\(s\.scopeId\) : nothing/);
  assert.match(chat, /if \(channelRoundsApplies\(s\)\) void loadChannelRounds\(s\.scopeId, \(\) => readonlyRedraw\?\.\(\)\)/);
  assert.match(chat, /else resetChannelRounds\(\)/);
});

test("adding the control did not add a send path to a read-only surface", () => {
  // The whole point of the placement is that it is the ONE writable thing here.
  assert.doesNotMatch(control, /<textarea/);
  assert.doesNotMatch(control, /composer/i);
  const methods = [...control.matchAll(/method: "([A-Z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)], ["PUT"], "the only write is the policy PUT");
});

test("the control uses the shared dropdown and the room rounds input, not hand-rolled markup", () => {
  assert.match(control, /fieldSelect\(\{/);
  assert.doesNotMatch(control, /<select/);
  assert.match(control, /class="room-rounds-input channel-rounds-input"/, "same input idiom as a room's rounds field");
});

test("the control's styles use the shell theme contract", () => {
  const start = css.indexOf(".channel-rounds {");
  assert.notEqual(start, -1, "the control has a style block");
  const block = css.slice(start, css.indexOf("\n.readonly-scroll", start));
  assert.match(block, /color: var\(--muted-foreground\)/);
  assert.match(block, /background: var\(--background\)/);
  assert.match(block, /:focus-visible/);
  assert.match(block, /outline: 2px solid/);
});

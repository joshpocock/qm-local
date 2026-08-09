import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer, type ViteDevServer } from "vite";
import type { TemplateResult } from "lit";

/**
 * `fieldSelect` (src/ui.ts) is the shared `<select>` wrapper used by ~a dozen call sites. lit
 * commits an element's attribute/property parts BEFORE its child part, so on an element's FIRST
 * render `.value` was assigned to a `<select>` with no `<option>`s yet — the browser silently
 * dropped it and the control fell back to whichever option renders first, regardless of what
 * `value` was actually passed. Later renders were fine (options already exist by then).
 *
 * Everything here goes through `vite.ssrLoadModule` — including "lit" itself — rather than a
 * plain top-level `import ... from "lit"`. Node's own ESM resolver picks lit's DOM-less "node"
 * export condition (meant for server string-rendering, its internal document stub has no
 * `createComment`), so a real, JSDOM-backed `render()` only works when loaded the same way the
 * rest of this test suite (see test/channel-rounds.test.ts) already loads it.
 */

interface Globals {
  window: unknown;
  document: unknown;
  location?: unknown;
  localStorage?: unknown;
  navigator?: unknown;
  HTMLElement: unknown;
  Node: unknown;
  Event: unknown;
  customElements: unknown;
  getComputedStyle?: unknown;
}

function installGlobals(dom: JSDOM, extra: Partial<Globals> = {}): () => void {
  const globals: Globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    customElements: dom.window.customElements,
    ...extra,
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => {
    for (const key of Object.keys(globals)) delete (globalThis as Record<string, unknown>)[key];
  };
}

// ---------------------------------------------------------------------------
// The shared helper, directly
// ---------------------------------------------------------------------------

test("a freshly-rendered fieldSelect whose value is not the first option shows that value on first paint", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>');
  const cleanup = installGlobals(dom);
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const lit = (await vite.ssrLoadModule("lit")) as {
      html: (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;
      render: (t: unknown, el: HTMLElement) => void;
    };
    const { fieldSelect } = (await vite.ssrLoadModule("/src/ui.ts")) as {
      fieldSelect: (props: {
        options: TemplateResult[];
        onChange: (v: string, e: Event) => void;
        value?: string;
      }) => TemplateResult;
    };
    const host = document.querySelector<HTMLElement>("#app")!;
    const opts = () => [
      lit.html`<option value="a">A</option>`,
      lit.html`<option value="b">B</option>`,
      lit.html`<option value="c">C</option>`,
    ];

    // "b" is deliberately NOT the first option — the exact shape that painted wrong before this
    // fix (first-rendered <select>, value pointing at something other than option #1).
    lit.render(fieldSelect({ value: "b", onChange: () => {}, options: opts() }), host);

    const select = host.querySelector("select")!;
    assert.ok(select, "the select renders");
    // The fix defers correction by one microtask (options must exist in the DOM first); drain the
    // microtask queue the same way the browser does before it paints.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(select.value, "b", "first paint shows the passed value, not whichever option is listed first");
    assert.equal(select.selectedOptions[0]?.value, "b");

    // A later, ordinary re-render (options already exist — the non-buggy path) still works.
    lit.render(fieldSelect({ value: "c", onChange: () => {}, options: opts() }), host);
    assert.equal(select.value, "c", "later re-renders keep updating .value synchronously, no microtask needed");
  } finally {
    await vite.close();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The two known-affected ambient-policy.ts call sites
// ---------------------------------------------------------------------------

interface AmbientModule {
  ambientPolicyState: {
    scope: string | null;
    loading: boolean;
    ambientEnabled: boolean | null;
    orders: string;
    bots: Array<{ name: string; mode: string; rollupHours?: number }>;
    baseUpdatedAt: number;
    dirty: boolean;
    saving: boolean;
  };
  ambientPolicySection: (scopeId: string) => unknown;
}

async function withAmbientPolicy(mutate: (mod: AmbientModule) => void): Promise<() => void> {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/web-ui/" });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const cleanupGlobals = installGlobals(dom, {
    location: dom.window.location,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });

  let vite: ViteDevServer | undefined;
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
    const lit = (await vite.ssrLoadModule("lit")) as { render: (t: unknown, el: HTMLElement) => void };
    const mod = (await vite.ssrLoadModule("/src/ambient-policy.ts")) as unknown as AmbientModule;
    const host = document.querySelector<HTMLElement>("#app")!;

    mod.ambientPolicyState.scope = "channel:C1";
    mod.ambientPolicyState.loading = false;
    mutate(mod);
    lit.render(mod.ambientPolicySection("channel:C1"), host);
    // Drain the microtask the fieldSelect fix schedules for a freshly-mounted <select>.
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    // Caller reads the DOM after this returns, so only tear down vite now; globals are cleaned up
    // by the returned callback once assertions are done.
    await vite?.close();
  }
  return cleanupGlobals;
}

test("a channel explicitly set to ambient Off paints 'Off', not 'Default', on first render", async () => {
  const cleanup = await withAmbientPolicy((mod) => {
    mod.ambientPolicyState.ambientEnabled = false;
    mod.ambientPolicyState.bots = [];
  });
  try {
    const select = document.querySelector<HTMLSelectElement>("#ambient-enabled");
    assert.ok(select, "the ambient-enabled select renders");
    assert.equal(select!.value, "off", "an explicit Off must not paint as the org default on first render");
  } finally {
    cleanup();
  }
});

test("a bot stored in 'action' mode paints 'Act immediately', not 'Ignore', on first render", async () => {
  const cleanup = await withAmbientPolicy((mod) => {
    mod.ambientPolicyState.ambientEnabled = null;
    mod.ambientPolicyState.bots = [{ name: "deploy-bot", mode: "action" }];
  });
  try {
    const select = document.querySelector<HTMLSelectElement>(".ambient-bot-mode select");
    assert.ok(select, "the per-bot mode select renders");
    assert.equal(select!.value, "action", "a bot stored as action mode must not paint as Ignore on first render");
  } finally {
    cleanup();
  }
});

// Guard against this test file drifting from the real caller sites it exercises.
const ambientSource = readFileSync(new URL("../src/ambient-policy.ts", import.meta.url), "utf8");
test("both covered call sites are still fieldSelect, not hand-rolled markup", () => {
  assert.match(ambientSource, /id: "ambient-enabled"/);
  assert.match(ambientSource, /className: "ambient-bot-mode"/);
});

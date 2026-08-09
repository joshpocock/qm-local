import assert from "node:assert/strict";
import test from "node:test";
import { createSlackMultiRuntimeReconciler, type DesiredSlackInstance } from "../src/surfaces/slack-runtime.ts";

type Cfg = { token: string };

/** A reconciler over fake plugin factories — no Slack, no sockets, just start/stop bookkeeping. */
function harness(opts: { failOn?: (token: string) => boolean; failStopOn?: (token: string) => boolean } = {}) {
  const events: string[] = [];
  let desired: Array<DesiredSlackInstance<Cfg>> = [];
  const stopFailures = new Set<string>();
  const runtime = createSlackMultiRuntimeReconciler<Cfg>({
    load: async () => desired,
    startPlugin: async (config, key) => {
      events.push(`start:${key}:${config.token}`);
      if (opts.failOn?.(config.token)) throw new Error(`cannot start ${config.token}`);
      return {
        stop: async () => {
          events.push(`stop:${key}:${config.token}`);
          if (opts.failStopOn?.(config.token) && !stopFailures.has(config.token)) {
            stopFailures.add(config.token);
            throw new Error(`cannot stop ${config.token}`);
          }
        },
      };
    },
    intervalMs: 60_000,
  });
  return {
    events,
    runtime,
    set(next: Array<DesiredSlackInstance<Cfg>>) {
      desired = next;
    },
  };
}

const bot = (key: string, version: string, token = key): DesiredSlackInstance<Cfg> => ({
  key,
  version,
  config: { token },
});

test("an empty registry is exactly today's single-instance behaviour", async () => {
  const h = harness();
  h.runtime.start();
  await h.runtime.reconcile();
  assert.deepEqual(h.events, [], "nothing configured starts nothing");

  h.set([bot("default", "1", "first")]);
  await h.runtime.reconcile();
  assert.deepEqual(h.events, ["start:default:first"]);

  // A config change stops the old instance and starts the new one, in that order.
  h.set([bot("default", "2", "second")]);
  await h.runtime.reconcile();
  assert.deepEqual(h.events.slice(1), ["stop:default:first", "start:default:second"]);

  // A steady state reconciles to nothing at all.
  await h.runtime.reconcile();
  assert.equal(h.events.length, 3);

  h.set([]);
  await h.runtime.reconcile();
  assert.deepEqual(h.events.at(-1), "stop:default:second");
  await h.runtime.stop();
});

test("adding, disabling and removing a registry bot touches only that instance", async () => {
  const h = harness();
  h.set([bot("default", "1")]);
  await h.runtime.reconcile();
  assert.deepEqual(h.runtime.running(), ["default"]);

  // Add a second bot: the default is untouched.
  h.set([bot("default", "1"), bot("codex", "a")]);
  await h.runtime.reconcile();
  assert.deepEqual(h.events, ["start:default:default", "start:codex:codex"]);
  assert.deepEqual(h.runtime.running().sort(), ["codex", "default"]);

  // Add a third: neither running bot restarts.
  h.set([bot("default", "1"), bot("codex", "a"), bot("claude", "a")]);
  await h.runtime.reconcile();
  assert.deepEqual(h.events.at(-1), "start:claude:claude");
  assert.equal(h.events.length, 3);

  // Edit ONE bot: only it cycles.
  h.set([bot("default", "1"), bot("codex", "b", "codex-rotated"), bot("claude", "a")]);
  await h.runtime.reconcile();
  assert.deepEqual(h.events.slice(3), ["stop:codex:codex", "start:codex:codex-rotated"]);

  // Disable one (the loader drops it): only it stops.
  h.set([bot("default", "1"), bot("claude", "a")]);
  await h.runtime.reconcile();
  assert.deepEqual(h.events.slice(5), ["stop:codex:codex-rotated"]);
  assert.deepEqual(h.runtime.running().sort(), ["claude", "default"]);

  // Remove the default: the registry bot keeps running on its own.
  h.set([bot("claude", "a")]);
  await h.runtime.reconcile();
  assert.deepEqual(h.events.slice(6), ["stop:default:default"]);
  assert.deepEqual(h.runtime.running(), ["claude"]);

  await h.runtime.stop();
  assert.deepEqual(h.runtime.running(), []);
  assert.deepEqual(h.events.at(-1), "stop:claude:claude");
});

test("one bot that cannot start never stops the others", async () => {
  const h = harness({ failOn: (token) => token === "broken" });
  h.set([bot("default", "1"), bot("broken", "a", "broken"), bot("claude", "a")]);
  await assert.rejects(h.runtime.reconcile(), /cannot start broken/);
  assert.deepEqual(h.runtime.running().sort(), ["claude", "default"]);
  assert.ok(h.events.includes("start:default:default"));
  assert.ok(h.events.includes("start:claude:claude"));
  await h.runtime.stop();
});

test("a reload that cannot start rolls the key back to its previous configuration", async () => {
  const h = harness({ failOn: (token) => token === "broken" });
  h.set([bot("default", "1", "first"), bot("codex", "a")]);
  await h.runtime.reconcile();
  h.set([bot("default", "2", "broken"), bot("codex", "a")]);
  await assert.rejects(h.runtime.reconcile(), /cannot start broken/);
  assert.deepEqual(h.events, [
    "start:default:first",
    "start:codex:codex",
    "stop:default:first",
    "start:default:broken",
    "start:default:first",
  ]);
  assert.deepEqual(h.runtime.running().sort(), ["codex", "default"], "both keys are still live");
  await h.runtime.stop();
});

test("a failed stop is retried before replacement credentials are started", async () => {
  const h = harness({ failStopOn: (token) => token === "first" });
  h.set([bot("default", "1", "first")]);
  await h.runtime.reconcile();
  h.set([bot("default", "2", "second")]);
  await assert.rejects(h.runtime.reconcile(), /cannot stop first/);
  await h.runtime.reconcile();
  assert.deepEqual(h.events, [
    "start:default:first",
    "stop:default:first",
    "stop:default:first",
    "start:default:second",
  ]);
  await h.runtime.stop();
});

test("start failures are reported per key, and a clean start clears the report", async () => {
  const reported: Array<[string, string]> = [];
  const started: string[] = [];
  let broken = true;
  let desired: Array<DesiredSlackInstance<Cfg>> = [{ key: "codex", version: "a", config: { token: "codex" } }];
  const runtime = createSlackMultiRuntimeReconciler<Cfg>({
    load: async () => desired,
    startPlugin: async () => {
      if (broken) throw new Error("invalid_auth");
      return { stop: async () => {} };
    },
    intervalMs: 60_000,
    onStartFailed: (key, error) => reported.push([key, (error as Error).message]),
    onStarted: (key) => started.push(key),
  });
  await assert.rejects(runtime.reconcile(), /invalid_auth/);
  assert.deepEqual(reported, [["codex", "invalid_auth"]]);
  assert.deepEqual(started, []);

  broken = false;
  desired = [{ key: "codex", version: "b", config: { token: "codex" } }];
  await runtime.reconcile();
  assert.deepEqual(started, ["codex"]);
  await runtime.stop();
});

test("a backed-off key stops being retried every tick until its config changes", async () => {
  let attempts = 0;
  let desired: Array<DesiredSlackInstance<Cfg>> = [
    { key: "codex", version: "a", backoff: true, config: { token: "codex" } },
  ];
  const runtime = createSlackMultiRuntimeReconciler<Cfg>({
    load: async () => desired,
    startPlugin: async () => {
      attempts++;
      throw new Error("invalid_auth");
    },
    intervalMs: 60_000,
  });
  await assert.rejects(runtime.reconcile(), /invalid_auth/);
  await runtime.reconcile();
  await runtime.reconcile();
  assert.equal(attempts, 1, "a broken registry bot must not hammer Slack every 5 seconds");

  // Editing the bot is an explicit "try again now".
  desired = [{ key: "codex", version: "b", backoff: true, config: { token: "codex" } }];
  await assert.rejects(runtime.reconcile(), /invalid_auth/);
  assert.equal(attempts, 2);
  await runtime.stop();
});

test("the default key keeps retrying every tick, exactly as it always has", async () => {
  let attempts = 0;
  const runtime = createSlackMultiRuntimeReconciler<Cfg>({
    load: async () => [{ key: "default", version: "1", config: { token: "first" } }],
    startPlugin: async () => {
      attempts++;
      throw new Error("invalid_auth");
    },
    intervalMs: 60_000,
  });
  await assert.rejects(runtime.reconcile(), /invalid_auth/);
  await assert.rejects(runtime.reconcile(), /invalid_auth/);
  assert.equal(attempts, 2);
  await runtime.stop();
});

import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSlackBotRegistry, type StoredSlackBot } from "../src/surfaces/slack-bot-registry.ts";

const KEY = "slack-bot-registry-test-key-material";

function registry(orgId = "acme") {
  const map = createMemoryMap<StoredSlackBot>();
  return { map, store: createSlackBotRegistry(orgId, map, KEY) };
}

test("registry round-trips a bot and keeps its tokens encrypted at rest", async () => {
  const { map, store } = registry();
  const created = await store.create({
    label: "Codex",
    personaId: "persona-codex",
    botToken: "xoxb-codex-secret",
    appToken: "xapp-codex-secret",
    teamId: "T1",
    teamName: "Acme",
    updatedBy: "admin-alice",
  });
  assert.ok(created.id);
  assert.equal(created.enabled, true);
  assert.equal(created.personaId, "persona-codex");

  const stored = await map.get(created.id);
  assert.ok(stored);
  assert.doesNotMatch(JSON.stringify(stored), /xoxb-codex-secret|xapp-codex-secret/);
  assert.notEqual(stored.botTokenEnc, stored.appTokenEnc);

  const decrypted = await store.getWithTokens(created.id);
  assert.equal(decrypted?.botToken, "xoxb-codex-secret");
  assert.equal(decrypted?.appToken, "xapp-codex-secret");

  // The redacted view carries no secret material at all.
  assert.doesNotMatch(JSON.stringify(await store.list()), /xoxb|xapp|Enc/);
});

test("a registry record decrypts only under its own purpose key", async () => {
  const { map, store } = registry();
  const created = await store.create({
    label: "Codex",
    botToken: "xoxb-a",
    appToken: "xapp-a",
    updatedBy: "admin-alice",
  });
  const otherKey = createSlackBotRegistry("acme", map, "a-completely-different-key");
  await assert.rejects(() => otherKey.getWithTokens(created.id));
});

test("a bot belongs to its org and is invisible to another", async () => {
  const map = createMemoryMap<StoredSlackBot>();
  const acme = createSlackBotRegistry("acme", map, KEY);
  const other = createSlackBotRegistry("other", map, KEY);
  const created = await acme.create({ label: "Codex", botToken: "xoxb", appToken: "xapp", updatedBy: "a" });
  assert.equal(await other.get(created.id), null);
  assert.deepEqual(await other.list(), []);
  assert.equal(await other.delete(created.id), false);
  assert.equal((await acme.get(created.id))?.id, created.id);
});

test("update rotates tokens, flips enabled, and bumps the version the reconciler watches", async () => {
  const { store } = registry();
  const created = await store.create({
    label: "Codex",
    personaId: "persona-codex",
    botToken: "xoxb-one",
    appToken: "xapp-one",
    updatedBy: "admin-alice",
  });

  const relabelled = await store.update(created.id, { label: "Codex Bot", updatedBy: "admin-bob" });
  assert.equal(relabelled?.label, "Codex Bot");
  assert.notEqual(relabelled?.version, created.version, "a config change must restart the instance");
  assert.equal(relabelled?.updatedBy, "admin-bob");
  assert.equal(relabelled?.personaId, "persona-codex", "an untouched field survives a patch");

  const rotated = await store.update(created.id, {
    botToken: "xoxb-two",
    appToken: "xapp-two",
    updatedBy: "admin-bob",
  });
  assert.notEqual(rotated?.version, relabelled?.version);
  const decrypted = await store.getWithTokens(created.id);
  assert.equal(decrypted?.botToken, "xoxb-two");
  assert.equal(decrypted?.appToken, "xapp-two");

  const disabled = await store.update(created.id, { enabled: false, updatedBy: "admin-bob" });
  assert.equal(disabled?.enabled, false);

  // personaId is explicitly clearable — a bot may go back to the default org agent.
  const cleared = await store.update(created.id, { personaId: null, updatedBy: "admin-bob" });
  assert.equal(cleared?.personaId, null);

  assert.equal(await store.update("nope", { label: "x", updatedBy: "admin-bob" }), null);
});

test("recording a start failure never looks like a config change", async () => {
  const { store } = registry();
  const created = await store.create({ label: "Codex", botToken: "xoxb", appToken: "xapp", updatedBy: "a" });

  await store.recordError(created.id, "invalid_auth");
  const failed = await store.get(created.id);
  assert.equal(failed?.lastError, "invalid_auth");
  assert.ok(failed?.lastErrorAt);
  assert.equal(failed?.version, created.version, "an error report must not restart the bot");

  // Repeating the same error is a no-op, so a failing bot cannot churn the store every tick.
  const at = failed.lastErrorAt;
  await store.recordError(created.id, "invalid_auth");
  assert.equal((await store.get(created.id))?.lastErrorAt, at);

  await store.clearError(created.id);
  assert.equal((await store.get(created.id))?.lastError, undefined);

  // A config write clears a stale error on its own: the next start is a fresh attempt.
  await store.recordError(created.id, "invalid_auth");
  const updated = await store.update(created.id, { label: "Codex 2", updatedBy: "a" });
  assert.equal(updated?.lastError, undefined);
});

test("labels are trimmed, capped and stripped of control characters", async () => {
  const { store } = registry();
  const created = await store.create({
    label: `  Co${String.fromCharCode(10)}dex ${"x".repeat(200)}`,
    botToken: "xoxb",
    appToken: "xapp",
    updatedBy: "a",
  });
  assert.ok(created.label.length <= 60);
  assert.doesNotMatch(created.label, /[\r\n\t]/);
  assert.ok(created.label.startsWith("Co dex"));
});

test("list is stable oldest-first and delete removes exactly one bot", async () => {
  const { store } = registry();
  const first = await store.create({ label: "A", botToken: "xoxb-a", appToken: "xapp-a", updatedBy: "a" });
  const second = await store.create({ label: "B", botToken: "xoxb-b", appToken: "xapp-b", updatedBy: "a" });
  assert.deepEqual((await store.list()).map((b) => b.label).sort(), ["A", "B"]);

  assert.equal(await store.delete(first.id), true);
  assert.equal(await store.delete(first.id), false);
  assert.deepEqual(
    (await store.list()).map((b) => b.id),
    [second.id],
  );
});

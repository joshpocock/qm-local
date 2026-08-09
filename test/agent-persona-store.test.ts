import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createAgentPersonaStore, personaFieldError, type AgentPersona } from "../src/agents/persona-store.ts";
import { scopeId } from "../src/types.ts";

const org = scopeId("org", "default-org");
const mine = scopeId("personal", "U1");
const yours = scopeId("personal", "U2");

const base = {
  color: "#BA9926",
  glyph: "SC",
  harnessId: "pi",
  modelId: "claude-opus-4-8",
  instructions: "You research things and report crisply.",
  createdBy: "U1",
};

function store() {
  return createAgentPersonaStore();
}

test("create/get/update/list round-trips a persona", async () => {
  const personas = store();
  const created = await personas.create({ ...base, scopeId: mine, name: "Scout" });

  assert.match(created.id, /^ap_/, "persona ids are prefixed so they are recognizable in transcripts");
  assert.equal(created.scopeId, mine);
  assert.equal(created.name, "Scout");
  assert.equal(created.color, "#ba9926", "colors normalize to lowercase hex");
  assert.equal(created.enabled, true);
  assert.equal(created.version, 1);
  assert.ok(created.createdAt > 0);

  const got = await personas.get(created.id);
  assert.deepEqual(got, created);

  const updated = await personas.update(created.id, { instructions: "Now you push back harder.", enabled: false });
  assert.equal(updated.instructions, "Now you push back harder.");
  assert.equal(updated.enabled, false);
  assert.equal(updated.name, "Scout", "untouched fields survive a partial patch");

  assert.deepEqual(
    (await personas.listForScopes([mine, org])).map((p) => p.id),
    [created.id],
  );
  assert.equal((await personas.list()).length, 1);
});

test("update bumps the version on every write", async () => {
  const personas = store();
  const p = await personas.create({ ...base, scopeId: mine, name: "Critic" });
  assert.equal(p.version, 1);
  assert.equal((await personas.update(p.id, { glyph: "CR" })).version, 2);
  assert.equal((await personas.update(p.id, { color: "#112233" })).version, 3);
  assert.equal((await personas.get(p.id))!.version, 3);
});

test("names are unique per scope, case-insensitively, but free in a sibling scope", async () => {
  const personas = store();
  await personas.create({ ...base, scopeId: mine, name: "Scout" });

  await assert.rejects(() => personas.create({ ...base, scopeId: mine, name: "Scout" }), /already exists/);
  await assert.rejects(() => personas.create({ ...base, scopeId: mine, name: "sCoUt" }), /already exists/);

  const elsewhere = await personas.create({ ...base, scopeId: yours, name: "scout", createdBy: "U2" });
  assert.equal(elsewhere.scopeId, yours);

  const other = await personas.create({ ...base, scopeId: mine, name: "Critic" });
  await assert.rejects(() => personas.update(other.id, { name: "SCOUT" }), /already exists/);
  assert.equal((await personas.update(other.id, { name: "Critic" })).name, "Critic", "renaming to itself is fine");
});

test("a freed-up name can be reused once the holder is archived", async () => {
  const personas = store();
  const first = await personas.create({ ...base, scopeId: mine, name: "Scout" });
  await personas.archive(first.id);
  const second = await personas.create({ ...base, scopeId: mine, name: "scout" });
  assert.notEqual(second.id, first.id);
});

test("invalid names, colors, glyphs, and oversized instructions are rejected", async () => {
  const personas = store();
  for (const name of ["S", "9lives", "-lead", "Scout Two", "has_underscore", "a".repeat(33), ""]) {
    await assert.rejects(
      () => personas.create({ ...base, scopeId: mine, name }),
      /persona name must/,
      `expected "${name}" to be rejected`,
    );
  }
  for (const color of ["ba9926", "#ba992", "#gggggg", "red", ""]) {
    await assert.rejects(() => personas.create({ ...base, scopeId: mine, name: "Scout", color }), /persona color must/);
  }
  for (const glyph of ["", "abc"]) {
    await assert.rejects(() => personas.create({ ...base, scopeId: mine, name: "Scout", glyph }), /persona glyph must/);
  }
  await assert.rejects(
    () => personas.create({ ...base, scopeId: mine, name: "Scout", instructions: "x".repeat(8001) }),
    /persona instructions must/,
  );

  // a two-codepoint emoji still counts as one glyph
  const emoji = await personas.create({ ...base, scopeId: mine, name: "Scout", glyph: "🛰" });
  assert.equal(emoji.glyph, "🛰");
});

test("personaFieldError names the first problem and passes clean fields", () => {
  assert.equal(personaFieldError({ name: "Scout", color: "#ba9926", glyph: "SC", instructions: "hi" }), null);
  assert.match(personaFieldError({ name: "S", color: "#ba9926", glyph: "S", instructions: "" })!, /persona name must/);
  assert.match(personaFieldError({ name: "Scout", color: "nope", glyph: "S", instructions: "" })!, /persona color/);
});

test("archived personas drop out of scope listings but stay readable, and archive is idempotent", async () => {
  const personas = store();
  const keep = await personas.create({ ...base, scopeId: mine, name: "Critic" });
  const gone = await personas.create({ ...base, scopeId: mine, name: "Scout" });

  const archived = await personas.archive(gone.id);
  assert.ok(archived.archivedAt);
  assert.deepEqual(
    (await personas.listForScopes([mine])).map((p) => p.name),
    ["Critic"],
  );
  assert.equal((await personas.get(gone.id))!.id, gone.id, "the record survives archival");
  assert.equal((await personas.archive(gone.id)).archivedAt, archived.archivedAt, "archive is idempotent");
  await assert.rejects(() => personas.update(gone.id, { glyph: "SC" }), /archived/);

  await personas.delete(keep.id);
  assert.equal(await personas.get(keep.id), null);
});

test("listForScopes honours scope precedence and ignores scopes the viewer cannot see", async () => {
  const personas = store();
  await personas.create({ ...base, scopeId: org, name: "OrgWide" });
  await personas.create({ ...base, scopeId: mine, name: "Mine" });
  await personas.create({ ...base, scopeId: yours, name: "Theirs", createdBy: "U2" });

  assert.deepEqual(
    (await personas.listForScopes([mine, org])).map((p) => p.name),
    ["Mine", "OrgWide"],
  );
  assert.deepEqual(await personas.listForScopes([]), []);
});

test("unknown ids fail loudly on update and archive", async () => {
  const personas = store();
  await assert.rejects(() => personas.update("ap_nope", { glyph: "X" }), /unknown agent persona/);
  await assert.rejects(() => personas.archive("ap_nope"), /unknown agent persona/);
});

test("personas persist through the backing map (a second store instance reads them back)", async () => {
  const backing = createMemoryMap<AgentPersona>();
  const first = createAgentPersonaStore({ backing });
  const created = await first.create({ ...base, scopeId: mine, name: "Scout" });

  const second = createAgentPersonaStore({ backing });
  const got = await second.get(created.id);
  assert.equal(got?.name, "Scout");
  await assert.rejects(
    () => second.create({ ...base, scopeId: mine, name: "scout" }),
    /already exists/,
    "uniqueness is enforced against the shared backing map, not a per-instance cache",
  );
});

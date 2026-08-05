import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_COLOR_PRESETS,
  agentDraftValid,
  agentEmptyState,
  agentFieldErrors,
  agentStatusCounts,
  filterAgents,
  type AgentItem,
} from "../src/agent-registry.ts";

function makeAgent(over: Partial<AgentItem> = {}): AgentItem {
  return {
    id: "ap_1",
    name: "Scout",
    color: "#2563eb",
    glyph: "SC",
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
    instructions: "Find the weak points.",
    enabled: true,
    scope: "personal",
    scopeId: "personal:alice",
    createdBy: "alice",
    createdAt: 1,
    version: 1,
    editable: true,
    ...over,
  };
}

const VALID = { name: "Scout", color: "#2563eb", glyph: "SC", instructions: "Be sharp." };

test("a well-formed draft passes with no field errors", () => {
  assert.deepEqual(agentFieldErrors(VALID), {});
  assert.equal(agentDraftValid(VALID), true);
});

test("names follow core's @mention rules — length, leading letter, no spaces", () => {
  assert.ok(agentFieldErrors({ ...VALID, name: "S" }).name, "too short");
  assert.ok(agentFieldErrors({ ...VALID, name: "S".repeat(33) }).name, "too long");
  assert.ok(agentFieldErrors({ ...VALID, name: "1Scout" }).name, "must start with a letter");
  assert.ok(agentFieldErrors({ ...VALID, name: "Scout Two" }).name, "no spaces — it is the mention token");
  assert.ok(agentFieldErrors({ ...VALID, name: "Scout_2" }).name, "no underscores");
  assert.equal(agentFieldErrors({ ...VALID, name: "Scout-2" }).name, undefined, "hyphens are fine");
});

test("colour must be a six-digit hex, which every preset already is", () => {
  assert.ok(agentFieldErrors({ ...VALID, color: "blue" }).color);
  assert.ok(agentFieldErrors({ ...VALID, color: "#25b" }).color, "short hex is not accepted");
  for (const preset of AGENT_COLOR_PRESETS) {
    assert.equal(agentFieldErrors({ ...VALID, color: preset }).color, undefined, `${preset} must validate`);
  }
});

test("a glyph is 1-2 user-perceived characters, so a two-codepoint emoji counts as one", () => {
  assert.ok(agentFieldErrors({ ...VALID, glyph: "" }).glyph);
  assert.ok(agentFieldErrors({ ...VALID, glyph: "ABC" }).glyph);
  assert.equal(agentFieldErrors({ ...VALID, glyph: "🔭" }).glyph, undefined);
  assert.equal(agentFieldErrors({ ...VALID, glyph: "🔭🔭" }).glyph, undefined);
  assert.ok(agentFieldErrors({ ...VALID, glyph: "🔭🔭🔭" }).glyph);
});

test("instructions are capped at core's limit", () => {
  assert.equal(agentFieldErrors({ ...VALID, instructions: "x".repeat(8000) }).instructions, undefined);
  assert.ok(agentFieldErrors({ ...VALID, instructions: "x".repeat(8001) }).instructions);
});

test("every broken field reports separately, so the form can mark each one", () => {
  const errors = agentFieldErrors({ name: "1", color: "nope", glyph: "", instructions: "x".repeat(8001) });
  assert.deepEqual(Object.keys(errors).sort(), ["color", "glyph", "instructions", "name"]);
});

test("filtering matches name, instructions, and runtime, and honours scope and status", () => {
  const agents = [
    makeAgent({ id: "a", name: "Scout" }),
    makeAgent({ id: "b", name: "Critic", enabled: false, instructions: "Push back hard." }),
    makeAgent({ id: "c", name: "Archivist", scope: "group", scopeId: "group:p1", harnessId: "claude" }),
  ];
  const ids = (q: Parameters<typeof filterAgents>[1]) => filterAgents(agents, q).map((a) => a.id);
  assert.deepEqual(ids({ query: "scout", scope: "all", status: "all" }), ["a"]);
  assert.deepEqual(ids({ query: "push back", scope: "all", status: "all" }), ["b"], "instructions are searchable");
  assert.deepEqual(ids({ query: "claude", scope: "all", status: "all" }), ["c"], "harness is searchable");
  assert.deepEqual(ids({ query: "", scope: "group", status: "all" }), ["c"]);
  assert.deepEqual(ids({ query: "", scope: "all", status: "disabled" }), ["b"]);
  assert.deepEqual(ids({ query: "", scope: "all", status: "enabled" }), ["a", "c"]);
});

test("status counts split the roster the way the filter tabs show it", () => {
  const agents = [makeAgent({ id: "a" }), makeAgent({ id: "b", enabled: false })];
  assert.deepEqual(agentStatusCounts(agents), { enabled: 1, disabled: 1, all: 2 });
});

test("the empty state tells apart 'flag off', 'still loading', 'filtered out', and 'none yet'", () => {
  assert.equal(agentEmptyState(0, 0, false, false), "disabled", "the flag being off outranks everything");
  assert.equal(agentEmptyState(0, 0, true, false), "disabled");
  assert.equal(agentEmptyState(0, 0, true, true), "loading");
  assert.equal(agentEmptyState(3, 0, false, true), "filtered");
  assert.equal(agentEmptyState(0, 0, false, true), "empty");
  assert.equal(agentEmptyState(3, 1, false, true), "none");
});

import "./support/agent-rooms-flag.ts";
import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { findRoute } from "../src/api/routes/route.ts";
import { agentRoutes } from "../src/api/routes/agents.ts";
import { apiRoutes } from "../src/api/routes/index.ts";
import { testConfig } from "./support/test-config.ts";

const JSON_HEADERS = { "content-type": "application/json" };

interface AgentView {
  id: string;
  name: string;
  color: string;
  glyph: string;
  harnessId: string;
  modelId: string;
  instructions: string;
  enabled: boolean;
  scope: string;
  scopeId: string;
  version: number;
  editable: boolean;
}

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "agent-personas-")), seedSkills: false }));
  const server = createInsecureTestServer(built.app, { config: built.config, harnessId: "pi" });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const NEW_SCOUT = {
  principalId: "U1",
  name: "Scout",
  color: "#BA9926",
  glyph: "SC",
  harnessId: "pi",
  modelId: "claude-opus-4-8",
  instructions: "You research and report crisply.",
};

function post(base: string, body: unknown, path = "/v1/agents", method = "POST") {
  return fetch(`${base}${path}`, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
}

test("the /v1/agents table is mounted only when QM_AGENT_ROOMS is on", () => {
  assert.deepEqual(agentRoutes({}), [], "flag off means no agent routes exist at all");
  assert.equal(findRoute(agentRoutes({}), "GET", "/v1/agents"), null);
  assert.equal(findRoute(agentRoutes({ QM_AGENT_ROOMS: "0" }), "POST", "/v1/agents"), null);

  const on = agentRoutes({ QM_AGENT_ROOMS: "1" });
  assert.equal(on.length, 5);
  for (const [method, path] of [
    ["GET", "/v1/agents"],
    ["GET", "/v1/agents/ap_1"],
    ["POST", "/v1/agents"],
    ["PUT", "/v1/agents/ap_1"],
    ["DELETE", "/v1/agents/ap_1"],
  ] as const) {
    assert.ok(findRoute(on, method, path), `${method} ${path} should resolve with the flag on`);
    assert.ok(findRoute(apiRoutes, method, path), `${method} ${path} should be in the live table for this process`);
  }
});

test("CRUD round-trips over HTTP and archived agents leave the listing", async () => {
  const srv = start();
  try {
    const created = (await (await post(srv.base, NEW_SCOUT)).json()) as { agent: AgentView };
    assert.match(created.agent.id, /^ap_/);
    assert.equal(created.agent.scope, "personal");
    assert.equal(created.agent.scopeId, "personal:U1");
    assert.equal(created.agent.color, "#ba9926");
    assert.equal(created.agent.version, 1);
    assert.equal(created.agent.editable, true);

    const list = (await (await fetch(`${srv.base}/v1/agents?principalId=U1`)).json()) as { agents: AgentView[] };
    assert.deepEqual(
      list.agents.map((a) => a.name),
      ["Scout"],
    );

    const detail = (await (await fetch(`${srv.base}/v1/agents/${created.agent.id}?principalId=U1`)).json()) as {
      agent: AgentView;
    };
    assert.equal(detail.agent.instructions, NEW_SCOUT.instructions);

    const updated = (await (
      await post(
        srv.base,
        { principalId: "U1", instructions: "You research, then hand off.", glyph: "🛰" },
        `/v1/agents/${created.agent.id}`,
        "PUT",
      )
    ).json()) as { agent: AgentView };
    assert.equal(updated.agent.instructions, "You research, then hand off.");
    assert.equal(updated.agent.glyph, "🛰");
    assert.equal(updated.agent.version, 2, "an update bumps the version");

    const deleted = await post(srv.base, { principalId: "U1" }, `/v1/agents/${created.agent.id}`, "DELETE");
    assert.equal(deleted.status, 200);

    const after = (await (await fetch(`${srv.base}/v1/agents?principalId=U1`)).json()) as { agents: AgentView[] };
    assert.deepEqual(after.agents, [], "an archived agent is gone from the listing");
    assert.equal((await post(srv.base, { principalId: "U1" }, `/v1/agents/${created.agent.id}`, "DELETE")).status, 200);
  } finally {
    await srv.close();
  }
});

test("a duplicate name in the same scope is a conflict, and every route needs a principal", async () => {
  const srv = start();
  try {
    assert.equal((await post(srv.base, NEW_SCOUT)).status, 200);

    const dupe = await post(srv.base, { ...NEW_SCOUT, name: "sCoUt" });
    assert.equal(dupe.status, 409);
    assert.match(((await dupe.json()) as { message: string }).message, /already exists/);

    // a sibling principal owns a different scope, so the name is free there
    assert.equal((await post(srv.base, { ...NEW_SCOUT, principalId: "U2" })).status, 200);

    assert.equal((await fetch(`${srv.base}/v1/agents`)).status, 400);
    const { principalId: _drop, ...anonymous } = NEW_SCOUT;
    assert.equal((await post(srv.base, anonymous)).status, 400);
  } finally {
    await srv.close();
  }
});

test("field validation is refused with 400 before anything is stored", async () => {
  const srv = start();
  try {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "Scout Two" }, /persona name must/],
      [{ name: "S" }, /persona name must/],
      [{ color: "ba9926" }, /persona color must/],
      [{ color: "#ggg999" }, /persona color must/],
      [{ glyph: "abc" }, /persona glyph must/],
      [{ instructions: "x".repeat(8001) }, /persona instructions must/],
    ];
    for (const [patch, expected] of cases) {
      const res = await post(srv.base, { ...NEW_SCOUT, ...patch });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(patch)}`);
      assert.match(((await res.json()) as { message: string }).message, expected);
    }
    const list = (await (await fetch(`${srv.base}/v1/agents?principalId=U1`)).json()) as { agents: AgentView[] };
    assert.deepEqual(list.agents, []);
  } finally {
    await srv.close();
  }
});

test("runtime is validated against the org's approved harnesses and the harness's models", async () => {
  const srv = start();
  try {
    await srv.built.config.setApprovedHarnesses(["pi"]);

    const notApproved = await post(srv.base, { ...NEW_SCOUT, harnessId: "codex", modelId: "gpt-5.6-terra" });
    assert.equal(notApproved.status, 400);
    assert.match(((await notApproved.json()) as { message: string }).message, /harness codex is not approved/);

    const unknownHarness = await post(srv.base, { ...NEW_SCOUT, harnessId: "definitely-not-a-harness" });
    assert.equal(unknownHarness.status, 400);
    assert.match(((await unknownHarness.json()) as { message: string }).message, /requires harnessId/);

    const badModel = await post(srv.base, { ...NEW_SCOUT, modelId: "not-a-model" });
    assert.equal(badModel.status, 400);
    assert.match(((await badModel.json()) as { message: string }).message, /is not supported by pi/);

    // approving codex org-wide is what makes a codex persona creatable
    await srv.built.config.setApprovedHarnesses(["pi", "codex"]);
    const ok = await post(srv.base, {
      ...NEW_SCOUT,
      name: "Coder",
      harnessId: "codex",
      modelId: "gpt-5.6-terra",
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { agent: AgentView }).agent.harnessId, "codex");

    // and an update carries the same gate
    const created = (await (await post(srv.base, NEW_SCOUT)).json()) as { agent: AgentView };
    await srv.built.config.setApprovedHarnesses(["pi"]);
    const flip = await post(
      srv.base,
      { principalId: "U1", harnessId: "codex", modelId: "gpt-5.6-terra" },
      `/v1/agents/${created.agent.id}`,
      "PUT",
    );
    assert.equal(flip.status, 400);
    assert.match(((await flip.json()) as { message: string }).message, /harness codex is not approved/);
  } finally {
    await srv.close();
  }
});

test("someone else's personal agent is neither visible nor editable", async () => {
  const srv = start();
  try {
    const created = (await (await post(srv.base, NEW_SCOUT)).json()) as { agent: AgentView };

    const theirList = (await (await fetch(`${srv.base}/v1/agents?principalId=U2`)).json()) as { agents: AgentView[] };
    assert.deepEqual(theirList.agents, []);
    assert.equal((await fetch(`${srv.base}/v1/agents/${created.agent.id}?principalId=U2`)).status, 404);
    assert.equal(
      (await post(srv.base, { principalId: "U2", glyph: "XX" }, `/v1/agents/${created.agent.id}`, "PUT")).status,
      404,
    );
    assert.equal((await post(srv.base, { principalId: "U2" }, `/v1/agents/${created.agent.id}`, "DELETE")).status, 403);
    assert.equal((await fetch(`${srv.base}/v1/agents/ap_missing?principalId=U1`)).status, 404);
  } finally {
    await srv.close();
  }
});

test("an org-scoped agent is visible to everyone but only creatable by a scope manager", async () => {
  const srv = start();
  try {
    const refused = await post(srv.base, { ...NEW_SCOUT, scopeId: "org:default-org" });
    assert.equal(refused.status, 403);

    const orgPersona = await srv.built.personas.create({
      scopeId: "org:default-org",
      name: "HouseStyle",
      color: "#ba9926",
      glyph: "HS",
      harnessId: "pi",
      modelId: "claude-opus-4-8",
      instructions: "Keep everyone on brand.",
      createdBy: "admin",
    });

    for (const viewer of ["U1", "U2"]) {
      const list = (await (await fetch(`${srv.base}/v1/agents?principalId=${viewer}`)).json()) as {
        agents: AgentView[];
      };
      const found = list.agents.find((a) => a.id === orgPersona.id);
      assert.ok(found, `${viewer} should see the org agent`);
      assert.equal(found.scope, "org");
      assert.equal(found.editable, false, "an org agent is not editable by a plain member");
    }
  } finally {
    await srv.close();
  }
});

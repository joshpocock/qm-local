import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

function coreCall(url: string, pathname: string): boolean {
  const u = new URL(url, "http://core");
  return u.pathname === pathname;
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const agent = {
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
};

/** Set by a test to make the next core reply a 404, the way the feature flag being off looks. */
let flagOff = false;
/** Set by a test to make core refuse the turn the way an unusable roster does. */
let refuseTurn = "";

const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ method: req.method ?? "GET", url: req.url ?? "", body });
    if (flagOff) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (refuseTurn && (req.url ?? "").startsWith("/v1/turns")) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "refused", reason: refuseTurn }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if ((req.url ?? "").startsWith("/v1/turns")) {
      return void res.end(JSON.stringify({ status: "queued", runId: "run_1" }));
    }
    if ((req.url ?? "").includes("/room")) return void res.end(JSON.stringify({ session: { id: "s1" } }));
    if (req.method === "GET" && new URL(req.url ?? "", "http://core").pathname === "/v1/agents") {
      return void res.end(JSON.stringify({ agents: [agent] }));
    }
    if (req.method === "DELETE") return void res.end(JSON.stringify({ ok: true }));
    res.end(JSON.stringify({ agent }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "agents-web-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "agents-web-route-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

function since(n: number, pathname: string): Call | undefined {
  return calls.slice(n).find((call) => coreCall(call.url, pathname));
}

test("the agents list relays under the signed-in principal, never a body-supplied one", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/agents?principalId=mallory`, { headers });
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as { agents: unknown[] }).agents, [agent]);
  const call = since(before, "/v1/agents");
  assert.ok(call, "the list must reach core");
  assert.equal(new URL(call.url, "http://core").searchParams.get("principalId"), "alice");
});

test("a single agent is fetched by id with the viewer bound as principal", async () => {
  const before = calls.length;
  await fetch(`${base}/api/agents/ap_1`, { headers });
  const call = since(before, "/v1/agents/ap_1");
  assert.ok(call);
  assert.equal(new URL(call.url, "http://core").searchParams.get("principalId"), "alice");
});

test("create forwards only persona fields, binding the principal and keeping the chosen scope", async () => {
  const before = calls.length;
  await fetch(`${base}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Scout",
      color: "#2563eb",
      glyph: "SC",
      harnessId: "codex",
      modelId: "gpt-5.6-sol",
      instructions: "Find the weak points.",
      enabled: true,
      scopeId: "group:web-project-p1",
      principalId: "mallory",
      version: 99,
      editable: true,
    }),
  });
  assert.deepEqual(since(before, "/v1/agents")?.body, {
    principalId: "alice",
    name: "Scout",
    color: "#2563eb",
    glyph: "SC",
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
    instructions: "Find the weak points.",
    enabled: true,
    scopeId: "group:web-project-p1",
  });
});

test("update forwards only the fields present, and never moves an agent between scopes", async () => {
  const before = calls.length;
  await fetch(`${base}/api/agents/ap_1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ instructions: "Push harder.", enabled: false, scopeId: "org:acme", principalId: "mallory" }),
  });
  assert.deepEqual(since(before, "/v1/agents/ap_1")?.body, {
    principalId: "alice",
    instructions: "Push harder.",
    enabled: false,
  });
});

test("delete relays as an archive carrying the signed-in principal", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/agents/ap_1`, { method: "DELETE", headers });
  assert.equal(r.status, 200);
  const call = since(before, "/v1/agents/ap_1");
  assert.equal(call?.method, "DELETE");
  assert.deepEqual(call?.body, { principalId: "alice" });
});

test("a room roster reaches core normalised, and null clears it", async () => {
  let before = calls.length;
  const ok = await fetch(`${base}/api/sessions/s1/room`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ room: { personaIds: ["ap_1", "ap_2"], rounds: 2 }, principalId: "mallory" }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(since(before, "/v1/sessions/s1/room")?.body, {
    principalId: "alice",
    room: { personaIds: ["ap_1", "ap_2"], rounds: 2 },
  });

  before = calls.length;
  await fetch(`${base}/api/sessions/s1/room`, { method: "PUT", headers, body: JSON.stringify({ room: null }) });
  assert.deepEqual(since(before, "/v1/sessions/s1/room")?.body, { principalId: "alice", room: null });
});

test("an unusable roster is rejected at the relay instead of reaching core", async () => {
  for (const room of [
    undefined,
    { personaIds: [], rounds: 1 },
    { personaIds: ["a", "a"], rounds: 1 },
    { personaIds: ["a", 7], rounds: 1 },
    { personaIds: ["a"], rounds: 0 },
    { personaIds: ["a"], rounds: 21 },
    { personaIds: ["a"], rounds: 2.5 },
    { personaIds: ["a"], rounds: "2" },
    "roster",
  ]) {
    const before = calls.length;
    const r = await fetch(`${base}/api/sessions/s1/room`, {
      method: "PUT",
      headers,
      body: JSON.stringify(room === undefined ? {} : { room }),
    });
    assert.equal(r.status, 400, `rejected: ${JSON.stringify(room)}`);
    assert.equal(since(before, "/v1/sessions/s1/room"), undefined, "nothing reaches core");
  }
});

/**
 * The relay's job is to keep junk off the wire, not to be a second, stricter rulebook: core
 * caps `rounds` at ROOM_MAX_ROUNDS (20) and puts no cap at all on roster size, and an edit
 * that core would accept must not die here. The dialog's "Custom…" rounds field reaches 20,
 * and `@tag`-ing agents into a room grows a roster past any small number.
 */
test("the relay's roster rules are core's: no size cap, rounds up to 20", async () => {
  for (const room of [
    { personaIds: ["a", "b", "c", "d", "e", "f"], rounds: 1 },
    { personaIds: ["a"], rounds: 7 },
    { personaIds: ["a"], rounds: 20 },
  ]) {
    const before = calls.length;
    const r = await fetch(`${base}/api/sessions/s1/room`, { method: "PUT", headers, body: JSON.stringify({ room }) });
    assert.equal(r.status, 200, `accepted: ${JSON.stringify(room)}`);
    assert.deepEqual(since(before, "/v1/sessions/s1/room")?.body, { principalId: "alice", room });
  }
});

/** The signed-in principal is the one core sees — a body cannot edit somebody else's room. */
test("a room edit always relays the signed-in principal, never the body's", async () => {
  const before = calls.length;
  await fetch(`${base}/api/sessions/s1/room`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ room: { personaIds: ["ap_1"], rounds: 3 }, principalId: "mallory" }),
  });
  assert.equal(since(before, "/v1/sessions/s1/room")?.body.principalId, "alice");
});

test("the first message of a new room carries its roster through to core's turn", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: "Scout, find the weak points.",
      threadRef: "web:alice:t1",
      room: { personaIds: ["ap_1", "ap_2"], rounds: 2 },
    }),
  });
  assert.equal(r.status, 200);
  const call = since(before, "/v1/turns");
  assert.ok(call, "the turn must reach core");
  assert.deepEqual(call.body.room, { personaIds: ["ap_1", "ap_2"], rounds: 2 });
  assert.equal(call.body.text, "Scout, find the weak points.");
});

test("an ordinary turn carries no room key at all", async () => {
  const before = calls.length;
  await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hello", threadRef: "web:alice:t2" }),
  });
  assert.equal("room" in (since(before, "/v1/turns")?.body ?? {}), false);
});

test("a malformed roster on a turn is rejected at the relay instead of reaching core", async () => {
  for (const room of [null, { personaIds: [], rounds: 1 }, { personaIds: ["a"], rounds: 99 }, "roster"]) {
    const before = calls.length;
    const r = await fetch(`${base}/api/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hi", threadRef: "web:alice:t3", room }),
    });
    assert.equal(r.status, 400, `rejected: ${JSON.stringify(room)}`);
    assert.equal(since(before, "/v1/turns"), undefined, "nothing reaches core");
  }
});

test("core refusing a roster comes back as a 403 that still carries the reason", async () => {
  refuseTurn = "agent Critic is disabled";
  try {
    const r = await fetch(`${base}/api/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "go", threadRef: "web:alice:t4", room: { personaIds: ["ap_1"], rounds: 1 } }),
    });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { status: "refused", reason: "agent Critic is disabled" });
  } finally {
    refuseTurn = "";
  }
});

test("core's 404 with the feature flag off is relayed verbatim, not turned into a 500", async () => {
  flagOff = true;
  try {
    const r = await fetch(`${base}/api/agents`, { headers });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "not_found" });
  } finally {
    flagOff = false;
  }
});

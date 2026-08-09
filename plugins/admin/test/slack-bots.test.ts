import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

// A realistic redacted GET /v1/admin/slack-bots response, shaped exactly like
// listSlackBots() in src/api/routes/admin/slack-bots.ts: tokens are never present.
const LIST_RESPONSE = {
  bots: [
    {
      id: "b1",
      label: "Codex",
      personaId: "ap_codex",
      enabled: true,
      teamId: "T1",
      teamName: "Acme HQ",
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
      updatedBy: "U-admin",
      version: "v1",
    },
    {
      id: "b2",
      label: "Broken bot",
      personaId: null,
      enabled: true,
      createdAt: 1700000000000,
      updatedAt: 1700000002000,
      updatedBy: "U-admin",
      lastError: "additional Slack bots need Socket Mode; this deployment runs SLACK_EVENTS_MODE=http",
      lastErrorAt: 1700000003000,
      version: "v2",
    },
  ],
  socketModeOnly: true,
  eventsMode: "socket",
  createUrl: "https://api.slack.com/apps?new_app=1&manifest_json=%7B...%7D",
};

const calls: { method: string; url: string; actor: string | null; signed: boolean; body: string }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      actor: (req.headers["x-admin-actor"] as string) ?? null,
      signed: Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]),
      body,
    });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "GET" && (req.url ?? "").startsWith("/v1/admin/slack-bots")) {
      return void res.end(JSON.stringify(LIST_RESPONSE));
    }
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-slack-bots-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("GET /api/slack-bots forwards to /v1/admin/slack-bots and returns the redacted list the card renders from", async () => {
  const r = await fetch(`${base}/api/slack-bots`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/slack-bots");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
  const body = (await r.json()) as typeof LIST_RESPONSE;
  assert.deepEqual(body, LIST_RESPONSE);
  // no token fields ever cross the wire
  assert.doesNotMatch(JSON.stringify(body), /botToken|appToken|xoxb-|xapp-/);
});

test("POST /api/slack-bots forwards the create body, actor, and signature", async () => {
  const r = await fetch(`${base}/api/slack-bots`, {
    method: "POST",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ label: "Codex", botToken: "xoxb-1", appToken: "xapp-1", personaId: "ap_codex" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/v1/admin/slack-bots");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
  assert.deepEqual(JSON.parse(c.body), {
    label: "Codex",
    botToken: "xoxb-1",
    appToken: "xapp-1",
    personaId: "ap_codex",
  });
});

test("PUT /api/slack-bots/:id forwards an enabled-toggle patch", async () => {
  const r = await fetch(`${base}/api/slack-bots/b1`, {
    method: "PUT",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "PUT");
  assert.equal(c.url, "/v1/admin/slack-bots/b1");
  assert.deepEqual(JSON.parse(c.body), { enabled: false });
});

test("DELETE /api/slack-bots/:id forwards as DELETE with no body", async () => {
  const r = await fetch(`${base}/api/slack-bots/b1`, { method: "DELETE", headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "DELETE");
  assert.equal(c.url, "/v1/admin/slack-bots/b1");
  assert.equal(c.body, "");
});

test("slack-bots reads and writes require a signed-in cookie (no core hop)", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/slack-bots`)).status, 401);
  assert.equal(
    (await fetch(`${base}/api/slack-bots`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
      .status,
    401,
  );
  assert.equal((await fetch(`${base}/api/slack-bots/b1`, { method: "PUT" })).status, 401);
  assert.equal((await fetch(`${base}/api/slack-bots/b1`, { method: "DELETE" })).status, 401);
  assert.equal(calls.length, before, "a signed-out request is rejected at the surface, never forwarded");
});

test("the Slack bots card renders label, persona, team, enabled toggle, and a red timestamped lastError from the list shape", () => {
  assert.match(html, /id="card-slack-bots"/);
  assert.match(html, /api\("GET", "\/api\/slack-bots"\)/);
  assert.match(html, /api\("POST", "\/api\/slack-bots",/);
  assert.match(html, /api\("PUT", "\/api\/slack-bots\/" \+ encodeURIComponent\(bot\.id\), \{ enabled: checkbox\.checked \}\)/);
  assert.match(html, /api\("DELETE", "\/api\/slack-bots\/" \+ encodeURIComponent\(bot\.id\)\)/);
  assert.match(html, /"answers as " \+ \(slackBotAgentNames\.get\(bot\.personaId\) \|\| bot\.personaId\)/);
  assert.match(html, /api\("GET", "\/api\/slack-bots\/agents"\)/);
  assert.match(html, /bot\.teamName \|\| bot\.teamId \|\| "not yet connected"/);
  assert.match(html, /checkbox\.checked = bot\.enabled/);
  assert.match(html, /err\.className = "flag-err";/);
  assert.match(html, /bot\.lastError \+ \(bot\.lastErrorAt \? " \(" \+ fmtTime\(bot\.lastErrorAt\) \+ "\)" : ""\)/);
  assert.match(html, /if \(r\.data\.createUrl\) \$\("slack-bots-create"\)\.href = r\.data\.createUrl;/);
  assert.match(html, /Delete the Slack bot/);
  assert.match(html, /type="password"\s+id="slack-bot-new-token"/);
  assert.match(html, /type="password"\s+id="slack-bot-new-app-token"/);
  assert.match(html, /id="slack-bot-new-persona"/);
});

test("the Slack bots card is reachable from the connectors view, not a new top-level view", () => {
  const sectionsStart = html.indexOf("const SECTIONS = [");
  const sectionsEnd = html.indexOf("const DISABLED_VIEWS", sectionsStart);
  assert.ok(sectionsStart >= 0 && sectionsEnd > sectionsStart, "could not locate SECTIONS block");
  const sectionsBlock = html.slice(sectionsStart, sectionsEnd);
  assert.match(sectionsBlock, /"connectors"/);
  assert.doesNotMatch(sectionsBlock, /slack-bots/, "no new view was added for the Slack bots card");
  assert.match(html, /await loadSlackInstallation\(\);\s*await loadSlackBots\(\);/);
});

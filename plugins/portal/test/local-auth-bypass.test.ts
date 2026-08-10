import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";

const upstream = createServer((req: IncomingMessage, res) => {
  if (req.url === "/api/whoami") {
    const m = (req.headers.cookie ?? "").match(/admin=([^;]+)/);
    const sub = m ? decodeURIComponent(m[1] ?? "") : "";
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: sub === "local-admin" }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "http://localhost:18197";
process.env.PORTAL_SESSION_SECRET = "local-auth-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "local-auth-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
process.env.PORTAL_LOCAL_AUTH_BYPASS = "1";
process.env.PORTAL_DEV_PRINCIPAL = "local-admin";

const { isLoopbackAddress, isLoopbackHostHeader, isLocalBypassRequest, server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const portalPort = (server.address() as AddressInfo).port;
const base = `http://localhost:${portalPort}`;

/**
 * node:http rather than fetch: the whole point of these cases is controlling the
 * `Host` header, which fetch treats as forbidden and owns itself.
 */
function rawRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: portalPort, path, method, headers, setHost: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const rawGet = (path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> =>
  rawRequest("GET", path, headers);

const localReq = (
  over: { host?: string; cf?: Record<string, string>; remoteAddress?: string } = {},
): { headers: IncomingHttpHeaders; socket: { remoteAddress?: string } } => ({
  headers: { host: over.host ?? "localhost:8291", ...(over.cf ?? {}) } as IncomingHttpHeaders,
  socket: { remoteAddress: over.remoteAddress ?? "127.0.0.1" },
});

test.after(() => {
  server.close();
  upstream.close();
});

test("local auth bypass signs in loopback portal requests without OIDC", async () => {
  const login = await fetch(`${base}/auth/login?returnTo=/admin/`, { redirect: "manual" });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("location"), "/admin/");
  assert.match(login.headers.get("set-cookie") ?? "", /portal_session=/);

  const admin = await fetch(`${base}/admin/api/me`);
  assert.equal(admin.status, 200);
  const body = (await admin.json()) as { url: string; cookie: string };
  assert.equal(body.url, "/api/me");
  assert.equal(body.cookie, "admin=local-admin");
});

test("local auth bypass only treats loopback client addresses as local", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.4.5.6"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isLoopbackAddress("::ffff:192.168.1.10"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("local auth bypass respects logout until explicit login", async () => {
  const logout = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { origin: process.env.PORTAL_PUBLIC_URL ?? "" },
    redirect: "manual",
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /portal_local_logout=1/);

  const loggedOut = await fetch(`${base}/admin/api/me`, {
    headers: { cookie: "portal_local_logout=1" },
    redirect: "manual",
  });
  assert.equal(loggedOut.status, 401);

  const login = await fetch(`${base}/auth/login?returnTo=/admin/`, {
    headers: { cookie: "portal_local_logout=1" },
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  assert.match(login.headers.get("set-cookie") ?? "", /portal_local_logout=;[^,]*Max-Age=0/);
});

// qm-local: the bypass is decided PER REQUEST so one deployment can serve both a
// private localhost front door (auto sign-in) and a public hostname (real
// sign-in) at once. These pin the classification down.

test("a loopback Host header is recognised on any port and in any loopback spelling", () => {
  for (const host of [
    "localhost",
    "localhost:8291",
    "LOCALHOST:8291",
    "127.0.0.1:8291",
    "127.4.5.6",
    "[::1]:8291",
    "[0:0:0:0:0:0:0:1]",
  ]) {
    assert.equal(isLoopbackHostHeader(host), true, host);
  }
  for (const host of [
    "qm.strideops.ai",
    "qm.strideops.ai:443",
    "localhost.evil.com",
    "127.0.0.1.evil.com",
    "192.168.1.10:8291",
    "[::1",
    "",
    "   ",
    undefined,
    ["localhost", "qm.strideops.ai"],
  ]) {
    assert.equal(isLoopbackHostHeader(host), false, JSON.stringify(host));
  }
});

test("loopback Host + no Cloudflare headers + loopback peer is local", () => {
  assert.equal(isLocalBypassRequest(localReq()), true);
  assert.equal(isLocalBypassRequest(localReq({ host: "[::1]:8291", remoteAddress: "::1" })), true);
});

test("a public Host over a loopback socket is NOT local — that is exactly the tunnel", () => {
  // cloudflared runs on this machine and dials the portal over loopback, so the
  // peer address alone would wave the whole public internet through.
  assert.equal(isLocalBypassRequest(localReq({ host: "qm.strideops.ai" })), false);
  assert.equal(
    isLocalBypassRequest(localReq({ host: "qm.strideops.ai" }), { enabled: true, trustedIngress: true }),
    false,
  );
});

test("a loopback Host carrying Cloudflare edge headers is NOT local — spoofed Host", () => {
  for (const header of ["cf-ray", "cf-connecting-ip", "cf-ipcountry", "cf-visitor"]) {
    assert.equal(isLocalBypassRequest(localReq({ cf: { [header]: "x" } })), false, header);
  }
});

test("a non-loopback peer is NOT local unless the deployment vouched for its ingress", () => {
  const fromLan = localReq({ remoteAddress: "192.168.1.10" });
  assert.equal(isLocalBypassRequest(fromLan, { enabled: true, trustedIngress: false }), false);
  assert.equal(isLocalBypassRequest(fromLan, { enabled: true, trustedIngress: true }), true);
});

test("with the flag off nothing is ever local", () => {
  assert.equal(isLocalBypassRequest(localReq(), { enabled: false }), false);
  assert.equal(isLocalBypassRequest(localReq(), { enabled: false, trustedIngress: true }), false);
});

test("in production nothing is ever local, even with the flag on", () => {
  const probe = [
    "const m = await import('./src/index.ts');",
    "const req = { headers: { host: 'localhost:8291' }, socket: { remoteAddress: '127.0.0.1' } };",
    "process.stdout.write(String(m.isLocalBypassRequest(req)));",
  ].join("\n");
  const run = (env: NodeJS.ProcessEnv): string =>
    spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: "utf8",
    }).stdout;
  assert.equal(run({ NODE_ENV: "production", PORTAL_LOCAL_AUTH_BYPASS: "1" }), "false");
  assert.equal(run({ NODE_ENV: "development", PORTAL_LOCAL_AUTH_BYPASS: "1" }), "true");
});

test("over the wire: a public Host never gets a bypass session, a loopback Host does", async () => {
  const local = await rawGet("/admin/api/me", { host: `localhost:${portalPort}` });
  assert.equal(local.status, 200);
  assert.equal((JSON.parse(local.body) as { cookie: string }).cookie, "admin=local-admin");

  const tunneled = await rawGet("/admin/api/me", { host: "qm.strideops.ai" });
  assert.equal(tunneled.status, 401, tunneled.body);

  const spoofed = await rawGet("/admin/api/me", { host: `localhost:${portalPort}`, "cf-ray": "8f2c-DFW" });
  assert.equal(spoofed.status, 401, spoofed.body);
});

// PORTAL_PUBLIC_URL here is http://localhost:18197 while the server listens on an
// ephemeral port, so "the local front door" and "the configured public origin" are
// genuinely different origins — the same split the tunnel deployment has.
test("writes from the local front door pass CSRF; other origins and the public host do not", async () => {
  const localDoor = { host: `localhost:${portalPort}`, origin: `http://localhost:${portalPort}` };

  const fromLocalDoor = await rawRequest("POST", "/auth/logout", localDoor);
  assert.equal(fromLocalDoor.status, 200, fromLocalDoor.body);

  const fromElsewhere = await rawRequest("POST", "/auth/logout", {
    host: `localhost:${portalPort}`,
    origin: "http://localhost:31337",
  });
  assert.equal(fromElsewhere.status, 403, fromElsewhere.body);

  const crossSite = await rawRequest("POST", "/auth/logout", {
    host: `localhost:${portalPort}`,
    origin: "https://evil.example.com",
  });
  assert.equal(crossSite.status, 403, crossSite.body);

  // Same Origin header, but the request came in over the tunnel: not provably
  // local, so the loopback relaxation must not apply.
  const overTheTunnel = await rawRequest("POST", "/auth/logout", {
    host: "qm.strideops.ai",
    origin: "http://localhost:8291",
  });
  assert.equal(overTheTunnel.status, 403, overTheTunnel.body);
});

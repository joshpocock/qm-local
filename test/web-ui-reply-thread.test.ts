// The web plugin's half of reply-in-thread: `/api/turn` carries the client's `replyToSeq`
// through to core, and core's refusal comes back to the client rather than being swallowed
// into a message that lands outside the thread it was aimed at.
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { SessionEntry } from "../src/types.ts";

const SECRET = "core-signing-secret".repeat(3);

const built = buildApp(
  testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webui-reply-")), harness: "mock", seedSkills: false }),
);
built.runtime.start();
const core = createServer(built.app, { signingSecret: SECRET });
core.listen(0);
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { handler } = await import("../plugins/web-ui/server/index.ts");
const web = createHttpServer(handler);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
  await built.runtime.stop();
});

const USER = "alice";
const THREAD = `web:${USER}:threaded`;

function asUser(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: `webuiuser=${encodeURIComponent(USER)}`,
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: USER, exp: Date.now() + 60_000 }, SECRET),
    },
  };
}

const postTurn = (body: Record<string, unknown>) =>
  fetch(`${webBase}/api/turn`, asUser({ method: "POST", body: JSON.stringify({ threadRef: THREAD, ...body }) }));

/** Waits for the turn to settle far enough that `want` more entries exist, and returns them all. */
async function entriesAfter(want: number, have: number): Promise<SessionEntry[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const session = await built.sessions.getByThread(THREAD);
    const entries = session ? await built.sessions.getEntries(session.id) : [];
    if (entries.length >= have + want) return entries;
    assert.ok(Date.now() < deadline, `timed out waiting for ${want} more entries (have ${entries.length})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const users = (entries: readonly SessionEntry[]) => entries.filter((e) => e.type === "user");

test("a reply carrying replyToSeq lands under the thread root core resolved for it", async () => {
  const opener = await postTurn({ text: "what should we do about the pricing page?" });
  assert.ok(opener.status < 300, `the opening turn should be accepted (got ${opener.status})`);
  const opened = await entriesAfter(2, 0);
  const root = users(opened)[0]!;

  const reply = await postTurn({ text: "say more about the headline", replyToSeq: root.seq });
  assert.ok(reply.status < 300, `the threaded reply should be accepted (got ${reply.status})`);
  const after = await entriesAfter(2, opened.length);
  const threaded = users(after).at(-1)!;

  assert.notEqual(threaded.seq, root.seq, "a second message was written");
  assert.equal(threaded.parentSeq, root.seq, "and the plugin's passthrough is what put it in the thread");
});

test("core's refusal reaches the client instead of a message landing outside its thread", async () => {
  const before = (await built.sessions.getEntries((await built.sessions.getByThread(THREAD))!.id)).length;
  const refused = await postTurn({ text: "into the void", replyToSeq: 9999 });
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { status?: string }).status, "refused");
  assert.equal(
    (await built.sessions.getEntries((await built.sessions.getByThread(THREAD))!.id)).length,
    before,
    "and nothing was written",
  );
});

test("a malformed replyToSeq is dropped, and the message still sends as an ordinary turn", async () => {
  const session = (await built.sessions.getByThread(THREAD))!;
  const before = (await built.sessions.getEntries(session.id)).length;
  const sent = await postTurn({ text: "plain message", replyToSeq: "not a number" });
  assert.ok(sent.status < 300, `a client bug must not cost the message (got ${sent.status})`);
  const after = await entriesAfter(2, before);
  const written = users(after).at(-1)!;
  assert.equal(written.parentSeq, written.seq - 1, "it stays on the linear chain, exactly as it does today");
});

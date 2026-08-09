import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(opts: { eventsMode?: "socket" | "http"; socketAppId?: string } = {}): {
  base: string;
  built: BuiltApp;
  close: () => Promise<void>;
} {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "slack-bots-")) }));
  const server = createInsecureTestServer(built.app, {
    replayDedupe: built.replayDedupe,
    slackInstallation: built.slackInstallation,
    slackBots: built.slackBots,
    slackEventsMode: opts.eventsMode ?? "socket",
    slackInstallationFetch: (async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/auth.test")
            ? { ok: true, team_id: "T-ACME", team: "Acme", app_id: "A-CODEX" }
            : { ok: true, url: "wss://example.invalid" },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
    slackInstallationSocketAppId: async () => opts.socketAppId ?? "A-CODEX",
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const TOKENS = { botToken: "xoxb-codex-super-secret", appToken: "xapp-codex-super-secret" };

const post = (base: string, body: object) =>
  fetch(`${base}/v1/admin/slack-bots`, { method: "POST", headers: ADMIN, body: JSON.stringify(body) });
const put = (base: string, id: string, body: object) =>
  fetch(`${base}/v1/admin/slack-bots/${id}`, { method: "PUT", headers: ADMIN, body: JSON.stringify(body) });

async function persona(built: BuiltApp, name: string, enabled = true) {
  return built.app.createPersona({
    principalId: "admin-alice@default-org",
    name,
    color: "#BA9926",
    glyph: "CX",
    harnessId: "pi",
    modelId: "claude-opus-4-8",
    instructions: `You are ${name}.`,
    enabled,
  });
}

test("an additional Slack bot is created, listed and deleted without its tokens ever coming back", async () => {
  const srv = start();
  try {
    const agent = await persona(srv.built, "Codex");

    const created = await post(srv.base, { label: "Codex bot", personaId: agent.id, ...TOKENS });
    assert.equal(created.status, 201);
    const createdText = await created.text();
    assert.doesNotMatch(createdText, /xoxb|xapp|super-secret/);
    const bot = JSON.parse(createdText) as { id: string; personaId: string; enabled: boolean; label: string };
    assert.equal(bot.personaId, agent.id);
    assert.equal(bot.enabled, true);
    assert.equal(bot.label, "Codex bot");

    const listed = await fetch(`${srv.base}/v1/admin/slack-bots`, { headers: ADMIN });
    assert.equal(listed.status, 200);
    const listedText = await listed.text();
    assert.doesNotMatch(listedText, /xoxb|xapp|super-secret|TokenEnc/);
    const body = JSON.parse(listedText) as { bots: Array<{ id: string; teamId?: string }>; createUrl: string };
    assert.deepEqual(
      body.bots.map((b) => b.id),
      [bot.id],
    );
    assert.equal(body.bots[0]?.teamId, "T-ACME");
    assert.ok(body.createUrl.includes("api.slack.com/apps"));

    // The tokens really are stored, just never echoed.
    assert.equal((await srv.built.slackBots.getWithTokens(bot.id))?.botToken, TOKENS.botToken);

    const removed = await fetch(`${srv.base}/v1/admin/slack-bots/${bot.id}`, { method: "DELETE", headers: ADMIN });
    assert.equal(removed.status, 200);
    assert.deepEqual(await srv.built.slackBots.list(), []);
    assert.equal(
      (await fetch(`${srv.base}/v1/admin/slack-bots/${bot.id}`, { method: "DELETE", headers: ADMIN })).status,
      404,
    );
  } finally {
    await srv.close();
  }
});

test("a bot may be created with no persona at all", async () => {
  const srv = start();
  try {
    const created = await post(srv.base, { label: "Spare", ...TOKENS });
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as { personaId: unknown }).personaId, null);
  } finally {
    await srv.close();
  }
});

test("an unknown, archived or disabled persona is refused", async () => {
  const srv = start();
  try {
    const unknown = await post(srv.base, { label: "Ghost", personaId: "nope", ...TOKENS });
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /unknown agent/);

    const off = await persona(srv.built, "Sleepy", false);
    const disabled = await post(srv.base, { label: "Sleepy bot", personaId: off.id, ...TOKENS });
    assert.equal(disabled.status, 400);
    assert.match(await disabled.text(), /disabled/);

    const gone = await persona(srv.built, "Retired");
    await srv.built.app.archivePersona(gone.id, "admin-alice@default-org");
    const archived = await post(srv.base, { label: "Retired bot", personaId: gone.id, ...TOKENS });
    assert.equal(archived.status, 400);
    assert.match(await archived.text(), /unknown agent/);

    assert.deepEqual(await srv.built.slackBots.list(), [], "nothing invalid was stored");
  } finally {
    await srv.close();
  }
});

test("token pairs from different Slack apps are refused, exactly like the singular installation", async () => {
  const srv = start({ socketAppId: "A-OTHER" });
  try {
    const created = await post(srv.base, { label: "Codex bot", ...TOKENS });
    assert.equal(created.status, 400);
    assert.match(await created.text(), /different Slack apps/);
    assert.deepEqual(await srv.built.slackBots.list(), []);
  } finally {
    await srv.close();
  }
});

test("update relabels, reassigns, and enables/disables a bot", async () => {
  const srv = start();
  try {
    const codex = await persona(srv.built, "Codex");
    const claude = await persona(srv.built, "ClaudeCode");
    const bot = (await (await post(srv.base, { label: "Codex bot", personaId: codex.id, ...TOKENS })).json()) as {
      id: string;
      version: string;
    };

    const reassigned = await put(srv.base, bot.id, { personaId: claude.id, label: "Claude bot" });
    assert.equal(reassigned.status, 200);
    const after = (await reassigned.json()) as { personaId: string; label: string; version: string };
    assert.equal(after.personaId, claude.id);
    assert.equal(after.label, "Claude bot");
    assert.notEqual(after.version, bot.version, "the reconciler must see a config change");

    const off = await put(srv.base, bot.id, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(((await off.json()) as { enabled: boolean }).enabled, false);

    const cleared = await put(srv.base, bot.id, { personaId: null });
    assert.equal(((await cleared.json()) as { personaId: unknown }).personaId, null);

    const halfRotation = await put(srv.base, bot.id, { botToken: "xoxb-only-half" });
    assert.equal(halfRotation.status, 400);
    assert.match(await halfRotation.text(), /rotated together/);

    assert.equal((await put(srv.base, "missing-id", { label: "x" })).status, 404);
  } finally {
    await srv.close();
  }
});

test("http events mode refuses additional bots instead of starting one that cannot listen", async () => {
  const srv = start({ eventsMode: "http" });
  try {
    const created = await post(srv.base, { label: "Codex bot", ...TOKENS });
    assert.equal(created.status, 400);
    const text = await created.text();
    assert.match(text, /socket_mode_required/);
    assert.match(text, /Socket Mode/);

    const listed = (await (await fetch(`${srv.base}/v1/admin/slack-bots`, { headers: ADMIN })).json()) as {
      unsupported?: string;
      eventsMode: string;
    };
    assert.equal(listed.eventsMode, "http");
    assert.match(listed.unsupported ?? "", /Socket Mode/);
  } finally {
    await srv.close();
  }
});

test("a non-admin cannot read or write the bot registry", async () => {
  const srv = start();
  try {
    const headers = { "content-type": "application/json", "x-admin-actor": "nobody@default-org" };
    assert.equal((await fetch(`${srv.base}/v1/admin/slack-bots`, { headers })).status, 403);
    assert.equal(
      (
        await fetch(`${srv.base}/v1/admin/slack-bots`, {
          method: "POST",
          headers,
          body: JSON.stringify({ label: "Sneaky", ...TOKENS }),
        })
      ).status,
      403,
    );
  } finally {
    await srv.close();
  }
});

test("the same Slack app cannot be registered twice, or alongside the default bot", async () => {
  const srv = start();
  try {
    const first = (await (await post(srv.base, { label: "Codex bot", ...TOKENS })).json()) as { id: string };

    const again = await post(srv.base, { label: "Codex again", ...TOKENS });
    assert.equal(again.status, 400);
    assert.match(await again.text(), /already belong to the .{0,4}Codex bot/);

    // The default installation's tokens are off limits too: two Bolt apps on one Slack app
    // fight over a single Socket Mode subscription.
    await srv.built.slackInstallation.set({
      botToken: "xoxb-the-default-bot",
      appToken: "xapp-the-default-bot",
      updatedBy: "admin-alice",
    });
    const stolen = await post(srv.base, {
      label: "Impostor",
      botToken: "xoxb-the-default-bot",
      appToken: "xapp-the-default-bot",
    });
    assert.equal(stolen.status, 400);
    assert.match(await stolen.text(), /default Slack bot/);

    assert.deepEqual(
      (await srv.built.slackBots.list()).map((b) => b.id),
      [first.id],
    );
  } finally {
    await srv.close();
  }
});

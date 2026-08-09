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

/**
 * The SINGULAR default Slack installation, and specifically its PANEL persona — the agent the
 * default bot answers as inside a room panel and nowhere else (docs/slack-multi-bot.md).
 */

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const TOKENS = { botToken: "xoxb-default-super-secret", appToken: "xapp-default-super-secret" };

function start(): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "slack-install-")) }));
  const server = createInsecureTestServer(built.app, {
    replayDedupe: built.replayDedupe,
    slackInstallation: built.slackInstallation,
    slackBots: built.slackBots,
    slackEventsMode: "socket",
    slackInstallationFetch: (async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/auth.test")
            ? { ok: true, team_id: "T-ACME", team: "Acme", app_id: "A-QM" }
            : { ok: true, url: "wss://example.invalid" },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
    slackInstallationSocketAppId: async () => "A-QM",
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const put = (base: string, body: object) =>
  fetch(`${base}/v1/admin/slack-installation`, { method: "PUT", headers: ADMIN, body: JSON.stringify(body) });
const get = (base: string) => fetch(`${base}/v1/admin/slack-installation`, { headers: ADMIN });

async function persona(built: BuiltApp, name: string, enabled = true) {
  return built.app.createPersona({
    principalId: "admin-alice@default-org",
    name,
    color: "#BA9926",
    glyph: "HS",
    harnessId: "pi",
    modelId: "claude-opus-4-8",
    instructions: `You are ${name}.`,
    enabled,
  });
}

test("a panel agent is saved with the tokens, read back, and never echoes a token", async () => {
  const srv = start();
  try {
    const host = await persona(srv.built, "Host");

    const saved = await put(srv.base, { ...TOKENS, panelPersonaId: host.id });
    assert.equal(saved.status, 200);
    const savedText = await saved.text();
    assert.doesNotMatch(savedText, /xoxb|xapp|super-secret|TokenEnc/);
    assert.equal((JSON.parse(savedText) as { panelPersonaId: unknown }).panelPersonaId, host.id);

    const read = await get(srv.base);
    assert.equal(read.status, 200);
    const readText = await read.text();
    assert.doesNotMatch(readText, /xoxb|xapp|super-secret|TokenEnc/);
    const body = JSON.parse(readText) as { configured: boolean; panelPersonaId: unknown };
    assert.equal(body.configured, true);
    assert.equal(body.panelPersonaId, host.id);

    // The tokens really are stored, just never echoed.
    assert.equal((await srv.built.slackInstallation.get())?.botToken, TOKENS.botToken);
    assert.equal((await srv.built.slackInstallation.get())?.panelPersonaId, host.id);
  } finally {
    await srv.close();
  }
});

test("the panel agent is rebound on its own, without re-entering the write-only tokens", async () => {
  const srv = start();
  try {
    const host = await persona(srv.built, "Host");
    const rival = await persona(srv.built, "Rival");
    const first = (await (await put(srv.base, { ...TOKENS, panelPersonaId: host.id })).json()) as { version: string };

    const rebound = await put(srv.base, { panelPersonaId: rival.id });
    assert.equal(rebound.status, 200);
    const after = (await rebound.json()) as { panelPersonaId: unknown; version: string; configured: boolean };
    assert.equal(after.panelPersonaId, rival.id);
    assert.equal(after.configured, true);
    assert.notEqual(after.version, first.version, "the reconciler must see a config change and restart the bot");

    const stored = await srv.built.slackInstallation.get();
    assert.equal(stored?.botToken, TOKENS.botToken, "the tokens survive a rebind untouched");
    assert.equal(stored?.appToken, TOKENS.appToken);
    assert.equal(stored?.panelPersonaId, rival.id);

    // …and null clears it, back to a plain default bot.
    const cleared = await put(srv.base, { panelPersonaId: null });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as { panelPersonaId: unknown }).panelPersonaId, null);
    assert.equal((await srv.built.slackInstallation.get())?.panelPersonaId, undefined);
    assert.equal((await srv.built.slackInstallation.get())?.botToken, TOKENS.botToken);
  } finally {
    await srv.close();
  }
});

test("an unknown, archived or disabled agent is refused, and nothing is stored", async () => {
  const srv = start();
  try {
    await put(srv.base, TOKENS);

    const unknown = await put(srv.base, { panelPersonaId: "nope" });
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /unknown agent/);

    const off = await persona(srv.built, "Sleepy", false);
    const disabled = await put(srv.base, { panelPersonaId: off.id });
    assert.equal(disabled.status, 400);
    assert.match(await disabled.text(), /disabled/);

    const gone = await persona(srv.built, "Retired");
    await srv.built.app.archivePersona(gone.id, "admin-alice@default-org");
    const archived = await put(srv.base, { panelPersonaId: gone.id });
    assert.equal(archived.status, 400);
    assert.match(await archived.text(), /unknown agent/);

    // A bad agent on a token save is refused before the tokens are touched, too.
    const withTokens = await put(srv.base, { ...TOKENS, panelPersonaId: "nope" });
    assert.equal(withTokens.status, 400);

    assert.equal((await srv.built.slackInstallation.get())?.panelPersonaId, undefined, "nothing invalid was stored");
  } finally {
    await srv.close();
  }
});

test("a token rotation carries the panel agent forward instead of silently unbinding it", async () => {
  const srv = start();
  try {
    const host = await persona(srv.built, "Host");
    await put(srv.base, { ...TOKENS, panelPersonaId: host.id });

    const rotated = await put(srv.base, { botToken: "xoxb-rotated", appToken: "xapp-rotated" });
    assert.equal(rotated.status, 200);
    assert.equal(((await rotated.json()) as { panelPersonaId: unknown }).panelPersonaId, host.id);
    assert.equal((await srv.built.slackInstallation.get())?.botToken, "xoxb-rotated");
  } finally {
    await srv.close();
  }
});

test("the panel agent needs an installation to attach to, and a token-less save is unchanged otherwise", async () => {
  const srv = start();
  try {
    const host = await persona(srv.built, "Host");

    const early = await put(srv.base, { panelPersonaId: host.id });
    assert.equal(early.status, 400);
    assert.match(await early.text(), /Slack tokens first/);

    // No tokens AND no agent is exactly the request it always was: a token validation failure.
    const empty = await put(srv.base, {});
    assert.equal(empty.status, 400);
    assert.match(await empty.text(), /invalid_slack_installation/);

    const unconfigured = (await (await get(srv.base)).json()) as { configured: boolean; panelPersonaId?: unknown };
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.panelPersonaId, undefined, "an unconfigured installation reports no panel agent");
  } finally {
    await srv.close();
  }
});

// --- debate ROUNDS ------------------------------------------------------------------------

test("debate rounds are saved, read back, rebound without the tokens, and cleared with null", async () => {
  const srv = start();
  try {
    const first = (await (await put(srv.base, { ...TOKENS, panelRounds: 3 })).json()) as {
      panelRounds: unknown;
      version: string;
    };
    assert.equal(first.panelRounds, 3);
    assert.equal((await srv.built.slackInstallation.get())?.panelRounds, 3);
    assert.equal(((await (await get(srv.base)).json()) as { panelRounds: unknown }).panelRounds, 3);

    // Token-less rebind, the whole point of the setting: no redeploy, no re-entering secrets.
    const rebound = await put(srv.base, { panelRounds: 7 });
    assert.equal(rebound.status, 200);
    const after = (await rebound.json()) as { panelRounds: unknown; version: string };
    assert.equal(after.panelRounds, 7);
    assert.notEqual(after.version, first.version, "the reconciler must see a config change and restart the bot");
    assert.equal((await srv.built.slackInstallation.get())?.botToken, TOKENS.botToken, "the tokens are untouched");

    // …and null clears it back to the deployment default.
    const cleared = await put(srv.base, { panelRounds: null });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as { panelRounds: unknown }).panelRounds, null);
    assert.equal(
      (await srv.built.slackInstallation.get())?.panelRounds,
      undefined,
      "absent = fall back to env/default",
    );
    assert.equal((await srv.built.slackInstallation.get())?.botToken, TOKENS.botToken);

    // Both boundaries are accepted.
    assert.equal(((await (await put(srv.base, { panelRounds: 1 })).json()) as { panelRounds: unknown }).panelRounds, 1);
    assert.equal(
      ((await (await put(srv.base, { panelRounds: 20 })).json()) as { panelRounds: unknown }).panelRounds,
      20,
    );
  } finally {
    await srv.close();
  }
});

test("out-of-range, fractional, string and negative rounds are refused, and nothing is stored", async () => {
  const srv = start();
  try {
    await put(srv.base, { ...TOKENS, panelRounds: 4 });

    for (const bad of [0, 21, "3", 2.5, -1, true, [3], {}] as unknown[]) {
      const res = await put(srv.base, { panelRounds: bad });
      assert.equal(res.status, 400, `panelRounds ${JSON.stringify(bad)} must be refused`);
      const text = await res.text();
      assert.match(text, /invalid_panel_rounds/);
      assert.match(text, /whole number from 1 to 20/, "the message says exactly what is allowed");
      assert.doesNotMatch(text, /xoxb|xapp|super-secret|TokenEnc/, "a refusal never echoes a token");
    }

    // A bad value on a token save is refused before the tokens are touched, too.
    const withTokens = await put(srv.base, { botToken: "xoxb-new", appToken: "xapp-new", panelRounds: 99 });
    assert.equal(withTokens.status, 400);

    const stored = await srv.built.slackInstallation.get();
    assert.equal(stored?.panelRounds, 4, "the good value survives every refusal");
    assert.equal(stored?.botToken, TOKENS.botToken, "…and so do the tokens");
  } finally {
    await srv.close();
  }
});

test("the agent and the rounds are set together in one version bump, and each survives the other", async () => {
  const srv = start();
  try {
    const host = await persona(srv.built, "Host");
    await put(srv.base, TOKENS);

    const both = await put(srv.base, { panelPersonaId: host.id, panelRounds: 5 });
    assert.equal(both.status, 200);
    const body = (await both.json()) as { panelPersonaId: unknown; panelRounds: unknown };
    assert.deepEqual([body.panelPersonaId, body.panelRounds], [host.id, 5], "one PUT, one write, both fields");

    // Changing one leaves the other alone…
    const rival = await persona(srv.built, "Rival");
    await put(srv.base, { panelPersonaId: rival.id });
    let stored = await srv.built.slackInstallation.get();
    assert.deepEqual([stored?.panelPersonaId, stored?.panelRounds], [rival.id, 5], "rebinding the agent keeps rounds");

    await put(srv.base, { panelRounds: 2 });
    stored = await srv.built.slackInstallation.get();
    assert.deepEqual([stored?.panelPersonaId, stored?.panelRounds], [rival.id, 2], "changing rounds keeps the agent");

    // …and a token rotation carries both forward rather than silently resetting them.
    const rotated = await put(srv.base, { botToken: "xoxb-rotated", appToken: "xapp-rotated" });
    const after = (await rotated.json()) as { panelPersonaId: unknown; panelRounds: unknown };
    assert.deepEqual([after.panelPersonaId, after.panelRounds], [rival.id, 2]);
    assert.equal((await srv.built.slackInstallation.get())?.botToken, "xoxb-rotated");
  } finally {
    await srv.close();
  }
});

test("an installation with no rounds set reports null and stores nothing", async () => {
  const srv = start();
  try {
    // The pre-existing shape: tokens only, exactly what every record written before this field
    // existed looks like.
    await put(srv.base, TOKENS);
    const read = (await (await get(srv.base)).json()) as { panelRounds: unknown; panelPersonaId: unknown };
    assert.equal(read.panelRounds, null, "null on the wire is 'no admin choice'");
    assert.equal(read.panelPersonaId, null);
    const stored = await srv.built.slackInstallation.get();
    assert.equal(stored?.panelRounds, undefined, "and nothing at all on the record the plugin config reads");

    // An unconfigured installation reports neither field.
    const fresh = start();
    try {
      const none = (await (await get(fresh.base)).json()) as { configured: boolean; panelRounds?: unknown };
      assert.equal(none.configured, false);
      assert.equal(none.panelRounds, undefined);
    } finally {
      await fresh.close();
    }
  } finally {
    await srv.close();
  }
});

test("a non-admin cannot read or rebind the panel agent", async () => {
  const srv = start();
  try {
    const headers = { "content-type": "application/json", "x-admin-actor": "nobody@default-org" };
    assert.equal((await fetch(`${srv.base}/v1/admin/slack-installation`, { headers })).status, 403);
    assert.equal(
      (
        await fetch(`${srv.base}/v1/admin/slack-installation`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ panelPersonaId: "anything" }),
        })
      ).status,
      403,
    );
  } finally {
    await srv.close();
  }
});

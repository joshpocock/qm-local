import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

test("membership events invalidate the pushed authorization roster", async () => {
  const manifest = JSON.parse(await readFile(new URL("../src/slack/manifest.json", import.meta.url), "utf8")) as {
    settings?: { event_subscriptions?: { bot_events?: string[] } };
  };
  const events = manifest.settings?.event_subscriptions?.bot_events ?? [];
  assert.ok(events.includes("member_joined_channel"));
  assert.ok(events.includes("member_left_channel"));
});

test("a per-bot manifest carries that bot's display name, and no name means qm", async () => {
  const { slackBotManifestCreationUrl } = await import("../src/surfaces/slack-manifest.ts");

  const fallback = new URL(slackBotManifestCreationUrl());
  const fallbackManifest = JSON.parse(fallback.searchParams.get("manifest_json")!) as {
    display_information: { name: string };
    features: { bot_user: { display_name: string } };
  };
  assert.equal(fallbackManifest.display_information.name, "qm");
  assert.equal(fallbackManifest.features.bot_user.display_name, "qm");

  const named = new URL(slackBotManifestCreationUrl("Claude Code"));
  const namedManifest = JSON.parse(named.searchParams.get("manifest_json")!) as {
    display_information: { name: string };
    features: { bot_user: { display_name: string } };
  };
  assert.equal(namedManifest.display_information.name, "Claude Code");
  assert.equal(namedManifest.features.bot_user.display_name, "Claude Code");

  // Slack caps the display name at 35 chars, and an empty name falls back rather than failing.
  const long = new URL(slackBotManifestCreationUrl("x".repeat(80)));
  const longManifest = JSON.parse(long.searchParams.get("manifest_json")!) as {
    display_information: { name: string };
  };
  assert.equal(longManifest.display_information.name.length, 35);
  assert.equal(
    JSON.parse(new URL(slackBotManifestCreationUrl("   ")).searchParams.get("manifest_json")!).display_information.name,
    "qm",
  );
});

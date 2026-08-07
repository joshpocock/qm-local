import { readFileSync } from "node:fs";

interface SlackBotManifest {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string } };
}

/** Slack caps an app display name at 35 characters. */
const APP_NAME_MAX = 35;

/**
 * `name` renders the manifest for an ADDITIONAL bot (a persona-bound one, say), so the Slack app
 * created from it is recognisable in the workspace. Omitted, this is the historical "qm" app.
 */
export function slackBotManifestCreationUrl(name?: string): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../cli/templates/slack-manifest.json", import.meta.url), "utf8"),
  ) as SlackBotManifest;
  const appName = (name ?? "").replace(/\s+/g, " ").trim().slice(0, APP_NAME_MAX) || "qm";
  manifest.display_information.name = appName;
  manifest.display_information.description = "qm workspace agent";
  manifest.features.bot_user.display_name = appName;
  const url = new URL("https://api.slack.com/apps");
  url.searchParams.set("new_app", "1");
  url.searchParams.set("manifest_json", JSON.stringify(manifest));
  return url.toString();
}

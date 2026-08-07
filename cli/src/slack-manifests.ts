import { existsSync, readFileSync } from "node:fs";
import type { QmConfig } from "./config.ts";

function template(name: string): string {
  const source = new URL(`../templates/${name}`, import.meta.url);
  const packaged = new URL(`../../templates/${name}`, import.meta.url);
  return readFileSync(existsSync(source) ? source : packaged, "utf8");
}

function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const scalar = (item: unknown): string => {
    if (typeof item !== "string") return String(item);
    const plain = /^[A-Za-z0-9][A-Za-z0-9 _:./-]*$/.test(item) && !item.includes(": ") && !item.endsWith(" ");
    return plain ? item : JSON.stringify(item);
  };
  if (Array.isArray(value)) return value.map((item) => `${pad}- ${scalar(item)}`).join("\n");
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .map(([key, item]) =>
        typeof item === "object" && item !== null
          ? `${pad}${key}:\n${toYaml(item, indent + 1)}`
          : `${pad}${key}: ${scalar(item)}`,
      )
      .join("\n");
  }
  return `${pad}${scalar(value)}`;
}

export interface SlackManifests {
  bot: string;
  sso: string;
}

export function usesSlackOidc(config: QmConfig): boolean {
  const portal = config.env.portal ?? {};
  return ["OIDC_AUTH_ENDPOINT", "OIDC_TOKEN_ENDPOINT", "OIDC_USERINFO_ENDPOINT", "OIDC_ISSUER"].some((name) =>
    portal[name]?.includes("slack.com"),
  );
}

/** Slack caps an app's display name at 35 characters; keep whatever we render inside it. */
export const SLACK_APP_NAME_MAX = 35;

/** The default bot's name, and the fallback whenever a per-bot name is empty or unusable. */
export const DEFAULT_SLACK_APP_NAME = "qm";

/**
 * A Slack app display name for one bot. Multi-bot deployments render one manifest per bot with
 * the persona's name (a "Codex" bot, a "Claude Code" bot), so each Slack app is recognisable in
 * the workspace; with no name given this is the historical "qm".
 */
export function slackAppName(name?: string): string {
  const cleaned = (name ?? "").replace(/\s+/g, " ").trim().slice(0, SLACK_APP_NAME_MAX);
  return cleaned || DEFAULT_SLACK_APP_NAME;
}

export function renderSlackManifests(config: QmConfig, opts: { name?: string } = {}): SlackManifests {
  const bot = JSON.parse(template("slack-manifest.json")) as {
    display_information: { name: string; description: string };
    features: { bot_user: { display_name: string } };
  };
  const name = slackAppName(opts.name);
  bot.display_information.name = name;
  bot.display_information.description = `qm workspace agent for ${config.orgId}`;
  bot.features.bot_user.display_name = name;

  const sso = JSON.parse(template("slack-sso-manifest.json")) as {
    oauth_config: { redirect_urls: string[] };
  };
  sso.oauth_config.redirect_urls = [`${config.publicUrl.replace(/\/$/, "")}/auth/callback`];

  return {
    bot: `${toYaml(bot)}\n`,
    sso: `${toYaml(sso)}\n`,
  };
}

export function slackManifestCreationUrl(manifest: string): string {
  const url = new URL("https://api.slack.com/apps");
  url.searchParams.set("new_app", "1");
  url.searchParams.set("manifest_yaml", manifest);
  return url.toString();
}

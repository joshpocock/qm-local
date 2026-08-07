import { botIdentityFromEnv } from "./delivery.ts";

export const NO_RETRY = { retryConfig: { retries: 0 } } as const;

export interface SlackPluginConfig {
  botToken: string;
  appToken?: string;
  apiUrl?: string;
  eventsMode?: "socket" | "http";
  signingSecret?: string;
  eventsPort?: number;
  userToken?: string;
  copilotBotToken?: string;
  webUiPublicUrl?: string;
  identityEmail?: string;
  logLevel?: string;
  userSnapshotTtlMs?: number;
  channelMembersTtlMs?: number;
  maxPrivateChannels?: number;
  recentMessages?: number;
  userCacheTtlMs?: number;
  botIdentity?: { username?: string; icon_emoji?: string };
  devIntrospection?: { port: number };
  /**
   * Run every turn this bot receives AS this agent persona (its harness, model and
   * instructions) instead of the default org agent. Delivered to core as a single-member room
   * roster on the turn request, so the whole persona path is the one agent rooms already use.
   * Requires QM_AGENT_ROOMS; ignored by core when the flag is off.
   */
  personaId?: string;
  /**
   * This instance is an ADDITIONAL bot running beside the default one. Secondary instances
   * deliberately keep their hands off everything that is process-global or a shared queue:
   * no directory/mention-index push (`replaceChannels` is a REPLACE), no delivery polling and
   * no surface-context fulfilment (both are org-wide queues with no per-bot ownership, so a
   * second claimant would post under the wrong identity), no dev-introspection port, and no
   * global bot-identity override.
   */
  secondary?: boolean;
  /** Human label for logs, e.g. the registry record's label. */
  instanceLabel?: string;
}

export function slackPluginConfigFromEnv(env: Record<string, string | undefined>): SlackPluginConfig | null {
  const eventsMode = env.SLACK_EVENTS_MODE?.trim() === "http" ? "http" : "socket";
  if (!env.SLACK_BOT_TOKEN) return null;
  if (eventsMode === "socket" && !env.SLACK_APP_TOKEN) return null;
  if (eventsMode === "http" && !env.SLACK_SIGNING_SECRET) return null;
  const num = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const opt = <K extends keyof SlackPluginConfig>(
    key: K,
    value: SlackPluginConfig[K] | undefined,
  ): Partial<SlackPluginConfig> => (value === undefined ? {} : ({ [key]: value } as Partial<SlackPluginConfig>));
  return {
    botToken: env.SLACK_BOT_TOKEN,
    ...opt("appToken", env.SLACK_APP_TOKEN),
    ...opt("apiUrl", env.SLACK_API_URL),
    ...(eventsMode === "http" ? { eventsMode } : {}),
    ...opt("signingSecret", env.SLACK_SIGNING_SECRET),
    ...opt("eventsPort", num(env.SLACK_EVENTS_PORT)),
    ...opt("userToken", env.SLACK_USER_TOKEN),
    ...opt("copilotBotToken", env.SLACK_COPILOT_BOT_TOKEN),
    ...opt("webUiPublicUrl", env.WEB_UI_PUBLIC_URL),
    ...opt("identityEmail", env.SLACK_IDENTITY_EMAIL),
    ...opt("logLevel", env.SLACK_LOG_LEVEL),
    ...opt("userSnapshotTtlMs", num(env.SLACK_USER_SNAPSHOT_TTL_MS)),
    ...opt("channelMembersTtlMs", num(env.SLACK_CHANNEL_MEMBERS_TTL_MS)),
    ...opt("maxPrivateChannels", num(env.SLACK_MAX_PRIVATE_CHANNELS)),
    ...opt("recentMessages", num(env.SLACK_RECENT_MESSAGES)),
    ...opt("userCacheTtlMs", num(env.SLACK_USER_CACHE_TTL_MS)),
    ...(() => {
      const identity = botIdentityFromEnv(env);
      return Object.keys(identity).length ? { botIdentity: identity } : {};
    })(),
    ...(env.DEV_INTROSPECTION === "1" ? { devIntrospection: { port: num(env.DEV_HEALTH_PORT) ?? 0 } } : {}),
  };
}

export function normalizeSlackApiUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? `${trimmed}/` : `${trimmed}/api/`;
}

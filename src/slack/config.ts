import { botIdentityFromEnv } from "./delivery.ts";
import { ROOM_MAX_ROUNDS } from "../types.ts";

export const NO_RETRY = { retryConfig: { retries: 0 } } as const;

/**
 * How many times a Slack room panel goes round its roster (`QM_SLACK_PANEL_ROUNDS`). One round
 * — every addressed persona answers once, plus a bonus turn each for being `@mentioned` — is
 * the default because that is what a "@BotA @BotB, discuss" message reads as. Clamped to the
 * same 1..ROOM_MAX_ROUNDS core enforces on `RoomConfig.rounds`, so a fat-fingered env var
 * never gets as far as a refusal.
 *
 * Re-exported from `src/config.ts` alongside the other core knobs.
 */
export function slackPanelRounds(env: Record<string, string | undefined>): number {
  const raw = env.QM_SLACK_PANEL_ROUNDS;
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return clampPanelRounds(n);
}

/** The single place `1..ROOM_MAX_ROUNDS` is enforced, whatever the value came in on. */
export function clampPanelRounds(rounds: number): number {
  return Math.min(ROOM_MAX_ROUNDS, Math.max(1, Math.floor(rounds)));
}

/**
 * The rounds the DEFAULT Slack bot runs a panel for: **the admin setting, then
 * `QM_SLACK_PANEL_ROUNDS`, then 1** — always clamped to `1..ROOM_MAX_ROUNDS`.
 *
 * The admin value lives on the singular Slack installation record next to `panelPersonaId`
 * (`src/surfaces/slack-installation.ts`), so an operator changes it in the admin UI and the
 * reconciler restarts the bot on the next poll — no redeploy, no restart by hand. `null` or an
 * absent value means "no admin choice", which is why the env var keeps working untouched for
 * deployments that never set one. Anything non-finite is treated the same way, so a corrupted
 * record degrades to the env var rather than to a crash.
 */
export function resolveSlackPanelRounds(
  stored: number | null | undefined,
  env: Record<string, string | undefined>,
): number {
  if (typeof stored === "number" && Number.isFinite(stored)) return clampPanelRounds(stored);
  return slackPanelRounds(env);
}

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
   * The persona this bot speaks as ONLY inside a room panel. Set on the DEFAULT installation, so
   * the org's neutral assistant can take a seat in a debate without changing anything about the
   * turns it takes on its own: with only `panelPersonaId` set, `personaId` stays unset, the turn
   * handler puts no `room` on a solo turn, and the DM/channel header still announces the scope's
   * runtime model. Ignored when `personaId` is also set (a registry bot is persona-bound on
   * every turn already). Requires QM_AGENT_ROOMS, like every other persona path.
   */
  panelPersonaId?: string;
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
  /** Rounds for a Slack-triggered room panel; see `slackPanelRounds`. */
  panelRounds?: number;
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
    ...(env.QM_SLACK_PANEL_ROUNDS?.trim() ? { panelRounds: slackPanelRounds(env) } : {}),
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

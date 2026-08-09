import type { DurableMap } from "../persistence/durable-map.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";

interface ActiveSlackInstallation {
  orgId: string;
  disabled: false;
  botTokenEnc: string;
  appTokenEnc: string;
  teamId?: string;
  teamName?: string;
  /**
   * The bot's Slack handle (`auth.test`'s `user`, e.g. `qm`), and its `U…` user id. Not
   * secrets — they are what every member of the workspace sees when the bot posts — so unlike
   * the tokens beside them they are stored in the clear and may be echoed by the API.
   *
   * Absent on every record written before these fields existed; nothing may assume they are
   * present. The next token save re-runs `auth.test` and backfills them.
   */
  botHandle?: string;
  botUserId?: string;
  /**
   * The agent persona the DEFAULT bot answers as inside a room panel, and only there
   * (docs/slack-multi-bot.md). Not a secret — it is an agent id, echoed by the admin API — so
   * unlike the tokens beside it, it is stored in the clear. Absent on every record written
   * before this field existed, which reads as "no panel persona": exactly today's behaviour.
   */
  panelPersonaId?: string | null;
  /**
   * How many times a Slack room panel goes round its roster, chosen by an admin instead of by
   * `QM_SLACK_PANEL_ROUNDS` (docs/slack-multi-bot.md). Not a secret. An integer in
   * `1..ROOM_MAX_ROUNDS`, or absent/null for "no admin choice", which falls back to the env var
   * and then to 1 — exactly the behaviour of every record written before this field existed.
   */
  panelRounds?: number | null;
  updatedAt: number;
  updatedBy: string;
  version: string;
}

interface DisabledSlackInstallation {
  orgId: string;
  disabled: true;
  updatedAt: number;
  updatedBy: string;
  version: string;
}

type StoredSlackInstallation = ActiveSlackInstallation | DisabledSlackInstallation;

interface SlackInstallation {
  botToken: string;
  appToken: string;
  teamId?: string;
  teamName?: string;
  /** See `ActiveSlackInstallation.botHandle`. Absent until a token save has run `auth.test`. */
  botHandle?: string;
  botUserId?: string;
  /** See `ActiveSlackInstallation.panelPersonaId`. Absent when the bot has no panel persona. */
  panelPersonaId?: string;
  /** See `ActiveSlackInstallation.panelRounds`. Absent when no admin value is stored. */
  panelRounds?: number;
  updatedAt: number;
  updatedBy: string;
  version: string;
}

interface SlackInstallationStatus {
  configured: boolean;
  managed: boolean;
  teamId?: string;
  teamName?: string;
  /** See `ActiveSlackInstallation.botHandle`. Absent on records saved before it was captured. */
  botHandle?: string;
  botUserId?: string;
  /** Present (possibly null) only on a configured, admin-managed installation. */
  panelPersonaId?: string | null;
  /** Present (possibly null) only on a configured, admin-managed installation. */
  panelRounds?: number | null;
  updatedAt?: number;
  updatedBy?: string;
  version?: string;
}

export interface SlackInstallationStore {
  get(): Promise<SlackInstallation | null>;
  status(): Promise<SlackInstallationStatus>;
  set(input: {
    botToken: string;
    appToken: string;
    teamId?: string;
    teamName?: string;
    /** From `auth.test`, like `teamId`/`teamName`: written when supplied, left alone otherwise. */
    botHandle?: string;
    botUserId?: string;
    /** Omit to carry the stored value forward; `null` clears it. */
    panelPersonaId?: string | null;
    /** Omit to carry the stored value forward; `null` clears it (back to env/default). */
    panelRounds?: number | null;
    updatedBy: string;
  }): Promise<SlackInstallationStatus>;
  /**
   * Changes the panel settings — which agent the default bot debates as, and how many rounds a
   * Slack panel runs — without touching the tokens, which is the only way an admin can change
   * them without re-entering both secrets. An omitted field is carried forward; `null` clears
   * it. Returns null when there is no active installation to write to. Bumps `version`, so the
   * runtime reconciler restarts the default bot within its poll interval and it picks up the
   * new rounds and re-resolves the persona's `@Name`.
   */
  setPanelSettings(
    input: { panelPersonaId?: string | null; panelRounds?: number | null },
    updatedBy: string,
  ): Promise<SlackInstallationStatus | null>;
  delete(updatedBy: string): Promise<void>;
}

export function createSlackInstallationStore(
  orgId: string,
  map: DurableMap<StoredSlackInstallation>,
  keyMaterial: Buffer | string,
): SlackInstallationStore {
  const key = deriveConnectorKey(keyMaterial, "slack-installation");
  const publicStatus = (record: StoredSlackInstallation | null): SlackInstallationStatus =>
    record && !record.disabled
      ? {
          configured: true,
          managed: true,
          ...(record.teamId ? { teamId: record.teamId } : {}),
          ...(record.teamName ? { teamName: record.teamName } : {}),
          ...(record.botHandle ? { botHandle: record.botHandle } : {}),
          ...(record.botUserId ? { botUserId: record.botUserId } : {}),
          panelPersonaId: record.panelPersonaId ?? null,
          panelRounds: record.panelRounds ?? null,
          updatedAt: record.updatedAt,
          updatedBy: record.updatedBy,
          version: record.version,
        }
      : { configured: false, managed: record !== null };
  return {
    async get() {
      const record = await map.get(orgId);
      if (!record || record.disabled) return null;
      return {
        botToken: decryptSecret(record.botTokenEnc, key),
        appToken: decryptSecret(record.appTokenEnc, key),
        ...(record.teamId ? { teamId: record.teamId } : {}),
        ...(record.teamName ? { teamName: record.teamName } : {}),
        ...(record.botHandle ? { botHandle: record.botHandle } : {}),
        ...(record.botUserId ? { botUserId: record.botUserId } : {}),
        ...(record.panelPersonaId ? { panelPersonaId: record.panelPersonaId } : {}),
        ...(typeof record.panelRounds === "number" ? { panelRounds: record.panelRounds } : {}),
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
        version: record.version,
      };
    },
    async status() {
      return publicStatus(await map.get(orgId));
    },
    async set(input) {
      const updatedAt = Date.now();
      // A token rotation must not silently unbind the panel persona or reset the rounds, so an
      // unspecified value is carried forward from whatever is stored today.
      const previous = await map.get(orgId);
      const live = previous && !previous.disabled ? previous : null;
      const panelPersonaId = input.panelPersonaId !== undefined ? input.panelPersonaId : (live?.panelPersonaId ?? null);
      const panelRounds = input.panelRounds !== undefined ? input.panelRounds : (live?.panelRounds ?? null);
      const record: StoredSlackInstallation = {
        orgId,
        disabled: false,
        botTokenEnc: encryptSecret(input.botToken, key),
        appTokenEnc: encryptSecret(input.appToken, key),
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.teamName ? { teamName: input.teamName } : {}),
        // Deliberately NOT carried forward like the panel settings: these describe the token
        // pair being written, so a rotation onto a different Slack app must never keep the old
        // bot's handle. An omitted value simply leaves the field absent until the next save.
        ...(input.botHandle ? { botHandle: input.botHandle } : {}),
        ...(input.botUserId ? { botUserId: input.botUserId } : {}),
        ...(panelPersonaId ? { panelPersonaId } : {}),
        ...(typeof panelRounds === "number" ? { panelRounds } : {}),
        updatedAt,
        updatedBy: input.updatedBy,
        version: `${updatedAt}:${crypto.randomUUID()}`,
      };
      await map.put(orgId, record);
      return publicStatus(record);
    },
    async setPanelSettings(input, updatedBy) {
      const previous = await map.get(orgId);
      if (!previous || previous.disabled) return null;
      const updatedAt = Date.now();
      const panelPersonaId =
        input.panelPersonaId !== undefined ? input.panelPersonaId : (previous.panelPersonaId ?? null);
      const panelRounds = input.panelRounds !== undefined ? input.panelRounds : (previous.panelRounds ?? null);
      const record: StoredSlackInstallation = {
        ...previous,
        panelPersonaId: panelPersonaId || null,
        panelRounds: typeof panelRounds === "number" ? panelRounds : null,
        updatedAt,
        updatedBy,
        version: `${updatedAt}:${crypto.randomUUID()}`,
      };
      await map.put(orgId, record);
      return publicStatus(record);
    },
    async delete(updatedBy) {
      const updatedAt = Date.now();
      await map.put(orgId, {
        orgId,
        disabled: true,
        updatedAt,
        updatedBy,
        version: `${updatedAt}:${crypto.randomUUID()}`,
      });
    },
  };
}

interface SlackValidationResponse {
  ok?: boolean;
  error?: string;
  team_id?: string;
  team?: string;
  /** `auth.test`: the bot's handle (the name after the `@`) and its `U…` user id. */
  user?: string;
  user_id?: string;
  app_id?: string;
  bot_id?: string;
  url?: string;
  bot?: { app_id?: string };
}

export type SlackSocketAppIdReader = (url: string) => Promise<string>;

async function readSlackSocketAppId(url: string): Promise<string> {
  const target = new URL(url);
  if (target.protocol !== "wss:" || (target.hostname !== "slack.com" && !target.hostname.endsWith(".slack.com"))) {
    throw new Error("apps.connections.open returned an unexpected WebSocket host");
  }
  return new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(target);
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error("Slack Socket Mode validation timed out"));
    }, 10_000);
    const finish = (error: Error | null, appId?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch (closeError) {
        void closeError;
      }
      if (error) reject(error);
      else resolve(appId!);
    };
    socket.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { type?: string; connection_info?: { app_id?: string } };
        if (frame.type !== "hello") return;
        const appId = frame.connection_info?.app_id;
        finish(appId ? null : new Error("Slack Socket Mode hello returned no app_id"), appId);
      } catch {
        finish(new Error("Slack Socket Mode returned an invalid hello frame"));
      }
    });
    socket.addEventListener("error", () => finish(new Error("Slack Socket Mode validation failed")));
    socket.addEventListener("close", () => finish(new Error("Slack Socket Mode closed before validation")));
  });
}

export async function validateSlackInstallation(
  botToken: string,
  appToken: string,
  fetchImpl: typeof fetch = fetch,
  readSocketAppId: SlackSocketAppIdReader = readSlackSocketAppId,
): Promise<{ teamId?: string; teamName?: string; botHandle?: string; botUserId?: string }> {
  if (!botToken.startsWith("xoxb-")) throw new Error("bot token must start with xoxb-");
  if (!appToken.startsWith("xapp-")) throw new Error("app token must start with xapp-");
  const call = async (method: string, token: string, formBody = ""): Promise<SlackValidationResponse> => {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: formBody,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json()) as SlackValidationResponse;
    if (!response.ok || !payload.ok) throw new Error(`${method} failed: ${payload.error ?? `HTTP ${response.status}`}`);
    return payload;
  };
  const auth = await call("auth.test", botToken);
  let botAppId = auth.app_id;
  if (!botAppId && auth.bot_id) {
    const bot = await call("bots.info", botToken, new URLSearchParams({ bot: auth.bot_id }).toString());
    botAppId = bot.bot?.app_id;
  }
  if (!botAppId) throw new Error("Slack bot identity returned no app_id");
  const connection = await call("apps.connections.open", appToken);
  if (!connection.url) throw new Error("apps.connections.open returned no WebSocket URL");
  const socketAppId = await readSocketAppId(connection.url);
  if (socketAppId !== botAppId) throw new Error("bot token and app token belong to different Slack apps");
  // `auth.test` already told us who this bot is, so the handle costs no extra call. Slack has
  // always returned `user`/`user_id` for a bot token, but an absent value is simply not stored
  // rather than treated as a validation failure — the tokens are still good either way.
  return {
    ...(auth.team_id ? { teamId: auth.team_id } : {}),
    ...(auth.team ? { teamName: auth.team } : {}),
    ...(typeof auth.user === "string" && auth.user ? { botHandle: auth.user } : {}),
    ...(typeof auth.user_id === "string" && auth.user_id ? { botUserId: auth.user_id } : {}),
  };
}

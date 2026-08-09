import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";

/**
 * ADDITIONAL Slack bots, beyond the one singular installation `createSlackInstallationStore`
 * holds. That store is keyed by orgId and stays the DEFAULT bot; this one is keyed by a
 * generated installation id so an org may run as many bots as it likes side by side, each
 * optionally speaking as one of its agent personas.
 *
 * Tokens are AES-encrypted at rest exactly like the singular store, under a key derived with
 * its own purpose string so a registry record can never be decrypted with the installation key
 * (or the other way round).
 */
export interface StoredSlackBot {
  id: string;
  orgId: string;
  label: string;
  /** null = this bot runs the ordinary org agent, exactly like the default installation */
  personaId: string | null;
  botTokenEnc: string;
  appTokenEnc: string;
  enabled: boolean;
  teamId?: string;
  teamName?: string;
  /**
   * The bot's Slack handle (`auth.test`'s `user`, e.g. `qm-codex`) and its `U…` user id, so a
   * surface can say WHICH bot an agent answers as. Not secrets — the whole workspace sees the
   * handle — so they sit in the clear beside the encrypted tokens and are safe to echo.
   *
   * Absent on every record written before these fields existed; a later token rotation
   * re-runs `auth.test` and backfills them. Nothing may assume they are present.
   */
  botHandle?: string;
  botUserId?: string;
  /**
   * Why this bot is not running, if it isn't — an events-mode mismatch, or a start that threw.
   * Deliberately NOT part of `version`: recording an error must never look like a config change,
   * or the reconciler would restart the bot on its own failure report.
   */
  lastError?: string;
  lastErrorAt?: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  /** bumped on every CONFIG write; the reconciler restarts an instance when this changes */
  version: string;
}

/** A registry record with its tokens decrypted — runtime only, never returned by the admin API. */
export interface SlackBotRecord {
  id: string;
  label: string;
  personaId: string | null;
  botToken: string;
  appToken: string;
  enabled: boolean;
  teamId?: string;
  teamName?: string;
  /** See `StoredSlackBot.botHandle`. */
  botHandle?: string;
  botUserId?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  version: string;
}

/** What the admin API hands out: everything except the secrets. */
export interface SlackBotView {
  id: string;
  label: string;
  personaId: string | null;
  enabled: boolean;
  teamId?: string;
  teamName?: string;
  /** See `StoredSlackBot.botHandle`. */
  botHandle?: string;
  botUserId?: string;
  lastError?: string;
  lastErrorAt?: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  version: string;
}

export interface NewSlackBot {
  label: string;
  personaId?: string | null;
  botToken: string;
  appToken: string;
  enabled?: boolean;
  teamId?: string;
  teamName?: string;
  botHandle?: string;
  botUserId?: string;
  updatedBy: string;
}

export interface SlackBotPatch {
  label?: string;
  personaId?: string | null;
  botToken?: string;
  appToken?: string;
  enabled?: boolean;
  teamId?: string;
  teamName?: string;
  botHandle?: string;
  botUserId?: string;
  updatedBy: string;
}

export interface SlackBotRegistry {
  /** Redacted list, oldest first — what the admin UI renders. */
  list(): Promise<SlackBotView[]>;
  /** Decrypted list for the runtime reconciler. Never expose this over HTTP. */
  listWithTokens(): Promise<SlackBotRecord[]>;
  get(id: string): Promise<SlackBotView | null>;
  getWithTokens(id: string): Promise<SlackBotRecord | null>;
  create(input: NewSlackBot): Promise<SlackBotView>;
  update(id: string, patch: SlackBotPatch): Promise<SlackBotView | null>;
  delete(id: string): Promise<boolean>;
  /** Records why a bot is not running WITHOUT bumping its version (see `lastError`). */
  recordError(id: string, message: string): Promise<void>;
  clearError(id: string): Promise<void>;
}

export const SLACK_BOT_LABEL_MAX = 60;
export const SLACK_BOT_ERROR_MAX = 500;

/** Control characters out, so a label can never break a log line or an admin table. */
function scrub(raw: string, max: number): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? " " : ch;
  }
  return out.slice(0, max);
}

function sanitizeLabel(raw: string): string {
  return scrub(raw, SLACK_BOT_LABEL_MAX).trim().slice(0, SLACK_BOT_LABEL_MAX);
}

export function createSlackBotRegistry(
  orgId: string,
  map: DurableMap<StoredSlackBot>,
  keyMaterial: Buffer | string,
): SlackBotRegistry {
  const key = deriveConnectorKey(keyMaterial, "slack-bot-registry");

  const mine = async (): Promise<StoredSlackBot[]> =>
    (await map.all())
      .filter((r) => r.orgId === orgId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));

  const owned = async (id: string): Promise<StoredSlackBot | null> => {
    const record = await map.get(id);
    return record && record.orgId === orgId ? record : null;
  };

  const view = (r: StoredSlackBot): SlackBotView => ({
    id: r.id,
    label: r.label,
    personaId: r.personaId,
    enabled: r.enabled,
    ...(r.teamId ? { teamId: r.teamId } : {}),
    ...(r.teamName ? { teamName: r.teamName } : {}),
    ...(r.botHandle ? { botHandle: r.botHandle } : {}),
    ...(r.botUserId ? { botUserId: r.botUserId } : {}),
    ...(r.lastError ? { lastError: r.lastError } : {}),
    ...(r.lastErrorAt ? { lastErrorAt: r.lastErrorAt } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
    version: r.version,
  });

  const decrypted = (r: StoredSlackBot): SlackBotRecord => ({
    id: r.id,
    label: r.label,
    personaId: r.personaId,
    botToken: decryptSecret(r.botTokenEnc, key),
    appToken: decryptSecret(r.appTokenEnc, key),
    enabled: r.enabled,
    ...(r.teamId ? { teamId: r.teamId } : {}),
    ...(r.teamName ? { teamName: r.teamName } : {}),
    ...(r.botHandle ? { botHandle: r.botHandle } : {}),
    ...(r.botUserId ? { botUserId: r.botUserId } : {}),
    ...(r.lastError ? { lastError: r.lastError } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
    version: r.version,
  });

  return {
    async list() {
      return (await mine()).map(view);
    },

    async listWithTokens() {
      return (await mine()).map(decrypted);
    },

    async get(id) {
      const record = await owned(id);
      return record ? view(record) : null;
    },

    async getWithTokens(id) {
      const record = await owned(id);
      return record ? decrypted(record) : null;
    },

    async create(input) {
      const now = Date.now();
      const id = randomUUID();
      const record: StoredSlackBot = {
        id,
        orgId,
        label: sanitizeLabel(input.label),
        personaId: input.personaId ?? null,
        botTokenEnc: encryptSecret(input.botToken, key),
        appTokenEnc: encryptSecret(input.appToken, key),
        enabled: input.enabled ?? true,
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.teamName ? { teamName: input.teamName } : {}),
        ...(input.botHandle ? { botHandle: input.botHandle } : {}),
        ...(input.botUserId ? { botUserId: input.botUserId } : {}),
        createdAt: now,
        updatedAt: now,
        updatedBy: input.updatedBy,
        version: `${now}:${randomUUID()}`,
      };
      await map.put(id, record);
      return view(record);
    },

    async update(id, patch) {
      const existing = await owned(id);
      if (!existing) return null;
      const now = Date.now();
      const next: StoredSlackBot = {
        ...existing,
        ...(patch.label !== undefined ? { label: sanitizeLabel(patch.label) } : {}),
        ...(patch.personaId !== undefined ? { personaId: patch.personaId } : {}),
        ...(patch.botToken !== undefined ? { botTokenEnc: encryptSecret(patch.botToken, key) } : {}),
        ...(patch.appToken !== undefined ? { appTokenEnc: encryptSecret(patch.appToken, key) } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.teamId !== undefined ? { teamId: patch.teamId } : {}),
        ...(patch.teamName !== undefined ? { teamName: patch.teamName } : {}),
        ...(patch.botHandle !== undefined ? { botHandle: patch.botHandle } : {}),
        ...(patch.botUserId !== undefined ? { botUserId: patch.botUserId } : {}),
        updatedAt: now,
        updatedBy: patch.updatedBy,
        version: `${now}:${randomUUID()}`,
      };
      // A config change is a fresh start; whatever went wrong last time is no longer current.
      delete next.lastError;
      delete next.lastErrorAt;
      await map.put(id, next);
      return view(next);
    },

    async delete(id) {
      const existing = await owned(id);
      if (!existing) return false;
      await map.delete(id);
      return true;
    },

    async recordError(id, message) {
      const existing = await owned(id);
      if (!existing) return;
      const trimmed = scrub(message, SLACK_BOT_ERROR_MAX);
      if (existing.lastError === trimmed) return;
      await map.put(id, { ...existing, lastError: trimmed, lastErrorAt: Date.now() });
    },

    async clearError(id) {
      const existing = await owned(id);
      if (!existing || existing.lastError === undefined) return;
      const next = { ...existing };
      delete next.lastError;
      delete next.lastErrorAt;
      await map.put(id, next);
    },
  };
}

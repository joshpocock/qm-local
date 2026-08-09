import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { errMessage } from "../../../util/errors.ts";
import { validateSlackInstallation } from "../../../surfaces/slack-installation.ts";
import { slackBotManifestCreationUrl } from "../../../surfaces/slack-manifest.ts";
import { SLACK_BOT_LABEL_MAX, type SlackBotRegistry } from "../../../surfaces/slack-bot-registry.ts";

/**
 * ADDITIONAL Slack bots. The singular `/v1/admin/slack-installation` above stays exactly as it
 * was and remains the DEFAULT bot; these routes manage the extra ones, each optionally bound to
 * an agent persona.
 *
 * Tokens are write-only over HTTP: they go in on POST/PUT and are never echoed back, in any
 * response, by any route here.
 */

interface Ready {
  registry: SlackBotRegistry;
  actorId: string;
  scope: string;
}

async function ready(ctx: ApiCtx): Promise<Ready | null> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return null;
  if (!ctx.deps.slackBots) {
    sendJson(ctx.res, 404, { error: "not_configured" });
    return null;
  }
  return { registry: ctx.deps.slackBots, actorId: actor.id, scope };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Registry bots run their own Socket Mode connection. In http events mode each bot would need
 * its own port and signing secret, which no config models — so say so plainly rather than
 * starting something that cannot receive an event.
 */
function httpModeRefusal(ctx: ApiCtx): string | null {
  return ctx.deps.slackEventsMode === "http"
    ? "additional Slack bots need Socket Mode; this deployment runs SLACK_EVENTS_MODE=http, which has one events port and signing secret for the default bot only"
    : null;
}

/**
 * null = unset (this bot runs the default org agent). A string must name a live, enabled
 * persona.
 *
 * Deliberately NOT filtered by what the admin can see: this is an org-level binding, and the
 * per-message check that actually matters happens at turn time, where core validates the
 * request-borne roster against the SLACK USER's visible personas. A persona homed in someone's
 * personal scope will therefore be refused for everybody else — home shared bot personas in an
 * org, team or channel scope (docs/slack-multi-bot.md).
 */
async function resolvePersonaId(ctx: ApiCtx, raw: unknown): Promise<{ personaId: string | null } | { error: string }> {
  if (raw === null || raw === undefined || raw === "") return { personaId: null };
  if (typeof raw !== "string") return { error: "personaId must be an agent id or null" };
  const persona = await ctx.app.getPersona(raw);
  if (!persona || persona.archivedAt !== undefined) return { error: `unknown agent: ${raw}` };
  if (!persona.enabled) return { error: `agent ${persona.name} is disabled` };
  return { personaId: persona.id };
}

/**
 * Two live Bolt apps on the same Slack app fight over one Socket Mode subscription, and only one
 * of them sees any given event — so registering the default bot's tokens (or another registry
 * bot's) a second time produces a bot that silently half-works. Cheaper to refuse it here.
 */
async function duplicateTokenRefusal(
  ctx: ApiCtx,
  registry: SlackBotRegistry,
  botToken: string,
  exceptId?: string,
): Promise<string | null> {
  if (!botToken) return null;
  const installed = await ctx.deps.slackInstallation?.get();
  if (installed?.botToken === botToken) return "those are the default Slack bot's tokens; each bot needs its own app";
  const clash = (await registry.listWithTokens()).find((b) => b.id !== exceptId && b.botToken === botToken);
  return clash ? `those tokens already belong to the "${clash.label}" bot` : null;
}

export async function listSlackBots(ctx: ApiCtx): Promise<void> {
  const r = await ready(ctx);
  if (!r) return;
  audit(ctx.deps, {
    principalId: r.actorId,
    action: "slack-bots.read",
    resource: "slack-bots",
    scopeLabel: r.scope,
  });
  const bots = await r.registry.list();
  return sendJson(ctx.res, 200, {
    bots,
    socketModeOnly: true,
    eventsMode: ctx.deps.slackEventsMode ?? "socket",
    ...(httpModeRefusal(ctx) ? { unsupported: httpModeRefusal(ctx) } : {}),
    createUrl: slackBotManifestCreationUrl(),
  });
}

/**
 * The persona picker's option list: the personas the ADMIN can see, name + id only. Org/team
 * scoped personas — the kind a bot should be bound to — are visible to every principal, so this
 * covers the recommended bindings; a persona homed in another user's personal scope will not
 * list here, and binding one is discouraged anyway (docs/slack-multi-bot.md).
 */
export async function listSlackBotAgents(ctx: ApiCtx): Promise<void> {
  const r = await ready(ctx);
  if (!r) return;
  const personas = await ctx.app.listVisiblePersonas(r.actorId);
  return sendJson(ctx.res, 200, {
    agents: personas
      .filter((p) => p.archivedAt === undefined)
      .map((p) => ({ id: p.id, name: p.name, enabled: p.enabled })),
  });
}

export async function createSlackBot(ctx: ApiCtx): Promise<void> {
  const r = await ready(ctx);
  if (!r) return;
  const refusal = httpModeRefusal(ctx);
  if (refusal) return sendJson(ctx.res, 400, { error: "socket_mode_required", message: refusal });
  const body = ctx.body as { label?: unknown; personaId?: unknown; botToken?: unknown; appToken?: unknown };
  const label = str(body.label);
  if (!label || label.length > SLACK_BOT_LABEL_MAX) {
    return sendJson(ctx.res, 400, { error: "invalid_label", message: `label must be 1-${SLACK_BOT_LABEL_MAX} chars` });
  }
  const persona = await resolvePersonaId(ctx, body.personaId);
  if ("error" in persona) return sendJson(ctx.res, 400, { error: "invalid_persona", message: persona.error });
  const botToken = str(body.botToken);
  const appToken = str(body.appToken);
  const duplicate = await duplicateTokenRefusal(ctx, r.registry, botToken);
  if (duplicate) return sendJson(ctx.res, 400, { error: "duplicate_slack_bot", message: duplicate });
  try {
    const workspace = await validateSlackInstallation(
      botToken,
      appToken,
      ctx.deps.slackInstallationFetch,
      ctx.deps.slackInstallationSocketAppId,
    );
    const created = await r.registry.create({
      label,
      personaId: persona.personaId,
      botToken,
      appToken,
      ...workspace,
      updatedBy: r.actorId,
    });
    audit(ctx.deps, {
      principalId: r.actorId,
      action: "slack-bots.create",
      resource: `slack-bot:${created.id}`,
      scopeLabel: r.scope,
    });
    return sendJson(ctx.res, 201, created);
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "invalid_slack_installation", message: errMessage(error) });
  }
}

export async function updateSlackBot(ctx: ApiCtx): Promise<void> {
  const r = await ready(ctx);
  if (!r) return;
  const id = ctx.params.id ?? "";
  const existing = await r.registry.get(id);
  if (!existing) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = ctx.body as {
    label?: unknown;
    personaId?: unknown;
    botToken?: unknown;
    appToken?: unknown;
    enabled?: unknown;
  };

  const patch: Parameters<SlackBotRegistry["update"]>[1] = { updatedBy: r.actorId };
  if (body.label !== undefined) {
    const label = str(body.label);
    if (!label || label.length > SLACK_BOT_LABEL_MAX) {
      return sendJson(ctx.res, 400, {
        error: "invalid_label",
        message: `label must be 1-${SLACK_BOT_LABEL_MAX} chars`,
      });
    }
    patch.label = label;
  }
  if (body.personaId !== undefined) {
    const persona = await resolvePersonaId(ctx, body.personaId);
    if ("error" in persona) return sendJson(ctx.res, 400, { error: "invalid_persona", message: persona.error });
    patch.personaId = persona.personaId;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return sendJson(ctx.res, 400, { error: "invalid_enabled", message: "enabled must be a boolean" });
    }
    if (body.enabled) {
      const refusal = httpModeRefusal(ctx);
      if (refusal) return sendJson(ctx.res, 400, { error: "socket_mode_required", message: refusal });
    }
    patch.enabled = body.enabled;
  }

  const botToken = str(body.botToken);
  const appToken = str(body.appToken);
  if (botToken || appToken) {
    // Rotating one half of the pair alone cannot be validated (the two must belong to the same
    // Slack app), so tokens are replaced together or not at all.
    if (!botToken || !appToken) {
      return sendJson(ctx.res, 400, {
        error: "invalid_slack_installation",
        message: "botToken and appToken must be rotated together",
      });
    }
    const duplicate = await duplicateTokenRefusal(ctx, r.registry, botToken, id);
    if (duplicate) return sendJson(ctx.res, 400, { error: "duplicate_slack_bot", message: duplicate });
    try {
      const workspace = await validateSlackInstallation(
        botToken,
        appToken,
        ctx.deps.slackInstallationFetch,
        ctx.deps.slackInstallationSocketAppId,
      );
      patch.botToken = botToken;
      patch.appToken = appToken;
      if (workspace.teamId) patch.teamId = workspace.teamId;
      if (workspace.teamName) patch.teamName = workspace.teamName;
    } catch (error) {
      return sendJson(ctx.res, 400, { error: "invalid_slack_installation", message: errMessage(error) });
    }
  }

  const updated = await r.registry.update(id, patch);
  if (!updated) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: r.actorId,
    action: "slack-bots.update",
    resource: `slack-bot:${id}`,
    scopeLabel: r.scope,
  });
  return sendJson(ctx.res, 200, updated);
}

export async function deleteSlackBot(ctx: ApiCtx): Promise<void> {
  const r = await ready(ctx);
  if (!r) return;
  const id = ctx.params.id ?? "";
  const removed = await r.registry.delete(id);
  if (!removed) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: r.actorId,
    action: "slack-bots.delete",
    resource: `slack-bot:${id}`,
    scopeLabel: r.scope,
  });
  return sendJson(ctx.res, 200, { id, deleted: true });
}

import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { errMessage } from "../../../util/errors.ts";
import { validateSlackInstallation } from "../../../surfaces/slack-installation.ts";
import { slackBotManifestCreationUrl } from "../../../surfaces/slack-manifest.ts";
import { resolvePersonaId } from "./slack-bots.ts";
import { ROOM_MAX_ROUNDS } from "../../../types.ts";

export async function getSlackInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  audit(ctx.deps, {
    principalId: actor.id,
    action: "slack-installation.read",
    resource: "slack-installation",
    scopeLabel: scope,
  });
  const createUrl = slackBotManifestCreationUrl();
  const stored = await ctx.deps.slackInstallation.status();
  if (stored.managed) return sendJson(ctx.res, 200, { ...stored, source: "admin", createUrl });
  if (ctx.deps.slackEnvironmentState === "configured") {
    return sendJson(ctx.res, 200, { configured: true, managed: false, source: "environment", createUrl });
  }
  return sendJson(ctx.res, 200, {
    configured: false,
    managed: false,
    source: ctx.deps.slackEnvironmentState === "partial" ? "invalid_environment" : "none",
    createUrl,
  });
}

export async function putSlackInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  const body = ctx.body as {
    botToken?: unknown;
    appToken?: unknown;
    panelPersonaId?: unknown;
    panelRounds?: unknown;
  };
  const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
  const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";

  // The PANEL persona — the agent the default bot answers as inside a room panel, and nowhere
  // else (docs/slack-multi-bot.md). Same rules as a registry bot's persona: null clears it, a
  // string must name a live, enabled, non-archived agent.
  let panelPersonaId: string | null | undefined;
  if (body.panelPersonaId !== undefined) {
    const persona = await resolvePersonaId(ctx, body.panelPersonaId);
    if ("error" in persona) return sendJson(ctx.res, 400, { error: "invalid_persona", message: persona.error });
    panelPersonaId = persona.personaId;
  }

  // Debate ROUNDS. Rejected rather than clamped, unlike the env var: an operator typing into a
  // form gets told the number is wrong, where a deployment's env var has nobody to tell.
  let panelRounds: number | null | undefined;
  if (body.panelRounds !== undefined) {
    const raw = body.panelRounds;
    if (raw === null) panelRounds = null;
    else if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > ROOM_MAX_ROUNDS) {
      return sendJson(ctx.res, 400, {
        error: "invalid_panel_rounds",
        message: `panelRounds must be a whole number from 1 to ${ROOM_MAX_ROUNDS}, or null to use the deployment default`,
      });
    } else panelRounds = raw;
  }

  const panelOnly = panelPersonaId !== undefined || panelRounds !== undefined;

  // Neither is a secret and Slack has nothing to say about either, so they can be set on their
  // own. Requiring the tokens here would mean re-entering both of them — and they are
  // write-only, never displayed again — every time an operator changes a debate setting.
  if (panelOnly && !botToken && !appToken) {
    const status = await ctx.deps.slackInstallation.setPanelSettings(
      {
        ...(panelPersonaId !== undefined ? { panelPersonaId } : {}),
        ...(panelRounds !== undefined ? { panelRounds } : {}),
      },
      actor.id,
    );
    if (!status) {
      return sendJson(ctx.res, 400, {
        error: "not_configured",
        message: "save the Slack tokens first — the debate settings are stored on the installation record",
      });
    }
    audit(ctx.deps, {
      principalId: actor.id,
      action: "slack-installation.update",
      resource: "slack-installation",
      scopeLabel: scope,
    });
    return sendJson(ctx.res, 200, { ...status, source: "admin" });
  }

  try {
    const workspace = await validateSlackInstallation(
      botToken,
      appToken,
      ctx.deps.slackInstallationFetch,
      ctx.deps.slackInstallationSocketAppId,
    );
    const status = await ctx.deps.slackInstallation.set({
      botToken,
      appToken,
      ...workspace,
      ...(panelPersonaId !== undefined ? { panelPersonaId } : {}),
      ...(panelRounds !== undefined ? { panelRounds } : {}),
      updatedBy: actor.id,
    });
    audit(ctx.deps, {
      principalId: actor.id,
      action: "slack-installation.update",
      resource: "slack-installation",
      scopeLabel: scope,
    });
    return sendJson(ctx.res, 200, { ...status, source: "admin" });
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "invalid_slack_installation", message: errMessage(error) });
  }
}

export async function deleteSlackInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  await ctx.deps.slackInstallation.delete(actor.id);
  audit(ctx.deps, {
    principalId: actor.id,
    action: "slack-installation.delete",
    resource: "slack-installation",
    scopeLabel: scope,
  });
  return sendJson(ctx.res, 200, { configured: false, managed: true, source: "admin" });
}

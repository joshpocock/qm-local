import { agentRoomsEnabled } from "../../config.ts";
import { sendJson } from "../http.ts";
import { type ApiCtx, type Route } from "./route.ts";

/**
 * Which agents answer as a Slack bot, for the surfaces that list agents.
 *
 * The registry itself (`/v1/admin/slack-bots`) and the singular installation are admin-gated
 * and hold secrets. This route is the ordinary member's read of the same two stores: agent id,
 * which bot, and the handle that bot posts under — never a token, encrypted or otherwise, and
 * never a field derived from one.
 */

/** What the DEFAULT installation is called when it has no handle stored yet. */
export const DEFAULT_SLACK_BOT_LABEL = "Default Slack bot";

export interface SlackBindingView {
  personaId: string;
  label: string;
  botHandle?: string;
  teamName?: string;
  /**
   * `bot`   — a registry bot bound to this agent: every message to it is answered as this agent.
   * `panel` — the default bot's panel persona: it speaks as this agent inside a room debate
   *           only, and answers as the ordinary org agent everywhere else.
   */
  kind: "bot" | "panel";
}

/** Same principal handling as `/v1/agents`: a capability or portal identity wins over the query. */
function principalFrom(ctx: ApiCtx): string | null {
  const fromQuery = ctx.url.searchParams.get("principalId");
  return ctx.capability?.actorId ?? ctx.actor?.p ?? fromQuery ?? null;
}

async function listSlackBindings(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  const principalId = principalFrom(ctx);
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });

  // A binding is only reportable for an agent the caller can already see; otherwise this route
  // would confirm the existence of someone else's personal persona by naming its bot.
  const visible = new Set((await app.listVisiblePersonas(principalId)).map((p) => p.id));
  const bindings: SlackBindingView[] = [];

  // `list()` is the redacted view — the token fields never leave the registry through it.
  for (const bot of (await deps.slackBots?.list()) ?? []) {
    if (!bot.enabled || !bot.personaId || !visible.has(bot.personaId)) continue;
    bindings.push({
      personaId: bot.personaId,
      label: bot.label,
      ...(bot.botHandle ? { botHandle: bot.botHandle } : {}),
      ...(bot.teamName ? { teamName: bot.teamName } : {}),
      kind: "bot",
    });
  }

  // `status()` is likewise token-free, and reports `panelPersonaId` only for an admin-managed
  // installation — an env-configured deployment has no record to hang a panel persona on.
  const installed = await deps.slackInstallation?.status();
  if (installed?.configured && installed.panelPersonaId && visible.has(installed.panelPersonaId)) {
    bindings.push({
      personaId: installed.panelPersonaId,
      label: DEFAULT_SLACK_BOT_LABEL,
      ...(installed.botHandle ? { botHandle: installed.botHandle } : {}),
      ...(installed.teamName ? { teamName: installed.teamName } : {}),
      kind: "panel",
    });
  }

  // No Slack at all is a deployment state, not an error: an empty list renders as nothing.
  return sendJson(res, 200, { bindings });
}

const SLACK_BINDING_ROUTES: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/slack-bindings", auth: "source", handle: listSlackBindings },
];

/**
 * Mounted only when QM_AGENT_ROOMS=1, like `/v1/agents` and `/v1/sessions/:id/room`: without
 * agents there is nothing for a bot to be bound to, and the surface that reads this is the
 * Agents page, which is itself flag-gated.
 */
export function slackBindingRoutes(env?: NodeJS.ProcessEnv): ReadonlyArray<Route<ApiCtx>> {
  return agentRoomsEnabled(env) ? SLACK_BINDING_ROUTES : [];
}

import type { ScopeId } from "../../types.ts";
import { parseScopeId, scopeId as makeScopeId } from "../../types.ts";
import { agentRoomsEnabled } from "../../config.ts";
import type { AgentPersona, AgentPersonaPatch } from "../../agents/persona-store.ts";
import { personaFieldError } from "../../agents/persona-store.ts";
import {
  isHarnessId,
  modelProviderAvailabilityFor,
  modelServiceable,
  modelSupportedByHarness,
  ALL_PROVIDERS_AVAILABLE,
  HARNESS_IDS,
} from "../../model/pi-models.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { type ApiCtx, type Route } from "./route.ts";

interface PersonaBody {
  principalId?: unknown;
  scopeId?: unknown;
  name?: unknown;
  color?: unknown;
  glyph?: unknown;
  harnessId?: unknown;
  modelId?: unknown;
  instructions?: unknown;
  enabled?: unknown;
}

function personaView(p: AgentPersona, editable: boolean): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    glyph: p.glyph,
    harnessId: p.harnessId,
    modelId: p.modelId,
    instructions: p.instructions,
    enabled: p.enabled,
    scope: parseScopeId(p.scopeId).kind ?? p.scopeId,
    scopeId: p.scopeId,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    ...(p.updatedAt === undefined ? {} : { updatedAt: p.updatedAt }),
    version: p.version,
    editable,
  };
}

/** Body/query principal, with a capability or portal identity winning when present. */
function principalFrom(ctx: ApiCtx, from: "body" | "query"): string | null {
  const fromRequest =
    from === "body" ? (ctx.body as PersonaBody | null)?.principalId : ctx.url.searchParams.get("principalId");
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p ?? (typeof fromRequest === "string" ? fromRequest : "");
  return principalId || null;
}

/**
 * Persona runtime is validated exactly like the admin `runtime` resource
 * (`admin-resources.ts`): a known harness, approved org-wide, running a model that
 * harness supports and that this deployment can actually service. Reusing the same
 * helpers is what makes "un-approve Codex" disable every Codex persona.
 */
async function runtimeError(ctx: ApiCtx, harnessId: unknown, modelId: unknown): Promise<string | null> {
  if (!isHarnessId(harnessId)) return `agent requires harnessId (${HARNESS_IDS.join(" | ")})`;
  const approved = (await ctx.deps.config?.getApprovedHarnessesDurable()) ?? [ctx.deps.harnessId ?? "pi"];
  if (!approved.includes(harnessId)) return `harness ${harnessId} is not approved`;
  if (typeof modelId !== "string" || !modelSupportedByHarness(modelId, harnessId)) {
    return `model ${String(modelId)} is not supported by ${harnessId}`;
  }
  const runtimeKeys = ctx.deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE;
  if (!modelServiceable(modelId, modelProviderAvailabilityFor(harnessId, runtimeKeys))) {
    return `model ${modelId} isn't serviceable on this deployment: its provider key is not configured for the ${harnessId} harness`;
  }
  return null;
}

async function listAgents(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  const principalId = principalFrom(ctx, "query");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const personas = await app.listVisiblePersonas(principalId);
  const agents = await Promise.all(
    personas.map(async (p) => personaView(p, await app.canManagePersona(p, principalId))),
  );
  return sendJson(res, 200, { agents });
}

async function getAgent(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  const principalId = principalFrom(ctx, "query");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const persona = await app.getPersona(ctx.params.id!);
  const editable = persona ? await app.canManagePersona(persona, principalId) : false;
  if (!persona || (!editable && !(await app.listVisiblePersonas(principalId)).some((p) => p.id === persona.id))) {
    return sendJson(res, 404, { error: "not_found" });
  }
  return sendJson(res, 200, { agent: personaView(persona, editable) });
}

async function createAgent(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  const b = (ctx.body ?? {}) as PersonaBody;
  const principalId = principalFrom(ctx, "body");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });

  let homeScope: ScopeId | undefined;
  if (ctx.capability) homeScope = ctx.capability.scopeId;
  else if (typeof b.scopeId === "string" && b.scopeId !== makeScopeId("personal", principalId)) {
    if (!(await app.managesScope(principalId, b.scopeId as ScopeId))) {
      return sendJson(res, 403, { error: "forbidden", message: "you cannot create an agent in that context" });
    }
    homeScope = b.scopeId as ScopeId;
  }

  const fields = {
    name: typeof b.name === "string" ? b.name.trim() : "",
    color: typeof b.color === "string" ? b.color.trim().toLowerCase() : "",
    glyph: typeof b.glyph === "string" ? b.glyph.trim() : "",
    instructions: typeof b.instructions === "string" ? b.instructions : "",
  };
  const invalid = personaFieldError(fields);
  if (invalid) return sendJson(res, 400, { error: "bad_request", message: invalid });
  const badRuntime = await runtimeError(ctx, b.harnessId, b.modelId);
  if (badRuntime) return sendJson(res, 400, { error: "bad_request", message: badRuntime });
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    return sendJson(res, 400, { error: "bad_request", message: "enabled must be a boolean" });
  }

  try {
    const persona = await app.createPersona({
      principalId,
      ...(homeScope ? { homeScope } : {}),
      ...fields,
      harnessId: b.harnessId as string,
      modelId: b.modelId as string,
      ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
    });
    return sendJson(res, 200, { agent: personaView(persona, true) });
  } catch (err) {
    return sendJson(res, 409, { error: "conflict", message: errMessage(err) });
  }
}

async function updateAgent(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  const b = (ctx.body ?? {}) as PersonaBody;
  const principalId = principalFrom(ctx, "body");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });

  const persona = await app.getPersona(ctx.params.id!);
  if (!persona || !(await app.canManagePersona(persona, principalId))) {
    return sendJson(res, 404, { error: "not_found", message: "no such agent, or it isn't yours to edit" });
  }

  const patch: AgentPersonaPatch = {};
  if (b.name !== undefined) patch.name = typeof b.name === "string" ? b.name.trim() : "";
  if (b.color !== undefined) patch.color = typeof b.color === "string" ? b.color.trim().toLowerCase() : "";
  if (b.glyph !== undefined) patch.glyph = typeof b.glyph === "string" ? b.glyph.trim() : "";
  if (b.instructions !== undefined) patch.instructions = typeof b.instructions === "string" ? b.instructions : "";
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean")
      return sendJson(res, 400, { error: "bad_request", message: "enabled must be a boolean" });
    patch.enabled = b.enabled;
  }

  const invalid = personaFieldError({
    name: patch.name ?? persona.name,
    color: patch.color ?? persona.color,
    glyph: patch.glyph ?? persona.glyph,
    instructions: patch.instructions ?? persona.instructions,
  });
  if (invalid) return sendJson(res, 400, { error: "bad_request", message: invalid });

  if (b.harnessId !== undefined || b.modelId !== undefined) {
    const harnessId = b.harnessId ?? persona.harnessId;
    const modelId = b.modelId ?? persona.modelId;
    const badRuntime = await runtimeError(ctx, harnessId, modelId);
    if (badRuntime) return sendJson(res, 400, { error: "bad_request", message: badRuntime });
    patch.harnessId = harnessId as string;
    patch.modelId = modelId as string;
  }

  try {
    const updated = await app.updatePersona(persona.id, principalId, patch);
    if (!updated)
      return sendJson(res, 404, { error: "not_found", message: "no such agent, or it isn't yours to edit" });
    return sendJson(res, 200, { agent: personaView(updated, true) });
  } catch (err) {
    return sendJson(res, 409, { error: "conflict", message: errMessage(err) });
  }
}

async function deleteAgent(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  const principalId = principalFrom(ctx, "body");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const outcome = await app.archivePersona(ctx.params.id!, principalId);
  if (outcome === "missing") return sendJson(res, 404, { error: "not_found", message: "no such agent" });
  if (outcome === "forbidden")
    return sendJson(res, 403, { error: "forbidden", message: "that agent isn't yours to archive" });
  return sendJson(res, 200, { ok: true });
}

const AGENT_ROUTES: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/agents", auth: "source", handle: listAgents },
  { method: "GET", path: "/v1/agents/:id", auth: "source", handle: getAgent },
  { method: "POST", path: "/v1/agents", auth: "source", handle: createAgent },
  { method: "PUT", path: "/v1/agents/:id", auth: "source", handle: updateAgent },
  { method: "DELETE", path: "/v1/agents/:id", auth: "source", handle: deleteAgent },
];

/**
 * Mounted only when QM_AGENT_ROOMS=1 — with the flag off the paths are simply not in
 * the table, so they 404 like any unknown route and no persona surface exists at all.
 */
export function agentRoutes(env?: NodeJS.ProcessEnv): ReadonlyArray<Route<ApiCtx>> {
  return agentRoomsEnabled(env) ? AGENT_ROUTES : [];
}

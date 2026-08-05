import type { ScopeId } from "../types.ts";
import { parseScopeId, scopeId } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import type { AgentPersona, AgentPersonaPatch } from "../agents/persona-store.ts";

import type { App, AppDeps } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";

/**
 * Personas are scope-owned artifacts, so visibility and management rights are the
 * same machinery skills use: the viewer's ordered scopes decide what is listed, and
 * the artifact-home check decides who may edit.
 */
/**
 * Personas visible to a principal, in scope order. Exported so the turn pipeline can
 * validate a request-borne room roster with exactly the semantics the routes use.
 */
export async function visiblePersonasFor(deps: AppDeps, h: AppHelpers, principalId: string): Promise<AgentPersona[]> {
  const actor = deps.identity.classify(principalId);
  const sharedHomes = [
    ...new Set(
      (await deps.personas.list())
        .map((p) => p.scopeId)
        .filter((sid) => {
          const k = parseScopeId(sid).kind;
          return k === "channel" || k === "group";
        }),
    ),
  ];
  const accessibleScopes = new Set(await h.currentResourceScopesForViewer(principalId));
  const shared = sharedHomes.filter((sid) => accessibleScopes.has(sid));
  const teams = (actor.teamIds ?? []).map((t) => scopeId("team", t));
  const ordered: ScopeId[] = [
    ...new Set([scopeId("personal", principalId), ...shared, ...teams, scopeId("org", orgIdOf())]),
  ];
  return deps.personas.listForScopes(ordered);
}

export function createAgentPersonaMethods(
  deps: AppDeps,
  h: AppHelpers,
): Pick<
  App,
  "listVisiblePersonas" | "getPersona" | "canManagePersona" | "createPersona" | "updatePersona" | "archivePersona"
> {
  const { principalManagesArtifactHome } = h;

  function canManagePersona(persona: AgentPersona, principalId: string): Promise<boolean> {
    return principalManagesArtifactHome(persona.scopeId, persona.createdBy, principalId);
  }

  return {
    async listVisiblePersonas(principalId) {
      return visiblePersonasFor(deps, h, principalId);
    },

    getPersona(id) {
      return deps.personas.get(id);
    },

    canManagePersona,

    async createPersona(input) {
      const homeScope = input.homeScope ?? scopeId("personal", input.principalId);
      const persona = await deps.personas.create({
        scopeId: homeScope,
        name: input.name,
        color: input.color,
        glyph: input.glyph,
        harnessId: input.harnessId,
        modelId: input.modelId,
        instructions: input.instructions,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        createdBy: input.principalId,
      });
      deps.auditLog.record({
        at: Date.now(),
        principalId: input.principalId,
        action: "agent_persona_create",
        resource: persona.id,
        scopeLabel: homeScope,
      });
      return persona;
    },

    async updatePersona(id, principalId, patch: AgentPersonaPatch) {
      const persona = await deps.personas.get(id);
      if (!persona || !(await canManagePersona(persona, principalId))) return null;
      if (persona.archivedAt !== undefined) return null;
      const updated = await deps.personas.update(id, patch);
      deps.auditLog.record({
        at: Date.now(),
        principalId,
        action: "agent_persona_update",
        resource: id,
        scopeLabel: persona.scopeId,
      });
      return updated;
    },

    async archivePersona(id, principalId) {
      const persona = await deps.personas.get(id);
      if (!persona) return "missing";
      if (!(await canManagePersona(persona, principalId))) return "forbidden";
      await deps.personas.archive(id);
      deps.auditLog.record({
        at: Date.now(),
        principalId,
        action: "agent_persona_archive",
        resource: id,
        scopeLabel: persona.scopeId,
      });
      return "archived";
    },
  };
}

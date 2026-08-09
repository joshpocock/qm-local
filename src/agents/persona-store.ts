import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";

export const PERSONA_NAME_MIN = 2;
export const PERSONA_NAME_MAX = 32;
export const PERSONA_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
export const PERSONA_INSTRUCTIONS_MAX = 8000;
const PERSONA_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * A named voice an operator can put in a room. Scope-owned exactly like a skill:
 * the owning scope decides who may see and manage it, and every turn a persona
 * takes still runs through the orchestrator under the session's scope, so
 * governance binds personas without any new enforcement code.
 */
export interface AgentPersona {
  id: string;
  scopeId: ScopeId;
  /** unique per scope (case-insensitive); no spaces, because it is the @mention token */
  name: string;
  /** #rrggbb transcript accent */
  color: string;
  /** 1-2 characters, avatar chip */
  glyph: string;
  harnessId: string;
  modelId: string;
  /** persona SOUL, composed below the org SOUL at turn time */
  instructions: string;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  version: number;
  updatedAt?: number;
  /** set by archive(); archived personas stay readable but drop out of listForScopes() */
  archivedAt?: number;
}

export interface NewAgentPersona {
  scopeId: ScopeId;
  name: string;
  color: string;
  glyph: string;
  harnessId: string;
  modelId: string;
  instructions: string;
  enabled?: boolean;
  createdBy: string;
}

export type AgentPersonaPatch = Partial<
  Pick<AgentPersona, "name" | "color" | "glyph" | "harnessId" | "modelId" | "instructions" | "enabled">
>;

export interface PersonaFields {
  name: string;
  color: string;
  glyph: string;
  instructions: string;
}

/** Length in user-perceived characters, so a two-codepoint emoji glyph counts as one. */
function glyphLength(glyph: string): number {
  return [...glyph].length;
}

/**
 * Returns a human-readable reason the fields are invalid, or null when they are fine.
 * Routes use this to answer 400 before touching the store; the store asserts the same
 * rules so no other caller can write a persona that breaks them.
 */
export function personaFieldError(fields: PersonaFields): string | null {
  const { name, color, glyph, instructions } = fields;
  if (typeof name !== "string" || name.length < PERSONA_NAME_MIN || name.length > PERSONA_NAME_MAX) {
    return `persona name must be ${PERSONA_NAME_MIN}-${PERSONA_NAME_MAX} characters`;
  }
  if (!PERSONA_NAME_PATTERN.test(name)) {
    return "persona name must start with a letter and contain only letters, digits, and hyphens (no spaces — it is the @mention token)";
  }
  if (typeof color !== "string" || !PERSONA_COLOR_PATTERN.test(color)) {
    return "persona color must be a #rrggbb hex color";
  }
  if (typeof glyph !== "string" || glyphLength(glyph) < 1 || glyphLength(glyph) > 2) {
    return "persona glyph must be 1-2 characters";
  }
  if (typeof instructions !== "string" || instructions.length > PERSONA_INSTRUCTIONS_MAX) {
    return `persona instructions must be at most ${PERSONA_INSTRUCTIONS_MAX} characters`;
  }
  return null;
}

export function assertValidPersonaFields(fields: PersonaFields): void {
  const problem = personaFieldError(fields);
  if (problem) throw new Error(problem);
}

export interface AgentPersonaStoreOptions {
  backing?: DurableMap<AgentPersona>;
}

export interface AgentPersonaStore {
  create(input: NewAgentPersona): Promise<AgentPersona>;
  update(id: string, patch: AgentPersonaPatch): Promise<AgentPersona>;
  get(id: string): Promise<AgentPersona | null>;
  list(): Promise<AgentPersona[]>;
  listForScopes(orderedScopes: readonly ScopeId[]): Promise<AgentPersona[]>;
  archive(id: string): Promise<AgentPersona>;
  delete(id: string): Promise<void>;
}

function isLive(p: AgentPersona): boolean {
  return p.archivedAt === undefined;
}

export function createAgentPersonaStore(opts: AgentPersonaStoreOptions = {}): AgentPersonaStore {
  const personas = opts.backing ?? createMemoryMap<AgentPersona>();

  async function assertNameFree(scopeId: ScopeId, name: string, exceptId?: string): Promise<void> {
    const wanted = name.toLowerCase();
    const clash = (await personas.all()).find(
      (p) => p.id !== exceptId && p.scopeId === scopeId && isLive(p) && p.name.toLowerCase() === wanted,
    );
    if (clash) throw new Error(`an agent named "${clash.name}" already exists in ${scopeId}`);
  }

  return {
    async create(input) {
      const name = input.name.trim();
      const color = input.color.trim().toLowerCase();
      const glyph = input.glyph.trim();
      const instructions = input.instructions;
      assertValidPersonaFields({ name, color, glyph, instructions });
      await assertNameFree(input.scopeId, name);
      const at = Date.now();
      const persona: AgentPersona = {
        id: `ap_${randomUUID()}`,
        scopeId: input.scopeId,
        name,
        color,
        glyph,
        harnessId: input.harnessId,
        modelId: input.modelId,
        instructions,
        enabled: input.enabled ?? true,
        createdBy: input.createdBy,
        createdAt: at,
        version: 1,
        updatedAt: at,
      };
      await personas.put(persona.id, persona);
      return persona;
    },

    async update(id, patch) {
      const p = await personas.get(id);
      if (!p) throw new Error(`unknown agent persona: ${id}`);
      if (!isLive(p)) throw new Error(`agent persona is archived: ${id}`);
      const name = patch.name === undefined ? p.name : patch.name.trim();
      const color = patch.color === undefined ? p.color : patch.color.trim().toLowerCase();
      const glyph = patch.glyph === undefined ? p.glyph : patch.glyph.trim();
      const instructions = patch.instructions === undefined ? p.instructions : patch.instructions;
      assertValidPersonaFields({ name, color, glyph, instructions });
      if (name.toLowerCase() !== p.name.toLowerCase()) await assertNameFree(p.scopeId, name, p.id);
      p.name = name;
      p.color = color;
      p.glyph = glyph;
      p.instructions = instructions;
      if (patch.harnessId !== undefined) p.harnessId = patch.harnessId;
      if (patch.modelId !== undefined) p.modelId = patch.modelId;
      if (patch.enabled !== undefined) p.enabled = patch.enabled;
      p.version += 1;
      p.updatedAt = Date.now();
      await personas.put(p.id, p);
      return p;
    },

    get: (id) => personas.get(id),
    list: () => personas.all(),

    async listForScopes(orderedScopes) {
      const rank = new Map(orderedScopes.map((scope, i) => [scope, i]));
      return (await personas.all())
        .filter((p) => isLive(p) && rank.has(p.scopeId))
        .sort((a, b) => rank.get(a.scopeId)! - rank.get(b.scopeId)! || a.name.localeCompare(b.name));
    },

    async archive(id) {
      const p = await personas.get(id);
      if (!p) throw new Error(`unknown agent persona: ${id}`);
      if (!isLive(p)) return p;
      p.archivedAt = Date.now();
      p.updatedAt = p.archivedAt;
      await personas.put(p.id, p);
      return p;
    },

    async delete(id) {
      await personas.delete(id);
    },
  };
}

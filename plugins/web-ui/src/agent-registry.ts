/**
 * Pure helpers for the Agents page. Kept free of DOM/Lit imports so the rules that
 * decide whether a persona is valid can be unit-tested directly.
 *
 * The validation here mirrors core's `personaFieldError` (`src/agents/persona-store.ts`)
 * field for field. It exists to give inline, per-field feedback before a round trip —
 * core stays the authority, and its 400/409 messages are always surfaced verbatim.
 */

/** An agent persona as `/api/agents` returns it. */
export interface AgentItem {
  id: string;
  name: string;
  color: string;
  glyph: string;
  harnessId: string;
  modelId: string;
  instructions: string;
  enabled: boolean;
  scope: string;
  scopeId: string;
  createdBy: string;
  createdAt: number;
  updatedAt?: number;
  version: number;
  editable: boolean;
}

export const AGENT_NAME_MIN = 2;
export const AGENT_NAME_MAX = 32;
export const AGENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
export const AGENT_INSTRUCTIONS_MAX = 8000;
export const AGENT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Swatches offered next to the colour input. Chosen to stay legible on both themes. */
export const AGENT_COLOR_PRESETS: readonly string[] = [
  "#2563eb",
  "#0f766e",
  "#15803d",
  "#b45309",
  "#c2410c",
  "#be185d",
  "#7c3aed",
  "#475569",
];

export interface AgentDraftFields {
  name: string;
  color: string;
  glyph: string;
  instructions: string;
}

export type AgentFieldErrors = Partial<Record<keyof AgentDraftFields, string>>;

/** Length in user-perceived characters, so a two-codepoint emoji glyph counts as one. */
function glyphLength(glyph: string): number {
  return [...glyph].length;
}

export function agentNameError(name: string): string | null {
  if (name.length < AGENT_NAME_MIN || name.length > AGENT_NAME_MAX) {
    return `Name must be ${AGENT_NAME_MIN}-${AGENT_NAME_MAX} characters.`;
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    return "Start with a letter; letters, digits, and hyphens only — the name is the @mention token.";
  }
  return null;
}

export function agentColorError(color: string): string | null {
  return AGENT_COLOR_PATTERN.test(color) ? null : "Colour must be a #rrggbb hex value.";
}

export function agentGlyphError(glyph: string): string | null {
  const length = glyphLength(glyph);
  return length >= 1 && length <= 2 ? null : "Glyph must be 1-2 characters.";
}

export function agentInstructionsError(instructions: string): string | null {
  return instructions.length > AGENT_INSTRUCTIONS_MAX
    ? `Instructions must be at most ${AGENT_INSTRUCTIONS_MAX} characters.`
    : null;
}

/** Per-field errors for inline display; empty object means the draft is submittable. */
export function agentFieldErrors(fields: AgentDraftFields): AgentFieldErrors {
  const errors: AgentFieldErrors = {};
  const name = agentNameError(fields.name);
  if (name) errors.name = name;
  const color = agentColorError(fields.color);
  if (color) errors.color = color;
  const glyph = agentGlyphError(fields.glyph);
  if (glyph) errors.glyph = glyph;
  const instructions = agentInstructionsError(fields.instructions);
  if (instructions) errors.instructions = instructions;
  return errors;
}

export function agentDraftValid(fields: AgentDraftFields): boolean {
  return Object.keys(agentFieldErrors(fields)).length === 0;
}

export interface AgentFilters {
  query: string;
  scope: string;
  status: "enabled" | "disabled" | "all";
}

export function filterAgents(agents: readonly AgentItem[], filters: AgentFilters): AgentItem[] {
  const q = filters.query.trim().toLowerCase();
  return agents.filter((agent) => {
    if (filters.scope !== "all" && agent.scope !== filters.scope) return false;
    if (filters.status === "enabled" && !agent.enabled) return false;
    if (filters.status === "disabled" && agent.enabled) return false;
    if (!q) return true;
    return (
      agent.name.toLowerCase().includes(q) ||
      agent.instructions.toLowerCase().includes(q) ||
      agent.modelId.toLowerCase().includes(q) ||
      agent.harnessId.toLowerCase().includes(q)
    );
  });
}

export function agentStatusCounts(agents: readonly AgentItem[]): {
  enabled: number;
  disabled: number;
  all: number;
} {
  const enabled = agents.filter((a) => a.enabled).length;
  return { enabled, disabled: agents.length - enabled, all: agents.length };
}

export type AgentEmptyState = "none" | "loading" | "filtered" | "empty" | "disabled";

export function agentEmptyState(
  total: number,
  visible: number,
  loading: boolean,
  roomsEnabled: boolean,
): AgentEmptyState {
  if (!roomsEnabled) return "disabled";
  if (loading && total === 0) return "loading";
  if (visible > 0) return "none";
  return total > 0 ? "filtered" : "empty";
}

/** Shown when core answers 404 because it is running without QM_AGENT_ROOMS=1. */
export const AGENT_ROOMS_DISABLED_COPY = "Agent rooms are not enabled on this deployment (QM_AGENT_ROOMS=1).";

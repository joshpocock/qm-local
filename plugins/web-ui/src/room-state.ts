/**
 * Client-side room bookkeeping: which threads are rooms, what roster they carry, and
 * the identity a transcript row should be labelled with.
 *
 * Kept free of DOM/Lit imports so the rules are unit-testable. Two stores live here:
 *
 * - **pending rooms**, keyed by `threadRef`. A web thread has no server-side session
 *   until its first message lands, so "New room" has nothing to PUT a roster onto. The
 *   picked config is parked here and rides in on the first turn (`drive` in
 *   core-bridge.ts), which is what core persists onto the session it creates.
 * - **pending room names**, keyed the same way and for the same reason. A room's name is
 *   an ordinary session title, and a session that does not exist cannot be titled — so the
 *   name waits here until there is an id to POST it against. It has its own lifecycle: the
 *   roster rides in on the turn, the name does not, so the two clear independently.
 * - **applied rooms**, also keyed by `threadRef`, so the composer and header can ask
 *   "is the mounted thread a room?" without a round trip.
 * - **refusals**, so a roster core rejected can be shown at the composer instead of
 *   leaving a failed assistant turn nobody took.
 */

import type { AgentItem } from "./agent-registry";

export interface RoomConfig {
  personaIds: string[];
  rounds: number;
}

/** Identity core stamps onto assistant entries in a room (`payload.persona`). */
export interface MessagePersona {
  id: string;
  name: string;
}

/** Everything needed to draw a persona chip. Colour/glyph are absent for archived personas. */
export interface PersonaChip {
  id: string;
  name: string;
  color?: string;
  glyph?: string;
}

export const MIN_ROOM_PERSONAS = 1;
/** Quick picks in the dialog; any integer up to MAX_ROOM_ROUNDS is accepted. */
export const ROOM_ROUNDS: readonly number[] = [1, 2, 3];
export const MAX_ROOM_ROUNDS = 20;
export const DEFAULT_ROOM_ROUNDS = 1;

export function roomConfigError(config: { personaIds: readonly string[]; rounds: number }): string | null {
  const unique = new Set(config.personaIds);
  if (unique.size !== config.personaIds.length) return "Each agent can only be in the room once.";
  if (config.personaIds.length < MIN_ROOM_PERSONAS) return "Pick at least one agent.";
  if (!Number.isInteger(config.rounds) || config.rounds < 1 || config.rounds > MAX_ROOM_ROUNDS) {
    return `Rounds must be a whole number from 1 to ${MAX_ROOM_ROUNDS}.`;
  }
  return null;
}

/** Roster multi-select: order of selection is the order they speak. There is no size cap. */
export function toggleRosterMember(personaIds: readonly string[], id: string): string[] {
  if (personaIds.includes(id)) return personaIds.filter((existing) => existing !== id);
  return [...personaIds, id];
}

export function canAddToRoster(_personaIds: readonly string[], agent: AgentItem): boolean {
  return agent.enabled;
}

// ---------------------------------------------------------------------------
// Persona identity cache
// ---------------------------------------------------------------------------

const personaCache = new Map<string, PersonaChip>();
/**
 * The whole persona, kept alongside the chip. A chip only ever needs four fields, but a
 * mention popover has to show harness, model, scope, enabled state and instructions — and
 * it is opened by a click, far too late to start a fetch. Same `/api/agents` payload, so
 * this costs nothing beyond the reference.
 */
const agentCache = new Map<string, AgentItem>();

/** Caches colour/glyph from the `/api/agents` list so transcript rows can be labelled. */
export function cachePersonas(agents: readonly AgentItem[]): void {
  for (const agent of agents) {
    personaCache.set(agent.id, { id: agent.id, name: agent.name, color: agent.color, glyph: agent.glyph });
    agentCache.set(agent.id, agent);
  }
}

export function cachedPersona(id: string): PersonaChip | undefined {
  return personaCache.get(id);
}

/** The full persona behind a chip, when `/api/agents` has been read. */
export function cachedAgent(id: string): AgentItem | undefined {
  return agentCache.get(id);
}

/**
 * Every agent `/api/agents` has told the client about, in cache (insertion) order. Used by
 * the composer's `@mention` autocomplete, which needs the whole roster of nameable agents —
 * not just the ones already in the current room — rather than a single lookup by id.
 */
export function cachedAgents(): AgentItem[] {
  return [...agentCache.values()];
}

export function clearPersonaCache(): void {
  personaCache.clear();
  agentCache.clear();
}

/**
 * Resolves the chip for a transcript row. Personas can be archived after they have
 * spoken, so an id missing from the cache degrades to a neutral chip carrying only the
 * name that core stamped on the entry — never to a blank label.
 */
export function personaChipFor(persona: MessagePersona | undefined | null): PersonaChip | null {
  if (!persona || typeof persona.id !== "string" || !persona.id) return null;
  const cached = personaCache.get(persona.id);
  if (cached) return { ...cached, name: cached.name || persona.name };
  if (!persona.name) return null;
  return { id: persona.id, name: persona.name };
}

/** Cache-invalidation identity for a memoised transcript row (see SettledRowKey). */
export function personaRowKey(persona: MessagePersona | undefined | null): string {
  const chip = personaChipFor(persona);
  if (!chip) return "";
  // Joined on a character none of the four fields can contain, so the key is unambiguous.
  return [chip.id, chip.name, chip.color ?? "", chip.glyph ?? ""].join("\n");
}

// ---------------------------------------------------------------------------
// Room names
// ---------------------------------------------------------------------------

/** How many members a derived name lists before it starts counting the rest. */
const ROOM_NAME_MEMBERS = 3;
/** Per-name ceiling, so one verbose agent cannot push the roster out of a sidebar row. */
const ROOM_NAME_PART = 18;
/** What an unnamed room with no resolvable roster is called. */
export const FALLBACK_ROOM_NAME = "Room";

function shortMemberName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= ROOM_NAME_PART) return trimmed;
  return `${trimmed.slice(0, ROOM_NAME_PART - 1).trimEnd()}…`;
}

/**
 * The name an unnamed room is shown under: "Scout", "Scout & Critic",
 * "Scout, Critic & Mesh", and past that a count — "Scout, Critic, Mesh & 2 more".
 * Only ever a display fallback; a room the operator named carries its own title.
 */
export function defaultRoomName(names: readonly string[]): string {
  const parts = names.map(shortMemberName).filter(Boolean);
  if (!parts.length) return FALLBACK_ROOM_NAME;
  const shown = parts.slice(0, ROOM_NAME_MEMBERS);
  const extra = parts.length - shown.length;
  if (extra > 0) return `${shown.join(", ")} & ${extra} more`;
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(", ")} & ${shown.at(-1)}`;
}

/**
 * Same, resolved through the persona cache. Ids the cache has not seen yet — the list paints
 * before `/api/agents` lands, and an archived member may never resolve — are counted, never
 * printed: "ap_5e3bafdd-c178-40da…" is worse than useless as a room name. With nothing
 * resolved at all the room reads as the neutral fallback until the cache warms and the list
 * repaints.
 */
export function defaultRoomNameFor(room: Pick<RoomConfig, "personaIds"> | null | undefined): string {
  if (!room?.personaIds.length) return FALLBACK_ROOM_NAME;
  const known = room.personaIds.map((id) => personaCache.get(id)?.name).filter((name): name is string => Boolean(name));
  if (!known.length) return FALLBACK_ROOM_NAME;
  const missing = room.personaIds.length - known.length;
  const named = defaultRoomName(known);
  return missing > 0 ? `${named} & ${missing} more` : named;
}

// ---------------------------------------------------------------------------
// Pending + applied room configs
// ---------------------------------------------------------------------------

const pendingRooms = new Map<string, RoomConfig>();
const pendingRoomNames = new Map<string, string>();
const appliedRooms = new Map<string, RoomConfig>();

/** Parks a roster for a thread whose session does not exist server-side yet. */
export function holdPendingRoom(threadRef: string, config: RoomConfig): void {
  pendingRooms.set(threadRef, config);
  appliedRooms.set(threadRef, config);
}

export function pendingRoomFor(threadRef: string | null): RoomConfig | null {
  return (threadRef && pendingRooms.get(threadRef)) || null;
}

export function clearPendingRoom(threadRef: string): void {
  pendingRooms.delete(threadRef);
}

/**
 * Parks the name a new room was given until its session exists. A blank name parks nothing:
 * the room then shows the roster-derived default, which is not worth persisting as a title.
 */
export function holdPendingRoomName(threadRef: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed) pendingRoomNames.set(threadRef, trimmed);
  else pendingRoomNames.delete(threadRef);
}

export function pendingRoomNameFor(threadRef: string | null): string | null {
  return (threadRef && pendingRoomNames.get(threadRef)) || null;
}

/** Called only once the title actually landed — a failed attempt leaves it parked to retry. */
export function clearPendingRoomName(threadRef: string): void {
  pendingRoomNames.delete(threadRef);
}

/** Records the room a session read reported (or its absence). */
export function noteRoom(threadRef: string | null, config: RoomConfig | null | undefined): void {
  if (!threadRef) return;
  if (config) appliedRooms.set(threadRef, config);
  else if (!pendingRooms.has(threadRef)) appliedRooms.delete(threadRef);
}

export function roomFor(threadRef: string | null): RoomConfig | null {
  return (threadRef && appliedRooms.get(threadRef)) || null;
}

export function isRoomThread(threadRef: string | null): boolean {
  return roomFor(threadRef) !== null;
}

// ---------------------------------------------------------------------------
// Roster refusals
// ---------------------------------------------------------------------------

/**
 * A roster core refused when it rode in on the first message — "agent Critic is disabled",
 * "unknown agent: …". It belongs next to the composer, not in the transcript as a failed
 * assistant turn: nothing was said, and the fix (re-enable the agent, then resend) is the
 * human's. The pending roster is deliberately kept so the next send retries it.
 */
const roomRefusals = new Map<string, string>();

export function noteRoomRefusal(threadRef: string | null, reason: string): void {
  if (threadRef && reason) roomRefusals.set(threadRef, reason);
}

export function roomRefusalFor(threadRef: string | null): string | null {
  return (threadRef && roomRefusals.get(threadRef)) || null;
}

export function clearRoomRefusal(threadRef: string | null): void {
  if (threadRef) roomRefusals.delete(threadRef);
}

export function resetRoomState(): void {
  pendingRooms.clear();
  pendingRoomNames.clear();
  appliedRooms.clear();
  roomRefusals.clear();
  clearPersonaCache();
}

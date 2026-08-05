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
 * - **applied rooms**, also keyed by `threadRef`, so the composer and header can ask
 *   "is the mounted thread a room?" without a round trip.
 * - **refusals**, so a roster core rejected can be shown at the composer instead of
 *   leaving a failed assistant turn nobody took.
 */

import type { AgentItem } from "./agent-registry";

export interface RoomConfig {
  personaIds: string[];
  rounds: 1 | 2 | 3;
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
export const ROOM_ROUNDS: ReadonlyArray<1 | 2 | 3> = [1, 2, 3];
export const DEFAULT_ROOM_ROUNDS: 1 | 2 | 3 = 1;

export function roomConfigError(config: { personaIds: readonly string[]; rounds: number }): string | null {
  const unique = new Set(config.personaIds);
  if (unique.size !== config.personaIds.length) return "Each agent can only be in the room once.";
  if (config.personaIds.length < MIN_ROOM_PERSONAS) return "Pick at least one agent.";
  if (!ROOM_ROUNDS.includes(config.rounds as 1 | 2 | 3)) return "Rounds must be 1, 2, or 3.";
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

/** Caches colour/glyph from the `/api/agents` list so transcript rows can be labelled. */
export function cachePersonas(agents: readonly AgentItem[]): void {
  for (const agent of agents) {
    personaCache.set(agent.id, { id: agent.id, name: agent.name, color: agent.color, glyph: agent.glyph });
  }
}

export function cachedPersona(id: string): PersonaChip | undefined {
  return personaCache.get(id);
}

export function clearPersonaCache(): void {
  personaCache.clear();
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
// Pending + applied room configs
// ---------------------------------------------------------------------------

const pendingRooms = new Map<string, RoomConfig>();
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
  appliedRooms.clear();
  roomRefusals.clear();
  personaCache.clear();
}

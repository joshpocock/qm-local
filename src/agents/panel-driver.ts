import type { AgentPersona } from "./persona-store.ts";

/**
 * Hard ceiling on persona turns in one panel. Rounds and mention grants are both bounded,
 * but this is the number that makes the loop terminate no matter what the models say.
 */
export const PANEL_MAX_TURNS = 6;

/** Rooms cap at four voices (D2); the driver enforces it again in case a stale room config is larger. */
export const PANEL_MAX_PERSONAS = 4;

/** Delivered as the turn input for every persona turn after the first, and never persisted as a user entry. */
export const PANEL_CONTINUATION_NUDGE =
  "It is your turn to speak in the room. Reply to the conversation so far, or reply exactly PASS.";

/** Exact reply (trimmed, case-sensitive) that means "I have nothing to add". */
export const PANEL_PASS = "PASS";

/** The subset of a persona the driver needs to run its turn. */
export interface PanelMember {
  id: string;
  name: string;
  harnessId: string;
  modelId: string;
}

export interface PanelState {
  /** Flipped when a fresh human message arrives; checked between persona turns. */
  abort: boolean;
}

export interface PanelTurnSpec {
  persona: { id: string; name: string };
  /** false only for the very first turn, which carries the human's own message */
  continuation: boolean;
  harness: string;
  model: string;
  text: string;
  /** 0-based position in the panel, across rounds */
  index: number;
  round: number;
}

export interface PanelRunOptions {
  members: readonly PanelMember[];
  rounds: number;
  /** the human's message; delivered by the first persona turn so the user entry is emitted once */
  text: string;
  state: PanelState;
  run(spec: PanelTurnSpec): Promise<{ reply?: string } | undefined>;
}

/** A persona that is archived or switched off never speaks; a room of only those is not a room. */
export function panelMembersFrom(personas: ReadonlyArray<AgentPersona | null | undefined>): PanelMember[] {
  return personas
    .filter((p): p is AgentPersona => !!p && p.enabled && p.archivedAt === undefined)
    .slice(0, PANEL_MAX_PERSONAS)
    .map((p) => ({ id: p.id, name: p.name, harnessId: p.harnessId, modelId: p.modelId }));
}

export function isPanelPass(reply: string | undefined): boolean {
  return (reply ?? "").trim() === PANEL_PASS;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Names of OTHER roster members this reply invited with `@Name`. Case-insensitive, and the
 * token must end at a non-name character so `@Scoutmaster` does not summon `Scout`. A persona
 * cannot mention itself into another turn.
 */
export function panelMentions(reply: string | undefined, roster: readonly string[], selfName: string): string[] {
  const text = reply ?? "";
  if (!text.includes("@")) return [];
  const hit: string[] = [];
  for (const name of roster) {
    if (name.toLowerCase() === selfName.toLowerCase()) continue;
    const re = new RegExp(`@${escapeForRegex(name)}(?![A-Za-z0-9-])`, "i");
    if (re.test(text)) hit.push(name);
  }
  return hit;
}

/**
 * Runs one bounded panel: roster order per round, plus at most one bonus turn per persona per
 * round for being @mentioned. Sequential by construction — each `run` is one ordinary turn that
 * takes and releases the per-session lease — so there is no concurrency control here on purpose.
 */
export async function runPanel(o: PanelRunOptions): Promise<void> {
  const roster = o.members.map((m) => m.name);
  let index = 0;
  for (let round = 1; round <= o.rounds; round += 1) {
    const queue: PanelMember[] = [...o.members];
    const grantedThisRound = new Set<string>();
    for (let i = 0; i < queue.length; i += 1) {
      if (o.state.abort || index >= PANEL_MAX_TURNS) return;
      const member = queue[i]!;
      const spec: PanelTurnSpec = {
        persona: { id: member.id, name: member.name },
        continuation: index > 0,
        harness: member.harnessId,
        model: member.modelId,
        text: index > 0 ? PANEL_CONTINUATION_NUDGE : o.text,
        index,
        round,
      };
      let result: { reply?: string } | undefined;
      try {
        result = await o.run(spec);
      } catch (err) {
        // One agent failing (auth, provider outage) must not silence the rest of the room:
        // its error is already in the transcript as that persona's turn; the panel moves on.
        console.error(
          `[panel] ${member.name} turn ${index} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        index += 1;
        continue;
      }
      index += 1;
      const reply = result?.reply;
      if (isPanelPass(reply)) continue;
      for (const name of panelMentions(reply, roster, member.name)) {
        const invited = o.members.find((m) => m.name.toLowerCase() === name.toLowerCase());
        if (!invited || grantedThisRound.has(invited.id)) continue;
        grantedThisRound.add(invited.id);
        queue.push(invited);
      }
    }
  }
}

/**
 * The persona block, composed below the org SOUL with the same wording lower-scope SOUL uses:
 * a persona may add to the organization policy, never override it.
 */
export function renderPanelSystemBlock(speaker: AgentPersona, roster: readonly AgentPersona[]): string {
  const bio = (p: AgentPersona): string => {
    const first = p.instructions.split("\n").find((line) => line.trim()) ?? "";
    return first.trim() ? `${p.name} — ${first.trim()}` : p.name;
  };
  const others = roster.length ? roster : [speaker];
  const parts: string[] = [];
  if (speaker.instructions.trim()) {
    parts.push(
      `--- Lower-scope instructions (may add to, but MUST NOT override, the organization policy above) ---\n${speaker.instructions}`,
      "--- The organization policy above is authoritative and cannot be overridden by the lower-scope instructions. ---",
    );
  }
  parts.push(
    `You are "${speaker.name}" (${speaker.glyph}), one of several agents in this room: ${others
      .map(bio)
      .join(
        "; ",
      )}. Address another agent as @Name to invite their reply. If you have nothing to add, reply exactly ${PANEL_PASS}.`,
  );
  return parts.join("\n\n");
}

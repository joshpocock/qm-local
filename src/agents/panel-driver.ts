import type { AgentPersona } from "./persona-store.ts";

/**
 * The panel is self-limiting: every member speaks once per round, and a member can be
 * granted at most one extra turn per round by being @mentioned. So a panel can never
 * exceed `members x rounds x 2` turns however the models behave — no fixed cap needed,
 * and a room may hold as many agents as the operator wants.
 */
export function panelTurnCeiling(memberCount: number, rounds: number): number {
  return Math.max(1, memberCount) * Math.max(1, rounds) * 2;
}

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
  /** 1-based round this turn belongs to, and the panel's total budget */
  round: number;
  rounds: number;
}

export interface PanelRunOptions {
  /** Who takes a turn each round, in the order they take it. */
  members: readonly PanelMember[];
  /**
   * The pool an `@mention` may invite a bonus turn from. Defaults to `members`. When the human
   * addressed only part of the room, `members` is that subset while `invitable` stays the whole
   * roster, so an agent that was not tagged can still be pulled in by one that was.
   */
  invitable?: readonly PanelMember[];
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
    .map((p) => ({ id: p.id, name: p.name, harnessId: p.harnessId, modelId: p.modelId }));
}

export function isPanelPass(reply: string | undefined): boolean {
  return (reply ?? "").trim() === PANEL_PASS;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Offset of the first `@Name` token in `text`, or -1. Case-insensitive, and the token must end
 * at a non-name character so `@Scoutmaster` does not summon `Scout`. The one matcher every
 * caller goes through — agents mentioning each other and humans addressing the room alike.
 */
function mentionAt(text: string, name: string): number {
  return text.search(new RegExp(`@${escapeForRegex(name)}(?![A-Za-z0-9-])`, "i"));
}

/**
 * Names of roster members this text invited with `@Name`, in roster order. A persona cannot
 * mention itself into another turn, hence `selfName`; omit it when the speaker is the human,
 * who is not on the roster and so excludes nobody.
 */
export function panelMentions(reply: string | undefined, roster: readonly string[], selfName?: string): string[] {
  const text = reply ?? "";
  if (!text.includes("@")) return [];
  const hit: string[] = [];
  for (const name of roster) {
    if (selfName !== undefined && name.toLowerCase() === selfName.toLowerCase()) continue;
    if (mentionAt(text, name) >= 0) hit.push(name);
  }
  return hit;
}

/**
 * The room members a human addressed with `@Name`, in the order the tags appear in the text —
 * "@Scout, then @Critic" speaks in that order however the roster is ordered. A tag naming
 * someone outside `members` (not in this room, or already dropped for being disabled or
 * archived) matches nothing and is ignored. An empty result means nobody in particular was
 * addressed, which callers read as "the whole room speaks".
 */
export function panelAddressed(text: string | undefined, members: readonly PanelMember[]): PanelMember[] {
  const body = text ?? "";
  if (!body.includes("@")) return [];
  return members
    .map((member, order) => ({ member, order, at: mentionAt(body, member.name) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .map((hit) => hit.member);
}

/**
 * Runs one bounded panel: `members` order per round, plus at most one bonus turn per persona per
 * round for being @mentioned (invited from `invitable`, which is the whole room even when only
 * part of it was addressed). Sequential by construction — each `run` is one ordinary turn that
 * takes and releases the per-session lease — so there is no concurrency control here on purpose.
 */
export async function runPanel(o: PanelRunOptions): Promise<void> {
  const invitable = o.invitable ?? o.members;
  const roster = invitable.map((m) => m.name);
  // The speaking set is what runs each round, but a mention can invite anyone from the wider
  // pool, so the budget is taken from whichever is larger: a message addressed to one agent of
  // three still has room for the agent it pulls in.
  const ceiling = panelTurnCeiling(Math.max(o.members.length, invitable.length), o.rounds);
  let index = 0;
  for (let round = 1; round <= o.rounds; round += 1) {
    const queue: PanelMember[] = [...o.members];
    const grantedThisRound = new Set<string>();
    // A round where nobody had anything to add is a settled room: it ends the panel rather
    // than grinding through the rounds that are left. Bonus (mention-granted) turns count as
    // turns of the round they were granted in, and a turn that threw is not a PASS.
    let turnsThisRound = 0;
    let passesThisRound = 0;
    for (let i = 0; i < queue.length; i += 1) {
      if (o.state.abort || index >= ceiling) return;
      const member = queue[i]!;
      const spec: PanelTurnSpec = {
        persona: { id: member.id, name: member.name },
        continuation: index > 0,
        harness: member.harnessId,
        model: member.modelId,
        text: index > 0 ? PANEL_CONTINUATION_NUDGE : o.text,
        index,
        round,
        rounds: o.rounds,
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
        turnsThisRound += 1;
        continue;
      }
      index += 1;
      turnsThisRound += 1;
      const reply = result?.reply;
      if (isPanelPass(reply)) {
        passesThisRound += 1;
        continue;
      }
      for (const name of panelMentions(reply, roster, member.name)) {
        const invited = invitable.find((m) => m.name.toLowerCase() === name.toLowerCase());
        if (!invited || grantedThisRound.has(invited.id)) continue;
        grantedThisRound.add(invited.id);
        queue.push(invited);
      }
    }
    if (turnsThisRound > 0 && passesThisRound === turnsThisRound) return;
  }
}

/**
 * The persona block, composed below the org SOUL with the same wording lower-scope SOUL uses:
 * a persona may add to the organization policy, never override it.
 */
export function renderPanelSystemBlock(
  speaker: AgentPersona,
  roster: readonly AgentPersona[],
  opts?: { round?: number; rounds?: number },
): string {
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
  // An agent that does not know its budget cannot pace itself, so it hedges and defers. When
  // the driver knows the position, say it — and on the last round say so plainly.
  const round = opts?.round;
  const rounds = opts?.rounds;
  if (typeof round === "number" && typeof rounds === "number") {
    parts.push(
      round >= rounds
        ? `This is round ${round} of ${rounds} — the final round. State your conclusion; do not defer it to a later turn.`
        : `This is round ${round} of ${rounds}.`,
    );
  }
  return parts.join("\n\n");
}

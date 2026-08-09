import { swallow } from "../util/errors.ts";
import { clampPanelRounds } from "./config.ts";

/**
 * How long a channel's debate-rounds override is trusted without re-reading it. Same 5s window
 * the ambient-room gate in `mirror.ts` uses: short enough that an admin edit is live "within
 * seconds" like every other Slack knob, long enough that a running panel does not hit the
 * channel-policy store once per turn.
 */
export const DEBATE_ROUNDS_TTL_MS = 5_000;

export interface DebateRoundsResolver {
  /**
   * The rounds ceiling to run a panel in `container` at.
   *
   * Each layer only ever NARROWS the one above it:
   *   channel override (if set) → admin default → the count stated in the message → PASS exit.
   *
   * With no `requested`, this is the effective ceiling. With one — the count a human asked for
   * in the triggering message — it is that count held under the ceiling, which is what the turn
   * handler wants. The PASS early exit is core's job and is unaffected either way.
   */
  effectiveDebateRounds(container: string, requested?: number): Promise<number>;
}

export function createDebateRoundsResolver(deps: {
  /** The channel's own override, or undefined when it has none. */
  channelDebateRounds(container: string): Promise<number | undefined>;
  /** The admin default this deployment resolved at start-up (`cfg.panelRounds`). */
  fallback: number;
  ttlMs?: number;
  now?: () => number;
}): DebateRoundsResolver {
  const ttlMs = deps.ttlMs ?? DEBATE_ROUNDS_TTL_MS;
  const now = deps.now ?? Date.now;
  const fallback = clampPanelRounds(deps.fallback);
  // One entry per channel this bot has run a panel in — the same unbounded-by-design shape as
  // the ambient-room gate, because the key space is the workspace's channels.
  const cache = new Map<string, { ceiling: number; at: number }>();

  async function ceilingFor(container: string): Promise<number> {
    const hit = cache.get(container);
    if (hit && now() - hit.at <= ttlMs) return hit.ceiling;
    let ceiling = fallback;
    try {
      const override = await deps.channelDebateRounds(container);
      // A corrupted or out-of-range stored value degrades to the admin default rather than
      // silently capping a debate at something nobody chose.
      if (typeof override === "number" && Number.isInteger(override) && override >= 1) {
        ceiling = clampPanelRounds(override);
      }
    } catch (e) {
      // A store blip must not stop a debate: fall back to the admin default and try again after
      // the TTL rather than failing the turn.
      swallow("slack: debate-rounds lookup", e);
    }
    cache.set(container, { ceiling, at: now() });
    return ceiling;
  }

  return {
    async effectiveDebateRounds(container, requested) {
      const ceiling = await ceilingFor(container);
      if (requested === undefined) return ceiling;
      return Math.max(1, Math.min(requested, ceiling));
    },
  };
}

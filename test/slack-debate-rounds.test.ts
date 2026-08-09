import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebateRoundsResolver, DEBATE_ROUNDS_TTL_MS } from "../src/slack/debate-rounds.ts";

function resolver(
  overrides: Record<string, number | undefined>,
  opts: { fallback?: number; now?: () => number; fail?: () => boolean } = {},
): {
  effectiveDebateRounds(container: string, requested?: number): Promise<number>;
  reads: string[];
} {
  const reads: string[] = [];
  const r = createDebateRoundsResolver({
    channelDebateRounds: async (container) => {
      reads.push(container);
      if (opts.fail?.()) throw new Error("channel policy store is down");
      return overrides[container];
    },
    fallback: opts.fallback ?? 3,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { effectiveDebateRounds: r.effectiveDebateRounds, reads };
}

test("debate rounds: a channel override narrows the admin default, and no override falls through to it", async () => {
  const { effectiveDebateRounds } = resolver({ "C-narrow": 1, "C-wide": 8 }, { fallback: 3 });
  assert.equal(await effectiveDebateRounds("C-narrow"), 1, "the channel's own ceiling wins");
  assert.equal(await effectiveDebateRounds("C-none"), 3, "no override means the admin default");
  assert.equal(
    await effectiveDebateRounds("C-wide"),
    8,
    "a channel may also set a ceiling above the default — the store is the narrowing layer, not this one",
  );
});

test("debate rounds: an invalid stored override is ignored in favour of the admin default", async () => {
  const { effectiveDebateRounds } = resolver(
    { "C-zero": 0, "C-frac": 2.5, "C-neg": -4, "C-huge": 999 } as Record<string, number>,
    { fallback: 3 },
  );
  assert.equal(await effectiveDebateRounds("C-zero"), 3);
  assert.equal(await effectiveDebateRounds("C-frac"), 3);
  assert.equal(await effectiveDebateRounds("C-neg"), 3);
  assert.equal(await effectiveDebateRounds("C-huge"), 20, "a too-large value clamps to ROOM_MAX_ROUNDS");
});

test("debate rounds: a count stated in the message wins BELOW the ceiling and never above it", async () => {
  const { effectiveDebateRounds } = resolver({ C1: 4 }, { fallback: 10 });
  assert.equal(await effectiveDebateRounds("C1", 2), 2, "asking for fewer rounds than the ceiling is honoured");
  assert.equal(await effectiveDebateRounds("C1", 9), 4, "asking for more is held at the channel ceiling");
  assert.equal(await effectiveDebateRounds("C1"), 4, "asking for nothing is the ceiling itself");
  assert.equal(await effectiveDebateRounds("C1", 0), 1, "a debate always gets at least one round");
});

test("debate rounds: the lookup is cached per channel for the TTL, then re-read", async () => {
  let clock = 1_000;
  const overrides: Record<string, number | undefined> = { C1: 2 };
  const { effectiveDebateRounds, reads } = resolver(overrides, { fallback: 5, now: () => clock });
  assert.equal(await effectiveDebateRounds("C1"), 2);
  assert.equal(await effectiveDebateRounds("C1"), 2);
  assert.equal(reads.length, 1, "a panel turn does not re-read the store");
  assert.equal(await effectiveDebateRounds("C2"), 5);
  assert.deepEqual(reads, ["C1", "C2"], "the cache is per channel");

  overrides.C1 = 7;
  clock += DEBATE_ROUNDS_TTL_MS;
  assert.equal(await effectiveDebateRounds("C1"), 2, "still inside the TTL");
  clock += 1;
  assert.equal(await effectiveDebateRounds("C1"), 7, "an admin edit is live within seconds");
});

test("debate rounds: a store failure degrades to the admin default instead of failing the turn", async () => {
  let down = true;
  let clock = 0;
  const { effectiveDebateRounds } = resolver({ C1: 6 }, { fallback: 3, now: () => clock, fail: () => down });
  assert.equal(await effectiveDebateRounds("C1"), 3, "the debate still runs");
  down = false;
  clock += DEBATE_ROUNDS_TTL_MS + 1;
  assert.equal(await effectiveDebateRounds("C1"), 6, "and picks the override back up once the store recovers");
});

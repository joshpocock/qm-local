/**
 * Turning a room transcript into threads: the human's message is the parent, and the
 * persona replies that answered it hang underneath it instead of running on as siblings.
 *
 * Kept free of DOM/Lit imports so the rule itself is unit-testable, and deliberately
 * conservative — the grouping is a *view* over the same message array the flat transcript
 * renders, so every message still appears exactly once, in `index` order, whether or not
 * it ended up inside a thread.
 *
 * Three things gate it, and any of them failing degrades to today's flat run:
 *
 * - **Only in a room.** Outside rooms `parentSeq` is an ordinary linear `seq - 1` chain,
 *   so a non-null value says nothing about who answered whom. The caller passes
 *   `isRoom` (from `isRoomThread`), and a false value short-circuits to one row per message.
 * - **Only when the parent is on screen.** A reply whose `parentSeq` does not resolve to a
 *   user message already rendered above it stays where it is, as its own row. That covers
 *   rooms whose entries predate room parenting (their `parentSeq` points at the previous
 *   activity entry, not at the human turn), a thread paged so the parent is above the
 *   window, and anything core has not stamped yet. A reply never disappears.
 * - **Only backwards.** A parent is matched among user messages *earlier* in the array, so
 *   grouping can never reorder the transcript.
 *
 * The in-flight reply is the one exception to seq matching: it is a client-side partial with
 * no seq at all (and, on a freshly sent turn, so is the user message that triggered it —
 * neither has round-tripped through core yet). It is attached by position instead, to the
 * last user message above it, which is by construction the turn it is answering.
 */

/**
 * The slice of an `AgentMessage` this module reads. Structural on purpose: the transcript's
 * real message type comes from pi, and nothing here needs the rest of it.
 */
export interface ThreadableMessage {
  role?: string;
  seq?: number;
  parentSeq?: number | null;
}

/**
 * The exact persona reply core treats as "I have nothing to add" (`PANEL_PASS` in
 * `src/agents/panel-driver.ts`). Trimmed and case-sensitive, matching core's `isPanelPass`.
 * Core no longer persists one, but rooms that predate that fix still carry them.
 */
export const ROOM_PASS_REPLY = "PASS";

/**
 * Drops the stored `PASS` replies from a room transcript, so they render as nothing at all
 * rather than as an empty bubble — and, because the grouping and the reply counts are both
 * built from the array this returns, so they never show up as an answer nobody gave.
 *
 * Three deliberate limits:
 *
 * - **Only in a room.** Outside one, `PASS` is just a word someone said.
 * - **Only assistant turns.** A human is entitled to type PASS and see it.
 * - **Never the live partial.** `keep` exists for the streaming message: a reply that has
 *   only emitted `PASS` so far may still be mid-sentence, and blinking it out of the
 *   transcript and back in would be worse than showing it for a moment.
 */
export function dropRoomPassReplies<T extends ThreadableMessage>(
  messages: readonly T[],
  opts: { isRoom: boolean; textOf: (message: T) => string; keep?: (message: T) => boolean },
): T[] {
  if (!opts.isRoom) return [...messages];
  return messages.filter((message) => {
    if (message.role !== "assistant") return true;
    if (opts.keep?.(message)) return true;
    return opts.textOf(message).trim() !== ROOM_PASS_REPLY;
  });
}

/**
 * One row of the rendered transcript. `replies` is empty for every row that is not a
 * thread parent — including a user message nobody answered, which must render with no
 * thread affordance at all.
 */
export interface TranscriptRow {
  /** Index into the message array this row was grouped from. */
  index: number;
  /** Indices of the replies grouped under it, in seq order, live reply last. */
  replies: number[];
  /** True when the in-flight stream is one of those replies. */
  live: boolean;
}

export interface GroupOptions {
  /** `isRoomThread(threadRef)` — the only thing that turns grouping on. */
  isRoom: boolean;
  /** Index of the streaming partial, when one is being rendered. */
  liveIndex?: number | null;
}

/** Both roles the composer and the transcript use for a human turn. */
export function isUserRole(role: string | undefined): boolean {
  return role === "user" || role === "user-with-attachments";
}

export function groupRoomTranscript(messages: readonly ThreadableMessage[], opts: GroupOptions): TranscriptRow[] {
  const flat = (): TranscriptRow[] => messages.map((_, index) => ({ index, replies: [], live: false }));
  if (!opts.isRoom) return flat();

  const liveIndex =
    typeof opts.liveIndex === "number" && opts.liveIndex >= 0 && opts.liveIndex < messages.length
      ? opts.liveIndex
      : null;

  const rows: TranscriptRow[] = [];
  const userRowBySeq = new Map<number, TranscriptRow>();
  let lastUserRow: TranscriptRow | null = null;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (isUserRole(message.role)) {
      const row: TranscriptRow = { index, replies: [], live: false };
      rows.push(row);
      // First writer wins: seqs are unique, so a duplicate would be a bug upstream and
      // silently rehoming replies onto the later copy would be worse than ignoring it.
      if (typeof message.seq === "number" && !userRowBySeq.has(message.seq)) userRowBySeq.set(message.seq, row);
      lastUserRow = row;
      continue;
    }
    if (index === liveIndex && lastUserRow) {
      lastUserRow.replies.push(index);
      lastUserRow.live = true;
      continue;
    }
    const parent =
      message.role === "assistant" && typeof message.parentSeq === "number"
        ? userRowBySeq.get(message.parentSeq)
        : undefined;
    if (parent && parent.index < index) {
      parent.replies.push(index);
      continue;
    }
    rows.push({ index, replies: [], live: false });
  }

  for (const row of rows) {
    if (row.replies.length < 2) continue;
    row.replies.sort((a, b) => {
      const left = messages[a]!.seq;
      const right = messages[b]!.seq;
      // A seq-less reply is the live partial, which belongs after everything settled;
      // array order already puts it there, so fall through to it rather than guessing.
      if (typeof left === "number" && typeof right === "number" && left !== right) return left - right;
      return a - b;
    });
  }

  return rows;
}

/**
 * Identity a thread's expanded/collapsed state is remembered under. The parent's seq
 * survives the transcript being rebuilt from entries after a turn settles, which message
 * object identity does not — so the thread the human just sent into stays open across the
 * refresh that ends its turn. A user message with no seq yet is the one just typed and not
 * round-tripped; there is only ever one of those, at the tail, so a shared sentinel is
 * unambiguous.
 */
export const UNSENT_THREAD_KEY = -1;

export function threadKeyFor(message: ThreadableMessage | undefined): number {
  return typeof message?.seq === "number" ? message.seq : UNSENT_THREAD_KEY;
}

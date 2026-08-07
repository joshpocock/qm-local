/**
 * Turning a transcript into threads: the human's message is the parent, and the
 * assistant replies that answered it hang underneath it instead of running on as siblings.
 *
 * Originally room-only, because rooms were the only place core stamped a final assistant
 * entry's `parentSeq` at the human turn it answered rather than at the previous activity
 * entry. Core now does this in every session, so the grouping runs everywhere — a 1:1 chat
 * gets the same "N replies" affordance a room does, once its entries carry that shape.
 *
 * Kept free of DOM/Lit imports so the rule itself is unit-testable, and deliberately
 * conservative — the grouping is a *view* over the same message array the flat transcript
 * renders, so every message still appears exactly once, in `index` order, whether or not
 * it ended up inside a thread.
 *
 * Two things gate it, and either failing degrades to today's flat run:
 *
 * - **Only when the parent is on screen.** A reply whose `parentSeq` does not resolve to a
 *   user message already rendered above it stays where it is, as its own row. That covers
 *   old transcripts (their final assistant entry's `parentSeq` points at the previous
 *   activity entry, not at the human turn, so it never matches a user row and the message
 *   renders exactly as it always has), a thread paged so the parent is above the window, and
 *   anything core has not stamped yet. A reply never disappears.
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
  /** Index of the streaming partial, when one is being rendered. */
  liveIndex?: number | null;
}

/** Both roles the composer and the transcript use for a human turn. */
export function isUserRole(role: string | undefined): boolean {
  return role === "user" || role === "user-with-attachments";
}

/**
 * The parent a message *deliberately* names, or null.
 *
 * Core stamps every entry with `parentSeq = seq - 1` unless it is told otherwise, so a
 * `parentSeq` pointing at the entry immediately before is the default chain rather than a
 * link anyone chose. That only matters for a human turn: an assistant's final entry is
 * always separated from the turn it answers by the activity entries of the run, so its
 * `parentSeq` naming a user row is meaningful, while two messages typed back to back would
 * otherwise read as one replying into the other's thread.
 *
 * Where the two genuinely coincide — a reply typed into a thread whose root happens to be
 * the entry right before it — this reads as flat. That is the safe way to be wrong: the
 * message renders in the transcript instead of only inside a panel.
 */
export function threadParentSeq(message: ThreadableMessage): number | null {
  const parentSeq = message.parentSeq;
  if (typeof parentSeq !== "number") return null;
  if (isUserRole(message.role) && typeof message.seq === "number" && parentSeq === message.seq - 1) return null;
  return parentSeq;
}

export function groupRoomTranscript(
  messages: readonly ThreadableMessage[],
  opts: GroupOptions = {},
): TranscriptRow[] {
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
      // A human turn typed *into* a thread belongs to the thread, not to the transcript: it
      // folds into the root's row rather than opening a row of its own, and its own seq is
      // registered against that same row so the answer it draws lands there too. That is
      // what turns a thread from a fan into a chain — root ← reply ← answer ← reply — while
      // the transcript still shows exactly one entry point for the whole of it.
      const link = threadParentSeq(message);
      const root = link === null ? undefined : userRowBySeq.get(link);
      if (root && root.index < index) {
        root.replies.push(index);
        if (typeof message.seq === "number" && !userRowBySeq.has(message.seq)) userRowBySeq.set(message.seq, root);
        lastUserRow = root;
        continue;
      }
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
 * Everything that belongs to the thread rooted at `rootIndex`, in seq order, root excluded.
 *
 * The panel asks this rather than reading `TranscriptRow.replies` because the two answer
 * slightly different questions and only one of them is the panel's: `groupRoomTranscript`
 * decides *where a row draws*, and is built in one pass while it walks the array, whereas
 * this walks each candidate's parent chain to the end. Both agree on the same rule — a
 * message is in the thread when its chain of deliberate parents (see `threadParentSeq`)
 * reaches the root — so the count on the affordance and the body of the panel cannot drift.
 *
 * Two guards, both structural rather than defensive:
 *
 * - **Backwards only.** Every hop must land on a strictly earlier message. A `parentSeq`
 *   naming a later message, or the message itself, ends the walk rather than following it,
 *   which is also what makes a cycle impossible: the index strictly decreases each step, so
 *   a transcript whose entries point at each other terminates instead of spinning.
 * - **Only what the root can reach.** A message joins on the hop that lands on something
 *   already known to be in the thread, so an unrelated chain that happens to pass nearby is
 *   never swept in.
 *
 * The in-flight reply is the same exception it is in `groupRoomTranscript`, for the same
 * reason: it is a client-side partial with no seq to chain from, so it is attached by
 * position instead, to the last human turn above it — which is by construction the turn it
 * is answering, and therefore in this thread exactly when that turn is.
 */
export function threadMembers(
  messages: readonly ThreadableMessage[],
  rootIndex: number,
  opts: GroupOptions = {},
): number[] {
  const root = messages[rootIndex];
  if (!root || !isUserRole(root.role)) return [];
  const liveIndex = typeof opts.liveIndex === "number" ? opts.liveIndex : null;
  const indexBySeq = new Map<number, number>();
  for (let i = 0; i < messages.length; i++) {
    const seq = messages[i]!.seq;
    // First writer wins, for the same reason `groupRoomTranscript` does it.
    if (typeof seq === "number" && !indexBySeq.has(seq)) indexBySeq.set(seq, i);
  }
  const inThread = new Set<number>([rootIndex]);
  const members: number[] = [];
  let lastUser = rootIndex;
  for (let index = rootIndex + 1; index < messages.length; index++) {
    if (index === liveIndex) {
      if (inThread.has(lastUser)) {
        inThread.add(index);
        members.push(index);
      }
      continue;
    }
    let at = index;
    for (;;) {
      const link = threadParentSeq(messages[at]!);
      if (link === null) break;
      const parent = indexBySeq.get(link);
      if (parent === undefined || parent >= at) break;
      if (inThread.has(parent)) {
        inThread.add(index);
        members.push(index);
        break;
      }
      at = parent;
    }
    if (isUserRole(messages[index]!.role)) lastUser = index;
  }
  members.sort((a, b) => {
    const left = messages[a]!.seq;
    const right = messages[b]!.seq;
    // A seq-less member is a client-side partial, which belongs after everything settled;
    // array order already puts it there, so fall through to it rather than guessing.
    if (typeof left === "number" && typeof right === "number" && left !== right) return left - right;
    return a - b;
  });
  return members;
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

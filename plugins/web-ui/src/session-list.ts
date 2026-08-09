import { sharedContextLabel, type CoreContext, type CoreProject, type CoreSession } from "./core-bridge.ts";

type ProjectAwareContext = CoreContext & { project?: CoreProject };

type RecentGroupKind = "personal" | "project" | "channel" | "group";

export interface RecentProjectSeed {
  scopeId: string;
  name: string | null;
  kind?: RecentGroupKind;
}

export type RecentItem =
  | { kind: "session"; session: CoreSession }
  | { kind: "project"; scopeId: string; name: string | null; groupKind: RecentGroupKind; sessions: CoreSession[] };

export function activityOf(s: CoreSession): number {
  return s.lastActivityAt ?? s.createdAt;
}

/**
 * Which surface a session's threadRef belongs to. Lives here (rather than in sessions.ts,
 * which imports from this module) so splitSlack and other list-partitioning helpers can use
 * it without creating an import cycle; sessions.ts re-exports it as the one public entry
 * point everyone else imports from.
 */
export function surfaceOf(s: Pick<CoreSession, "threadRef">): string {
  if (s.threadRef.startsWith("web:")) return "web";
  if (s.threadRef.startsWith("dm:") || s.threadRef.startsWith("ch:")) return "slack";
  return "core";
}

/**
 * Whether a row is a Slack conversation only its participants can read.
 *
 * A channel row says what it is on its own — the title is `#general` — but a DM or group DM
 * row carries a name that looks exactly like any other chat's, so the one thing worth
 * knowing before opening it is invisible. Slack-only on purpose: "private" is a fact about
 * a workspace's visibility rules, and saying it about a web chat would be noise at best.
 */
export function isPrivateSlackRow(s: Pick<CoreSession, "threadRef" | "type">): boolean {
  return surfaceOf(s) === "slack" && (s.type === "dm" || s.type === "group");
}

export type ChatBrowseStatus = "active" | "waiting" | "archived";

export function splitPinned<T extends Pick<CoreSession, "pinned">>(sessions: readonly T[]): { pinned: T[]; rest: T[] } {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const s of sessions) (s.pinned ? pinned : rest).push(s);
  return { pinned, rest };
}

/**
 * What makes a row belong under Rooms rather than Chats: a roster with someone in it.
 * A `room` of `null` (core cleared it) or an empty roster is an ordinary chat — a room
 * nobody is in is not a room. A brand-new room has no server session yet, so the sidebar
 * row is stamped client-side at pick time (see `notePendingRoom`) and matches here too.
 */
export function isRoomSession(s: Pick<CoreSession, "room">): boolean {
  return Boolean(s.room?.personaIds?.length);
}

/**
 * Lifts rooms into their own section, exactly as `splitPinned` lifts pinned rows. Both
 * halves keep the order they came in with, so the caller's recency sort still holds.
 *
 * Slack-surface rows are deliberately *not* lifted, however many personas their roster
 * carries. A Slack room panel is one session per thread, so five debate threads in one
 * channel would otherwise appear five times under Rooms *and* again under their channel in
 * the Slack section. Slack sessions have exactly one home — the Slack section, under the
 * channel they live in — and `splitSlack` puts them there.
 */
export function splitRooms<T extends Pick<CoreSession, "room" | "threadRef">>(
  sessions: readonly T[],
): { rooms: T[]; rest: T[] } {
  const rooms: T[] = [];
  const rest: T[] = [];
  for (const s of sessions) (isRoomSession(s) && surfaceOf(s) !== "slack" ? rooms : rest).push(s);
  return { rooms, rest };
}

/**
 * Lifts Slack-mirrored sessions into their own section, exactly as `splitRooms` lifts rooms.
 * Slack sessions have their own home in the sidebar now, so they never fall through to the
 * generic date/project buckets. Both halves keep the order they came in with, so the
 * caller's recency sort still holds.
 */
export function splitSlack<T extends Pick<CoreSession, "threadRef">>(sessions: readonly T[]): { slack: T[]; rest: T[] } {
  const slack: T[] = [];
  const rest: T[] = [];
  for (const s of sessions) (surfaceOf(s) === "slack" ? slack : rest).push(s);
  return { slack, rest };
}

/**
 * The Slack channel a thread-session belongs to, or `null` for anything that is not one.
 *
 * A channel thread's `threadRef` is `ch:<CHANNELID>:<rootTs>` — the channel id is the middle
 * segment, and it is the only part two threads of the same channel share. DMs (`dm:<ID>`)
 * are not channels and return `null`, which is what keeps them rendering flat.
 */
export function slackChannelIdOf(threadRef: string): string | null {
  if (!threadRef.startsWith("ch:")) return null;
  const end = threadRef.indexOf(":", 3);
  return (end === -1 ? threadRef.slice(3) : threadRef.slice(3, end)) || null;
}

export type SlackListItem =
  | { kind: "session"; session: CoreSession }
  | { kind: "channel"; channelId: string; name: string | null; sessions: CoreSession[] };

/**
 * Whether a Slack channel is private, per the workspace directory `/api/contexts` already
 * syncs into the client (`contextsFor` in `src/api/app-helpers.ts` mints the scope id
 * `channel:<CHANNELID>` from the same raw Slack channel id `slackChannelIdOf` reads out of a
 * `ch:` threadRef, so the two join with no format translation needed).
 *
 * Absent contexts — not yet loaded, or a channel the viewer's directory sync hasn't surfaced
 * — read as "unknown", not "public": the heading shows no chip rather than asserting the
 * wrong one.
 */
export function isPrivateSlackChannel(
  channelId: string,
  contexts: readonly Pick<CoreContext, "scopeId" | "isPrivate">[],
): boolean {
  return contexts.find((c) => c.scopeId === `channel:${channelId}`)?.isPrivate === true;
}

/**
 * Reshapes a flat Slack list into the shape Slack itself has: the channel is the room, and
 * the threads inside it are where the context lives. Five test threads in `#general` become
 * one `#general` heading with five children instead of five near-identical sidebar rows.
 *
 * Built exactly like `groupProjectSessions`: the input is sorted newest-first once, a
 * channel takes the list position of its newest thread, and children are appended in that
 * same order — so channels sort by the most recent activity of any child, and children sort
 * newest-first, with no second pass. DMs carry no channel and stay where they fall, so they
 * interleave with the channel headings by recency exactly as they did when every Slack row
 * was flat.
 */
export function groupSlackChannels(sessions: readonly CoreSession[]): SlackListItem[] {
  const channels = new Map<string, Extract<SlackListItem, { kind: "channel" }>>();
  const items: SlackListItem[] = [];
  for (const session of [...sessions].sort((a, b) => activityOf(b) - activityOf(a))) {
    const channelId = slackChannelIdOf(session.threadRef);
    if (!channelId) {
      items.push({ kind: "session", session });
      continue;
    }
    let channel = channels.get(channelId);
    if (!channel) {
      channel = { kind: "channel", channelId, name: null, sessions: [] };
      channels.set(channelId, channel);
      items.push(channel);
    }
    channel.sessions.push(session);
    // The newest thread that knows the channel's name wins; a thread mirrored before the
    // name was resolved carries none, and the heading falls back to the bare id.
    if (!channel.name) {
      const name = session.channelName?.trim().replace(/^#/, "");
      if (name) channel.name = name;
    }
  }
  return items;
}

export function chatBrowseStatusMatches(
  session: Pick<CoreSession, "archived" | "awaitingInput">,
  status: ChatBrowseStatus,
): boolean {
  if (status === "archived") return Boolean(session.archived);
  if (session.archived) return false;
  return status === "waiting" ? Boolean(session.awaitingInput) : !session.awaitingInput;
}

export function recentProjectSeeds(contexts: readonly ProjectAwareContext[]): RecentProjectSeed[] {
  return contexts.map((context): RecentProjectSeed => {
    if (context.project)
      return { scopeId: context.scopeId, name: context.project.name.trim() || null, kind: "project" };
    if (context.kind === "personal") return { scopeId: context.scopeId, name: "Personal", kind: "personal" };
    if (context.kind === "group")
      return { scopeId: context.scopeId, name: sharedContextLabel(context.scopeId, context.name), kind: "group" };
    return { scopeId: context.scopeId, name: sharedContextLabel(context.scopeId, context.name), kind: "channel" };
  });
}

export function groupProjectSessions(
  sessions: readonly CoreSession[],
  projectSeeds: readonly RecentProjectSeed[],
): RecentItem[] {
  const seeds = new Map(projectSeeds.map((seed) => [seed.scopeId, seed]));
  const projects = new Map<string, Extract<RecentItem, { kind: "project" }>>();
  const items: RecentItem[] = [];
  for (const session of [...sessions].sort((a, b) => activityOf(b) - activityOf(a))) {
    const seed = seeds.get(session.scopeId);
    if (!seed) {
      items.push({ kind: "session", session });
      continue;
    }
    let project = projects.get(session.scopeId);
    if (!project) {
      project = {
        kind: "project",
        scopeId: session.scopeId,
        name: seed.name,
        groupKind: seed.kind ?? "project",
        sessions: [],
      };
      projects.set(session.scopeId, project);
      items.push(project);
    }
    project.sessions.push(session);
  }
  for (const seed of projectSeeds) {
    if (projects.has(seed.scopeId)) continue;
    const kind = seed.kind ?? "project";
    if (kind === "channel" || kind === "group") continue;
    items.push({ kind: "project", scopeId: seed.scopeId, name: seed.name, groupKind: kind, sessions: [] });
  }
  return items;
}

export function recencyGroup(ms: number, now = Date.now()): string {
  const d = new Date(now);
  const dayStart = (back: number): number => new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
  if (ms >= dayStart(0)) return "Today";
  if (ms >= dayStart(1)) return "Yesterday";
  if (ms >= dayStart(6)) return "Previous 7 days";
  if (ms >= dayStart(29)) return "Previous 30 days";
  return "Older";
}

export function withPendingSession(list: CoreSession[], pending: CoreSession): CoreSession[] {
  return [pending, ...list.filter((s) => s.threadRef !== pending.threadRef)];
}

export function withoutUnsentPending(list: CoreSession[], threadRef: string): CoreSession[] {
  return list.filter((s) => s.id !== "" || s.threadRef !== threadRef);
}

export function bumpActivity(list: CoreSession[], threadRef: string, at: number): CoreSession[] {
  return list.map((s) => (s.threadRef === threadRef ? { ...s, lastActivityAt: at } : s));
}

export function reconcileSessions(server: CoreSession[], prev: CoreSession[]): CoreSession[] {
  const known = new Set(server.map((s) => s.threadRef));
  const pending = prev.filter((s) => !s.id && !known.has(s.threadRef));
  return [...pending, ...server];
}

export function markWorking(list: CoreSession[], threadRef: string): CoreSession[] {
  return list.map((s) => (s.threadRef === threadRef ? { ...s, working: true } : s));
}

export function clearWorking(list: CoreSession[], threadRef: string): CoreSession[] {
  return list.map((s) => (s.threadRef === threadRef ? { ...s, working: false } : s));
}

export type SessionRow = CoreSession & { stateAt?: number };

export interface SessionStateDelta {
  threadRef: string;
  state: "working" | "awaiting_approval" | "idle";
  at?: number;
}

export function applySessionState(
  list: SessionRow[],
  delta: SessionStateDelta,
): { list: SessionRow[]; matched: boolean } {
  let matched = false;
  const next = list.map((s) => {
    if (s.threadRef !== delta.threadRef) return s;
    matched = true;
    if (delta.at !== undefined && s.stateAt !== undefined && delta.at < s.stateAt) return s;
    return {
      ...s,
      working: delta.state === "working",
      awaitingInput: delta.state === "awaiting_approval",
      ...(delta.at !== undefined ? { stateAt: delta.at } : {}),
    };
  });
  return { list: matched ? next : list, matched };
}

export interface RowIndicators {
  working: boolean;
  awaiting: boolean;
  background: { jobs: number; watches: number; label: string } | null;
}

export function backgroundLabel(
  jobs: number,
  watches: number,
): { jobs: number; watches: number; label: string } | null {
  const parts: string[] = [];
  if (jobs > 0) parts.push(`${jobs} background job${jobs === 1 ? "" : "s"} running`);
  if (watches > 0) parts.push(`${watches} watch${watches === 1 ? "" : "es"} armed`);
  return parts.length ? { jobs, watches, label: parts.join(" · ") } : null;
}

export function rowIndicators(s: CoreSession, liveThreads: ReadonlySet<string> | string | null): RowIndicators {
  const live = typeof liveThreads === "string" ? new Set([liveThreads]) : (liveThreads ?? new Set<string>());
  return {
    working: Boolean(s.working) || (Boolean(s.threadRef) && live.has(s.threadRef)),
    awaiting: Boolean(s.awaitingInput),
    background: backgroundLabel(s.backgroundJobs ?? 0, s.watches ?? 0),
  };
}

export function conversationBackground(
  list: CoreSession[],
  sessionId: string | null,
  threadRef: string | null,
): RowIndicators["background"] {
  const row = list.find((s) => (sessionId ? s.id === sessionId : Boolean(threadRef) && s.threadRef === threadRef));
  return row ? rowIndicators(row, null).background : null;
}

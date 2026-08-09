import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activityOf,
  applySessionState,
  bumpActivity,
  chatBrowseStatusMatches,
  clearWorking,
  groupProjectSessions,
  groupSlackChannels,
  isPrivateSlackChannel,
  isPrivateSlackRow,
  isRoomSession,
  slackChannelIdOf,
  splitRooms,
  splitSlack,
  surfaceOf,
  backgroundLabel,
  conversationBackground,
  markWorking,
  recencyGroup,
  rowIndicators,
  recentProjectSeeds,
  reconcileSessions,
  splitPinned,
  withPendingSession,
  withoutUnsentPending,
} from "../src/session-list.ts";
import type { CoreContext, CoreSession } from "../src/core-bridge.ts";

function pending(threadRef: string): CoreSession {
  return {
    id: "",
    type: "dm",
    scopeId: "",
    threadRef,
    createdAt: Date.now(),
    title: null,
    channelName: null,
    archived: false,
  };
}
function saved(id: string, threadRef: string, title: string | null = null): CoreSession {
  return { id, type: "dm", scopeId: "", threadRef, createdAt: 1, title, channelName: null, archived: false };
}

test("chat browse statuses are mutually exclusive and working does not mean waiting", () => {
  const active = { ...saved("active", "web:u:active"), working: true };
  const waiting = { ...saved("waiting", "web:u:waiting"), awaitingInput: true };
  const archived = { ...saved("archived", "web:u:archived"), archived: true, awaitingInput: true };
  assert.deepEqual(
    [active, waiting, archived]
      .filter((session) => chatBrowseStatusMatches(session, "active"))
      .map((session) => session.id),
    ["active"],
  );
  assert.deepEqual(
    [active, waiting, archived]
      .filter((session) => chatBrowseStatusMatches(session, "waiting"))
      .map((session) => session.id),
    ["waiting"],
  );
  assert.deepEqual(
    [active, waiting, archived]
      .filter((session) => chatBrowseStatusMatches(session, "archived"))
      .map((session) => session.id),
    ["archived"],
  );
});

test("splitPinned lifts pinned rows out in order and leaves the rest untouched", () => {
  const a = saved("a", "web:u:a");
  const b = { ...saved("b", "web:u:b"), pinned: true };
  const c = saved("c", "web:u:c");
  const d = { ...saved("d", "web:u:d"), pinned: true };
  const { pinned, rest } = splitPinned([a, b, c, d]);
  assert.deepEqual(
    pinned.map((s) => s.id),
    ["b", "d"],
    "pinned rows keep their relative (recency) order",
  );
  assert.deepEqual(
    rest.map((s) => s.id),
    ["a", "c"],
  );
  assert.deepEqual(splitPinned([]).pinned, []);
  assert.deepEqual(
    splitPinned([a]).rest.map((s) => s.id),
    ["a"],
  );
});

test("a session belongs under Rooms exactly when it carries a roster someone is in", () => {
  assert.equal(isRoomSession(saved("plain", "web:u:plain")), false, "an ordinary chat is not a room");
  assert.equal(isRoomSession({ ...saved("a", "web:u:a"), room: null }), false, "a cleared roster is not a room");
  assert.equal(
    isRoomSession({ ...saved("b", "web:u:b"), room: { personaIds: [], rounds: 1 } }),
    false,
    "a room nobody is in is not a room",
  );
  assert.equal(isRoomSession({ ...saved("c", "web:u:c"), room: { personaIds: ["ap_1"], rounds: 1 } }), true);
  assert.equal(
    isRoomSession({ ...pending("web:u:new"), room: { personaIds: ["ap_1", "ap_2"], rounds: 2 } }),
    true,
    "a brand-new room files under Rooms before its session exists",
  );
});

test("splitRooms lifts rooms out in order, exactly as splitPinned lifts pinned rows", () => {
  const a = saved("a", "web:u:a");
  const b = { ...saved("b", "web:u:b"), room: { personaIds: ["ap_1"], rounds: 1 } };
  const c = saved("c", "web:u:c");
  const d = { ...saved("d", "web:u:d"), room: { personaIds: ["ap_1", "ap_2"], rounds: 3 } };
  const { rooms, rest } = splitRooms([a, b, c, d]);
  assert.deepEqual(
    rooms.map((s) => s.id),
    ["b", "d"],
    "rooms keep their relative (recency) order",
  );
  assert.deepEqual(
    rest.map((s) => s.id),
    ["a", "c"],
    "and the chats they came from are otherwise untouched",
  );
  assert.deepEqual(splitRooms([]).rooms, []);
  assert.deepEqual(
    splitRooms([a]).rest.map((s) => s.id),
    ["a"],
  );
});

test("splitRooms never lifts a Slack room: it has one home, under its channel", () => {
  const webRoom = { ...saved("w", "web:u:w"), room: { personaIds: ["ap_1"], rounds: 1 } };
  const slackThreadRoom = { ...saved("t", "ch:C1:1.1"), room: { personaIds: ["ap_1", "ap_2"], rounds: 2 } };
  const slackDmRoom = { ...saved("d", "dm:D1"), room: { personaIds: ["ap_1"], rounds: 1 } };
  const { rooms, rest } = splitRooms([webRoom, slackThreadRoom, slackDmRoom]);
  assert.deepEqual(
    rooms.map((s) => s.id),
    ["w"],
    "only the web room is lifted",
  );
  assert.deepEqual(
    rest.map((s) => s.id),
    ["t", "d"],
    "the Slack rooms fall through to splitSlack, which files them under Slack — five debate threads in one channel must not also appear as five rows under Rooms",
  );
  // The two splits together must place every row exactly once.
  const { slack } = splitSlack(rest);
  assert.deepEqual(
    slack.map((s) => s.id),
    ["t", "d"],
  );
});

test("slackChannelIdOf reads the channel out of a thread ref, and only out of a thread ref", () => {
  assert.equal(slackChannelIdOf("ch:C0GENERAL:1712345678.000100"), "C0GENERAL");
  assert.equal(slackChannelIdOf("ch:C0GENERAL"), "C0GENERAL", "a channel ref with no root ts is still that channel");
  assert.equal(slackChannelIdOf("dm:D0PRIVATE"), null, "a DM is not a channel");
  assert.equal(slackChannelIdOf("web:u:a"), null);
  assert.equal(slackChannelIdOf("core:u:a"), null);
  assert.equal(slackChannelIdOf("ch::1712345678.000100"), null, "a ref with no channel id groups nothing");
});

function slackThread(id: string, channelId: string, ts: string, at: number, channelName: string | null): CoreSession {
  return {
    ...saved(id, `ch:${channelId}:${ts}`),
    type: "channel",
    channelName,
    lastActivityAt: at,
  };
}

test("groupSlackChannels nests threads under their channel, newest channel and newest thread first", () => {
  // Deliberately shuffled on the way in: grouping must impose the order, not inherit it.
  const items = groupSlackChannels([
    slackThread("g1", "C0GEN", "1.1", 10, "general"),
    slackThread("r2", "C0RND", "2.2", 40, "#random"),
    slackThread("g3", "C0GEN", "1.3", 30, "general"),
    slackThread("r1", "C0RND", "2.1", 20, "#random"),
    slackThread("g2", "C0GEN", "1.2", 50, "general"),
  ]);
  assert.deepEqual(
    items.map((item) => (item.kind === "channel" ? `#${item.name}` : item.session.id)),
    ["#general", "#random"],
    "two channels, each once — #general leads because its newest thread (50) beats #random's (40)",
  );
  const [general, random] = items as Array<Extract<(typeof items)[number], { kind: "channel" }>>;
  assert.deepEqual(
    general.sessions.map((s) => s.id),
    ["g2", "g3", "g1"],
    "children are newest-first within the channel",
  );
  assert.deepEqual(
    random.sessions.map((s) => s.id),
    ["r2", "r1"],
  );
  assert.equal(general.channelId, "C0GEN");
  assert.equal(random.name, "random", "the stored name is bare; the '#' is the heading's to draw");
});

test("groupSlackChannels leaves DMs flat, interleaved with channels by recency", () => {
  const dm = { ...saved("dm1", "dm:D0BOSS"), lastActivityAt: 35 };
  const items = groupSlackChannels([
    slackThread("g1", "C0GEN", "1.1", 50, "general"),
    dm,
    slackThread("r1", "C0RND", "2.1", 20, "random"),
  ]);
  assert.deepEqual(
    items.map((item) => (item.kind === "channel" ? `channel:${item.name}` : `session:${item.session.id}`)),
    ["channel:general", "session:dm1", "channel:random"],
    "a DM keeps its own top-level row and its place in the recency order",
  );
  const flat = items.find((item) => item.kind === "session");
  assert.equal(flat?.kind === "session" && flat.session, dm, "and it is the very same session object, untouched");
});

test("groupSlackChannels: a DM that knows its counterpart is still not a channel", () => {
  // A DM now carries a name in `channelName` — the person it is with — and QM models a DM as
  // one continuous session, so there are no sub-threads to fold under a heading. The name is
  // for the row's title only; grouping keys off the `ch:` thread ref and must ignore it.
  const dm = { ...saved("dm1", "dm:D0BOSS"), channelName: "qm-cc", lastActivityAt: 35 };
  const items = groupSlackChannels([slackThread("g1", "C0GEN", "1.1", 50, "general"), dm]);
  assert.deepEqual(
    items.map((item) => (item.kind === "channel" ? `channel:${item.name}` : `session:${item.session.id}`)),
    ["channel:general", "session:dm1"],
  );
  assert.equal(slackChannelIdOf(dm.threadRef), null, "a DM ref names no channel to group under");
});

test("groupSlackChannels: one thread still gets a channel heading, and an empty list gets nothing", () => {
  // A lone thread is grouped too: the heading is what says which channel it is, and a second
  // thread arriving must not reshuffle the row it is already sitting in.
  const items = groupSlackChannels([slackThread("g1", "C0GEN", "1.1", 10, "general")]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "channel");
  assert.deepEqual(groupSlackChannels([]), []);
});

test("groupSlackChannels falls back to the bare channel id when no thread knows the name", () => {
  const items = groupSlackChannels([
    slackThread("g1", "C0GEN", "1.1", 10, null),
    slackThread("g2", "C0GEN", "1.2", 20, "  "),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind === "channel" && items[0]!.name, null, "null name, so the heading shows the id");
  // A later thread that does know the name is enough for the whole group.
  const named = groupSlackChannels([
    slackThread("g1", "C0GEN", "1.1", 10, "general"),
    slackThread("g2", "C0GEN", "1.2", 20, null),
  ]);
  assert.equal(named[0]!.kind === "channel" && named[0]!.name, "general");
});

test("surfaceOf classifies by threadRef prefix", () => {
  assert.equal(surfaceOf({ threadRef: "web:u:a" }), "web");
  assert.equal(surfaceOf({ threadRef: "dm:u:a" }), "slack");
  assert.equal(surfaceOf({ threadRef: "ch:general:a" }), "slack");
  assert.equal(surfaceOf({ threadRef: "core:u:a" }), "core");
});

test("splitSlack lifts Slack-surface rows out in order, exactly as splitRooms lifts rooms", () => {
  const a = saved("a", "web:u:a");
  const b = saved("b", "dm:u:b");
  const c = saved("c", "web:u:c");
  const d = saved("d", "ch:general:d");
  const { slack, rest } = splitSlack([a, b, c, d]);
  assert.deepEqual(
    slack.map((s) => s.id),
    ["b", "d"],
    "slack rows keep their relative (recency) order",
  );
  assert.deepEqual(
    rest.map((s) => s.id),
    ["a", "c"],
    "and the web/core chats they came from are otherwise untouched",
  );
  assert.deepEqual(splitSlack([]).slack, []);
  assert.deepEqual(
    splitSlack([a]).rest.map((s) => s.id),
    ["a"],
  );
});

test("isPrivateSlackRow: only a Slack DM or group DM is private", () => {
  assert.equal(isPrivateSlackRow({ threadRef: "dm:u:b", type: "dm" }), true);
  assert.equal(isPrivateSlackRow({ threadRef: "dm:u:b", type: "group" }), true);
  assert.equal(isPrivateSlackRow({ threadRef: "ch:general:d", type: "channel" }), false, "#general says so itself");
  // A web chat is private too, in the ordinary sense — but saying so on every row would
  // make the word mean nothing where it matters.
  assert.equal(isPrivateSlackRow({ threadRef: "web:u:a", type: "dm" }), false);
  assert.equal(isPrivateSlackRow({ threadRef: "core:u:a", type: "group" }), false);
});

function context(scopeId: string, isPrivate?: boolean): CoreContext {
  return {
    scopeId,
    kind: "channel",
    name: null,
    sessionCount: 0,
    lastActivityAt: null,
    ...(isPrivate !== undefined ? { isPrivate } : {}),
  };
}

test("isPrivateSlackChannel: joins the channel id out of a threadRef against its /api/contexts scope", () => {
  const contexts = [context("channel:C0GEN", true), context("channel:C0RND", false), context("channel:C0NOFLAG")];
  assert.equal(isPrivateSlackChannel("C0GEN", contexts), true, "isPrivate:true on the matching scope locks the heading");
  assert.equal(isPrivateSlackChannel("C0RND", contexts), false, "isPrivate:false is an explicit public channel");
  assert.equal(
    isPrivateSlackChannel("C0NOFLAG", contexts),
    false,
    "a matching scope with isPrivate absent reads as not private, not as unknown-but-locked",
  );
  assert.equal(isPrivateSlackChannel("C0GEN", []), false, "contexts not loaded yet -> no chip, not a false positive");
  assert.equal(
    isPrivateSlackChannel("C0MISSING", contexts),
    false,
    "a channel id with no matching scope (id mismatch) -> no chip",
  );
});

test("a Slack DM row wears the lock chip, and says 'private' to a screen reader", () => {
  // sessions.ts renders through lit against the DOM, so its wiring is asserted on source.
  const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
  const mark = sessions.slice(sessions.indexOf("function privateMark"));
  const body = mark.slice(0, mark.indexOf("\n}\n"));
  assert.match(body, /if \(!isPrivateSlackRow\(s\)\) return nothing;/, "one rule, shared with the list helper");
  assert.match(body, /class="private-chip"/);
  assert.match(body, /\$\{icon\(Lock, 10\)\}/, "reusing the Lock the read-only mark already imports");
  assert.match(body, /<span>Private<\/span>/);
  assert.match(sessions, /\$\{statusMarks\(s\)\}\$\{surfaceGlyph\(s\)\}\$\{privateMark\(s\)\}/, "prefixing the title");
  assert.match(sessions, /isPrivateSlackRow\(s\) \? "private" : null,/, "and named in the row's aria-label");
});

test("a second New chat keeps the first pending row (both show in Recents)", () => {
  let list: CoreSession[] = [];
  list = withPendingSession(list, pending("web:u:a"));
  list = withPendingSession(list, pending("web:u:b"));
  assert.deepEqual(
    list.map((s) => s.threadRef),
    ["web:u:b", "web:u:a"],
  );
});

test("re-adding the same threadRef dedupes rather than duplicating", () => {
  let list: CoreSession[] = [saved("1", "web:u:x")];
  list = withPendingSession(list, pending("web:u:a"));
  list = withPendingSession(list, pending("web:u:a"));
  assert.equal(list.filter((s) => s.threadRef === "web:u:a").length, 1);
  assert.equal(list.length, 2);
});

test("reconcile keeps saved sessions and re-adds unsent pending chats", () => {
  const prev = [pending("web:u:a"), pending("web:u:b"), saved("1", "web:u:x")];
  const server = [saved("1", "web:u:x")];
  const out = reconcileSessions(server, prev);
  assert.deepEqual(new Set(out.map((s) => s.threadRef)), new Set(["web:u:a", "web:u:b", "web:u:x"]));
});

test("reconcile drops a pending chat once the server knows its threadRef", () => {
  const prev = [pending("web:u:a")];
  const server = [saved("9", "web:u:a", "Bubble waffle order")];
  const out = reconcileSessions(server, prev);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, "9");
  assert.equal(out[0]!.title, "Bubble waffle order");
});

test("reconcile against an empty prev is just the server list", () => {
  const server = [saved("1", "web:u:x"), saved("2", "web:u:y")];
  assert.deepEqual(reconcileSessions(server, []), server);
});

test("bumpActivity stamps lastActivityAt on the matching row only", () => {
  const list = [saved("1", "web:u:x"), saved("2", "web:u:y")];
  const out = bumpActivity(list, "web:u:y", 12345);
  assert.equal(out.find((s) => s.threadRef === "web:u:y")!.lastActivityAt, 12345);
  assert.equal(out.find((s) => s.threadRef === "web:u:x")!.lastActivityAt, undefined, "other rows untouched");
});

test("bumpActivity is a no-op when no row matches the threadRef", () => {
  const list = [saved("1", "web:u:x")];
  assert.deepEqual(bumpActivity(list, "web:u:missing", 999), list);
});

test("activityOf prefers lastActivityAt, falling back to createdAt", () => {
  assert.equal(activityOf(saved("1", "web:u:x")), 1, "no lastActivityAt -> createdAt (createdAt is 1 here)");
  assert.equal(activityOf({ ...saved("2", "web:u:y"), lastActivityAt: 999 }), 999, "lastActivityAt wins when present");
});

test("activityOf orders a context's conversations by recency, not creation", () => {
  const old = { ...saved("1", "web:u:old"), createdAt: 200 };
  const active = { ...saved("2", "web:u:active"), createdAt: 100, lastActivityAt: 500 };
  const ranked = [old, active].sort((a, b) => activityOf(b) - activityOf(a));
  assert.deepEqual(
    ranked.map((s) => s.threadRef),
    ["web:u:active", "web:u:old"],
    "most-recently-active first",
  );
});

test("withoutUnsentPending drops only the empty-id twin for the threadRef", () => {
  const list = [pending("web:u:a"), saved("1", "web:u:x")];
  const out = withoutUnsentPending(list, "web:u:a");
  assert.deepEqual(
    out.map((s) => s.threadRef),
    ["web:u:x"],
  );
});

test("withoutUnsentPending never removes a real server-backed row", () => {
  const list = [saved("9", "web:u:a")];
  assert.deepEqual(withoutUnsentPending(list, "web:u:a"), list);
});

test("withoutUnsentPending is a no-op for an unknown threadRef", () => {
  const list = [pending("web:u:a")];
  assert.deepEqual(withoutUnsentPending(list, "web:u:zzz"), list);
});

test("applySessionState: working lights the dot on the matching row only", () => {
  const list = [saved("1", "web:u:x"), saved("2", "web:u:y")];
  const { list: out, matched } = applySessionState(list, { threadRef: "web:u:y", state: "working" });
  assert.equal(matched, true);
  assert.equal(out.find((s) => s.threadRef === "web:u:y")!.working, true);
  assert.equal(out.find((s) => s.threadRef === "web:u:x")!.working, undefined, "other rows untouched");
});

test("applySessionState: awaiting_approval swaps the working dot for the amber dot", () => {
  const list = [{ ...saved("1", "web:u:x"), working: true }];
  const { list: out } = applySessionState(list, { threadRef: "web:u:x", state: "awaiting_approval" });
  assert.equal(out[0]!.working, false);
  assert.equal(out[0]!.awaitingInput, true);
});

test("applySessionState: idle clears both dots", () => {
  const list = [{ ...saved("1", "web:u:x"), working: true, awaitingInput: true }];
  const { list: out } = applySessionState(list, { threadRef: "web:u:x", state: "idle" });
  assert.equal(out[0]!.working, false);
  assert.equal(out[0]!.awaitingInput, false);
});

test("applySessionState: an unknown threadRef reports matched:false and leaves the list identical", () => {
  const list = [saved("1", "web:u:x")];
  const { list: out, matched } = applySessionState(list, { threadRef: "web:u:missing", state: "working" });
  assert.equal(matched, false);
  assert.equal(out, list, "caller heals by re-snapshotting; the list object is untouched");
});

test("applySessionState does not bump recency — lifecycle is not user activity", () => {
  const row = { ...saved("1", "web:u:x"), lastActivityAt: 1111 };
  const { list: out } = applySessionState([row], { threadRef: "web:u:x", state: "idle" });
  assert.equal(activityOf(out[0]!), 1111);
});

test("applySessionState: an out-of-order (older `at`) frame is ignored — last state wins by timestamp", () => {
  let list: CoreSession[] = [saved("1", "web:u:x")];
  ({ list } = applySessionState(list, { threadRef: "web:u:x", state: "idle", at: 200 }));
  const { list: out, matched } = applySessionState(list, { threadRef: "web:u:x", state: "working", at: 100 });
  assert.equal(matched, true, "the row exists — no heal snapshot needed");
  assert.equal(out[0]!.working, false, "the stale working frame is dropped");
});

test("applySessionState: frames without `at` (and rows fresh from a snapshot) still apply", () => {
  let list: CoreSession[] = [saved("1", "web:u:x")];
  ({ list } = applySessionState(list, { threadRef: "web:u:x", state: "idle", at: 200 }));
  const { list: out } = applySessionState(list, { threadRef: "web:u:x", state: "working" });
  assert.equal(out[0]!.working, true, "an unstamped frame applies unconditionally");
});

test("reconcile replaces a pushed working state with server truth", () => {
  const { list: prev } = applySessionState([saved("1", "web:u:x")], { threadRef: "web:u:x", state: "working" });
  const out = reconcileSessions([saved("1", "web:u:x")], prev);
  assert.equal(out[0]!.working, undefined, "server row (no working flag) supersedes the pushed state");
});

test("markWorking stamps the matching row only", () => {
  const list = [saved("1", "web:u:x"), saved("2", "web:u:y")];
  const out = markWorking(list, "web:u:y");
  assert.equal(out.find((s) => s.threadRef === "web:u:y")!.working, true);
  assert.equal(out.find((s) => s.threadRef === "web:u:x")!.working, undefined, "other rows untouched");
});

test("markWorking is a no-op when no row matches", () => {
  const list = [saved("1", "web:u:x")];
  assert.deepEqual(markWorking(list, "web:u:missing"), list);
});

test("clearWorking clears only the matching row", () => {
  const list = [
    { ...saved("1", "web:u:x"), working: true },
    { ...saved("2", "web:u:y"), working: true },
  ];
  assert.deepEqual(
    clearWorking(list, "web:u:x").map((s) => s.working),
    [false, true],
  );
});

test("recencyGroup buckets by calendar day, then widening spans", () => {
  const now = new Date(2026, 6, 14, 15, 30).getTime();
  const day = 86_400_000;
  const midnight = new Date(2026, 6, 14, 0, 0).getTime();
  assert.equal(recencyGroup(now, now), "Today");
  assert.equal(recencyGroup(midnight, now), "Today", "first instant of today");
  assert.equal(recencyGroup(midnight - 1, now), "Yesterday", "last instant of yesterday");
  assert.equal(recencyGroup(midnight - day, now), "Yesterday");
  assert.equal(recencyGroup(midnight - day - 1, now), "Previous 7 days");
  assert.equal(recencyGroup(midnight - 6 * day, now), "Previous 7 days", "6 days back is still in the window");
  assert.equal(recencyGroup(midnight - 6 * day - 1, now), "Previous 30 days");
  assert.equal(recencyGroup(midnight - 29 * day, now), "Previous 30 days");
  assert.equal(recencyGroup(midnight - 29 * day - 1, now), "Older");
});

test("recencyGroup anchors boundaries to calendar days, not fixed 24h offsets", () => {
  const now = new Date(2026, 6, 14, 15, 30).getTime();
  assert.equal(recencyGroup(new Date(2026, 6, 13, 23, 59, 59).getTime(), now), "Yesterday");
  assert.equal(recencyGroup(new Date(2026, 6, 13, 0, 0).getTime(), now), "Yesterday");
  assert.equal(recencyGroup(new Date(2026, 6, 8, 0, 0).getTime(), now), "Previous 7 days");
  assert.equal(recencyGroup(new Date(2026, 6, 7, 23, 59, 59).getTime(), now), "Previous 30 days");
  assert.equal(recencyGroup(new Date(2026, 5, 15, 0, 0).getTime(), now), "Previous 30 days");
  assert.equal(recencyGroup(new Date(2026, 5, 14, 23, 59, 59).getTime(), now), "Older");
});

test("recencyGroup treats a future timestamp (optimistic bump) as Today", () => {
  const now = new Date(2026, 6, 14, 15, 30).getTime();
  assert.equal(recencyGroup(now + 60_000, now), "Today");
});

test("reconcile replaces an optimistic working stamp with server truth", () => {
  const prev = markWorking([saved("1", "web:u:x")], "web:u:x");
  const out = reconcileSessions([saved("1", "web:u:x")], prev);
  assert.equal(out[0]!.working, undefined, "server row (no working flag) supersedes the stamp");
});

test("project metadata groups only its group scope while ordinary chats stay flat", () => {
  const project = {
    scopeId: "group:web-project-p1",
    kind: "group" as const,
    name: "Launch",
    sessionCount: 2,
    lastActivityAt: 30,
    project: {
      id: "p1",
      name: "Launch",
      ownerId: "alice",
      memberIds: ["alice"],
      scopeId: "group:web-project-p1",
      members: [{ principalId: "alice", displayName: "Alice" }],
    },
  };
  const sessions = [
    { ...saved("1", "web:alice:p1-a"), type: "group" as const, scopeId: project.scopeId, lastActivityAt: 30 },
    { ...saved("2", "web:alice:plain"), lastActivityAt: 20 },
    { ...saved("3", "web:alice:p1-b"), type: "group" as const, scopeId: project.scopeId, lastActivityAt: 10 },
  ];
  const items = groupProjectSessions(sessions, recentProjectSeeds([project]));
  assert.equal(items[0]?.kind, "project");
  assert.deepEqual(items[0]?.kind === "project" ? items[0].sessions.map((session) => session.id) : [], ["1", "3"]);
  assert.equal(items[1]?.kind, "session");
});

test("empty projects appear in Recents", () => {
  const seeds = [{ scopeId: "group:web-project-empty", name: "Empty" }];
  const items = groupProjectSessions([], seeds);
  assert.deepEqual(items, [
    { kind: "project", scopeId: "group:web-project-empty", name: "Empty", groupKind: "project", sessions: [] },
  ]);
});

test("a pending (not-yet-sent) chat in a project scope nests under its project", () => {
  const seeds = [{ scopeId: "group:web-project-p1", name: "P1" }];
  const fresh = { ...pending("web:alice:new"), type: "group" as const, scopeId: seeds[0]!.scopeId };
  const list = withPendingSession([saved("1", "web:alice:old")], fresh);
  const items = groupProjectSessions(list, seeds);
  assert.equal(items[0]?.kind, "project");
  assert.deepEqual(items[0]?.kind === "project" ? items[0].sessions.map((s) => s.threadRef) : [], ["web:alice:new"]);
});

test("without project metadata every conversation keeps the existing flat recency order", () => {
  const olderGroup = {
    ...saved("1", "web:alice:group"),
    type: "group" as const,
    scopeId: "group:slack-mpdm",
    lastActivityAt: 10,
  };
  const newerPersonal = { ...saved("2", "web:alice:personal"), lastActivityAt: 20 };
  assert.deepEqual(groupProjectSessions([olderGroup, newerPersonal], []), [
    { kind: "session", session: newerPersonal },
    { kind: "session", session: olderGroup },
  ]);
});

test("rowIndicators: server working flag lights the dot", () => {
  const ind = rowIndicators({ ...saved("1", "web:u:x"), working: true }, null);
  assert.equal(ind.working, true);
  assert.equal(ind.awaiting, false);
  assert.equal(ind.background, null);
});

test("rowIndicators: the mounted pane's live turn lights its own row even before the server flag lands", () => {
  const ind = rowIndicators(saved("1", "web:u:x"), "web:u:x");
  assert.equal(ind.working, true);
  assert.equal(
    rowIndicators(saved("2", "web:u:other"), "web:u:x").working,
    false,
    "only the live thread borrows the client signal",
  );
});

test("rowIndicators: awaitingInput maps through", () => {
  assert.equal(rowIndicators({ ...saved("1", "web:u:x"), awaitingInput: true }, null).awaiting, true);
});

test("backgroundLabel: jobs and watches fold into one chip with a spoken label", () => {
  assert.deepEqual(backgroundLabel(1, 0), { jobs: 1, watches: 0, label: "1 background job running" });
  assert.deepEqual(backgroundLabel(2, 1), {
    jobs: 2,
    watches: 1,
    label: "2 background jobs running · 1 watch armed",
  });
  assert.deepEqual(backgroundLabel(0, 2), { jobs: 0, watches: 2, label: "2 watches armed" });
  assert.equal(backgroundLabel(0, 0), null, "nothing running, nothing to say");
});

test("rowIndicators: background counts flow through backgroundLabel — zero counts treated as absent", () => {
  const both = rowIndicators({ ...saved("1", "web:u:x"), backgroundJobs: 2, watches: 1 }, null);
  assert.deepEqual(both.background, {
    jobs: 2,
    watches: 1,
    label: "2 background jobs running · 1 watch armed",
  });
  assert.equal(rowIndicators({ ...saved("1", "web:u:x"), backgroundJobs: 0, watches: 0 }, null).background, null);
  assert.equal(rowIndicators(saved("1", "web:u:x"), null).background, null);
});

test("conversationBackground: resolves the mounted conversation by session id", () => {
  const list = [saved("1", "web:u:a"), { ...saved("2", "web:u:b"), backgroundJobs: 2, watches: 1 }];
  assert.deepEqual(conversationBackground(list, "2", null), {
    jobs: 2,
    watches: 1,
    label: "2 background jobs running · 1 watch armed",
  });
});

test("conversationBackground: falls back to threadRef while the conversation is still pending adoption", () => {
  const list = [{ ...saved("1", "web:u:a"), watches: 1 }];
  assert.deepEqual(conversationBackground(list, null, "web:u:a"), { jobs: 0, watches: 1, label: "1 watch armed" });
});

test("conversationBackground: null when the conversation has nothing running, or isn't in the list", () => {
  assert.equal(conversationBackground([saved("1", "web:u:a")], "1", "web:u:a"), null, "no counts, no strip");
  assert.equal(
    conversationBackground([{ ...saved("1", "web:u:a"), backgroundJobs: 1 }], "9", "web:u:zzz"),
    null,
    "unknown conversation",
  );
  assert.equal(
    conversationBackground([{ ...saved("1", "web:u:a"), backgroundJobs: 1 }], null, null),
    null,
    "nothing mounted",
  );
});

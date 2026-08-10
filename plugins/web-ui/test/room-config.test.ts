import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ApiError,
  entriesToMessages,
  personaFromPayload,
  refusalReason,
  type AssistantWork,
  type SessionEntry,
} from "../src/core-bridge.ts";
import {
  cachePersonas,
  clearPersonaCache,
  clearPendingRoomName,
  defaultRoomName,
  defaultRoomNameFor,
  holdPendingRoom,
  holdPendingRoomName,
  isRoomThread,
  noteRoom,
  pendingRoomFor,
  pendingRoomNameFor,
  clearPendingRoom,
  clearRoomRefusal,
  noteRoomRefusal,
  personaChipFor,
  personaRowKey,
  resetRoomState,
  roomConfigError,
  roomFor,
  roomRefusalFor,
  toggleRosterMember,
} from "../src/room-state.ts";
import type { AgentItem } from "../src/agent-registry.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Parameters<
  typeof entriesToMessages
>[1];

function makeAgent(id: string, name: string, over: Partial<AgentItem> = {}): AgentItem {
  return {
    id,
    name,
    color: "#2563eb",
    glyph: "SC",
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
    instructions: "",
    enabled: true,
    scope: "personal",
    scopeId: "personal:alice",
    createdBy: "alice",
    createdAt: 1,
    version: 1,
    editable: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Roster rules
// ---------------------------------------------------------------------------

test("a roster holds one or more unique agents over 1-20 rounds, with no size cap", () => {
  assert.equal(roomConfigError({ personaIds: ["a"], rounds: 1 }), null);
  assert.equal(roomConfigError({ personaIds: ["a", "b", "c", "d"], rounds: 3 }), null);
  assert.equal(
    roomConfigError({ personaIds: Array.from({ length: 12 }, (_, i) => `p${i}`), rounds: 1 }),
    null,
    "a room may hold as many agents as the operator wants",
  );
  assert.ok(roomConfigError({ personaIds: [], rounds: 1 }), "an empty roster is not a room");
  assert.ok(roomConfigError({ personaIds: ["a", "a"], rounds: 1 }), "an agent cannot be in a room twice");
  assert.equal(roomConfigError({ personaIds: ["a"], rounds: 7 }), null, "a custom round count is allowed");
  assert.equal(roomConfigError({ personaIds: ["a"], rounds: 20 }), null, "up to the ceiling");
  assert.ok(roomConfigError({ personaIds: ["a"], rounds: 0 }));
  assert.ok(roomConfigError({ personaIds: ["a"], rounds: 21 }), "past the ceiling");
  assert.ok(roomConfigError({ personaIds: ["a"], rounds: 2.5 }), "whole rounds only");
});

test("toggling roster membership preserves order and never refuses a pick", () => {
  let ids: string[] = [];
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) ids = toggleRosterMember(ids, id);
  assert.deepEqual(ids, ["a", "b", "c", "d", "e", "f", "g"], "picks keep the order they were made in");
  assert.deepEqual(toggleRosterMember(ids, "b"), ["a", "c", "d", "e", "f", "g"], "deselecting always works");
});

// ---------------------------------------------------------------------------
// Persona identity
// ---------------------------------------------------------------------------

test("a cached persona supplies the colour and glyph the chip needs", () => {
  resetRoomState();
  cachePersonas([makeAgent("ap_1", "Scout", { color: "#c2410c", glyph: "🔭" })]);
  assert.deepEqual(personaChipFor({ id: "ap_1", name: "Scout" }), {
    id: "ap_1",
    name: "Scout",
    color: "#c2410c",
    glyph: "🔭",
  });
});

test("an archived persona still gets a chip — the name from the entry, no colour invented", () => {
  resetRoomState();
  const chip = personaChipFor({ id: "ap_gone", name: "Critic" });
  assert.deepEqual(chip, { id: "ap_gone", name: "Critic" });
  assert.equal(chip?.color, undefined, "an unknown id must not borrow another persona's colour");
});

test("no persona means no chip, which is how every non-room message renders", () => {
  resetRoomState();
  assert.equal(personaChipFor(undefined), null);
  assert.equal(personaChipFor(null), null);
  assert.equal(personaChipFor({ id: "", name: "Scout" }), null);
  assert.equal(personaRowKey(undefined), "");
});

test("the row key changes when the cache fills in, so a memoised label cannot go stale", () => {
  resetRoomState();
  const persona = { id: "ap_1", name: "Scout" };
  const beforeCache = personaRowKey(persona);
  cachePersonas([makeAgent("ap_1", "Scout", { color: "#15803d", glyph: "SC" })]);
  const afterCache = personaRowKey(persona);
  assert.notEqual(beforeCache, afterCache, "colour/glyph arriving must invalidate the settled-row cache");
  clearPersonaCache();
  assert.equal(personaRowKey(persona), beforeCache);
});

// ---------------------------------------------------------------------------
// Pending vs applied rooms
// ---------------------------------------------------------------------------

test("a roster picked before the session exists is held against the thread and marks it a room", () => {
  resetRoomState();
  const config = { personaIds: ["ap_1", "ap_2"], rounds: 2 as const };
  holdPendingRoom("web:alice:t1", config);
  assert.deepEqual(pendingRoomFor("web:alice:t1"), config, "held until a session id exists");
  assert.equal(isRoomThread("web:alice:t1"), true, "the composer must already treat it as a room");
  clearPendingRoom("web:alice:t1");
  assert.equal(pendingRoomFor("web:alice:t1"), null, "applied once, never re-sent");
  assert.equal(isRoomThread("web:alice:t1"), true, "…but the thread is still a room");
});

test("a session read is what tells an unseen thread it is (or is not) a room", () => {
  resetRoomState();
  assert.equal(isRoomThread("web:alice:t2"), false);
  noteRoom("web:alice:t2", { personaIds: ["ap_1"], rounds: 1 });
  assert.deepEqual(roomFor("web:alice:t2"), { personaIds: ["ap_1"], rounds: 1 });
  noteRoom("web:alice:t2", null);
  assert.equal(isRoomThread("web:alice:t2"), false, "a cleared roster stops being a room");
});

test("a session read that has not caught up yet cannot drop a roster still awaiting apply", () => {
  resetRoomState();
  holdPendingRoom("web:alice:t3", { personaIds: ["ap_1"], rounds: 1 });
  noteRoom("web:alice:t3", null);
  assert.equal(isRoomThread("web:alice:t3"), true, "the pending roster wins over a stale read");
});

// ---------------------------------------------------------------------------
// Room names
// ---------------------------------------------------------------------------

test("an unnamed room is named after its roster, and reads as a sentence up to three", () => {
  assert.equal(defaultRoomName(["Scout"]), "Scout");
  assert.equal(defaultRoomName(["Scout", "Critic"]), "Scout & Critic");
  assert.equal(defaultRoomName(["Scout", "Critic", "Mesh"]), "Scout, Critic & Mesh");
});

test("past three the rest are counted, so a big roster still fits a sidebar row", () => {
  assert.equal(defaultRoomName(["Scout", "Critic", "Mesh", "Archivist"]), "Scout, Critic, Mesh & 1 more");
  assert.equal(defaultRoomName(Array.from({ length: 12 }, (_, i) => `A${i}`)), "A0, A1, A2 & 9 more");
});

test("one verbose agent cannot run away with the name", () => {
  const long = "Extremely Verbose Research Assistant";
  assert.equal(defaultRoomName([long]), "Extremely Verbose…", "each member is clipped, with an ellipsis to say so");
  assert.ok(defaultRoomName([long, long, long]).length < 64, "and three of them still fit");
});

test("a nameless roster still has something to be called", () => {
  assert.equal(defaultRoomName([]), "Room");
  assert.equal(defaultRoomName(["", "   "]), "Room", "blank names are not members");
  assert.equal(defaultRoomName(["  Scout  ", "Critic"]), "Scout & Critic", "and real ones are trimmed");
});

test("the derived name resolves ids through the persona cache, and never prints a raw id", () => {
  resetRoomState();
  cachePersonas([makeAgent("ap_1", "Scout"), makeAgent("ap_2", "Critic")]);
  assert.equal(defaultRoomNameFor({ personaIds: ["ap_1", "ap_2"] }), "Scout & Critic");
  assert.equal(
    defaultRoomNameFor({ personaIds: ["ap_1", "ap_unknown"] }),
    "Scout & 1 more",
    "an unresolved id is counted, never shown — a raw ap_… id is worse than useless as a name",
  );
  assert.equal(
    defaultRoomNameFor({ personaIds: ["ap_unknown", "ap_other"] }),
    "Room",
    "and with nothing resolved the room reads neutrally until the cache warms",
  );
  assert.equal(defaultRoomNameFor(null), "Room");
  assert.equal(defaultRoomNameFor({ personaIds: [] }), "Room");
});

// ---------------------------------------------------------------------------
// Pending room names
// ---------------------------------------------------------------------------

test("a name picked before the session exists is held against the thread, per thread", () => {
  resetRoomState();
  assert.equal(pendingRoomNameFor("web:alice:n1"), null);
  holdPendingRoomName("web:alice:n1", "  Design review  ");
  assert.equal(pendingRoomNameFor("web:alice:n1"), "Design review", "trimmed on the way in");
  assert.equal(pendingRoomNameFor("web:alice:n2"), null, "a name belongs to one thread only");
  assert.equal(pendingRoomNameFor(null), null);
});

test("a blank name parks nothing — the roster-derived default is not worth persisting", () => {
  resetRoomState();
  holdPendingRoomName("web:alice:n3", "Design review");
  holdPendingRoomName("web:alice:n3", "   ");
  assert.equal(pendingRoomNameFor("web:alice:n3"), null, "and it clears a name already parked");
});

test("a name clears only once it lands, so a failed apply is retried on the next attempt", () => {
  resetRoomState();
  holdPendingRoomName("web:alice:n4", "Design review");
  // A failed POST leaves it exactly where it was: nothing calls clear on that path.
  assert.equal(pendingRoomNameFor("web:alice:n4"), "Design review");
  clearPendingRoomName("web:alice:n4");
  assert.equal(pendingRoomNameFor("web:alice:n4"), null, "applied once, never re-sent");
});

test("the name and the roster clear independently — the turn carries one and not the other", () => {
  resetRoomState();
  holdPendingRoom("web:alice:n5", { personaIds: ["ap_1"], rounds: 1 });
  holdPendingRoomName("web:alice:n5", "Design review");
  clearPendingRoom("web:alice:n5");
  assert.equal(pendingRoomFor("web:alice:n5"), null, "the roster rode in on the first turn");
  assert.equal(pendingRoomNameFor("web:alice:n5"), "Design review", "the name still needs a session id");
});

test("resetting room state drops parked names with everything else", () => {
  holdPendingRoomName("web:alice:n6", "Design review");
  resetRoomState();
  assert.equal(pendingRoomNameFor("web:alice:n6"), null);
});

// ---------------------------------------------------------------------------
// Refused rosters
// ---------------------------------------------------------------------------

test("only a refused turn carrying a reason counts as a roster refusal", () => {
  assert.equal(
    refusalReason(new ApiError("HTTP 403", 403, { status: "refused", reason: "agent Critic is disabled" })),
    "agent Critic is disabled",
  );
  assert.equal(refusalReason(new ApiError("HTTP 403", 403, { status: "refused" })), null, "no reason to show");
  assert.equal(refusalReason(new ApiError("HTTP 403", 403, { error: "forbidden_scope" })), null, "not a refusal");
  assert.equal(refusalReason(new ApiError("HTTP 500", 500, { status: "refused", reason: "x" })), null, "wrong status");
  assert.equal(refusalReason(new Error("network down")), null);
  assert.equal(refusalReason(null), null);
});

test("a refusal is remembered per thread and stays dismissible", () => {
  resetRoomState();
  assert.equal(roomRefusalFor("web:alice:t4"), null);
  noteRoomRefusal("web:alice:t4", "unknown agent: ap_9");
  assert.equal(roomRefusalFor("web:alice:t4"), "unknown agent: ap_9");
  assert.equal(roomRefusalFor("web:alice:other"), null, "a refusal belongs to one thread only");
  clearRoomRefusal("web:alice:t4");
  assert.equal(roomRefusalFor("web:alice:t4"), null);
});

test("a refused roster stays parked so fixing the agent and resending retries it", () => {
  resetRoomState();
  holdPendingRoom("web:alice:t5", { personaIds: ["ap_1"], rounds: 1 });
  noteRoomRefusal("web:alice:t5", "agent Critic is disabled");
  assert.deepEqual(pendingRoomFor("web:alice:t5"), { personaIds: ["ap_1"], rounds: 1 });
});

// ---------------------------------------------------------------------------
// Attribution through the transcript
// ---------------------------------------------------------------------------

test("only a complete {id, name} counts as an author", () => {
  assert.deepEqual(personaFromPayload({ persona: { id: "ap_1", name: "Scout" } }), { id: "ap_1", name: "Scout" });
  assert.equal(personaFromPayload({ text: "hi" }), undefined);
  assert.equal(personaFromPayload({ persona: null }), undefined);
  assert.equal(personaFromPayload({ persona: { id: "ap_1" } }), undefined);
  assert.equal(personaFromPayload({ persona: { name: "Scout" } }), undefined);
  assert.equal(personaFromPayload(null), undefined);
});

test("each persona's turn carries its own author through entriesToMessages", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "who has thoughts?" }, createdAt: 100 },
    { type: "assistant", payload: { text: "I do.", persona: { id: "ap_1", name: "Scout" } }, createdAt: 110 },
    { type: "assistant", payload: { text: "I disagree.", persona: { id: "ap_2", name: "Critic" } }, createdAt: 120 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 3);
  assert.deepEqual((msgs[1] as AssistantWork).persona, { id: "ap_1", name: "Scout" });
  assert.deepEqual((msgs[2] as AssistantWork).persona, { id: "ap_2", name: "Critic" });
});

test("a persona's tool work stays on that persona's message", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "look it up" }, createdAt: 100 },
    { type: "tool_call", payload: { tool: "execute", command: "ls" }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 115, seq: 3, parentSeq: 2 },
    { type: "assistant", payload: { text: "found it", persona: { id: "ap_1", name: "Scout" } }, createdAt: 120 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const reply = msgs[1] as AssistantWork;
  assert.deepEqual(reply.persona, { id: "ap_1", name: "Scout" });
  assert.equal(reply.work?.activity.length, 2, "the work block is still folded in");
});

test("entries written before rooms existed produce messages with no author at all", () => {
  const msgs = entriesToMessages(
    [
      { type: "user", payload: { text: "hi" }, createdAt: 100 },
      { type: "assistant", payload: { text: "hello" }, createdAt: 110 },
    ],
    MODEL,
  );
  assert.equal((msgs[1] as AssistantWork).persona, undefined);
  assert.equal("persona" in (msgs[1] as object), false, "no key at all, so nothing renders a chip");
});

// ---------------------------------------------------------------------------
// Wiring the renderers cannot get wrong silently
// ---------------------------------------------------------------------------

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("the settled-row cache key includes the author, or a room's labels go stale", () => {
  assert.match(chat, /const persona = personaRowKey\(msg\.persona\);/);
  assert.ok(chat.includes("hit.persona === persona"), "the cache must compare the author identity");
  assert.match(chat, /persona,\s*thread: threadKey,\s*tpl,\s*\}\);/, "and store it alongside the memoised template");
});

test("the author chip renders in the assistant branch only, above the bubble", () => {
  assert.match(chat, /\$\{personaAuthorChip\(\(msg as AssistantWork\)\.persona\)\}/);
  const assistantBranch = chat.slice(chat.indexOf('if (role === "assistant")'));
  const chipAt = assistantBranch.indexOf("personaAuthorChip");
  const contentAt = assistantBranch.indexOf("assistantContent(msg");
  assert.ok(chipAt > 0 && chipAt < contentAt, "the chip must come before the message content");
});

test("a room's header shows the roster and its composer hides the per-thread runtime pickers", () => {
  assert.match(chat, /\$\{roomRosterChips\(room\)\}/, "the header draws whatever roster it was handed");
  assert.match(
    chat,
    /room: RoomConfig \| null = roomFor\(chatState\.threadRef\),/,
    "which defaults to the mounted thread's",
  );
  assert.match(
    chat,
    /\$\{chatHeader\(groupDmTitle\(s\), surfaceOf\(s\), true, s\.room \?\? null\)\}/,
    "and the read-only pane, which clears threadRef before it draws, passes the session's own",
  );
  assert.match(
    composer,
    /function roomThread\(\): boolean \{\s*\n\s*return isRoomThread\(ctx\.chat\.state\.threadRef\);/,
  );
  assert.match(composer, /: roomThread\(\)\s*\n\s*\? nothing/, "the composer's model/harness pickers drop out");
  assert.match(composer, /\$\{\s*\n?\s*roomThread\(\)\s*\n?\s*\? nothing/, "…and so do the ones in the settings menu");
});

test("a held roster is still applied if a thread gets a session id without carrying it on a turn", () => {
  const adopt = chat.slice(chat.indexOf("function adoptActiveSessionFromList"));
  const body = adopt.slice(0, adopt.indexOf("\n  }"));
  assert.match(body, /void applyPendingRoom\(chatState\.threadRef, chatState\.sessionId\);/);
  assert.ok(
    body.indexOf("chatState.sessionId = match.id") < body.indexOf("applyPendingRoom"),
    "the id must be adopted before the roster is applied",
  );
});

const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");

test("a new room's roster rides in on its first turn, and not on openers or approvals", () => {
  assert.match(bridge, /const roomForTurn = opener \|\| approval \? null : pendingRoomFor\(threadRef\);/);
  assert.match(bridge, /\.\.\.\(roomForTurn \? \{ room: roomForTurn \} : \{\}\),/, "the turn body carries it");
  const submitAt = bridge.indexOf('api<{ status?: string; runId?: string; reply?: string }>("/api/turn"');
  assert.ok(bridge.indexOf("const roomForTurn") < submitAt, "resolved before the turn is submitted");
});

test("an accepted roster stops being pending, so the deferred PUT never fires for that path", () => {
  assert.match(bridge, /if \(roomForTurn\) clearPendingRoom\(threadRef\);/);
  const clearAt = bridge.indexOf("if (roomForTurn) clearPendingRoom(threadRef);");
  const followAt = bridge.indexOf("await followRun(stream, partial, submit.runId");
  assert.ok(clearAt > 0 && clearAt < followAt, "cleared only after the submit came back without throwing");
});

test("a refused roster leaves no failed assistant turn in the transcript", () => {
  const drive = bridge.slice(bridge.indexOf("const roomForTurn"));
  const body = drive.slice(0, drive.indexOf("\n}\n"));
  assert.match(body, /const refused = roomForTurn \? refusalReason\(e\) : null;/, "only a room turn can refuse a room");
  assert.match(body, /noteRoomRefusal\(threadRef, refused\);/);
  assert.ok(
    body.indexOf("noteRoomRefusal") < body.indexOf("fail(stream, partial"),
    "the refusal path must return before the ordinary failure path",
  );
  assert.match(body, /clearRoomRefusal\(threadRef\);/, "each new send clears the previous refusal");
});

test("the refusal is surfaced at the composer, with its reason and a way to dismiss it", () => {
  assert.match(composer, /const refusal = roomRefusalFor\(ctx\.chat\.state\.threadRef\);/);
  assert.match(composer, /composer-error room-refusal/, "it renders in the composer's own error slot");
  assert.match(composer, /This room could not start: \$\{refusal\}/);
  assert.match(composer, /clearRoomRefusal\(ctx\.chat\.state\.threadRef\);/, "and can be dismissed");
});

// ---------------------------------------------------------------------------
// Named rooms as a sidebar surface
// ---------------------------------------------------------------------------

const roomsSrc = readFileSync(new URL("../src/rooms.ts", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

test("the dialog asks for a name first and offers the derived one as the placeholder", () => {
  const dialog = roomsSrc.slice(roomsSrc.indexOf("function roomDialogTpl"));
  const body = dialog.slice(0, dialog.indexOf("\n}\n"));
  assert.ok(body.indexOf('id="room-name"') < body.indexOf("${rosterBody()}"), "the name field comes before the roster");
  assert.match(body, /autofocus/, "and takes focus when the dialog opens");
  assert.match(body, /placeholder=\$\{derivedRoomName\(dialogState\.personaIds\)\}/);
});

test("a blank name falls back to the roster, so a room is never nameless", () => {
  assert.match(roomsSrc, /return dialogState\.name\.trim\(\) \|\| derivedRoomName\(personaIds\);/);
  assert.match(roomsSrc, /onCreate\?\.\(config, name\);/, "the name rides out with the config");
});

test("a new room parks its name next to its roster and files under Rooms straight away", () => {
  const start = shell.slice(shell.indexOf("export function startNewRoom"));
  const body = start.slice(0, start.indexOf("\n}\n"));
  assert.match(body, /holdPendingRoom\(threadRef, config\);/);
  assert.match(body, /holdPendingRoomName\(threadRef, name\);/);
  assert.match(body, /notePendingRoom\(threadRef, config, name\);/, "the sidebar row is stamped before any turn");
});

test("the parked name is applied the moment a session id exists, and only cleared if it lands", () => {
  const apply = roomsSrc.slice(roomsSrc.indexOf("export async function applyPendingRoom"));
  const body = apply.slice(0, apply.indexOf("\n}\n"));
  assert.match(body, /const name = pendingRoomNameFor\(threadRef\);/);
  assert.match(body, /await updateSession\(sessionId, \{ title: name \}\);/, "an explicit title, not a regeneration");
  assert.ok(
    body.indexOf("await updateSession(sessionId, { title: name });") < body.indexOf("clearPendingRoomName(threadRef)"),
    "cleared only after the POST came back without throwing",
  );
  assert.match(body, /swallow\("web-ui: apply room name", e\);/, "a failure never reaches the chat");
});

test("a room's name survives an unnamed room: the roster is the default title everywhere", () => {
  const def = sessions.slice(sessions.indexOf("export function defaultSessionTitle"));
  const body = def.slice(0, def.indexOf("\n}\n"));
  assert.match(body, /if \(s\.room\?\.personaIds\.length\) return defaultRoomNameFor\(s\.room\);/);
  assert.ok(body.indexOf("defaultRoomNameFor") < body.indexOf("projectName(s.scopeId)"), "a room outranks its project");
});

test("rooms are lifted into their own sidebar section before chats are grouped", () => {
  const list = sessions.slice(sessions.indexOf("export function renderList"));
  const body = list.slice(0, list.indexOf("\n}\n"));
  assert.match(body, /const \{ rooms, rest: afterRooms \} = splitRooms\(rest\);/);
  assert.ok(
    body.indexOf("splitRooms(rest)") < body.indexOf("recentItemsFor(chats)"),
    "a room must never nest under a project heading",
  );
  assert.match(body, /recents-group rooms-head/, "under a Rooms heading of its own");
  assert.match(body, /aria-label="New room"/, "which carries its own way to start one");
});

test("a room row shows its roster as glyphs, reusing the chip renderer", () => {
  assert.match(sessions, /\$\{roomRosterDots\(s\.room\)\}/);
  assert.match(sessions, /\$\{room \? "room-row" : ""\}/);
  assert.match(roomsSrc, /function personaDot\(chip: PersonaChip\): TemplateResult/, "one dot renderer, four callers");
  for (const caller of ["personaAuthorChip", "roomRosterChips", "personaDotStack", "roomRosterDots"]) {
    const at = roomsSrc.indexOf(`export function ${caller}`);
    const body = roomsSrc.slice(at, roomsSrc.indexOf("\n}\n", at));
    assert.ok(
      /personaDot\(|personaDotStack\(|personaChip\(/.test(body),
      `${caller} must go through the shared renderers, not hand-roll the glyph markup`,
    );
  }
});

test("the composer says how tagging works, without deciding who replies", () => {
  assert.match(composer, /else if \(roomThread\(\)\) placeholder = "Message the room — @mention an agent/);
  assert.equal(
    /routeTagged|tagsInMessage|parseMentions/.test(composer),
    false,
    "@tag routing is core-side only — the client must not fork on it",
  );
});

test("the header's left column is the title and one quiet sub-line; the roster trails on the row", () => {
  const at = chat.indexOf("function chatHeader(");
  assert.ok(at > 0, "chatHeader is still where the header is built");
  const header = chat.slice(at, chat.indexOf("\n  }", at));
  const headingAt = header.indexOf('class="chat-heading"');
  const subtitleAt = header.indexOf('class="chat-subtitle"');
  const metaAt = header.indexOf('class="chat-topbar-meta"');
  const actionsAt = header.indexOf('class="topbar-actions"');
  assert.ok(headingAt >= 0 && subtitleAt > headingAt, "the title and Read-only line stack, in that order");
  assert.ok(metaAt > subtitleAt, "the roster left the heading stack");
  assert.ok(
    header.lastIndexOf("</div>", metaAt) > subtitleAt,
    "and is a sibling of .chat-heading, not another line inside it",
  );
  assert.ok(metaAt < actionsAt, "sitting on the header row, before the actions it right-aligns against");
  assert.match(
    header,
    /room\?\.personaIds\.length\s*\r?\n?\s*\? html`<div class="chat-topbar-meta">\$\{roomRosterChips\(room\)\}<\/div>`/,
    "the very same chips (and their '· N rounds'), and no empty box spending the header's gap when there is no room",
  );
});

test("the trailing header meta right-aligns, and wraps below the title rather than overflowing", () => {
  const block = css.slice(css.indexOf(".chat-topbar-meta {"));
  const base = block.slice(0, block.indexOf(".topbar-actions {"));
  assert.match(base, /justify-content: flex-end/, "it hangs off the right edge of the header row");
  assert.match(base, /flex: 0 1 auto/, "and gives way before the title does");
  assert.match(base, /\.chat-topbar-meta \.room-roster \{[^}]*margin-top: 0/, "no stacked-under-the-title offset left");
  const narrow = css.slice(css.indexOf("@media (max-width: 700px) {"));
  const query = narrow.slice(0, narrow.indexOf("\n}\n"));
  assert.match(query, /\.chat-topbar \{[^}]*flex-wrap: wrap/, "the row is allowed to become two rows");
  assert.match(query, /\.chat-topbar \{[^}]*height: auto/, "the fixed 56px band cannot clip the wrapped line");
  assert.match(query, /\.chat-topbar-meta \{[^}]*flex: 1 0 100%/, "and the chips take the second line whole");
});

test("a room thread reads as a room in the live pane: its name, then its roster", () => {
  const banner = chat.slice(chat.indexOf("function roomBanner"));
  const body = banner.slice(0, banner.indexOf("\n  }"));
  assert.match(body, /const room = roomFor\(chatState\.threadRef\);/);
  assert.match(body, /\$\{roomRosterChips\(room\)\}/, "the header chips are the same ones");
  assert.ok(body.indexOf("room-banner-name") < body.indexOf("roomRosterChips"), "the name reads first");
  assert.match(chat, /\$\{roomBanner\(\)\} \$\{contextBanner\(\)\}/, "and it is mounted in the active chat shell");
});

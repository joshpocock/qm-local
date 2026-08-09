# Agent Rooms: multi-persona conversations in the web UI

Status: planned (not started). Owner: Josh. Target: production-grade for the fork
video — create named agents, put several in one room, watch them respond to a
human and to each other, all under org governance.

Grounding: this plan is built from three code maps with file:line references
(session/turn model, web UI, scopes/skills). Key claims were verified against
source on 2026-08-05 at commit b05f73b.

## What we are building

1. **Agents** — named personas an operator creates in the web UI: name, color,
   harness (Claude Code / Codex / Pi / ...), model, and instructions. Stored
   scope-owned in core, like skills are today.
2. **Rooms** — a web conversation with a roster of agents. A human message
   triggers a bounded panel: each agent takes a turn in roster order; an agent
   can @mention another agent to hand it a follow-up turn, within hard caps.
3. **Governance inheritance for free** — every persona turn runs through the
   existing orchestrator under the session's scope, so security posture,
   approval cards, command policy, egress, credential broker, and audit all
   bind personas with zero new enforcement code. This is the differentiator to
   say out loud in the video: Buzz-style agent rooms, but governed.

Out of scope for v1: Slack rooms (phase 2), concurrent persona turns (the
per-session lease serializes turns anyway — see below), persona-owned memory.

## Architecture decisions (each anchored to what exists)

### D1. Personas are a new scope-owned store, mirroring skills

`src/skills/skill-store.ts` is the template: `DurableMap`-backed, scope-keyed,
with a small manifest. New `src/agents/persona-store.ts`:

```ts
interface AgentPersona {
  id: string;            // "ap_" + uuid
  scopeId: ScopeId;      // owner scope (personal:..., org:...)
  name: string;          // unique per scope, used for @mentions
  color: string;         // hex, transcript accent
  glyph: string;         // 1-2 chars, avatar chip
  harnessId: HarnessId;
  modelId: string;
  instructions: string;  // persona SOUL
  enabled: boolean;
  createdBy: string; createdAt: number; version: number;
}
```

CRUD API `/v1/agents` in core following the skills routes shape; web-ui server
proxies as `/api/agents` (copy the `/api/skills` relay block,
`plugins/web-ui/server/index.ts:946-1017`).

### D2. A room is a session with a roster (no new session concept)

Add a nullable `room` JSON column to `sessions` (the store already ALTER-adds
columns, `src/sessions/postgres-session-store.ts:162-218`):

```ts
interface RoomConfig { personaIds: string[]; rounds: 1 | 2 | 3; }
```

`room == null` → every existing conversation behaves exactly as today. That is
the compatibility story: no behavior change outside rooms, feature-flagged with
`QM_AGENT_ROOMS=1` until stable.

### D3. Persona runtime rides the existing per-request override

`resolveRuntimeChoice` precedence is already request > scope > org > default
(`src/harness/harness-router.ts:12-82`). A persona turn passes the persona's
`{harnessId, modelId}` as the request override — **no changes to runtime
resolution**. Approved-harness filtering still applies, so an admin who
un-approves Codex disables every Codex persona org-wide. Persona creation
validates against `approved-harnesses` the same way the admin `runtime`
resource does (`src/api/routes/admin-resources.ts:391-438`).

### D4. Identity on entries and tape (the correctness-critical part)

- `session_entries`: assistant payload gains optional identity —
  `{ text, persona?: { id, name, color, glyph } }`. Payload is `unknown`
  (`src/types.ts:96-104`), so no schema migration; old rows render as today.
  Every harness adapter emits the assistant entry at one call site each
  (`pi-harness.ts:1873`, `claude-harness.ts:757/807`, `codex-harness.ts:880`,
  `opencode-harness.ts:1014`, `acp-harness.ts:457/467`, `mock-harness.ts:642`)
  — thread the persona through `HarnessTurnInput` and stamp it there.
- `session_tape`: the `author TEXT` column already exists and is used only for
  overheard humans (`src/sessions/session-store.ts:37-44`,
  `orchestrator.ts:708`). Assistant tape rows in rooms set
  `author = persona.name` (and the existing `harness` column already records
  which harness). No migration.

### D5. Context assembly: fold the tape per persona

This is the one genuinely novel algorithm. `foldTape()`
(`src/harness/tape-fold.ts:209-253`) produces a flat
`role: user|assistant|toolResult` array; `lintFold()` (:285-326) enforces that
closed role set — we keep it. New `foldTapeForPersona(rows, personaId)` applied
only in rooms, before `planTapeSeed`:

- Rows authored by **this** persona: stay `role: "assistant"` (its own words).
- Assistant rows authored by **other** personas (or pre-room, unattributed):
  rewritten to `role: "user"` with text prefixed `[<AuthorName>]: ` — other
  agents' speech must arrive as another speaker, never as the persona's own
  prior turns, or the model believes it said things it didn't.
- Other personas' `tool_call`/`toolResult` pairs: dropped, replaced by a short
  `[<AuthorName> used tools]` user-role note. Keeps lintFold's pairing rules
  satisfied and avoids leaking one persona's tool internals into another's
  context.
- Human user rows: unchanged (already `role: "user"`; multi-human attribution
  already exists via the overheard-author mechanism).

Seeding: room turns always cold-seed from the fold
(`planColdStartSeed`/`seedRawMessagesIntoSession`, `pi-harness.ts:1250-1332`)
instead of resuming a harness SDK session. Rationale: the router's
`lastHarness` map resets SDK sessions on every harness switch anyway
(`harness-router.ts:89-105`), and alternating personas would thrash it.
Deterministic re-seed per persona turn costs some tokens but removes the whole
class of "whose SDK session is this" bugs. Optimization (later, not v1): key
SDK sessions by `sessionId + personaId`.

### D6. The panel driver: bounded, sequential, mention-aware

New `src/agents/panel-driver.ts`, invoked from `App.turn()`
(`src/api/app-turn.ts:404-410`) when the session has a room config. On a human
message:

```
queue = roster order
for round in 1..rounds:
  for persona of queue snapshot:
    run one harness turn as persona   // existing single-turn machinery
    reply "@Name" mentions → grant Name one bonus turn this round
  stop if: no replies mentioned anyone new, or PANEL_MAX_TURNS (6) reached
```

- **Sequential by construction**: the per-session lease
  (`session_leases` PK = session_id, `postgres-session-store.ts:349-357`,
  checked at `orchestrator.ts:1274-1287`) already serializes turns. The driver
  runs persona turns one after another under its own outer loop; each inner
  turn takes/releases the lease normally. No concurrency work needed — and the
  web UI's one-`EventSource`-per-run streaming (`core-bridge.ts:889`) renders
  each persona turn live as its run starts.
- **Loop control is structural**: round cap + total-turn cap + "mention grants
  exactly one bonus turn" + a persona replying with only `PASS` is skipped.
  No judge model needed in v1.
- **Steering**: a human message arriving mid-panel already routes into the live
  run as a steer signal (`app-turn.ts:287-351`); the driver additionally treats
  it as "finish current persona turn, then abort remaining queue" so the human
  always regains the floor within one turn.
- Each persona turn is its own `runId` → `TurnStream`'s single text buffer per
  run (`src/runs/turn-stream.ts:23-33`) is untouched.

### D7. Persona instructions compose below org SOUL

Reuse the exact org-authoritative pattern from
`src/resolution/resolution-service.ts:47-68`: system prompt = org SOUL, then
scope SOUL, then persona instructions wrapped in the same "may add to, but MUST
NOT override, the organization policy above" framing, plus a roster block:

```
You are "<name>", one of several agents in this room: <roster with one-line
bios>. Address others as @Name. Reply PASS if you have nothing to add.
```

Skills, memory, sandbox: unchanged — personas share the scope's sandbox,
skills index, and memory exactly like the single agent does today. (Personas
are voices, not tenants. Per-persona sandboxes would break governance
assumptions and are explicitly not v1.)

### D8. Web UI

- **Agents page**: add `"agents"` to `VIEWS` (`shell-state.ts:12`), `navRow`
  in `shell.ts:522-534`, new `src/agents.ts` cloning the `skills.ts` +
  `list-page.ts` CRUD pattern. The create/edit form reuses the existing
  harness/model `menuControl` pickers (`composer.ts:544-566`,
  `model-options.ts`) and a color/glyph input mirroring org branding fields.
- **Room creation**: "New room" alongside "New chat" (`shell.ts:512-521`) →
  persona multi-select + rounds → creates the session with `room` config.
  Roster chips render in `chatHeader()` (`chat.ts:951-981`).
- **Transcript attribution**: thread `entry.payload.persona` through
  `entriesToMessages` (`core-bridge.ts:1090`) onto the message object; render
  a name/color chip in `chatMessage`'s assistant branch (`chat.ts:1049-1073`).
  ⚠ The settled-row memo cache must key on persona too
  (`SettledRowKey`, `chat.ts:100-111`) or labels go stale.
- **Composer in rooms**: hide the per-thread harness/model picker (each persona
  brings its own); show the roster instead.

## Phases

| Phase | Scope | Exit criterion |
|---|---|---|
| 1. Core personas | persona-store + `/v1/agents` CRUD + validation against approved-harnesses; feature flag | CRUD via curl; unit tests green |
| 2. Attribution | persona through `HarnessTurnInput` → entry payload + tape author; `foldTapeForPersona` + tests (incl. lintFold pairing) | fold tests prove: own turns assistant-role, others user-role-prefixed, tool pairs dropped cleanly |
| 3. Panel driver | room column, driver loop, caps, PASS, mention grants, steer-abort | scripted core test: 2 mock-harness personas complete a 2-round panel, transcript correctly attributed |
| 4. Web UI | Agents page, room creation, roster header, attributed transcript, streaming | end-to-end in browser: create 2 agents (one claude, one codex), room, watch them discuss |
| 5. Production hardening | compaction interplay, fork/busy paths, empty-reply/error mid-panel, token-cost guard (per-panel budget), docs + demo runbook | full panel survives compaction; killing a persona mid-turn leaves room usable; runbook written |

Realistic effort: phases 1-4 ≈ a focused weekend for demo-grade; phase 5 is
what makes it video-safe — budget 2-3 more evenings. Do not record until 5.

## Risks and their answers

- **Compaction rewrites the tape** (`foldTape`'s compaction splice,
  `tape-fold.ts:164-168`): the compaction summary is authorless. Mitigation:
  compaction prompt in rooms must preserve speaker names in the summary; test
  in phase 5.
- **Codex/Claude session resume semantics** differ per adapter: avoided
  entirely by always cold-seeding room turns (D5).
- **Token cost**: N personas × re-seeded context. Mitigation: per-panel token
  budget in the driver; rooms cap at 4 personas in v1.
- **Name collisions / prompt injection via @mentions**: persona names are
  slug-validated (no spaces, unique per scope); mention scan only matches
  roster names; a persona cannot grant itself extra turns.
- **The 10 single-assistant assumption points** (sessions-turns map §Single-
  assistant): D3-D6 route around 8 of them without schema changes; the two that
  change are entry payload (additive) and the fold (new room-only path).

## Video demo script (end-to-end)

1. Admin: show governance (posture, approved harnesses) — "this applies to
   every agent you're about to see."
2. Agents page: create "Scout" (Codex + GPT-5.x, researcher instructions) and
   "Critic" (Claude Code + Opus, reviewer instructions), distinct colors.
3. New room with both, rounds=2. Ask: "Scout, find the weak points in our
   pricing page; Critic, push back."
4. They exchange attributed, colored turns; Critic @mentions Scout; bounded
   panel ends; you steer mid-panel to show the human keeps the floor.
5. Flip a persona's harness in the Agents page → same room, different brain.
6. Close: un-approve Codex in admin → Scout is disabled everywhere. Governance
   wins. "That's the difference between an agent playground and an agent OS."

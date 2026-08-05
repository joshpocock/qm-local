# Agent Rooms: demo runbook + status

Verified live 2026-08-05 on the winlocal stack (commits `35762d2..cac3b39` on
feat/local-first). A two-persona room ran end-to-end in the browser: roster
order, an @mention bonus turn, persona chips, one user entry, roster persisted.

## One-time setup

1. `QM_AGENT_ROOMS=1` is set for core in `qm-win-test/qm.config.jsonc` (done).
2. Both harness logins must be fresh — verified working 2026-08-05:
   - **Codex**: `~/.codex/auth.json`.
   - **Claude Code**: `~/.claude/.credentials.json`. This expires (~8h) and the
     container cannot refresh it; when a persona's turn returns "Failed to
     authenticate: OAuth session expired", run `claude login` in a terminal and
     `docker restart qm-winlocal-core`. The panel survives the failure and the
     other agents still speak, so it degrades visibly rather than silently.
3. Deploy: `node <qm-local>/cli/dist/bin/qm.js up --build-from=<qm-local>` from
   `qm-win-test`. (Currently the running core is hot-patched + image rebuilt,
   so a plain restart is also fine.)

## Demo flow (matches the plan's script)

1. **Agents page** (sidebar → Agents): create Scout and Critic — name, color,
   glyph, harness + model per persona, instructions. Names are the @mention
   tokens (no spaces).
2. **New room** (sidebar, under New chat): pick both, rounds=1, Start room.
3. First message panels immediately (the roster rides the first message; no
   pre-steps). Each persona streams as its own run with its color/glyph chip.
4. **Mention grant**: a persona saying `@Name` hands that agent one bonus turn
   in the round — ask Critic to "hand off to @Scout" to show it on demand.
5. **Governance beat**: Admin → un-approve a harness → every persona on it is
   dead org-wide (persona create/update also validates against the approved
   list). Re-approve to restore.
6. **Swap a brain**: Agents page → edit Scout's harness/model → same room,
   next message uses it. (Verified live: Critic claude→codex mid-room.)

## Current limits (known, deliberate v1)

- A human message landing mid persona-turn steers into that persona's live
  turn (existing steer path) instead of aborting the panel; between turns it
  aborts cleanly.
- Error replies ("returned an error result") carry no persona chip — the
  error emit path doesn't stamp persona yet.
- In rooms, prior-turn tool-call detail is elided for everyone (incl. self)
  as "[Name used tools]" — stamping persona on tool_call entries would fix
  attribution of one's own tool history.
- Compaction summaries are not yet forced to preserve speaker names (rooms
  long enough to compact are untested).
- Slack rooms: not in v1. The bot-ledger path (other bots as `action`) is
  the Slack-side agent-to-agent story for now.

## Revert map

Each slice is one commit on feat/local-first: fold `35762d2`, adapter stamps
`0148422`, persona store `3df629f`, replay attribution `2293c0d`, panel driver
`a9e85ec`, web UI `7e6b189`, first-message rooms `8b14d58`, web-first-message
`4a1f331`, failure hardening `cac3b39`. `git revert <sha>` any of them; the
feature as a whole dies with `QM_AGENT_ROOMS` unset (routes vanish, sessions
behave exactly as before).

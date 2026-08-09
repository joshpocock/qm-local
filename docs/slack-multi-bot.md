# Running more than one Slack bot

qm has always run exactly one Slack bot: one `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` pair, one
installation record, one live Bolt app. That bot is still there, still the default, and nothing
about it changes.

On top of it you can now register **additional** bots. Each one is its own Slack app with its own
tokens, connects over its own Socket Mode session, and can be bound to one of your **agent
personas** — so a "Codex" bot answers as the Codex persona (its harness, model and instructions)
and a "Claude Code" bot answers as that one, side by side with the default qm bot in the same
workspace.

## Requirements

- **Socket Mode only.** Additional bots refuse to run under `SLACK_EVENTS_MODE=http`, because http
  mode has exactly one events port and one signing secret, both belonging to the default bot. The
  admin API rejects creating or enabling a bot in http mode, and says so rather than starting
  something that could never receive an event.
- **`QM_AGENT_ROOMS=1`** for persona binding. Persona turns run through the agent-rooms path; with
  the flag off an additional bot still runs, it just answers as the default org agent (a warning is
  logged at startup).
- The persona you bind should live in an **org, team or channel scope**, not someone's personal
  scope. See "Persona visibility" below.

## 1. Create the second Slack app

Render a manifest with the bot's name on it:

```
qm slack render --name "Codex"
```

That writes `slack-app-manifest-codex.yml` next to your config, leaving the default
`slack-app-manifest.yml` alone. Create the app at <https://api.slack.com/apps> → **From a
manifest**, paste the YAML, install it to the workspace, then collect:

- the **bot token** (`xoxb-…`) from _OAuth & Permissions_
- an **app-level token** (`xapp-…`) with `connections:write` from _Basic Information → App-Level
  Tokens_

The admin API also hands you a ready-made "create app" link in the `createUrl` field of
`GET /v1/admin/slack-bots`.

## 2. Register it

```
POST /v1/admin/slack-bots
{
  "label": "Codex",
  "personaId": "ap_…",          // optional; omit or null for default org-agent behaviour
  "botToken": "xoxb-…",
  "appToken": "xapp-…"
}
```

The pair is validated the same way the singular installation is: `auth.test`, then
`apps.connections.open` plus a Socket Mode hello, and the two tokens must belong to the **same
Slack app**. Tokens are AES-encrypted at rest and are **never** returned by any route — `GET`,
`POST` and `PUT` all answer with a redacted view.

Other routes:

- `GET /v1/admin/slack-bots` — list (redacted), plus `eventsMode` and the manifest `createUrl`
- `PUT /v1/admin/slack-bots/:id` — relabel, reassign `personaId` (or `null` to unbind), flip
  `enabled`, or rotate `botToken` **and** `appToken` together
- `DELETE /v1/admin/slack-bots/:id`

## 3. What happens next

The runtime reconciler polls every 5 seconds and reconciles the set
`{default installation} ∪ {enabled registry records}` to one running Bolt app per record. Adding,
editing, disabling or deleting one bot starts or stops **only** that bot; the others, including the
default, keep their connections. A bot that fails to start has the reason stored on its record and
surfaced as `lastError` in the admin list, and is retried with an exponential backoff instead of
every tick.

Invite the new bot to channels like any other Slack app, or DM it. In a DM it has its own channel,
so it gets its own conversation; in a channel, mention it by its own handle.

## How persona attribution works

A persona-bound bot attaches a single-member **room roster** to every turn it submits:

```
room: { personaIds: ["ap_…"], rounds: 1 }
```

That is the request-borne room config core already validates and runs for the web UI's room panels,
so the turn goes through exactly one well-trodden path and comes out with the persona's harness,
model and instructions composed under the org SOUL. No new turn machinery was added.

Two consequences worth knowing:

- **Persona visibility is checked against the Slack user, not the admin.** Core validates the
  roster against the personas _that person_ can see. A persona homed in an operator's personal
  scope will be refused for everyone else, with a visible refusal. Home shared bot personas in an
  org, team or channel scope.
- **A room, once set on a session, sticks.** In a DM this is what you want: the DM channel belongs
  to that bot alone, so the session becomes that persona's for good. In a **shared channel thread**
  the thread is one session across all bots, so whichever bot answers first sets the room and later
  messages in that same thread run under it — mentioning a second persona-bound bot in an existing
  thread will not switch personas mid-thread. Start a new thread, or use DMs, when you want a
  specific persona. (`@Name` mentions inside a room still add and address agents exactly as they do
  in the web UI.)

## Isolation between bots

Each instance derives its own bot identity from its own `auth.test`, and keeps its own dedupe
window, thread tracker, user cache and ack state. The process-global and org-wide seams are handled
explicitly:

| Seam                                                              | Handling                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Outbound username/icon override (`setDefaultBotIdentity`)         | Primary instance only                                                                                                            |
| Directory push (`upsertChannels` REPLACES the org's channel list) | Primary instance only — a secondary bot sees only the channels it was invited to                                                 |
| Mention index used to render `@name` → `<@U…>`                    | Primary instance only, for the same reason                                                                                       |
| Delivery poller (`claimDeliveries("slack")`, an org-wide queue)   | Primary instance only                                                                                                            |
| Surface-context requests (`pendingContextRequests("slack")`)      | Primary instance only                                                                                                            |
| Dev-introspection port                                            | Primary instance only                                                                                                            |
| Mirror / surface-cache ingestion                                  | Shared, and safe: ingest is an upsert on `(org, container, ts)`, so two bots seeing the same channel message converge on one row |
| Sibling bot messages                                              | Ignored — see below                                                                                                              |

### Bots do not answer each other

qm dispatches an unprompted turn when a bot posts into a thread it already has stake in — that is
how a GitHub or PagerDuty message gets picked up. With two qm bots in one thread that rule would
loop forever, so each running instance registers its Slack identity in-process and every instance
ignores messages from its siblings. Third-party bots behave exactly as before.

This gate is permanent and is **not** what makes personas talk to each other in Slack. Bot-to-bot
dispatch through Slack events stays blocked; a back-and-forth between personas is driven by core's
room panel instead — see [Slack room panels](#slack-room-panels).

### Recovery-path deliveries

The delivery-poller decision has one visible consequence: a reply that has to go out through the
**recovery path** (the inline post failed, or the run finished after the handler let go) is posted
by the **default** bot, not the persona bot that received the message. Ordinary replies — the
overwhelming majority — are posted inline by the bot that was addressed, under its own identity.
Per-bot delivery ownership would need a bot id on the delivery record, which is a core schema
change and deliberately out of scope here.

## Slack room panels

Two or more persona bots addressed in the same message hold a **panel**: they answer in turn, in
the same Slack thread, each under its own bot, and they can pull each other back in by name.

### How to trigger one

`@mention` two or more persona-bound bots in one message, in a channel or in an existing thread:

```
@Scout @Critic — is the migration plan safe to ship on Friday?
```

- Channels and group DMs only. A 1:1 DM belongs to one bot and the other personas are not in it,
  so a DM that tags several bots still runs as that DM's own single-persona turn.
- Ordering is the order you tagged them: Scout answers first, then Critic.
- A persona whose reply names another roster persona (`@Scout, that misses the point`) grants that
  persona **one bonus turn** in the round, exactly as an agent room does in the web UI.
- The whole exchange lands in the triggering message's thread. Nothing else changes about
  threading: `ch:<channel>:<root>` is still one session, so the room shares the human's context.
- Follow-ups are judged fresh, message by message. Tag one bot in the same thread and you get a
  single persona turn; tag two and you get a new panel. The shared session carries the context
  either way.
- **One** bot dispatches the panel even though every mentioned bot receives the message. The claim
  is first-caller-wins on `<channel>:<message ts>`, held for 5 minutes; the losing instances do
  nothing at all with that message — their mention is answered by the panel.

Requires `QM_AGENT_ROOMS=1` and both bots bound to a persona — either a registry bot's every-turn
persona, or the default bot's [panel persona](#giving-the-default-bot-a-panel-persona). With the
flag off, no bot registers a persona, so nothing is ever recognised as a panel and every bot answers
exactly as it does today.

### The rounds knob

A **round** is one pass over the addressed personas. It is set in the admin UI, on the **Slack bot**
card: a **Debate rounds** number input beside the _Answers as (in debates)_ picker. Leave it blank
for "no admin choice".

| Where                        | Wins over        | Notes                                                                           |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| Admin UI → **Debate rounds** | everything below | stored on the singular installation record beside `panelPersonaId`              |
| `QM_SLACK_PANEL_ROUNDS`      | the default      | still works; it is the fallback for a deployment that never set the admin value |
| built-in default             | —                | `1`                                                                             |

Range is `1`–`20` (`ROOM_MAX_ROUNDS`) throughout. The admin API **refuses** an out-of-range,
fractional or non-numeric value (`invalid_panel_rounds`) — an operator typing into a form gets told
what is wrong — while the env var is still **clamped** rather than refused, because a deployment's
environment has nobody to tell. The value is process-wide: every bot in the process uses the same
one.

Over the API, the same PUT that sets the debate agent:

```bash
curl -X PUT "$QM_API/v1/admin/slack-installation" \
  -H 'content-type: application/json' \
  -d '{"panelRounds":3}'
```

`null` (or a blank input) clears it back to `QM_SLACK_PANEL_ROUNDS`, then to `1`. Leave both token
fields blank to change only the debate settings — the tokens are write-only and never displayed
again, so they are not required. Both settings can be changed in one request; it is one write and
one version bump.

**It takes effect within seconds, and in threads that already held a debate.** Saving bumps the
installation record's `version`, which the runtime reconciler notices on its next poll (5s) and
restarts the default bot with the new number — no redeploy, no restart by hand. And because the
plugin puts `rounds` on **every** dispatch rather than only the first, a thread that already ran a
panel picks the new number up on its next message: the persisted room still owns the **roster**, but
the request owns that dispatch's **rounds** (`src/api/app-turn.ts`). A turn that carries no room
config at all — every ordinary web-UI turn into an existing room — is untouched and still uses the
rounds the room was configured with.

A deployment whose Slack tokens come from the process environment has no installation record to
store the setting on, so it uses `QM_SLACK_PANEL_ROUNDS` exactly as before.

### Ceiling math — a panel cannot run away

`panelTurnCeiling = max(addressed, roster) × rounds × 2`. The `× 2` is the bonus turn each persona
can be granted per round by being `@mentioned`. So two personas at the default one round is at most
**4** Slack messages. A round in which every speaker replies `PASS` ends the panel early, and `PASS`
itself is never posted to Slack (or written to the transcript).

Raising **Debate rounds** to 3 with a three-persona roster allows up to 18 messages in one thread.
Treat it as a budget, not a target.

### What the default qm bot does

By default, nothing. The default bot has no persona, so it is never on a roster. If you address it
_and_ two persona bots in the same message, the panel claims the message and the default bot stays
silent — including when it is the instance that happened to claim and dispatch the panel. Its own
`<@mention>` is stripped from the text exactly as it always was.

Give it a **panel persona** and it takes a seat instead. See below.

### Giving the default bot a panel persona

A **panel persona** is an agent the default bot answers as _only_ inside a room panel. It is not
the same binding as a registry bot's persona:

|                                     | Registry bot (`personaId`)         | Default bot (`panelPersonaId`)                                                 |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| DMs, crons, ordinary replies        | answers as the persona, every turn | answers as the **default org agent**, on the scope's runtime model — unchanged |
| Harness and model on solo turns     | the persona's                      | the admin runtime choice for the scope                                         |
| DM/channel header                   | names the persona and its model    | names the scope's runtime model, exactly as before                             |
| Counted for the ≥ 2 panel threshold | yes                                | yes                                                                            |
| Speaks in a panel                   | as the persona                     | as the persona                                                                 |
| Posts its own panel replies         | yes                                | yes                                                                            |

So the org's neutral assistant keeps every behaviour it has today, and additionally can be tagged
alongside an agent bot to hold a debate:

```
@qm @Critic — is the migration plan safe to ship on Friday?
```

That is now two personas, so it is a panel: the default bot answers as its panel persona and
Critic answers as itself, each posting under its own bot. Tag the default bot **alone** and nothing
about the turn changes — no roster on the request, no persona instructions, no header change.

**How to set it.** In the admin UI, the **Slack bot** card has an _Answers as (in debates)_ picker;
choose an agent and save. Leave both token fields blank to change only the agent — the tokens are
write-only and are never displayed again, so they are not required for a rebind. Over the API:

```bash
curl -X PUT "$QM_API/v1/admin/slack-installation" \
  -H 'content-type: application/json' \
  -d '{"panelPersonaId":"<agent id>"}'
```

`null` (or an empty picker) clears it. The agent must be live, enabled and not archived — the same
rule a registry bot's persona follows, including the caveat that it should be homed in an
org/team/channel scope so every Slack user can see it. Saving bumps the installation's version, so
the default bot restarts within a few seconds and re-resolves the agent's `@Name`.

Requires `QM_AGENT_ROOMS=1`, like every other persona path. With the flag off the binding is stored
but not applied, and a warning is logged at startup. A token rotation carries the binding forward;
removing the installation clears it along with the tokens.

### Who posts each reply

The first persona's reply is posted inline by the bot whose persona wrote it. Every later persona
turn is a background run with no handler waiting on it, so its reply reaches Slack through the
delivery queue, tagged with its author (`Destination.identity = "persona:<personaId>"`) and posted
under that persona's own bot. Those deliveries skip the ordinary recovery grace, because the grace
exists to let an owning handler post first and a continuation has no owner — otherwise a panel
would put up to a minute between one persona's turn and the next.

`@Name` in a persona's reply is rewritten to a real `<@U…>` mention pill when that persona has a
bot running in this process, using the driver's own word-boundary rule (`@Scoutmaster` never
becomes Scout). A persona's mention of itself is left as text.

**Fallback identity caveat.** If the authoring persona's bot is not running at post time — it was
disabled, its token was rotated, or the process is mid-reconcile — the reply is posted by the
claiming (or primary) bot instead, under the default identity, with the text unchanged. A reply
posted by the wrong bot beats a reply nobody ever sees. The event is logged.

This closes the [recovery-path](#recovery-path-deliveries) gap **for panel continuation turns
only**. A persona bot's ordinary single-turn recovery copy still goes out under the default bot;
covering that generally still needs a bot id on the delivery record.

### Known rough edges

- A room persisted on the session owns its **roster**: the message cannot replace who is in the
  room, only add to it, and the extra `@mentions` join it the same way a web-UI `@tag` does. Its
  `rounds`, by contrast, are re-read from each dispatch (see [The rounds knob](#the-rounds-knob)),
  so an admin change reaches a thread that already panelled. Nothing else about roster resolution
  moves, and a turn carrying no room config keeps using the persisted rounds.
- Panels run without the "⚙ Working…" ack and without the task-list placeholder. Both are posted,
  and later edited in place, by whichever instance claimed the message, and an edit cannot change
  identity afterwards — a third voice in the thread is worse than no progress indicator. Ordinary
  single-mention turns keep both.
- Core validates the roster against the **Slack user's** visible personas (see
  [How persona attribution works](#how-persona-attribution-works)); home shared panel personas in
  an org/team/channel scope.
- A persona's `@Name` is resolved once, when its bot starts. Rename a persona and its bot keeps
  the old token until it restarts.

## Limitations

- Socket Mode only (see above).
- Additional bots inherit every other Slack tuning knob from the process environment
  (`SLACK_USER_TOKEN`, TTLs, `SLACK_API_URL`, …). Only the token pair, label and persona are
  per-bot.
- The admin UI covers registering bots, binding a persona to each, and the default bot's panel
  persona and debate rounds. Everything else about a bot is API-only.
- The panel persona and the debate rounds are properties of the admin-managed installation record.
  A deployment whose Slack tokens come from the process environment has no such record, so it has
  no panel persona until the tokens are saved through the admin API, and its rounds come from
  `QM_SLACK_PANEL_ROUNDS`.
- Recovery-path deliveries come from the default bot (see above), except for panel continuation
  turns, which carry their author.
- Room panels have their own rough edges; see [Slack room panels](#slack-room-panels).

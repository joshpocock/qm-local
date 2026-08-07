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
ignores messages from its siblings. Third-party bots behave exactly as before. If you want two
personas to talk to each other, use an agent room in the web UI; that is what rooms are for.

### Recovery-path deliveries

The delivery-poller decision has one visible consequence: a reply that has to go out through the
**recovery path** (the inline post failed, or the run finished after the handler let go) is posted
by the **default** bot, not the persona bot that received the message. Ordinary replies — the
overwhelming majority — are posted inline by the bot that was addressed, under its own identity.
Per-bot delivery ownership would need a bot id on the delivery record, which is a core schema
change and deliberately out of scope here.

## Limitations

- Socket Mode only (see above).
- Additional bots inherit every other Slack tuning knob from the process environment
  (`SLACK_USER_TOKEN`, TTLs, `SLACK_API_URL`, …). Only the token pair, label and persona are
  per-bot.
- There is no admin UI for this yet; use the API.
- Recovery-path deliveries come from the default bot (see above).

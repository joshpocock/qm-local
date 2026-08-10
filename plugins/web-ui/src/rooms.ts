/**
 * Agent rooms in the chat surface: the "New room" roster picker, the roster chips in
 * the chat header, the roster dots on a sidebar room row, and the per-message author chip
 * in the transcript.
 *
 * Deliberately imports neither `chat.ts` nor `conversations.ts` — the caller passes in
 * what to do with a chosen roster, which keeps the module out of the conversation
 * import cycle and makes the picker reusable from the sidebar.
 */

import { html, nothing, render, type TemplateResult } from "lit";
import { Users, X } from "lucide";
import { api, ApiError, updateSession, updateSessionRoom } from "./core-bridge";
import { errMessage, swallow } from "../../chassis/src/errors";
import { fieldSelect, icon } from "./ui";
import { AGENT_ROOMS_DISABLED_COPY, type AgentItem } from "./agent-registry";
import {
  cachePersonas,
  cachedPersona,
  MAX_ROOM_ROUNDS,
  clearPendingRoom,
  clearPendingRoomName,
  defaultRoomName,
  DEFAULT_ROOM_ROUNDS,
  pendingRoomFor,
  pendingRoomNameFor,
  personaChipFor,
  roomConfigError,
  ROOM_ROUNDS,
  toggleRosterMember,
  type MessagePersona,
  type PersonaChip,
  type RoomConfig,
} from "./room-state";

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

function chipStyle(chip: PersonaChip): string {
  if (!chip.color) return "";
  return `--persona-color: ${chip.color};`;
}

/** The coloured square every persona label is built from — chip, author, sidebar dot. */
function personaDot(chip: PersonaChip): TemplateResult {
  return html`<span class="persona-dot" style=${chipStyle(chip)}
    >${chip.glyph ?? chip.name.slice(0, 1).toUpperCase()}</span
  >`;
}

function personaChip(chip: PersonaChip, extraClass = ""): TemplateResult {
  return html`<span class="persona-chip ${extraClass} ${chip.color ? "" : "neutral"}" style=${chipStyle(chip)}>
    ${personaDot(chip)}<span class="persona-name">${chip.name}</span>
  </span>`;
}

/** How many glyphs a sidebar row shows before the rest become a "+N" count. */
const ROSTER_DOTS_SHOWN = 4;

/** Roster order, resolved through the persona cache; an unknown id degrades to itself. */
function rosterChips(room: Pick<RoomConfig, "personaIds">): PersonaChip[] {
  return room.personaIds.map((id) => personaChipFor({ id, name: "" }) ?? { id, name: id });
}

/**
 * The small author label above an assistant bubble in a room. Renders nothing at all
 * outside rooms, so single-agent conversations look exactly as they do today.
 */
export function personaAuthorChip(persona: MessagePersona | undefined): TemplateResult | typeof nothing {
  const chip = personaChipFor(persona);
  if (!chip) return nothing;
  return html`<div class="persona-chip persona-author ${chip.color ? "" : "neutral"}" style=${chipStyle(chip)}>
    ${personaDot(chip)}<span class="persona-name">${chip.name}</span>
  </div>`;
}

/** Roster chips for the chat header, in roster order. */
export function roomRosterChips(room: RoomConfig | null): TemplateResult | typeof nothing {
  if (!room?.personaIds.length) return nothing;
  return html`<div class="room-roster" title="Agents in this room — each takes a turn in this order">
    ${rosterChips(room).map((chip) => personaChip(chip))}
    <span class="room-rounds">${room.rounds} round${room.rounds === 1 ? "" : "s"}</span>
  </div>`;
}

/**
 * A set of personas shrunk to an overlapping stack of glyphs, for somewhere there is no
 * width for names — a sidebar row, a collapsed thread's "who answered". The names ride
 * along in the tooltip so it is still readable to a screen reader and on hover.
 */
export function personaDotStack(
  chips: readonly PersonaChip[],
  ariaLabel: (names: string) => string,
): TemplateResult | typeof nothing {
  if (!chips.length) return nothing;
  const label = chips.map((chip) => chip.name).join(", ");
  const shown = chips.slice(0, ROSTER_DOTS_SHOWN);
  const extra = chips.length - shown.length;
  return html`<span class="room-dots" title=${label} aria-label=${ariaLabel(label)}
    >${shown.map((chip) => personaDot(chip))}${
      extra > 0 ? html`<span class="room-dots-more">+${extra}</span>` : nothing
    }</span
  >`;
}

/** The room's roster, as that stack, for a sidebar row. */
export function roomRosterDots(room: RoomConfig | null | undefined): TemplateResult | typeof nothing {
  if (!room?.personaIds.length) return nothing;
  return personaDotStack(rosterChips(room), (names) => `Agents in this room: ${names}`);
}

// ---------------------------------------------------------------------------
// Applying a held roster once the session exists
// ---------------------------------------------------------------------------

/**
 * Flushes everything a new room parked against its thread the moment a session id exists.
 *
 * The roster is a safety net: the normal path is the first message carrying `room` (core
 * validates and persists it), which clears the pending entry — so that half usually finds
 * nothing. It still exists for a thread that acquired a session some other way (a fork, a
 * resumed draft) while its roster was still parked.
 *
 * The name has no such shortcut — a turn carries no title — so this is the only path that
 * ever applies it. Either half failing leaves its value parked for the next attempt, and
 * neither is allowed to throw into the chat.
 */
export async function applyPendingRoom(threadRef: string | null, sessionId: string | null): Promise<void> {
  if (!threadRef || !sessionId) return;
  const config = pendingRoomFor(threadRef);
  if (config) {
    try {
      await updateSessionRoom(sessionId, config);
      clearPendingRoom(threadRef);
    } catch (e) {
      swallow("web-ui: apply room roster", e);
    }
  }
  const name = pendingRoomNameFor(threadRef);
  if (name) {
    try {
      await updateSession(sessionId, { title: name });
      clearPendingRoomName(threadRef);
    } catch (e) {
      swallow("web-ui: apply room name", e);
    }
  }
}

/**
 * Fills the persona cache so roster chips can show names and colours instead of raw ids
 * after a reload. Memoised: the first caller pays for the fetch, everyone else awaits it,
 * and a failure degrades to the neutral name-only chips rather than blocking the chat.
 */
let personasWarmed: Promise<void> | null = null;

export function ensureRoomPersonas(): Promise<void> {
  personasWarmed ??= api<{ agents: AgentItem[] }>("/api/agents")
    .then((r) => cachePersonas(r.agents ?? []))
    .catch((e) => swallow("web-ui: warm persona cache", e));
  return personasWarmed;
}

// ---------------------------------------------------------------------------
// "New room" dialog
// ---------------------------------------------------------------------------

/** Sentinel option value: the picker switches to a free number input. */
const CUSTOM_ROUNDS = "custom";

/**
 * The dialog serves both "New room" and "Edit room". Same fields, same validation, same
 * submit path — only the copy and the starting values differ, because an operator changing
 * a room's roster or its round budget is making exactly the choice they made when they
 * created it, and a second dialog would be a second set of rules to keep in step.
 */
type RoomDialogMode = "create" | "edit";

interface RoomDialogState {
  open: boolean;
  mode: RoomDialogMode;
  loading: boolean;
  agents: AgentItem[];
  name: string;
  personaIds: string[];
  rounds: number;
  error: string;
  roomsDisabled: boolean;
  onCreate: ((config: RoomConfig, name: string) => void) | null;
  opener: HTMLElement | null;
}

const dialogState: RoomDialogState = {
  open: false,
  mode: "create",
  loading: false,
  agents: [],
  name: "",
  personaIds: [],
  rounds: DEFAULT_ROOM_ROUNDS,
  error: "",
  roomsDisabled: false,
  onCreate: null,
  opener: null,
};

let dialogHost: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (dialogHost?.isConnected) return dialogHost;
  dialogHost = document.createElement("div");
  dialogHost.className = "room-dialog-host";
  document.body.appendChild(dialogHost);
  return dialogHost;
}

function closeRoomDialog(): void {
  if (!dialogState.open) return;
  dialogState.open = false;
  dialogState.error = "";
  dialogState.onCreate = null;
  const opener = dialogState.opener;
  dialogState.opener = null;
  drawRoomDialog();
  queueMicrotask(() => opener?.isConnected && opener.focus());
}

/**
 * What the room will be called. A typed name wins; a blank field falls back to the roster,
 * resolved off the dialog's own agent list rather than the persona cache — the names are
 * already in hand here, and the cache may not be warm on a first-ever room.
 */
function derivedRoomName(personaIds: readonly string[]): string {
  return defaultRoomName(
    personaIds.map((id) => dialogState.agents.find((a) => a.id === id)?.name || cachedPersona(id)?.name || id),
  );
}

function roomNameFromDialog(personaIds: readonly string[]): string {
  return dialogState.name.trim() || derivedRoomName(personaIds);
}

function submitRoom(): void {
  const config: RoomConfig = { personaIds: [...dialogState.personaIds], rounds: dialogState.rounds };
  const invalid = roomConfigError(config);
  if (invalid) {
    dialogState.error = invalid;
    drawRoomDialog();
    return;
  }
  const name = roomNameFromDialog(config.personaIds);
  const onCreate = dialogState.onCreate;
  closeRoomDialog();
  onCreate?.(config, name);
}

function agentRosterRow(agent: AgentItem): TemplateResult {
  const selected = dialogState.personaIds.includes(agent.id);
  // A disabled agent cannot be added, but one a room already holds must still be removable:
  // core refuses a roster containing it, so leaving the row inert would wedge the edit with
  // no way out but re-enabling an agent the operator may well be trying to drop.
  const disabled = !agent.enabled && !selected;
  let hint = `${agent.harnessId} · ${agent.modelId}`;
  if (!agent.enabled) {
    hint = selected
      ? "Disabled — remove it from the room, or re-enable it on the Agents page"
      : "Disabled — enable it on the Agents page to use it in a room";
  }
  return html`<button
    class="room-pick ${selected ? "selected" : ""}"
    type="button"
    role="checkbox"
    aria-checked=${selected ? "true" : "false"}
    ?disabled=${disabled}
    title=${hint}
    @click=${() => {
      dialogState.personaIds = toggleRosterMember(dialogState.personaIds, agent.id);
      dialogState.error = "";
      drawRoomDialog();
    }}
  >
    <span class="room-pick-box" aria-hidden="true">${selected ? "✓" : ""}</span>
    <span class="persona-dot" style=${`--persona-color: ${agent.color};`}>${agent.glyph}</span>
    <span class="room-pick-copy">
      <span class="room-pick-name">@${agent.name}</span>
      <span class="room-pick-meta">${hint}</span>
    </span>
    ${agent.enabled ? nothing : html`<span class="badge">Disabled</span>`}
  </button>`;
}

/**
 * A member the agent list does not contain — an archived persona, or one that left the
 * viewer's scope. It still speaks in the room, so it has to be visible and removable here;
 * dropping it silently because `/api/agents` no longer mentions it would rewrite the roster
 * behind the operator's back the first time they touched any other field.
 */
function missingRosterRow(id: string): TemplateResult {
  const chip = personaChipFor({ id, name: "" }) ?? { id, name: id };
  return html`<button
    class="room-pick selected"
    type="button"
    role="checkbox"
    aria-checked="true"
    title="No longer available — it stays in the room until you remove it"
    @click=${() => {
      dialogState.personaIds = toggleRosterMember(dialogState.personaIds, id);
      dialogState.error = "";
      drawRoomDialog();
    }}
  >
    <span class="room-pick-box" aria-hidden="true">✓</span>
    ${personaDot(chip)}
    <span class="room-pick-copy">
      <span class="room-pick-name">@${chip.name}</span>
      <span class="room-pick-meta">No longer available — remove it to drop it from the room</span>
    </span>
    <span class="badge">Unavailable</span>
  </button>`;
}

function rosterBody(): TemplateResult {
  if (dialogState.roomsDisabled) return html`<p class="room-empty">${AGENT_ROOMS_DISABLED_COPY}</p>`;
  if (dialogState.loading && !dialogState.agents.length) return html`<p class="room-empty">Loading agents…</p>`;
  const known = new Set(dialogState.agents.map((agent) => agent.id));
  const missing = dialogState.personaIds.filter((id) => !known.has(id));
  if (!dialogState.agents.length && !missing.length) {
    return html`<p class="room-empty">No agents yet. Create one on the Agents page, then start a room.</p>`;
  }
  return html`<div class="room-pick-list" role="group" aria-label="Agents in this room">
      ${missing.map(missingRosterRow)}${dialogState.agents.map(agentRosterRow)}
    </div>
    ${
      dialogState.personaIds.length
        ? nothing
        : html`<p class="room-hint">Select the agents above to start the room.</p>`
    }`;
}

function roomDialogTpl(): TemplateResult {
  const ready = !dialogState.roomsDisabled && dialogState.personaIds.length > 0;
  const editing = dialogState.mode === "edit";
  return html`
    <dialog
      class="project-dialog room-dialog"
      aria-labelledby="room-dialog-title"
      @close=${closeRoomDialog}
      @click=${(event: MouseEvent) =>
        event.target === event.currentTarget && (event.currentTarget as HTMLDialogElement).close()}
    >
      <form
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          submitRoom();
        }}
      >
        <div class="project-dialog-head">
          <span class="context-glyph large">${icon(Users, 21)}</span>
          <div><h2 id="room-dialog-title">${editing ? "Edit room" : "New room"}</h2></div>
          <button
            class="project-icon-button"
            type="button"
            aria-label=${editing ? "Close edit room" : "Close new room"}
            title="Close"
            data-dialog-cancel
            @click=${closeRoomDialog}
          >
            ${icon(X, 16)}
          </button>
        </div>
        <p class="room-dialog-lead">
          ${
            editing
              ? html`Rename the room, add or drop agents, and change how many rounds it runs. Changes take effect on
                the next message you send — everything already said stays in the transcript, including turns from an
                agent you remove.`
              : html`Name the room and pick your agents. Each takes a turn in roster order when you send a message, and
                can @mention another agent to hand it a follow-up turn.`
          }
        </p>
        <label class="project-name-field room-name-field" for="room-name">
          <span>Name</span>
          <input
            id="room-name"
            name="name"
            autofocus
            maxlength="200"
            autocomplete="off"
            placeholder=${derivedRoomName(dialogState.personaIds)}
            .value=${dialogState.name}
            ?disabled=${dialogState.roomsDisabled}
            @input=${(event: InputEvent) => {
              dialogState.name = (event.currentTarget as HTMLInputElement).value;
              dialogState.error = "";
            }}
          />
        </label>
        ${rosterBody()}
        <label class="room-rounds-field">
          <span>Rounds</span>
          ${fieldSelect({
            compact: true,
            ariaLabel: "Rounds per message",
            value: ROOM_ROUNDS.includes(dialogState.rounds) ? String(dialogState.rounds) : CUSTOM_ROUNDS,
            disabled: dialogState.roomsDisabled,
            onChange: (value) => {
              dialogState.rounds = value === CUSTOM_ROUNDS ? ROOM_ROUNDS.length + 1 : Number(value);
              drawRoomDialog();
            },
            options: [
              ...ROOM_ROUNDS.map(
                (rounds) => html`<option value=${String(rounds)}>${rounds} round${rounds === 1 ? "" : "s"}</option>`,
              ),
              html`<option value=${CUSTOM_ROUNDS}>Custom…</option>`,
            ],
          })}
          ${
            ROOM_ROUNDS.includes(dialogState.rounds)
              ? nothing
              : html`<input
                  class="room-rounds-input"
                  type="number"
                  min="1"
                  max=${String(MAX_ROOM_ROUNDS)}
                  step="1"
                  aria-label="Number of rounds"
                  .value=${String(dialogState.rounds)}
                  ?disabled=${dialogState.roomsDisabled}
                  @input=${(event: Event) => {
                    dialogState.rounds = Number((event.target as HTMLInputElement).value);
                    dialogState.error = "";
                  }}
                />`
          }
        </label>
        <p class="room-hint">
          A round is one turn each, in roster order. Agents are told which round they are on, and the room stops early
          once nobody has anything left to add.
        </p>
        <div class="form-error" aria-live="polite">${dialogState.error}</div>
        <div class="project-dialog-actions">
          <button class="btn" type="button" @click=${closeRoomDialog}>Cancel</button>
          <button class="btn primary" type="submit" ?disabled=${!ready}>
            ${icon(Users, 15)}<span>${editing ? "Save room" : "Start room"}</span>
          </button>
        </div>
      </form>
    </dialog>
  `;
}

function drawRoomDialog(): void {
  const host = ensureHost();
  render(dialogState.open ? roomDialogTpl() : nothing, host);
  const dialog = host.querySelector<HTMLDialogElement>(".room-dialog");
  if (dialog && !dialog.open) dialog.showModal();
}

async function loadRoomAgents(): Promise<void> {
  dialogState.loading = true;
  try {
    const r = await api<{ agents: AgentItem[] }>("/api/agents");
    dialogState.agents = (r.agents ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    cachePersonas(dialogState.agents);
    dialogState.roomsDisabled = false;
  } catch (e) {
    dialogState.agents = [];
    if (e instanceof ApiError && e.status === 404) dialogState.roomsDisabled = true;
    else dialogState.error = errMessage(e, "Failed to load agents.");
  } finally {
    dialogState.loading = false;
    if (dialogState.open) drawRoomDialog();
  }
}

/** What an "Edit room" opener pre-fills the dialog with. Omitted fields start as a new room's. */
export interface RoomDialogPrefill {
  name?: string;
  personaIds?: readonly string[];
  rounds?: number;
}

/**
 * Opens the roster picker. `onCreate` receives the chosen config once it validates, plus
 * the room's name — the typed one, or the roster-derived default when the field was left
 * blank. It is never empty, so callers never have to derive a name themselves.
 */
export function openRoomDialog(onCreate: (config: RoomConfig, name: string) => void): void {
  openDialog("create", onCreate, {});
}

/**
 * The same dialog, opened over a room that already exists. `onSave` is handed the edited
 * config and name exactly as `onCreate` is — the caller owns the PUT, which keeps this
 * module free of the session store the way the create path already keeps it free of the
 * conversation one.
 */
export function openEditRoomDialog(
  prefill: RoomDialogPrefill,
  onSave: (config: RoomConfig, name: string) => void,
): void {
  openDialog("edit", onSave, prefill);
}

function openDialog(
  mode: RoomDialogMode,
  onCreate: (config: RoomConfig, name: string) => void,
  prefill: RoomDialogPrefill,
): void {
  dialogState.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialogState.open = true;
  dialogState.mode = mode;
  dialogState.name = prefill.name ?? "";
  dialogState.personaIds = [...(prefill.personaIds ?? [])];
  dialogState.rounds = prefill.rounds ?? DEFAULT_ROOM_ROUNDS;
  dialogState.error = "";
  dialogState.onCreate = onCreate;
  drawRoomDialog();
  void loadRoomAgents();
}

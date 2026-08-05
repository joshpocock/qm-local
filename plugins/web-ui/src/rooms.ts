/**
 * Agent rooms in the chat surface: the "New room" roster picker, the roster chips in
 * the chat header, and the per-message author chip in the transcript.
 *
 * Deliberately imports neither `chat.ts` nor `conversations.ts` — the caller passes in
 * what to do with a chosen roster, which keeps the module out of the conversation
 * import cycle and makes the picker reusable from the sidebar.
 */

import { html, nothing, render, type TemplateResult } from "lit";
import { Users, X } from "lucide";
import { api, ApiError, updateSessionRoom } from "./core-bridge";
import { errMessage, swallow } from "../../chassis/src/errors";
import { fieldSelect, icon } from "./ui";
import { AGENT_ROOMS_DISABLED_COPY, type AgentItem } from "./agent-registry";
import {
  cachePersonas,
  clearPendingRoom,
  DEFAULT_ROOM_ROUNDS,
  MAX_ROOM_PERSONAS,
  pendingRoomFor,
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

/**
 * The small author label above an assistant bubble in a room. Renders nothing at all
 * outside rooms, so single-agent conversations look exactly as they do today.
 */
export function personaAuthorChip(persona: MessagePersona | undefined): TemplateResult | typeof nothing {
  const chip = personaChipFor(persona);
  if (!chip) return nothing;
  return html`<div class="persona-chip persona-author ${chip.color ? "" : "neutral"}" style=${chipStyle(chip)}>
    <span class="persona-dot">${chip.glyph ?? chip.name.slice(0, 1).toUpperCase()}</span>
    <span class="persona-name">${chip.name}</span>
  </div>`;
}

/** Roster chips for the chat header, in roster order. */
export function roomRosterChips(room: RoomConfig | null): TemplateResult | typeof nothing {
  if (!room?.personaIds.length) return nothing;
  const chips = room.personaIds.map((id) => personaChipFor({ id, name: "" }) ?? { id, name: id });
  return html`<div class="room-roster" title="Agents in this room — each takes a turn in this order">
    ${chips.map(
      (chip) =>
        html`<span class="persona-chip ${chip.color ? "" : "neutral"}" style=${chipStyle(chip)}>
          <span class="persona-dot">${chip.glyph ?? chip.name.slice(0, 1).toUpperCase()}</span>
          <span class="persona-name">${chip.name}</span>
        </span>`,
    )}
    <span class="room-rounds">${room.rounds} round${room.rounds === 1 ? "" : "s"}</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Applying a held roster once the session exists
// ---------------------------------------------------------------------------

/**
 * Web threads have no server-side session until the first message lands, so "New room"
 * parks the roster against the thread ref. This applies it the moment a session id
 * appears; on failure the config stays parked so the next attempt can retry.
 */
export async function applyPendingRoom(threadRef: string | null, sessionId: string | null): Promise<void> {
  if (!threadRef || !sessionId) return;
  const config = pendingRoomFor(threadRef);
  if (!config) return;
  try {
    await updateSessionRoom(sessionId, config);
    clearPendingRoom(threadRef);
  } catch (e) {
    swallow("web-ui: apply room roster", e);
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

interface RoomDialogState {
  open: boolean;
  loading: boolean;
  agents: AgentItem[];
  personaIds: string[];
  rounds: 1 | 2 | 3;
  error: string;
  roomsDisabled: boolean;
  onCreate: ((config: RoomConfig) => void) | null;
  opener: HTMLElement | null;
}

const dialogState: RoomDialogState = {
  open: false,
  loading: false,
  agents: [],
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

function submitRoom(): void {
  const config: RoomConfig = { personaIds: [...dialogState.personaIds], rounds: dialogState.rounds };
  const invalid = roomConfigError(config);
  if (invalid) {
    dialogState.error = invalid;
    drawRoomDialog();
    return;
  }
  const onCreate = dialogState.onCreate;
  closeRoomDialog();
  onCreate?.(config);
}

function agentRosterRow(agent: AgentItem): TemplateResult {
  const selected = dialogState.personaIds.includes(agent.id);
  const full = !selected && dialogState.personaIds.length >= MAX_ROOM_PERSONAS;
  const disabled = !agent.enabled || full;
  let hint = `${agent.harnessId} · ${agent.modelId}`;
  if (!agent.enabled) hint = "Disabled — enable it on the Agents page to use it in a room";
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
    <span class="persona-dot" style=${`--persona-color: ${agent.color};`}>${agent.glyph}</span>
    <span class="room-pick-copy">
      <span class="room-pick-name">@${agent.name}</span>
      <span class="room-pick-meta">${hint}</span>
    </span>
    ${agent.enabled ? nothing : html`<span class="badge">Disabled</span>`}
  </button>`;
}

function rosterBody(): TemplateResult {
  if (dialogState.roomsDisabled) return html`<p class="room-empty">${AGENT_ROOMS_DISABLED_COPY}</p>`;
  if (dialogState.loading && !dialogState.agents.length) return html`<p class="room-empty">Loading agents…</p>`;
  if (!dialogState.agents.length) {
    return html`<p class="room-empty">No agents yet. Create one on the Agents page, then start a room.</p>`;
  }
  return html`<div class="room-pick-list" role="group" aria-label="Agents in this room">
    ${dialogState.agents.map(agentRosterRow)}
  </div>`;
}

function roomDialogTpl(): TemplateResult {
  const ready = !dialogState.roomsDisabled && dialogState.personaIds.length > 0;
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
          <div><h2 id="room-dialog-title">New room</h2></div>
          <button
            class="project-icon-button"
            type="button"
            aria-label="Close new room"
            title="Close"
            data-dialog-cancel
            @click=${closeRoomDialog}
          >
            ${icon(X, 16)}
          </button>
        </div>
        <p class="room-dialog-lead">
          Pick up to ${MAX_ROOM_PERSONAS} agents. Each takes a turn in roster order when you send a message, and can
          @mention another agent to hand it a follow-up turn.
        </p>
        ${rosterBody()}
        <label class="room-rounds-field">
          <span>Rounds</span>
          ${fieldSelect({
            compact: true,
            ariaLabel: "Rounds per message",
            value: String(dialogState.rounds),
            disabled: dialogState.roomsDisabled,
            onChange: (value) => {
              dialogState.rounds = (Number(value) || DEFAULT_ROOM_ROUNDS) as 1 | 2 | 3;
              drawRoomDialog();
            },
            options: ROOM_ROUNDS.map(
              (rounds) => html`<option value=${String(rounds)}>${rounds} round${rounds === 1 ? "" : "s"}</option>`,
            ),
          })}
        </label>
        <div class="form-error" aria-live="polite">${dialogState.error}</div>
        <div class="project-dialog-actions">
          <button class="btn" type="button" @click=${closeRoomDialog}>Cancel</button>
          <button class="btn primary" type="submit" ?disabled=${!ready}>
            ${icon(Users, 15)}<span>Start room</span>
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

/** Opens the roster picker. `onCreate` receives the chosen config once it validates. */
export function openRoomDialog(onCreate: (config: RoomConfig) => void): void {
  dialogState.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialogState.open = true;
  dialogState.personaIds = [];
  dialogState.rounds = DEFAULT_ROOM_ROUNDS;
  dialogState.error = "";
  dialogState.onCreate = onCreate;
  drawRoomDialog();
  void loadRoomAgents();
}

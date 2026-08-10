/**
 * The debate-rounds ceiling for a Slack channel, on the surface where a human can actually
 * reach it.
 *
 * The same value is editable from the admin app's Governance card, but that card only unhides
 * for a channel scope and the admin view has no scope picker — so nobody could get to it. This
 * is the reachable placement: a Slack channel conversation already appears in the sidebar, and
 * a room already shows an editable "N rounds", so the control lives on the channel and reads
 * like the one rooms have.
 *
 * Deliberately the ONE writable control on a read-only Slack conversation. It changes how a
 * future debate runs; it is not a send path, and nothing here posts to Slack.
 *
 * Storage is `channel_policy.debate_rounds`, carried by the member-scoped
 * `GET|PUT /api/contexts/:scope/ambient-policy` proxy — the same policy row the standing-orders
 * card writes, which is why `orders`/`bots` are round-tripped untouched under the
 * `baseUpdatedAt` conflict snapshot rather than re-sent as blanks.
 */

import { html, nothing, render, type TemplateResult } from "lit";
import { Hash, X } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect, icon } from "./ui";
import { MAX_ROOM_ROUNDS, ROOM_ROUNDS } from "./room-state";

/** The picker value that means "no override — follow whatever the org default is". */
const INHERIT = "default";
/** The picker value that swaps in a free number input, exactly as the room dialog does. */
const CUSTOM = "custom";

interface BotWire {
  mode: string;
  rollupHours?: number;
}

interface PolicyWire {
  policy: {
    orders: string;
    bots: Record<string, BotWire>;
    debateRounds?: number | null;
    defaultDebateRounds?: number;
    updatedAt: number;
  };
}

export const channelRoundsState = {
  scope: null as string | null,
  loading: false,
  loaded: false,
  /** This channel's own override, or null when it inherits the org default. */
  rounds: null as number | null,
  /** What a channel with no override of its own follows, as core resolved it. */
  defaultRounds: 1,
  /** Picker parked on "Custom…", so the number input shows even while the value is a quick pick. */
  custom: false,
  saving: false,
  notice: "",
  noticeKind: "" as "" | "saved" | "error",
  // Round-tripped, never rewritten here: saving a rounds change must not blank a channel's
  // standing orders or its bot ledger.
  orders: "",
  bots: {} as Record<string, BotWire>,
  baseUpdatedAt: 0,
};

let loadSeq = 0;
let redraw: () => void = () => {};

/**
 * Channel conversations only. A Slack DM is one bot taking one round, so a ceiling there would
 * be a control with nothing to do; a web chat has its room dialog instead.
 */
export function channelRoundsApplies(s: { threadRef: string; scopeId?: string | null }): boolean {
  if (!s.threadRef.startsWith("ch:")) return false;
  const scope = s.scopeId ?? "";
  return scope.startsWith("channel:") || scope.startsWith("group:");
}

/**
 * The scope a Slack channel's own controls write against, given the threads mirrored under it
 * — or null when none of them has a policy scope to write to.
 *
 * Deliberately `channelRoundsApplies` over the channel's children rather than a scope minted
 * from the raw channel id: the sidebar row and the conversation must edit the same row of
 * `channel_policy`, and the only thing that knows which scope core actually stamped is a
 * session core stamped. Returning null where the conversation would show no control is the
 * point — the row offers the setting exactly where the thread does, and nowhere else.
 */
export function channelRoundsScopeFor(
  sessions: readonly { threadRef: string; scopeId?: string | null }[],
): string | null {
  return sessions.find((s) => channelRoundsApplies(s))?.scopeId ?? null;
}

export function resetChannelRounds(): void {
  loadSeq += 1;
  channelRoundsState.scope = null;
  channelRoundsState.loading = false;
  channelRoundsState.loaded = false;
  channelRoundsState.rounds = null;
  channelRoundsState.defaultRounds = 1;
  channelRoundsState.custom = false;
  channelRoundsState.saving = false;
  channelRoundsState.notice = "";
  channelRoundsState.noticeKind = "";
  channelRoundsState.orders = "";
  channelRoundsState.bots = {};
  channelRoundsState.baseUpdatedAt = 0;
}

function absorb(p: PolicyWire["policy"]): void {
  channelRoundsState.rounds = typeof p.debateRounds === "number" ? p.debateRounds : null;
  channelRoundsState.defaultRounds = typeof p.defaultDebateRounds === "number" ? p.defaultDebateRounds : 1;
  channelRoundsState.orders = p.orders ?? "";
  channelRoundsState.bots = p.bots ?? {};
  channelRoundsState.baseUpdatedAt = p.updatedAt ?? 0;
  channelRoundsState.custom = channelRoundsState.rounds !== null && !ROOM_ROUNDS.includes(channelRoundsState.rounds);
  channelRoundsState.loaded = true;
}

export async function loadChannelRounds(scopeId: string, onChange: () => void): Promise<void> {
  redraw = onChange;
  if (channelRoundsState.scope === scopeId) return;
  resetChannelRounds();
  const seq = ++loadSeq;
  channelRoundsState.scope = scopeId;
  channelRoundsState.loading = true;
  try {
    const r = await api<PolicyWire>(`/api/contexts/${encodeURIComponent(scopeId)}/ambient-policy`);
    if (seq !== loadSeq) return;
    absorb(r.policy);
  } catch (e) {
    if (seq !== loadSeq) return;
    channelRoundsState.notice = errMessage(e, "Couldn't load this channel's debate rounds.");
    channelRoundsState.noticeKind = "error";
  } finally {
    if (seq === loadSeq) {
      channelRoundsState.loading = false;
      redraw();
    }
  }
}

/**
 * `next` of null clears the override back to inheriting. Sends the channel's stored orders and
 * bot ledger back unchanged, under the `baseUpdatedAt` snapshot core checks — so two people
 * editing the same channel from different cards get a 409 rather than one silently winning.
 */
async function save(next: number | null): Promise<void> {
  const scope = channelRoundsState.scope;
  if (!scope || channelRoundsState.saving) return;
  channelRoundsState.saving = true;
  channelRoundsState.notice = "";
  channelRoundsState.noticeKind = "";
  redraw();
  try {
    const r = await api<PolicyWire>(`/api/contexts/${encodeURIComponent(scope)}/ambient-policy`, {
      method: "PUT",
      body: JSON.stringify({
        orders: channelRoundsState.orders,
        bots: channelRoundsState.bots,
        debateRounds: next,
        baseUpdatedAt: channelRoundsState.baseUpdatedAt,
      }),
    });
    const wasCustom = channelRoundsState.custom;
    absorb(r.policy);
    // A custom number that happens to be a quick pick should not yank the input away
    // mid-edit; only a fresh load decides the picker shape from scratch.
    if (wasCustom && channelRoundsState.rounds !== null) channelRoundsState.custom = true;
    channelRoundsState.notice = "Saved.";
    channelRoundsState.noticeKind = "saved";
  } catch (e) {
    channelRoundsState.notice = errMessage(e, "Couldn't save — try again.");
    channelRoundsState.noticeKind = "error";
  } finally {
    channelRoundsState.saving = false;
    redraw();
  }
}

/** The ceiling this channel actually runs at right now. */
export function effectiveChannelRounds(): number {
  return channelRoundsState.rounds ?? channelRoundsState.defaultRounds;
}

/** Where that number came from, in the words a member would use. */
export function channelRoundsSource(): string {
  return channelRoundsState.rounds === null ? "org default" : "this channel";
}

function summaryText(): string {
  const n = effectiveChannelRounds();
  return `${n} round${n === 1 ? "" : "s"} · ${channelRoundsSource()}`;
}

function pickerValue(): string {
  if (channelRoundsState.rounds === null) return INHERIT;
  if (channelRoundsState.custom || !ROOM_ROUNDS.includes(channelRoundsState.rounds)) return CUSTOM;
  return String(channelRoundsState.rounds);
}

/**
 * Options carry `?selected` as well as riding under `fieldSelect`'s `.value`.
 *
 * lit commits an element's attribute and property bindings BEFORE the child part inside it, so
 * on the first paint `.value` is assigned to a select element that has no options yet and the
 * browser drops it — leaving the picker parked on whatever renders first. That first option is
 * "Org default", so a channel with an explicit override of 3 would have painted as inheriting:
 * exactly the distinction this control exists to make. `selected` is applied with the options
 * themselves, so the first paint is right; `.value` keeps later updates right once the options
 * are on screen and the select's selectedness is dirty.
 */
function roundsOption(value: string, label: string, current: string): TemplateResult {
  return html`<option value=${value} ?selected=${value === current}>${label}</option>`;
}

/**
 * The control itself. Renders nothing until the channel's policy has loaded, so a channel a
 * member cannot read policy for (403) shows the transcript exactly as it does today rather
 * than an inert dropdown.
 */
export function channelRoundsControl(scopeId: string): TemplateResult | typeof nothing {
  if (channelRoundsState.scope !== scopeId) return nothing;
  if (channelRoundsState.loading)
    return html`<div class="channel-rounds" aria-busy="true">
      <span class="channel-rounds-label">Debate rounds</span>
      <span class="channel-rounds-summary">Loading…</span>
    </div>`;
  if (!channelRoundsState.loaded && channelRoundsState.noticeKind === "error") return nothing;
  if (!channelRoundsState.loaded) return nothing;
  const current = pickerValue();
  const fallbackLabel = `Org default (${channelRoundsState.defaultRounds} round${channelRoundsState.defaultRounds === 1 ? "" : "s"})`;
  return html`<div class="channel-rounds">
    <span class="channel-rounds-label" id="channel-rounds-label">Debate rounds</span>
    ${fieldSelect({
      compact: true,
      className: "channel-rounds-select",
      focusKey: "channel-rounds",
      ariaLabel: "Debate rounds for this channel",
      describedBy: "channel-rounds-summary",
      disabled: channelRoundsState.saving,
      value: current,
      onChange: (value) => {
        if (value === INHERIT) {
          channelRoundsState.custom = false;
          void save(null);
          return;
        }
        if (value === CUSTOM) {
          // Park on the current effective number so the input opens on something real, and
          // wait for the person to commit a value before writing anything.
          channelRoundsState.custom = true;
          channelRoundsState.rounds = effectiveChannelRounds();
          redraw();
          return;
        }
        channelRoundsState.custom = false;
        void save(Number(value));
      },
      options: [
        roundsOption(INHERIT, fallbackLabel, current),
        ...ROOM_ROUNDS.map((rounds) =>
          roundsOption(String(rounds), `${rounds} round${rounds === 1 ? "" : "s"}`, current),
        ),
        roundsOption(CUSTOM, "Custom…", current),
      ],
    })}
    ${
      current === CUSTOM
        ? html`<input
            class="room-rounds-input channel-rounds-input"
            type="number"
            min="1"
            max=${String(MAX_ROOM_ROUNDS)}
            step="1"
            data-focus-key="channel-rounds-custom"
            aria-label="Number of debate rounds for this channel"
            .value=${String(channelRoundsState.rounds ?? effectiveChannelRounds())}
            ?disabled=${channelRoundsState.saving}
            @change=${(event: Event) => {
              const n = Number((event.target as HTMLInputElement).value);
              if (!Number.isInteger(n) || n < 1 || n > MAX_ROOM_ROUNDS) {
                channelRoundsState.notice = `Pick a whole number from 1 to ${MAX_ROOM_ROUNDS}.`;
                channelRoundsState.noticeKind = "error";
                redraw();
                return;
              }
              void save(n);
            }}
          />`
        : nothing
    }
    <span class="channel-rounds-summary" id="channel-rounds-summary" aria-live="polite">
      ${channelRoundsState.saving ? "Saving…" : summaryText()}
    </span>
    ${
      channelRoundsState.notice
        ? html`<span
            class=${`channel-rounds-status ${channelRoundsState.noticeKind === "error" ? "error" : ""}`}
            aria-live="polite"
            >${channelRoundsState.notice}</span
          >`
        : nothing
    }
  </div>`;
}

// ---------------------------------------------------------------------------
// The same control, opened from the channel row
// ---------------------------------------------------------------------------

/**
 * Reaching the ceiling only through an open thread taught the wrong thing: a channel-global
 * setting read as a per-thread one, because a thread was the only place it appeared. The
 * channel row's kebab opens this dialog, which hosts the very same `channelRoundsControl`
 * against the very same scope — one control, two doors, no second copy of the fetch or the
 * PUT to keep in step.
 */
interface ChannelRoundsDialogState {
  open: boolean;
  scopeId: string;
  /** `#name` as the row shows it, so the dialog names the channel the same way. */
  label: string;
  opener: HTMLElement | null;
  /**
   * The scope (and redraw) that owned the shared state before the dialog borrowed it. The
   * module holds ONE channel's policy at a time, so opening this over a mounted conversation
   * would otherwise leave that conversation's control blank until its pane remounted.
   */
  prior: { scopeId: string; redraw: () => void } | null;
}

const dialogState: ChannelRoundsDialogState = {
  open: false,
  scopeId: "",
  label: "",
  opener: null,
  prior: null,
};

let dialogHost: HTMLElement | null = null;

function ensureDialogHost(): HTMLElement {
  if (dialogHost?.isConnected) return dialogHost;
  dialogHost = document.createElement("div");
  dialogHost.className = "channel-rounds-dialog-host";
  document.body.appendChild(dialogHost);
  return dialogHost;
}

function drawChannelRoundsDialog(): void {
  const host = ensureDialogHost();
  render(dialogState.open ? channelRoundsDialogTpl() : nothing, host);
  const dialog = host.querySelector<HTMLDialogElement>(".channel-rounds-dialog");
  if (dialog && !dialog.open) dialog.showModal();
}

export function openChannelRoundsDialog(scopeId: string, label: string): void {
  dialogState.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialogState.open = true;
  dialogState.scopeId = scopeId;
  dialogState.label = label;
  dialogState.prior = channelRoundsState.scope ? { scopeId: channelRoundsState.scope, redraw } : null;
  // Loaded before the first paint, not after it: `loadChannelRounds` parks the scope and the
  // loading flag synchronously, so the dialog opens on "Loading…" rather than on the previous
  // channel's state or on a "couldn't load" that has not been tried yet.
  void loadChannelRounds(scopeId, drawChannelRoundsDialog);
  drawChannelRoundsDialog();
}

export function closeChannelRoundsDialog(): void {
  if (!dialogState.open) return;
  dialogState.open = false;
  const opener = dialogState.opener;
  const prior = dialogState.prior;
  dialogState.opener = null;
  dialogState.prior = null;
  drawChannelRoundsDialog();
  // Hand the shared state back, and repaint whoever had it — including when it is the same
  // channel, whose number may have just changed under it.
  if (prior) void loadChannelRounds(prior.scopeId, prior.redraw).then(() => prior.redraw());
  queueMicrotask(() => opener?.isConnected && opener.focus());
}

function channelRoundsDialogTpl(): TemplateResult {
  // Only ever says "couldn't load" about THIS channel's own settled failure; anything else is
  // still in flight, and `channelRoundsControl` paints that itself.
  const unreadable =
    channelRoundsState.scope === dialogState.scopeId && !channelRoundsState.loading && !channelRoundsState.loaded;
  return html`
    <dialog
      class="project-dialog channel-rounds-dialog"
      aria-labelledby="channel-rounds-dialog-title"
      @close=${closeChannelRoundsDialog}
      @click=${(event: MouseEvent) =>
        event.target === event.currentTarget && (event.currentTarget as HTMLDialogElement).close()}
    >
      <div class="project-dialog-head">
        <span class="context-glyph large">${icon(Hash, 21)}</span>
        <div><h2 id="channel-rounds-dialog-title">Debate rounds</h2></div>
        <button
          class="project-icon-button"
          type="button"
          aria-label="Close debate rounds"
          title="Close"
          data-dialog-cancel
          @click=${closeChannelRoundsDialog}
        >
          ${icon(X, 16)}
        </button>
      </div>
      <p class="room-dialog-lead">
        The ceiling for every debate in <strong>${dialogState.label}</strong> — this is the channel's setting, not one
        thread's. A thread can ask for fewer rounds than this; none can run more.
      </p>
      ${
        unreadable
          ? html`<p class="channel-rounds-unavailable">
              ${channelRoundsState.notice || "Couldn't load this channel's debate rounds."}
            </p>`
          : channelRoundsControl(dialogState.scopeId)
      }
    </dialog>
  `;
}

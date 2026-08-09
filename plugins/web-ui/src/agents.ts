import { html, nothing, render, type TemplateResult } from "lit";
import { Users } from "lucide";
import { api, ApiError, fetchRuntimeConfig, type CoreContext } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect, icon } from "./ui";
import { appState } from "./shell";
import { applyRuntimeOptions, getHarnessOptions, getModelOptionsForHarness } from "./model-options";
import { listBackLink, listPageTpl } from "./list-page";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import {
  AGENT_COLOR_PRESETS,
  AGENT_INSTRUCTIONS_MAX,
  AGENT_NAME_MAX,
  AGENT_ROOMS_DISABLED_COPY,
  agentEmptyState,
  agentFieldErrors,
  agentStatusCounts,
  filterAgents,
  type AgentFieldErrors,
  type AgentItem,
} from "./agent-registry";
import { cachePersonas } from "./room-state";

interface AgentDraft {
  id: string | null;
  name: string;
  color: string;
  glyph: string;
  harnessId: string;
  modelId: string;
  instructions: string;
  enabled: boolean;
  scopeId: string;
  /** Set once the form has been submitted, so errors appear on submit rather than on first keystroke. */
  submitted: boolean;
}

let agentRows: AgentItem[] = [];
let agentsNotice = "";
let agentSearch = "";
let scopeFilter = "all";
let statusFilter: "enabled" | "disabled" | "all" = "all";
let createScopes: Array<{ scopeId: string; name: string }> = [];
let agentsPageHost: HTMLElement | null = null;
let roomsDisabled = false;
let runtimeScope: string | null = null;

let draft: AgentDraft | null = null;
let draftMode: "create" | "edit" = "create";
let saving = false;
let formError = "";
let deleting: string | null = null;
let archiveConfirmation: AgentItem | null = null;
let flowFocusTarget: HTMLElement | null = null;
let archiveFocusTarget: HTMLElement | null = null;
let refreshSeq = 0;

function scopeLabel(scope: string): string {
  return scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : "";
}

function harnessLabel(harnessId: string): string {
  return getHarnessOptions(runtimeScope).find((h) => h.value === harnessId)?.label ?? harnessId;
}

function modelLabel(harnessId: string, modelId: string): string {
  return getModelOptionsForHarness(harnessId, runtimeScope).find((o) => o.model.id === modelId)?.label ?? modelId;
}

function agentMeta(a: AgentItem): string {
  return `${scopeLabel(a.scope)} · ${harnessLabel(a.harnessId)} · ${modelLabel(a.harnessId, a.modelId)} · v${a.version}`;
}

function draftErrors(): AgentFieldErrors {
  if (!draft?.submitted) return {};
  return agentFieldErrors({
    name: draft.name.trim(),
    color: draft.color.trim().toLowerCase(),
    glyph: draft.glyph.trim(),
    instructions: draft.instructions,
  });
}

function fieldError(key: keyof AgentFieldErrors): TemplateResult | typeof nothing {
  const message = draftErrors()[key];
  return message ? html`<small class="form-error inline-field-error" role="alert">${message}</small>` : nothing;
}

// ---------------------------------------------------------------------------
// Create / edit flow
// ---------------------------------------------------------------------------

function firstHarness(): string {
  return getHarnessOptions(runtimeScope)[0]?.value ?? "pi";
}

function firstModelFor(harnessId: string): string {
  return getModelOptionsForHarness(harnessId, runtimeScope)[0]?.model.id ?? "";
}

function closeFocusedFlow(): void {
  draft = null;
  saving = false;
  formError = "";
  agentsNotice = "";
  const target = flowFocusTarget;
  flowFocusTarget = null;
  drawAgents();
  queueMicrotask(() => {
    if (draft || archiveConfirmation || appState.currentView !== "agents") return;
    restoreDialogFocus(
      target,
      () =>
        agentsPageHost?.querySelector<HTMLElement>(".list-page-action") ??
        agentsPageHost?.querySelector<HTMLElement>(".list-search input") ??
        null,
    );
  });
}

function startCreate(): void {
  if (draft) return;
  flowFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const harnessId = firstHarness();
  draftMode = "create";
  draft = {
    id: null,
    name: "",
    color: AGENT_COLOR_PRESETS[agentRows.length % AGENT_COLOR_PRESETS.length]!,
    glyph: "",
    harnessId,
    modelId: firstModelFor(harnessId),
    instructions: "",
    enabled: true,
    scopeId: createScopes[0]?.scopeId ?? "",
    submitted: false,
  };
  formError = "";
  drawAgents();
  queueMicrotask(() => agentsPageHost?.querySelector<HTMLInputElement>("#agent-name")?.focus());
}

function startEdit(a: AgentItem): void {
  if (!a.editable) return;
  flowFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  draftMode = "edit";
  draft = {
    id: a.id,
    name: a.name,
    color: a.color,
    glyph: a.glyph,
    harnessId: a.harnessId,
    modelId: a.modelId,
    instructions: a.instructions,
    enabled: a.enabled,
    scopeId: a.scopeId,
    submitted: false,
  };
  formError = "";
  drawAgents();
  queueMicrotask(() => agentsPageHost?.querySelector<HTMLInputElement>("#agent-name")?.focus());
}

async function saveDraft(): Promise<void> {
  const d = draft;
  if (!d || saving) return;
  d.submitted = true;
  const fields = {
    name: d.name.trim(),
    color: d.color.trim().toLowerCase(),
    glyph: d.glyph.trim(),
    instructions: d.instructions,
  };
  if (Object.keys(agentFieldErrors(fields)).length) {
    formError = "";
    drawAgents();
    return;
  }
  saving = true;
  formError = "";
  drawAgents();
  const body = {
    ...fields,
    harnessId: d.harnessId,
    modelId: d.modelId,
    enabled: d.enabled,
    ...(draftMode === "create" && d.scopeId ? { scopeId: d.scopeId } : {}),
  };
  try {
    if (draftMode === "create") await api("/api/agents", { method: "POST", body: JSON.stringify(body) });
    else await api(`/api/agents/${encodeURIComponent(d.id!)}`, { method: "PUT", body: JSON.stringify(body) });
    const returnTarget = flowFocusTarget;
    flowFocusTarget = null;
    draft = null;
    saving = false;
    await renderAgents();
    queueMicrotask(() =>
      restoreDialogFocus(returnTarget, () => agentsPageHost?.querySelector<HTMLElement>(".list-page-action") ?? null),
    );
  } catch (e) {
    // Core owns name uniqueness (409) and runtime approval (400); show its wording verbatim.
    formError = errMessage(e, "Failed to save agent.");
    saving = false;
    drawAgents();
  }
}

function setAgentsBackgroundInert(inert: boolean): void {
  agentsPageHost?.querySelectorAll<HTMLElement>(":scope > :not(.project-dialog-backdrop)").forEach((element) => {
    element.inert = inert;
  });
}

function closeArchiveDialog(): void {
  if (deleting) return;
  const target = archiveFocusTarget;
  archiveConfirmation = null;
  archiveFocusTarget = null;
  drawAgents();
  setAgentsBackgroundInert(false);
  queueMicrotask(() => {
    if (archiveConfirmation || appState.currentView !== "agents") return;
    const fallback = target?.dataset.agentId
      ? [...(agentsPageHost?.querySelectorAll<HTMLElement>(".agent-archive-trigger") ?? [])].find(
          (element) => element.dataset.agentId === target.dataset.agentId,
        )
      : null;
    restoreDialogFocus(target, () => fallback);
  });
}

function requestArchive(a: AgentItem, trigger?: HTMLElement): void {
  if (deleting) return;
  archiveFocusTarget = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  archiveConfirmation = a;
  drawAgents();
  setAgentsBackgroundInert(true);
  queueMicrotask(() => {
    if (archiveConfirmation?.id !== a.id || appState.currentView !== "agents") return;
    if (agentsPageHost) focusDialogCancel(agentsPageHost);
  });
}

async function performArchive(a: AgentItem): Promise<void> {
  if (deleting) return;
  archiveConfirmation = null;
  archiveFocusTarget = null;
  deleting = a.id;
  agentsNotice = "";
  drawAgents();
  setAgentsBackgroundInert(false);
  try {
    await api(`/api/agents/${encodeURIComponent(a.id)}`, { method: "DELETE" });
    deleting = null;
    await renderAgents();
  } catch (e) {
    deleting = null;
    agentsNotice = errMessage(e, "Failed to archive agent.");
    drawAgents();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function agentRow(a: AgentItem): TemplateResult {
  return html`
    <div class="skill-variant agent-row ${a.enabled ? "" : "archived"}">
      <span class="persona-dot" style=${`--persona-color: ${a.color};`}>${a.glyph}</span>
      <div class="skill-variant-copy">
        <div class="skill-variant-description" title=${`@${a.name}`}>@${a.name}</div>
        <div class="skill-variant-meta">${agentMeta(a)}</div>
        <details class="skill-variant-details">
          <summary>Instructions</summary>
          <p>${a.instructions || "No instructions set."}</p>
          <dl>
            <div>
              <dt>Scope</dt>
              <dd>${a.scopeId}</dd>
            </div>
            <div>
              <dt>Created by</dt>
              <dd>${a.createdBy}</dd>
            </div>
          </dl>
        </details>
      </div>
      <div class="skill-variant-state">
        <span class="badge ${a.enabled ? "skill-active" : ""}">${a.enabled ? "Enabled" : "Disabled"}</span>
        ${
          a.editable
            ? html`<button
                class="btn agent-edit-trigger"
                data-agent-id=${a.id}
                type="button"
                ?disabled=${deleting === a.id}
                @click=${() => startEdit(a)}
              >
                Edit
              </button>`
            : nothing
        }
        ${
          a.editable
            ? html`<button
                class="btn agent-archive-trigger"
                data-agent-id=${a.id}
                type="button"
                ?disabled=${deleting === a.id}
                @click=${(event: Event) => requestArchive(a, event.currentTarget as HTMLElement)}
              >
                ${deleting === a.id ? "Working…" : "Archive"}
              </button>`
            : nothing
        }
      </div>
    </div>
  `;
}

function colorField(d: AgentDraft): TemplateResult {
  return html`<div class="skill-field">
    <span>Colour</span>
    <div class="agent-color-row">
      <input
        id="agent-color"
        class="agent-color-input"
        type="color"
        aria-label="Agent colour"
        .value=${d.color}
        ?disabled=${saving}
        @input=${(ev: Event) => {
          d.color = (ev.target as HTMLInputElement).value;
          drawAgents();
        }}
      />
      <div class="agent-swatches" role="group" aria-label="Preset colours">
        ${AGENT_COLOR_PRESETS.map(
          (preset) =>
            html`<button
              class="agent-swatch ${d.color.toLowerCase() === preset ? "selected" : ""}"
              type="button"
              title=${preset}
              aria-label=${`Use ${preset}`}
              aria-pressed=${d.color.toLowerCase() === preset ? "true" : "false"}
              style=${`--persona-color: ${preset};`}
              ?disabled=${saving}
              @click=${() => {
              d.color = preset;
              drawAgents();
            }}
            ></button>`,
        )}
      </div>
    </div>
    ${fieldError("color")}
  </div>`;
}

function runtimeFields(d: AgentDraft): TemplateResult {
  const harnesses = getHarnessOptions(runtimeScope);
  const models = getModelOptionsForHarness(d.harnessId, runtimeScope);
  return html`
    <label class="skill-field">
      <span>Harness</span>
      ${fieldSelect({
        className: "agent-harness-select",
        value: d.harnessId,
        disabled: saving,
        onChange: (value) => {
          d.harnessId = value;
          d.modelId = firstModelFor(value);
          drawAgents();
        },
        options: harnesses.map((h) => html`<option value=${h.value}>${h.label}</option>`),
      })}
      <small class="card-meta">Only org-approved harnesses appear here.</small>
    </label>
    <label class="skill-field">
      <span>Model</span>
      ${fieldSelect({
        className: "agent-model-select",
        value: d.modelId,
        disabled: saving || !models.length,
        onChange: (value) => {
          d.modelId = value;
          drawAgents();
        },
        options: models.length
          ? models.map((m) => html`<option value=${m.model.id}>${m.label}</option>`)
          : [html`<option value="">No models available for this harness</option>`],
      })}
    </label>
  `;
}

function formPane(): TemplateResult {
  const d = draft!;
  const creating = draftMode === "create";
  let saveLabel = creating ? "Create agent" : "Save";
  if (saving) saveLabel = "Saving…";
  return html`
    <form
      class="skill-form-page agent-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void saveDraft();
      }}
    >
      ${listBackLink("Back to agents", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">${creating ? "New agent" : `Edit @${d.name || "agent"}`}</h1>
          <p>
            A named voice you can put in a room. It runs under this context's governance, with its own harness, model,
            and instructions.
          </p>
        </div>
        <span class="badge">${creating ? "New" : "Editing"}</span>
      </div>
      <label class="skill-field">
        <span>Name</span>
        <input
          id="agent-name"
          class="skill-desc-input"
          type="text"
          placeholder="Scout"
          maxlength=${AGENT_NAME_MAX}
          autocomplete="off"
          .value=${d.name}
          ?disabled=${saving}
          @input=${(ev: Event) => {
            d.name = (ev.target as HTMLInputElement).value;
            drawAgents();
          }}
        />
        <small class="card-meta">This is the @mention token, so no spaces.</small>
        ${fieldError("name")}
      </label>
      ${
        creating && createScopes.length > 1
          ? html`<label class="skill-field">
              <span>Available to</span>
              ${fieldSelect({
                className: "agent-scope-select",
                value: d.scopeId,
                disabled: saving,
                onChange: (value) => {
                  d.scopeId = value;
                  drawAgents();
                },
                options: createScopes.map((scope) => html`<option value=${scope.scopeId}>${scope.name}</option>`),
              })}
            </label>`
          : nothing
      }
      <div class="agent-identity-row">
        ${colorField(d)}
        <label class="skill-field agent-glyph-field">
          <span>Glyph</span>
          <input
            id="agent-glyph"
            class="skill-desc-input agent-glyph-input"
            type="text"
            placeholder="SC"
            .value=${d.glyph}
            ?disabled=${saving}
            @input=${(ev: Event) => {
              d.glyph = (ev.target as HTMLInputElement).value;
              drawAgents();
            }}
          />
          <small class="card-meta">1-2 characters for the transcript chip.</small>
          ${fieldError("glyph")}
        </label>
      </div>
      ${runtimeFields(d)}
      <label class="skill-field">
        <span>Instructions</span>
        <textarea
          class="skill-body-input"
          spellcheck="false"
          placeholder="How this agent behaves in a room — its brief, its stance, what it should push on."
          maxlength=${AGENT_INSTRUCTIONS_MAX}
          ?disabled=${saving}
          @input=${(ev: Event) => {
            d.instructions = (ev.target as HTMLTextAreaElement).value;
            drawAgents();
          }}
          .value=${d.instructions}
        ></textarea>
        <small class="card-meta">Composed below the org policy, which it can add to but never override.</small>
        ${fieldError("instructions")}
      </label>
      <div class="skill-field">
        <span>Status</span>
        <div class="resource-tabs" role="group" aria-label="Agent status">
          ${(
            [
              [true, "Enabled"],
              [false, "Disabled"],
            ] as const
          ).map(
            ([value, label]) =>
              html`<button
                type="button"
                aria-pressed=${d.enabled === value}
                class=${d.enabled === value ? "active" : ""}
                ?disabled=${saving}
                @click=${() => {
                  d.enabled = value;
                  drawAgents();
                }}
              >
                ${label}
              </button>`,
          )}
        </div>
        <small class="card-meta">Disabled agents stay listed but cannot be added to a room.</small>
      </div>
      ${formError ? html`<div class="form-error" role="alert">${formError}</div>` : nothing}
      <div class="actions skill-form-actions">
        <button class="btn primary" type="submit" ?disabled=${saving}>${saveLabel}</button>
        <button class="btn" type="button" ?disabled=${saving} @click=${closeFocusedFlow}>Cancel</button>
      </div>
    </form>
  `;
}

function archiveDialog(a: AgentItem): TemplateResult {
  return html`<div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeArchiveDialog()}
  >
    <div
      class="project-dialog agent-archive-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-archive-title"
      aria-describedby="agent-archive-impact"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeArchiveDialog)}
    >
      <div class="project-dialog-head">
        <div><h2 id="agent-archive-title">Archive @${a.name}?</h2></div>
      </div>
      <p id="agent-archive-impact">
        It stops being available for new rooms. Rooms it already spoke in keep their transcript, and its turns stay
        attributed by name.
      </p>
      <div class="project-dialog-actions actions">
        <button
          class="btn"
          type="button"
          data-dialog-cancel
          ?disabled=${deleting === a.id}
          @click=${closeArchiveDialog}
        >
          Cancel</button
        ><button
          class="btn danger agent-archive-confirm"
          type="button"
          ?disabled=${deleting === a.id}
          @click=${() => void performArchive(a)}
        >
          ${deleting === a.id ? "Archiving…" : "Archive agent"}
        </button>
      </div>
    </div>
  </div>`;
}

function roomsDisabledCard(): TemplateResult {
  return html`<div class="agent-disabled-card">
    <span class="agent-disabled-glyph">${icon(Users, 20)}</span>
    <div>
      <strong>${AGENT_ROOMS_DISABLED_COPY}</strong>
      <p class="card-meta">Agents and rooms appear here once this deployment turns the feature on.</p>
    </div>
  </div>`;
}

function drawAgents(loading = false): void {
  if (appState.currentView !== "agents" || !appState.mainEl) return;
  if (!agentsPageHost || agentsPageHost.parentElement !== appState.mainEl) {
    agentsPageHost = document.createElement("div");
    agentsPageHost.className = "pane agents-page";
    appState.mainEl.replaceChildren(agentsPageHost);
  }
  if (draft) {
    render(formPane(), agentsPageHost);
    return;
  }
  const filtered = filterAgents(agentRows, { query: agentSearch, scope: scopeFilter, status: statusFilter });
  const counts = agentStatusCounts(agentRows);
  const state = agentEmptyState(agentRows.length, filtered.length, loading, !roomsDisabled);
  let empty: string | TemplateResult = "No agents yet. Create one, then put a few in a room.";
  if (state === "disabled") empty = roomsDisabledCard();
  else if (state === "loading") empty = "Loading agents…";
  else if (state === "filtered") {
    empty = html`<div class="skill-empty">
      <span>No agents match these filters.</span
      ><button
        class="btn"
        type="button"
        @click=${() => {
          agentSearch = "";
          scopeFilter = "all";
          statusFilter = "all";
          drawAgents();
        }}
      >
        Clear filters
      </button>
    </div>`;
  }
  render(
    html`${listPageTpl({
      title: "Agents",
      onRefresh: () => void renderAgents(),
      ...(roomsDisabled ? {} : { action: { label: "New agent", onClick: startCreate } }),
      search: {
        value: agentSearch,
        placeholder: "Search agents…",
        onInput: (value) => {
          agentSearch = value;
          drawAgents();
        },
      },
      filters: html`<div class="skill-registry-controls">
          <div class="resource-tabs" role="group" aria-label="Filter by agent status">
            ${(
              [
                ["all", "All", counts.all],
                ["enabled", "Enabled", counts.enabled],
                ["disabled", "Disabled", counts.disabled],
              ] as const
            ).map(
              ([value, label, count]) =>
                html`<button
                  type="button"
                  aria-pressed=${statusFilter === value}
                  class=${statusFilter === value ? "active" : ""}
                  @click=${() => {
                    statusFilter = value;
                    drawAgents();
                  }}
                >
                  ${label}<span>${count}</span>
                </button>`,
            )}
          </div>
          <div class="skill-filter-fields">
            <label class="list-select"
              ><span>Scope</span>${fieldSelect({
                compact: true,
                ariaLabel: "Filter agents by scope",
                value: scopeFilter,
                onChange: (value) => {
                  scopeFilter = value;
                  drawAgents();
                },
                options: [
                  html`<option value="all">All scopes</option>`,
                  html`<option value="personal">Personal</option>`,
                  html`<option value="channel">Channel</option>`,
                  html`<option value="group">Project / group</option>`,
                  html`<option value="team">Team</option>`,
                  html`<option value="org">Organization</option>`,
                ],
              })}</label
            >
          </div>
        </div>
        <div class="skill-result-count" aria-live="polite">
          ${loading ? "Loading…" : `${filtered.length} agent${filtered.length === 1 ? "" : "s"}`}
        </div>
        ${agentsNotice ? html`<div class="status">${agentsNotice}</div>` : nothing}`,
      rows: filtered.map(agentRow),
      empty,
    })}${archiveConfirmation ? archiveDialog(archiveConfirmation) : nothing}`,
    agentsPageHost,
  );
}

export function resetAgentsState(): void {
  refreshSeq += 1;
  agentRows = [];
  agentsNotice = "";
  agentSearch = "";
  scopeFilter = "all";
  statusFilter = "all";
  draft = null;
  saving = false;
  formError = "";
  deleting = null;
  archiveConfirmation = null;
  roomsDisabled = false;
}

export async function renderAgents(): Promise<void> {
  if (appState.currentView !== "agents") return;
  if (!agentsPageHost || agentsPageHost.parentElement !== appState.mainEl) {
    archiveConfirmation = null;
    archiveFocusTarget = null;
    setAgentsBackgroundInert(false);
  }
  const seq = appState.viewRenderSeq;
  const request = ++refreshSeq;
  agentsNotice = "";
  drawAgents(true);

  const personal = appState.me ? `personal:${appState.me.user}` : "";
  runtimeScope = personal || null;
  const runtime = await fetchRuntimeConfig(personal || null);
  if (runtime) {
    applyRuntimeOptions(
      runtimeScope,
      runtime.approvedHarnesses,
      runtime.modelsByHarness,
      runtime.effective,
      runtime.modelCatalog,
    );
  }

  try {
    const [r, contexts] = await Promise.all([
      api<{ agents: AgentItem[] }>("/api/agents"),
      api<{ contexts?: CoreContext[] }>("/api/contexts").catch(() => ({ contexts: [] })),
    ]);
    if (request !== refreshSeq || seq !== appState.viewRenderSeq || appState.currentView !== "agents") return;
    roomsDisabled = false;
    agentRows = (r.agents ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    cachePersonas(agentRows);
    createScopes = [
      { scopeId: personal, name: "Personal — only you" },
      ...(contexts.contexts ?? [])
        .filter(
          (context) =>
            context.scopeId !== personal &&
            (context.kind === "group" || (context.kind === "channel" && context.isPrivate)),
        )
        .map((context) => ({ scopeId: context.scopeId, name: context.name || context.scopeId })),
    ].filter((scope) => scope.scopeId);
  } catch (e) {
    if (request !== refreshSeq || seq !== appState.viewRenderSeq || appState.currentView !== "agents") return;
    agentRows = [];
    // Core mounts /v1/agents only under QM_AGENT_ROOMS=1; a 404 means the flag is off,
    // which is a deployment state to explain, not an error to apologise for.
    if (e instanceof ApiError && e.status === 404) roomsDisabled = true;
    else agentsNotice = errMessage(e, "Failed to load agents.");
  }
  if (request === refreshSeq) drawAgents(false);
}

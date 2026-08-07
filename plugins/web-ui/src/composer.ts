import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Attachment } from "@earendil-works/pi-web-ui";
import { FolderDropError, folderToZipFile, isFolderReadError, splitDropItems, type DropEntryLike } from "./folder-drop";
import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import {
  ArrowUp,
  Box,
  Brain,
  Check,
  ChevronDown,
  FileText,
  Paperclip,
  ScrollText,
  SlidersHorizontal,
  Square,
  X,
  Zap,
  type IconNode,
} from "lucide";
import {
  api,
  fetchRuntimeConfig,
  updateRuntimeConfig,
  type ApprovalDecision,
  type PendingApproval,
  type RuntimeConfig,
} from "./core-bridge";
import { errMessage, swallow } from "../../chassis/src/errors";
import { icon } from "./ui";
import {
  EFFORT_LEVELS,
  applyRuntimeOptions,
  defaultEffortForModel,
  defaultModelValue,
  effortLabel,
  getHarnessOptions,
  getModelOptions,
  getModelOptionsForHarness,
  harnessSupportsEffort,
  harnessSupportsFastMode,
  type EffortLevel,
  type ModelOption,
  type ModelOptionValue,
} from "./model-options";
import { modelSupportsFastMode, setFastModeModelIds } from "./pi-models";
import type { ComposerSurface, ConvCtx } from "./conv-types";
import { bumpSessionActivity, dropPendingSession, renderList } from "./sessions";
import { adminSessionLogUrl, appState, can } from "./shell";
import { base64ToText, bytesToBase64, insertIntoDraft, pasteChipLabel } from "./paste-text";
import { clearDraft, newChatDraftKey, saveDraft } from "./drafts";
import { cachedAgents, cachedPersona, clearRoomRefusal, isRoomThread, roomFor, roomRefusalFor } from "./room-state";
import { ensureRoomPersonas } from "./rooms";
import { mentionSegments, viewerMentionName, type MentionTarget } from "./mentions";

export type ComposerMenu = "effort" | "harness" | "model" | "settings";

/** What a caller other than the composer's own form can vary about a send. */
export interface SendOptions {
  /**
   * Text to send instead of the main composer's draft. Present exactly when the send came
   * from somewhere with a draft of its own — today, the thread panel's composer.
   */
  text?: string;
  /** The thread root's seq, when this send is a reply into that thread. */
  replyToSeq?: number;
}

const LEGACY_MODEL_STORAGE_KEY = "web-ui:model";
const THREAD_PICKS_STORAGE_KEY = "web-ui:model-picks";
const THREAD_PICKS_CAP = 50;
const FAST_MODE_STORAGE_KEY = "web-ui:fast-mode";
const EFFORT_STORAGE_KEY = "web-ui:effort";

function loadThreadPicks(): Map<string, ModelOptionValue> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(THREAD_PICKS_STORAGE_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      const pairs = raw.filter(
        (p): p is [string, string] => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string",
      );
      return new Map(pairs.slice(-THREAD_PICKS_CAP));
    }
  } catch {
    void 0;
  }
  return new Map();
}

let threadModelPicks = loadThreadPicks();
let seededRuntime: { scopeId: string | null; config: RuntimeConfig } | null = null;

export function seedRuntimeConfig(scopeId: string | null, config: RuntimeConfig): void {
  seededRuntime = { scopeId: runtimeScopeKey(scopeId), config };
}

function runtimeScopeKey(scopeId: string | null): string | null {
  if (scopeId) return scopeId;
  const user = appState.me?.user;
  return user ? `personal:${user}` : null;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === THREAD_PICKS_STORAGE_KEY) threadModelPicks = loadThreadPicks();
  });
}

function rememberThreadPick(threadRef: string, value: ModelOptionValue): void {
  const merged = loadThreadPicks();
  for (const [ref, pick] of threadModelPicks) if (!merged.has(ref)) merged.set(ref, pick);
  merged.delete(threadRef);
  merged.set(threadRef, value);
  while (merged.size > THREAD_PICKS_CAP) merged.delete(merged.keys().next().value as string);
  threadModelPicks = merged;
  persistPreference(THREAD_PICKS_STORAGE_KEY, JSON.stringify([...merged]));
}

export function carryModelPick(fromThreadRef: string | null, toThreadRef: string): void {
  const pick = fromThreadRef ? threadModelPicks.get(fromThreadRef) : undefined;
  if (pick) rememberThreadPick(toThreadRef, pick);
}

function modelOptionFor(value: ModelOptionValue, scopeKey?: string | null): ModelOption {
  const options = getModelOptions(scopeKey);
  return (
    options.find((option) => option.value === value) ??
    options.find((option) => option.value === defaultModelValue()) ??
    options[0]
  );
}

function loadStoredFastMode(): boolean | undefined {
  try {
    const stored = localStorage.getItem(FAST_MODE_STORAGE_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    void 0;
  }
  return undefined;
}

function loadStoredEffort(fallback: EffortLevel): EffortLevel {
  try {
    const stored = localStorage.getItem(EFFORT_STORAGE_KEY);
    if (stored && EFFORT_LEVELS.some((option) => option.value === stored)) return stored as EffortLevel;
  } catch {
    void 0;
  }
  return fallback;
}

function persistPreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    void 0;
  }
}

export interface SkillItem {
  id?: string;
  name: string;
  description: string;
  body?: string;
  scope: string;
  shadowed?: boolean;
  editable?: boolean;
  scopeId?: string;
  status?: string;
  version?: number;
  source?: "native" | "pack";
  pack?: { packId: string; commit: string; upstreamName: string };
  assetCount?: number;
  requiredCapabilities?: string[];
  createdBy?: string;
  files?: Array<{ path: string; executable?: boolean }>;
}
interface SkillMatch {
  skill: SkillItem;
  start: number;
  end: number;
}

let skillsCache: SkillItem[] | null = null;

export function clearSkillsCache(): void {
  skillsCache = null;
}

const SLASH_TOKEN = /(^|\s)\/([a-zA-Z0-9_-]*)$/;

export function slashQuery(draft: string): string | null {
  const m = SLASH_TOKEN.exec(draft);
  return m ? (m[2] ?? "") : null;
}

/**
 * The `@mention` autocomplete token, structurally the same trick as `SLASH_TOKEN`: only the
 * trailing run of the draft counts, so the popover follows whatever is being typed right now
 * rather than any `@` earlier in the message. The character class deliberately includes a
 * space — an agent name cannot contain one today (`AGENT_NAME_PATTERN`), but the query is
 * filtered against the roster regardless of what it captures, so a name that later gains
 * multi-word support costs nothing here. This is purely a typing aid: it has no bearing on
 * `mentions.ts`'s `matchesAt`, which is the actual grammar a rendered `@Name` is checked
 * against, and which this file must never touch.
 */
const MENTION_TOKEN = /(^|\s)@([A-Za-z0-9 ._-]*)$/;

export function mentionQuery(draft: string): string | null {
  const m = MENTION_TOKEN.exec(draft);
  return m ? (m[2] ?? "") : null;
}

export function resyncModelSelection(): void {
  try {
    localStorage.removeItem(LEGACY_MODEL_STORAGE_KEY);
  } catch {
    void 0;
  }
}

export function createComposerSurface(ctx: ConvCtx): ComposerSurface {
  let activeRuntimeConfig: RuntimeConfig | null = null;
  let runtimeRequest = 0;

  function isUnsentNewChat(): boolean {
    return (
      ctx.chat.state.sessionId === null &&
      !(ctx.chat.state.agent?.state.messages ?? []).some((m) => !(m as { opener?: boolean }).opener)
    );
  }

  function persistDraft(): void {
    if (!ctx.chat.state.threadRef) return;
    saveDraft(ctx.chat.state.threadRef, composerState.draft);
    if (isUnsentNewChat()) saveDraft(newChatDraftKey(appState.me?.user), composerState.draft);
  }

  function clearActiveDraft(): void {
    if (ctx.chat.state.threadRef) clearDraft(ctx.chat.state.threadRef);
    if (ctx.chat.state.sessionId === null) clearDraft(newChatDraftKey(appState.me?.user));
  }

  const composerState = {
    draft: "",
    attachments: [] as Attachment[],
    error: "",
    processingFiles: false,
    dragging: false,
    openMenu: null as ComposerMenu | null,
    slashDismissed: false,
    mentionDismissed: false,
    effortLevel: loadStoredEffort(defaultEffortForModel(modelOptionFor(defaultModelValue()).model)),
    fastMode: loadStoredFastMode(),
    pasteView: null as { id: string; text: string; initial: string; dirty: boolean } | null,
  };

  const pastedTextIds = new Set<string>();

  let dragDepth = 0;
  let skillsLoading = false;
  let slashActiveIndex = 0;
  let mentionActiveIndex = 0;
  // Fire-and-forget: `ensureRoomPersonas()` memoises the `/api/agents` fetch, so this is a
  // no-op after the first composer mounts. The autocomplete degrades gracefully if a keystroke
  // races it — an empty candidate list just means the popover has nothing to show yet.
  void ensureRoomPersonas().then(() => {
    if (ctx.chat.state.agent) ctx.chat.drawActiveChat(ctx.chat.state.agent);
  });
  let fastModeCharging = false;
  let orgFastModeDefault = false;
  let fastModeChargeTimer: ReturnType<typeof setTimeout> | null = null;

  function effectiveFastMode(): boolean {
    return composerState.fastMode ?? orgFastModeDefault;
  }

  function resetComposer(): void {
    composerState.draft = "";
    composerState.attachments = [];
    composerState.pasteView = null;
    pastedTextIds.clear();
    composerState.error = "";
    composerState.processingFiles = false;
    composerState.openMenu = null;
    slashActiveIndex = 0;
    composerState.slashDismissed = false;
    mentionActiveIndex = 0;
    composerState.mentionDismissed = false;
  }

  function scopeKey(): string | null {
    return runtimeScopeKey(ctx.chat.state.scopeId);
  }

  /**
   * In a room every persona brings its own harness and model, so a per-thread override
   * would be meaningless — the pickers are hidden and the header shows the roster instead.
   */
  function roomThread(): boolean {
    return isRoomThread(ctx.chat.state.threadRef);
  }

  function currentModelOption(): ModelOption {
    const picked = ctx.chat.state.threadRef ? threadModelPicks.get(ctx.chat.state.threadRef) : undefined;
    return modelOptionFor(picked ?? defaultModelValue(scopeKey()), scopeKey());
  }

  async function refreshRuntimeSelection(scopeId: string | null, agent?: Agent): Promise<void> {
    const request = ++runtimeRequest;
    const scopeKey = runtimeScopeKey(scopeId);
    const seeded = scopeKey !== null && seededRuntime?.scopeId === scopeKey ? seededRuntime.config : null;
    if (seeded) {
      applySelectedRuntime(seeded, agent);
      return;
    }
    activeRuntimeConfig = null;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    const config = await fetchRuntimeConfig(scopeId);
    if (request !== runtimeRequest) return;
    if (!config) {
      composerState.error = "Could not load runtime settings.";
      ctx.chat.drawActiveChat(agent);
      return;
    }
    applySelectedRuntime(config, agent);
  }

  function applySelectedRuntime(config: RuntimeConfig, agent?: Agent): void {
    activeRuntimeConfig = config;
    composerState.error = "";
    setFastModeModelIds(scopeKey(), config.fastModeModelIds);
    orgFastModeDefault = config.interactiveFastMode === true;
    applyRuntimeOptions(
      scopeKey(),
      config.approvedHarnesses,
      config.modelsByHarness,
      config.effective,
      config.modelCatalog,
    );
    if (agent && (!ctx.chat.state.threadRef || !threadModelPicks.has(ctx.chat.state.threadRef)))
      agent.state.model = currentModelOption().model;
    ctx.chat.drawActiveChat(agent);
    if (pendingComposerFocus) focusComposerEnd();
  }

  async function changeScopeRuntime(
    change: { harnessId?: string; modelId?: string; inherit?: boolean; keep?: boolean },
    agent: Agent,
  ): Promise<void> {
    const request = ++runtimeRequest;
    const scopeId = ctx.chat.state.scopeId;
    try {
      const config = await updateRuntimeConfig(scopeId, change);
      if (request !== runtimeRequest || scopeId !== ctx.chat.state.scopeId) return;
      seededRuntime = null;
      activeRuntimeConfig = config;
      setFastModeModelIds(scopeKey(), config.fastModeModelIds);
      orgFastModeDefault = config.interactiveFastMode === true;
      applyRuntimeOptions(
        scopeKey(),
        config.approvedHarnesses,
        config.modelsByHarness,
        config.effective,
        config.modelCatalog,
      );
      if (!ctx.chat.state.threadRef || !threadModelPicks.has(ctx.chat.state.threadRef))
        agent.state.model = currentModelOption().model;
      composerState.error = "";
    } catch (e) {
      if (request !== runtimeRequest || scopeId !== ctx.chat.state.scopeId) return;
      composerState.error = errMessage(e, "Could not update the scope default.");
    }
    ctx.chat.drawActiveChat(agent);
  }

  function composerForm(agent: Agent): TemplateResult {
    const selectedModel = currentModelOption();
    const effortAvailable = harnessSupportsEffort(selectedModel.harnessId);
    const fastSupported = harnessSupportsFastMode(selectedModel.harnessId);
    const fastAvailable = fastSupported && modelSupportsFastMode(scopeKey(), selectedModel.model.id);
    const fastOn = fastAvailable && effectiveFastMode();
    const fastCharging = fastModeCharging && fastOn;
    let fastTitle = "Fast mode is only available on Opus models";
    if (fastAvailable) fastTitle = fastOn ? "Fast mode active" : "Fast mode";
    const approvalPauses = ctx.chat.activePendingApprovals();
    const runtimePending = activeRuntimeConfig === null;
    const modelToggled = !runtimePending && selectedModel.value !== defaultModelValue(scopeKey());
    const inputBlocked = runtimePending || ctx.chat.state.resolvingApprovals.size > 0 || approvalPauses.length > 0;
    const attachingDisabled = inputBlocked;
    let placeholder = "Ask anything";
    if (inputBlocked) placeholder = runtimePending ? "Loading runtime…" : "Approve or deny to continue";
    else if (agent.state.isStreaming) placeholder = "Steer the running task…";
    // Routing is core's: an untagged message goes to the whole roster, a tagged one only to
    // the agents named. The composer just says so — it never decides who replies.
    else if (roomThread()) placeholder = "Message the room — @mention an agent to have only them reply.";
    let composerNotice: TemplateResult | typeof nothing = nothing;
    if (composerState.processingFiles) {
      composerNotice = html`<div class="composer-note">Preparing files...</div>`;
    } else if (!approvalPauses.length && runtimePending) {
      composerNotice = composerState.error
        ? html`<div class="composer-error">
            ${composerState.error}
            <button type="button" @click=${() => void refreshRuntimeSelection(ctx.chat.state.scopeId, agent)}>
              Retry
            </button>
          </div>`
        : html`<div class="composer-note">Loading runtime settings…</div>`;
    } else if (composerState.error) {
      composerNotice = html`<div class="composer-error">${composerState.error}</div>`;
    } else {
      // A roster core refused on the first message. It sits here rather than in the
      // transcript because no persona ever took a turn, and the fix is the human's.
      const refusal = roomRefusalFor(ctx.chat.state.threadRef);
      if (refusal) {
        composerNotice = html`<div class="composer-error room-refusal">
          <span>This room could not start: ${refusal}</span>
          <button
            type="button"
            @click=${() => {
              clearRoomRefusal(ctx.chat.state.threadRef);
              ctx.chat.drawActiveChat(agent);
            }}
          >
            Dismiss
          </button>
        </div>`;
      }
    }
    return html`
      <form class="composer-wrap" @submit=${(e: Event) => submitComposer(e, agent)}>
        ${slashMenu(agent)} ${mentionMenu(agent)}
        ${
          activeRuntimeConfig?.upgradeAvailable
            ? html`<div class="runtime-upgrade">
                <span
                  >The org now recommends
                  ${modelOptionFor(`${activeRuntimeConfig.orgDefault.harnessId}:${activeRuntimeConfig.orgDefault.modelId}`).harnessLabel}
                  ·
                  ${modelOptionFor(`${activeRuntimeConfig.orgDefault.harnessId}:${activeRuntimeConfig.orgDefault.modelId}`).buttonLabel}.</span
                >
                <button
                  type="button"
                  @click=${() => changeScopeRuntime({ harnessId: activeRuntimeConfig!.orgDefault.harnessId, modelId: activeRuntimeConfig!.orgDefault.modelId }, agent)}
                >
                  Upgrade
                </button>
                <button type="button" @click=${() => changeScopeRuntime({ keep: true }, agent)}>Keep mine</button>
                <button type="button" @click=${() => changeScopeRuntime({ inherit: true }, agent)}>
                  Inherit future defaults
                </button>
              </div>`
            : nothing
        }
        ${
          composerState.attachments.length
            ? html`
                <div class="attachment-strip">
                  ${composerState.attachments.map(
                    (a) => html`
                      <span class="file-chip">
                        ${
                          pastedTextIds.has(a.id)
                            ? html`
                                <button
                                  type="button"
                                  class="chip-open"
                                  title="View pasted text"
                                  @click=${() => openPasteView(a.id, agent)}
                                >
                                  ${icon(FileText, 14)}
                                  <span>${pasteChipLabel(a.extractedText?.length ?? 0)}</span>
                                </button>
                              `
                            : html`${icon(Paperclip, 14)}<span>${a.fileName}</span>`
                        }
                        <button
                          type="button"
                          class="chip-x"
                          title="Remove"
                          @click=${() => removeAttachment(a.id, agent)}
                        >
                          ${icon(X, 13)}
                        </button>
                      </span>
                    `,
                  )}
                </div>
              `
            : nothing
        }
        ${
          approvalPauses.length
            ? composerApprovalPanel(approvalPauses)
            : html`
                <div class="composer-input-wrap">
                  ${mirrorHost(composerState.draft, mentionTargetsFor(ctx.chat.state.threadRef))}
                  <textarea
                    class="composer-input"
                    rows="1"
                    placeholder=${placeholder}
                    ?disabled=${inputBlocked}
                    .value=${live(composerState.draft)}
                    @input=${(e: InputEvent) => onDraftInput(e, agent)}
                    @keydown=${(e: KeyboardEvent) => onComposerKeydown(e, agent)}
                    @paste=${(e: ClipboardEvent) => void onComposerPaste(e, agent)}
                    @scroll=${onComposerScroll}
                  ></textarea>
                </div>
              `
        }
        <div class="composer-toolbar">
          <div class="composer-left">
            ${
              !ctx.pane && ctx.chat.state.sessionId && can("admin")
                ? html`<a
                    class="icon-btn"
                    title="View session log (admin)"
                    href=${adminSessionLogUrl(ctx.chat.state.sessionId, ctx.chat.state.scopeId ?? `org:${appState.me?.org ?? ""}`)}
                    target="_blank"
                    rel="noreferrer"
                    >${icon(ScrollText, 18)}</a
                  >`
                : nothing
            }
            <input
              class="file-input"
              type="file"
              multiple
              hidden
              ?disabled=${attachingDisabled}
              @change=${(e: Event) => void onFilesSelected(e, agent)}
            />
            <button
              class="icon-btn"
              type="button"
              title="Attach files"
              ?disabled=${attachingDisabled}
              @click=${() => pickFiles()}
            >
              ${icon(Paperclip, 18)}
            </button>
            ${
              ctx.pane
                ? nothing
                : html`
                    ${
                      effortAvailable
                        ? menuControl({
                            kind: "effort",
                            glyph: Brain,
                            label: effortLabel(composerState.effortLevel),
                            title: "Effort",
                            selected: composerState.effortLevel,
                            options: EFFORT_LEVELS,
                            disabled: inputBlocked,
                            onSelect: (value: string) => selectEffort(value as EffortLevel, agent),
                          })
                        : nothing
                    }
                    ${
                      fastSupported
                        ? html`<button
                            class="fast-toggle ${fastOn ? "active" : ""} ${fastCharging ? "charging" : ""} ${fastAvailable ? "" : "unavailable"}"
                            type="button"
                            title=${fastTitle}
                            aria-label=${fastTitle}
                            aria-pressed=${fastOn ? "true" : "false"}
                            aria-disabled=${fastAvailable ? "false" : "true"}
                            ?disabled=${inputBlocked}
                            @click=${() => toggleFastMode(agent)}
                          >
                            ${icon(Zap, 15)}
                            <span class="fast-label">Fast</span>
                          </button>`
                        : nothing
                    }
                  `
            }
          </div>
          <div class="composer-right">
            ${
              ctx.pane
                ? settingsControl(agent, selectedModel, inputBlocked)
                : roomThread()
                  ? nothing
                  : html`
                      ${
                        modelToggled
                          ? html`<button
                              class="runtime-default-btn"
                              type="button"
                              aria-label="Make default"
                              data-mobile-label="Default"
                              title="Use this harness and model as the default for this scope"
                              ?disabled=${inputBlocked}
                              @click=${() => changeScopeRuntime({ harnessId: selectedModel.harnessId, modelId: selectedModel.model.id }, agent)}
                            >
                              Make default
                            </button>`
                          : nothing
                      }
                      ${
                        modelToggled && activeRuntimeConfig?.scopeOverride
                          ? html`<button
                              class="runtime-default-btn"
                              type="button"
                              aria-label="Use org default"
                              data-mobile-label="Org default"
                              ?disabled=${inputBlocked}
                              @click=${() => changeScopeRuntime({ inherit: true }, agent)}
                            >
                              Use org default
                            </button>`
                          : nothing
                      }
                      ${menuControl({
                        kind: "model",
                        label: selectedModel.buttonLabel,
                        title: "Model",
                        selected: selectedModel.value,
                        align: "right",
                        options: getModelOptionsForHarness(selectedModel.harnessId, scopeKey()).map((option) => ({
                          value: option.value,
                          label: option.label,
                        })),
                        disabled: inputBlocked,
                        onSelect: (value: string) => selectModel(value, agent),
                      })}
                      ${menuControl({
                        kind: "harness",
                        label: selectedModel.harnessLabel,
                        title: "Harness",
                        selected: selectedModel.harnessId,
                        align: "right",
                        options: getHarnessOptions(scopeKey()),
                        disabled: inputBlocked,
                        onSelect: (value: string) => selectHarness(value, agent),
                      })}
                    `
            }
            ${sendControls(agent)}
          </div>
        </div>
        ${composerNotice}
      </form>
      ${pasteViewDialog(agent)}
    `;
  }

  function pasteViewDialog(agent: Agent): TemplateResult | typeof nothing {
    const view = composerState.pasteView;
    if (!view) return nothing;
    return html`
      <div
        class="project-dialog-backdrop"
        @click=${(e: MouseEvent) => e.target === e.currentTarget && closePasteView(agent)}
        @keydown=${(e: KeyboardEvent) => e.key === "Escape" && closePasteView(agent)}
      >
        <div class="project-dialog paste-dialog" role="dialog" aria-modal="true" aria-labelledby="paste-dialog-title">
          <div class="project-dialog-head">
            <div><h2 id="paste-dialog-title">Pasted text</h2></div>
            <button class="chip-x" type="button" aria-label="Close" title="Close" @click=${() => closePasteView(agent)}>
              ${icon(X, 16)}
            </button>
          </div>
          <textarea
            class="paste-dialog-text"
            @input=${(e: InputEvent) => {
              view.text = (e.currentTarget as HTMLTextAreaElement).value;
              view.dirty = true;
            }}
          >
  ${view.initial}</textarea>
          <div class="project-dialog-actions">
            <button class="btn" type="button" @click=${() => removeAttachment(view.id, agent)}>Remove</button>
            <button class="btn" type="button" @click=${() => insertPasteIntoDraft(agent)}>Insert into message</button>
            <button class="btn primary" type="button" @click=${() => closePasteView(agent)}>Done</button>
          </div>
        </div>
      </div>
    `;
  }

  function openPasteView(id: string, agent: Agent): void {
    const attachment = composerState.attachments.find((a) => a.id === id);
    if (!attachment) return;
    const text = attachment.extractedText ?? base64ToText(attachment.content);
    composerState.pasteView = { id, text, initial: text, dirty: false };
    ctx.chat.drawActiveChat(agent);
    requestAnimationFrame(() => ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".paste-dialog-text")?.focus());
  }

  function closePasteView(agent: Agent): void {
    const view = composerState.pasteView;
    if (!view) return;
    const attachment = composerState.attachments.find((a) => a.id === view.id);
    if (attachment && view.dirty) {
      const bytes = new TextEncoder().encode(view.text);
      attachment.content = bytesToBase64(bytes);
      attachment.size = bytes.length;
      attachment.extractedText = view.text;
    }
    composerState.pasteView = null;
    ctx.chat.drawActiveChat(agent);
  }

  function insertPasteIntoDraft(agent: Agent): void {
    const view = composerState.pasteView;
    if (!view) return;
    const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
    const { draft, cursor } = insertIntoDraft(composerState.draft, view.text, ta ? ta.selectionStart : null);
    composerState.draft = draft;
    persistDraft();
    composerState.pasteView = null;
    removeAttachment(view.id, agent);
    resizeComposer();
    requestAnimationFrame(() => {
      const input = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!input) return;
      input.focus();
      input.setSelectionRange(cursor, cursor);
    });
  }

  function sendControls(agent: Agent): TemplateResult {
    if (!agent.state.isStreaming) {
      return html`<button class="send-btn" type="submit" title="Send" ?disabled=${!composerCanSend()}>
        ${icon(ArrowUp, 17)}
      </button>`;
    }
    const canSteer = Boolean(composerState.draft.trim());
    const steerTitle = composerState.attachments.length
      ? "Steer the running task (attachments stay for your next message)"
      : "Steer the running task";
    return html`
      <button class="stop-btn" type="button" title="Stop" aria-label="Stop" @click=${() => stopStreaming(agent)}>
        ${icon(Square, 16)}
      </button>
      <button class="send-btn" type="submit" title=${steerTitle} aria-label=${steerTitle} ?disabled=${!canSteer}>
        ${icon(ArrowUp, 17)}
      </button>
    `;
  }

  function composerApprovalPanel(approvals: PendingApproval[]): TemplateResult {
    const busy = ctx.chat.state.resolvingApprovals.size > 0;
    const decide = (decision: ApprovalDecision): void => {
      if (!busy) ctx.chat.resolveCommandApproval(decision);
    };
    return html`<div class="composer-approval-panel" role="group" aria-label="Command approval">
      ${approvals.map(
        (a) =>
          html`<div class="composer-approval">
            <div class="composer-approval-copy">${ctx.chat.approvalSummaryView(a, true)}</div>
            <div class="approval-actions">
              <button
                class="approval-btn deny"
                type="button"
                ?disabled=${busy}
                @click=${() => decide({ requestId: a.requestId, approved: false })}
              >
                Deny
              </button>
              <button
                class="approval-btn"
                type="button"
                ?disabled=${busy}
                @click=${() => decide({ requestId: a.requestId, approved: true, scope: "once" })}
              >
                Allow once
              </button>
              ${
                a.grantModes?.session === false
                  ? nothing
                  : html`<button
                      class="approval-btn primary"
                      type="button"
                      ?disabled=${busy}
                      @click=${() => decide({ requestId: a.requestId, approved: true, scope: "session" })}
                    >
                      Allow for session
                    </button>`
              }
              ${
                a.grantModes?.always === false
                  ? nothing
                  : html`<button
                      class="approval-btn"
                      type="button"
                      ?disabled=${busy}
                      @click=${() => decide({ requestId: a.requestId, approved: true, scope: "always" })}
                    >
                      Allow always
                    </button>`
              }
            </div>
          </div>`,
      )}
    </div>`;
  }

  function settingsControl(agent: Agent, selected: ModelOption, disabled: boolean): TemplateResult {
    const open = composerState.openMenu === "settings";
    const fastAvailable =
      harnessSupportsFastMode(selected.harnessId) && modelSupportsFastMode(scopeKey(), selected.model.id);
    const fastOn = fastAvailable && effectiveFastMode();
    const summary = `${selected.buttonLabel} · ${effortLabel(composerState.effortLevel)}${fastOn ? " · Fast" : ""}`;
    return html`
      <div class="menu-control settings-control ${open ? "open" : ""}" data-align="right">
        <button
          class="menu-button settings-button"
          type="button"
          title="Session settings — ${summary}"
          aria-label="Session settings — ${summary}"
          aria-haspopup="menu"
          aria-expanded=${open ? "true" : "false"}
          aria-controls="composer-settings-menu"
          ?disabled=${disabled}
          @click=${(e: Event) => toggleComposerMenu(e, "settings")}
        >
          ${icon(SlidersHorizontal, 16)}
        </button>
        ${
          open && !disabled
            ? html`
                <div
                  class="menu-popover settings-popover"
                  id="composer-settings-menu"
                  role="menu"
                  @click=${(e: Event) => e.stopPropagation()}
                >
                  ${
                    roomThread()
                      ? nothing
                      : html`
                          <div class="menu-title">Model</div>
                          ${getModelOptionsForHarness(selected.harnessId, scopeKey()).map(
                            (option) => html`
                              <button
                                class="menu-option ${option.value === selected.value ? "active" : ""}"
                                type="button"
                                role="menuitemradio"
                                aria-checked=${option.value === selected.value ? "true" : "false"}
                                @click=${() => selectModel(option.value, agent)}
                              >
                                <span class="menu-option-copy">
                                  <span class="menu-option-label">${option.label}</span>
                                </span>
                                ${option.value === selected.value ? icon(Check, 15) : nothing}
                              </button>
                            `,
                          )}
                          <div class="menu-title">Harness</div>
                          <div class="settings-seg" role="group" aria-label="Harness">
                            ${getHarnessOptions(scopeKey()).map(
                              (option) => html`
                                <button
                                  class="settings-chip ${option.value === selected.harnessId ? "active" : ""}"
                                  type="button"
                                  aria-pressed=${option.value === selected.harnessId ? "true" : "false"}
                                  @click=${() => selectHarness(option.value, agent)}
                                >
                                  ${option.label}
                                </button>
                              `,
                            )}
                          </div>
                        `
                  }
                  ${
                    harnessSupportsEffort(selected.harnessId)
                      ? html`
                          <div class="menu-title">Effort</div>
                          <div class="settings-seg" role="group" aria-label="Effort">
                            ${EFFORT_LEVELS.map(
                              (option) => html`
                                <button
                                  class="settings-chip ${option.value === composerState.effortLevel ? "active" : ""}"
                                  type="button"
                                  aria-pressed=${option.value === composerState.effortLevel ? "true" : "false"}
                                  @click=${() => selectEffort(option.value, agent)}
                                >
                                  ${option.label}
                                </button>
                              `,
                            )}
                          </div>
                        `
                      : nothing
                  }
                  ${
                    fastAvailable
                      ? html`
                          <button
                            class="menu-option ${fastOn ? "active" : ""}"
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked=${fastOn ? "true" : "false"}
                            @click=${() => toggleFastMode(agent)}
                          >
                            <span class="menu-option-copy">
                              <span class="menu-option-label">${icon(Zap, 13)} Fast mode</span>
                            </span>
                            ${fastOn ? icon(Check, 15) : nothing}
                          </button>
                        `
                      : nothing
                  }
                </div>
              `
            : nothing
        }
      </div>
    `;
  }

  function menuControl(args: {
    kind: ComposerMenu;
    glyph?: IconNode;
    label: string;
    title: string;
    selected: string;
    options: Array<{ value: string; label: string }>;
    disabled?: boolean;
    align?: "left" | "right";
    onSelect: (value: string) => void;
  }): TemplateResult {
    const open = composerState.openMenu === args.kind;
    const menuId = `composer-${args.kind}-menu`;
    let controlClass = "";
    if (args.kind === "model") controlClass = "model-control";
    else if (args.kind === "harness") controlClass = "harness-control";
    return html`
      <div class="menu-control ${controlClass}" data-align=${args.align ?? "left"}>
        <button
          class="menu-button"
          type="button"
          title=${args.title}
          aria-haspopup="menu"
          aria-expanded=${open ? "true" : "false"}
          aria-controls=${menuId}
          ?disabled=${args.disabled}
          @click=${(e: Event) => toggleComposerMenu(e, args.kind)}
        >
          ${args.glyph ? icon(args.glyph, 16) : nothing}
          <span class="menu-label">${args.label}</span>
          ${icon(ChevronDown, 14)}
        </button>
        ${
          open && !args.disabled
            ? html`
                <div class="menu-popover" id=${menuId} role="menu" @click=${(e: Event) => e.stopPropagation()}>
                  <div class="menu-title">${args.title}</div>
                  ${args.options.map(
                    (option) => html`
                      <button
                        class="menu-option ${option.value === args.selected ? "active" : ""}"
                        type="button"
                        role="menuitemradio"
                        aria-checked=${option.value === args.selected ? "true" : "false"}
                        @click=${() => args.onSelect(option.value)}
                      >
                        <span class="menu-option-copy">
                          <span class="menu-option-label">${option.label}</span>
                        </span>
                        ${option.value === args.selected ? icon(Check, 15) : nothing}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing
        }
      </div>
    `;
  }

  function toggleComposerMenu(e: Event, kind: ComposerMenu): void {
    e.stopPropagation();
    composerState.openMenu = composerState.openMenu === kind ? null : kind;
    ctx.chat.drawActiveChat();
  }

  function matchSkills(query: string, skills: SkillItem[]): SkillMatch[] {
    const q = query.toLowerCase();
    if (!q) return skills.map((skill) => ({ skill, start: -1, end: -1 }));
    const out: SkillMatch[] = [];
    for (const skill of skills) {
      const at = skill.name.toLowerCase().indexOf(q);
      if (at >= 0) out.push({ skill, start: at, end: at + q.length });
    }
    return out.sort((a, b) => a.start - b.start || a.skill.name.localeCompare(b.skill.name));
  }

  function currentSlashMenu(): { open: boolean; loading: boolean; matches: SkillMatch[] } {
    const query = slashQuery(composerState.draft);
    if (query === null || composerState.slashDismissed) return { open: false, loading: false, matches: [] };
    const loading = skillsLoading;
    const matches = skillsCache ? matchSkills(query, skillsCache) : [];
    return { open: loading || matches.length > 0, loading, matches };
  }

  function clampedActive(matchCount: number): number {
    return Math.max(0, Math.min(slashActiveIndex, matchCount - 1));
  }

  async function loadSkills(agent: Agent): Promise<void> {
    if (skillsLoading || skillsCache !== null) return;
    skillsLoading = true;
    ctx.chat.drawActiveChat(agent);
    try {
      const r = await api<{ skills: SkillItem[] }>("/api/skills");
      skillsCache = r.skills ?? [];
    } catch {
      skillsCache = null;
    } finally {
      skillsLoading = false;
      if (agent === ctx.chat.state.agent) ctx.chat.drawActiveChat(agent);
    }
  }

  function acceptSkill(skill: SkillItem, agent: Agent): void {
    composerState.draft = composerState.draft.replace(SLASH_TOKEN, (_m, pre: string) => `${pre}/${skill.name} `);
    persistDraft();
    slashActiveIndex = 0;
    composerState.slashDismissed = false;
    ctx.chat.drawActiveChat(agent);
    focusComposerEnd();
  }

  let pendingComposerFocus = false;

  function focusComposerEnd(): void {
    requestAnimationFrame(() => {
      const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!ta) return;
      if (ta.disabled) {
        pendingComposerFocus = true;
        return;
      }
      pendingComposerFocus = false;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  function closeSlashMenu(agent: Agent): void {
    composerState.slashDismissed = true;
    ctx.chat.drawActiveChat(agent);
  }

  function slashMenu(agent: Agent): TemplateResult | typeof nothing {
    const slash = currentSlashMenu();
    if (!slash.open) return nothing;
    if (slash.loading && slash.matches.length === 0) {
      return html`<div class="slash-popover">
        <div class="menu-title">Skills</div>
        <div class="slash-empty">Loading skills…</div>
      </div>`;
    }
    const active = clampedActive(slash.matches.length);
    return html`
      <div class="slash-popover" role="listbox" aria-label="Skills">
        <div class="menu-title">Skills</div>
        ${slash.matches.map((m, i) => slashRow(m, i === active, agent))}
      </div>
    `;
  }

  function slashRow(m: SkillMatch, active: boolean, agent: Agent): TemplateResult {
    return html`
      <button
        type="button"
        role="option"
        aria-selected=${active ? "true" : "false"}
        class="slash-option ${active ? "active" : ""}"
        title=${m.skill.description}
        @mousedown=${(e: Event) => e.preventDefault()}
        @click=${() => acceptSkill(m.skill, agent)}
      >
        <span class="slash-icon">${icon(Box, 16)}</span>
        <span class="slash-name">${highlightName(m)}</span>
        <span class="slash-desc">${m.skill.description}</span>
        <span class="slash-scope">${scopeBadge(m.skill.scope)}</span>
      </button>
    `;
  }

  function highlightName(m: SkillMatch): TemplateResult {
    const { name } = m.skill;
    if (m.start < 0 || m.end <= m.start) return html`${name}`;
    return html`${name.slice(0, m.start)}<b>${name.slice(m.start, m.end)}</b>${name.slice(m.end)}`;
  }

  function scopeBadge(scope: string): string {
    return scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : "";
  }

  // ---------------------------------------------------------------------------
  // @mention autocomplete
  // ---------------------------------------------------------------------------

  /** One nameable candidate, plus whether it is already in the mounted room (if any). */
  interface MentionCandidate {
    target: MentionTarget;
    inRoom: boolean;
  }

  interface MentionMatch {
    candidate: MentionCandidate;
    start: number;
    end: number;
  }

  /**
   * Who `@` can complete to, in priority order: the room roster first (so the people
   * already in the conversation sort to the top), then every other enabled agent the
   * `/api/agents` cache knows about, then the viewer. Used by both the dropdown and the
   * highlight overlay below, so a name lights up in the draft exactly when it is also an
   * autocomplete candidate.
   *
   * Deliberately broader than `mentionTargetsForThread` (mention-markdown.ts), which is
   * room-only because that is what core's mention grammar actually routes on. This list is
   * just a typing aid — offering (and highlighting) a name here says nothing about whether
   * core will treat it as a mention once sent.
   */
  function mentionCandidatesFor(threadRef: string | null): MentionCandidate[] {
    const room = roomFor(threadRef);
    const inRoomIds = new Set(room?.personaIds ?? []);
    const seen = new Set<string>();
    const out: MentionCandidate[] = [];
    for (const id of room?.personaIds ?? []) {
      const chip = cachedPersona(id);
      if (!chip?.name || seen.has(id)) continue;
      seen.add(id);
      out.push({
        target: {
          kind: "agent",
          id: chip.id,
          name: chip.name,
          ...(chip.color ? { color: chip.color } : {}),
          ...(chip.glyph ? { glyph: chip.glyph } : {}),
        },
        inRoom: true,
      });
    }
    for (const agent of cachedAgents()) {
      if (!agent.enabled || seen.has(agent.id)) continue;
      seen.add(agent.id);
      out.push({
        target: { kind: "agent", id: agent.id, name: agent.name, color: agent.color, glyph: agent.glyph },
        inRoom: inRoomIds.has(agent.id),
      });
    }
    const me = viewerMentionName(appState.me?.user);
    if (me) out.push({ target: { kind: "viewer", id: "", name: me }, inRoom: true });
    return out;
  }

  function mentionTargetsFor(threadRef: string | null): MentionTarget[] {
    return mentionCandidatesFor(threadRef).map((c) => c.target);
  }

  function matchMentions(query: string, candidates: MentionCandidate[]): MentionMatch[] {
    const q = query.toLowerCase();
    if (!q) return candidates.map((candidate) => ({ candidate, start: -1, end: -1 }));
    const out: MentionMatch[] = [];
    for (const candidate of candidates) {
      const at = candidate.target.name.toLowerCase().indexOf(q);
      if (at >= 0) out.push({ candidate, start: at, end: at + q.length });
    }
    return out.sort((a, b) => a.start - b.start || a.candidate.target.name.localeCompare(b.candidate.target.name));
  }

  function currentMentionMenu(): { open: boolean; matches: MentionMatch[] } {
    const query = mentionQuery(composerState.draft);
    if (query === null || composerState.mentionDismissed) return { open: false, matches: [] };
    const matches = matchMentions(query, mentionCandidatesFor(ctx.chat.state.threadRef));
    return { open: matches.length > 0, matches };
  }

  function clampedMentionActive(matchCount: number): number {
    return Math.max(0, Math.min(mentionActiveIndex, matchCount - 1));
  }

  function acceptMention(candidate: MentionCandidate, agent: Agent): void {
    const name = candidate.target.name;
    composerState.draft = composerState.draft.replace(MENTION_TOKEN, (_m, pre: string) => `${pre}@${name} `);
    persistDraft();
    mentionActiveIndex = 0;
    composerState.mentionDismissed = false;
    ctx.chat.drawActiveChat(agent);
    focusComposerEnd();
  }

  function closeMentionMenu(agent: Agent): void {
    composerState.mentionDismissed = true;
    ctx.chat.drawActiveChat(agent);
  }

  function mentionDotStyle(target: MentionTarget): string {
    return target.color ? `--persona-color: ${target.color};` : "";
  }

  function highlightMentionName(m: MentionMatch): TemplateResult {
    const { name } = m.candidate.target;
    if (m.start < 0 || m.end <= m.start) return html`${name}`;
    return html`${name.slice(0, m.start)}<b>${name.slice(m.start, m.end)}</b>${name.slice(m.end)}`;
  }

  function mentionRow(m: MentionMatch, active: boolean, agent: Agent): TemplateResult {
    const { target, inRoom } = m.candidate;
    const showHint = target.kind === "agent" && roomThread() && !inRoom;
    return html`
      <button
        type="button"
        role="option"
        aria-selected=${active ? "true" : "false"}
        class="mention-option ${active ? "active" : ""}"
        @mousedown=${(e: Event) => e.preventDefault()}
        @click=${() => acceptMention(m.candidate, agent)}
      >
        <span class="persona-dot mention-option-dot" style=${mentionDotStyle(target)} aria-hidden="true">
          ${target.glyph ?? target.name.slice(0, 1).toUpperCase()}
        </span>
        <span class="mention-option-name">${highlightMentionName(m)}</span>
        ${showHint ? html`<span class="mention-option-hint">not in room — will be added</span>` : nothing}
      </button>
    `;
  }

  function mentionMenu(agent: Agent): TemplateResult | typeof nothing {
    const mention = currentMentionMenu();
    if (!mention.open) return nothing;
    const active = clampedMentionActive(mention.matches.length);
    return html`
      <div class="mention-autocomplete" role="listbox" aria-label="Mention">
        <div class="menu-title">Mention</div>
        ${mention.matches.map((m, i) => mentionRow(m, i === active, agent))}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // @mention highlighting — the mirror overlay behind the textarea
  // ---------------------------------------------------------------------------

  /**
   * The backdrop's content: the exact draft text, with recognised `@Name` tokens wrapped in
   * a `<mark>` for its background highlight. The mirror's own text is transparent (see
   * `.composer-mirror` in shell.css) — only the `<mark>` backgrounds are visible, sitting
   * behind the real, fully opaque textarea text above it.
   */
  function mirrorTemplate(text: string, targets: MentionTarget[]): TemplateResult {
    const segments = mentionSegments(text, targets);
    return html`${segments.map((seg) =>
      seg.target ? html`<mark class="composer-mention-hl">${seg.text}</mark>` : seg.text,
    )}`;
  }

  /**
   * The mirror element itself. It exists here, on ONE line, rather than inline in
   * `composerForm`, because `.composer-mirror` is `white-space: pre-wrap` — it has to be, to
   * wrap exactly where the textarea wraps — which makes it whitespace-SENSITIVE. Authored
   * across lines, the newline and source indentation between the open tag and the content are
   * real characters: they push every highlight down one line and right by the indent width.
   * Nothing about a `<div>` tells a formatter that, hence the ignore.
   */
  // prettier-ignore
  function mirrorHost(text: string, targets: MentionTarget[]): TemplateResult {
    return html`<div class="composer-mirror" aria-hidden="true">${mirrorTemplate(text, targets)}</div>`;
  }

  /**
   * Repaints just the mirror, imperatively — called from the per-keystroke fast path in
   * `onDraftInput` that deliberately skips a full `drawActiveChat` re-render for typing
   * latency. A full render (e.g. after `acceptMention`) already renders the mirror correctly
   * from `composerState.draft` via `mirrorTemplate` in `composerForm`, so this only needs to
   * cover the path that bypasses that render.
   */
  function syncComposerMirror(agent: Agent): void {
    if (!ctx.chat.state.host || agent !== ctx.chat.state.agent) return;
    const mirror = ctx.chat.state.host.querySelector<HTMLElement>(".composer-mirror");
    const ta = ctx.chat.state.host.querySelector<HTMLTextAreaElement>(".composer-input");
    if (!mirror || !ta) return;
    render(mirrorTemplate(composerState.draft, mentionTargetsFor(ctx.chat.state.threadRef)), mirror);
    mirror.scrollTop = ta.scrollTop;
  }

  /** Keeps the (non-scrollable) mirror's clipped window aligned with the real textarea's. */
  function onComposerScroll(e: Event): void {
    const ta = e.currentTarget as HTMLTextAreaElement;
    const mirror = ta.previousElementSibling;
    if (mirror instanceof HTMLElement && mirror.classList.contains("composer-mirror")) {
      mirror.scrollTop = ta.scrollTop;
    }
  }

  function submitComposer(e: Event, agent: Agent): void {
    e.preventDefault();
    void sendPrompt(agent);
  }

  function onDraftInput(e: InputEvent, agent: Agent): void {
    composerState.draft = (e.currentTarget as HTMLTextAreaElement).value;
    persistDraft();
    const hadError = Boolean(composerState.error);
    composerState.error = "";
    composerState.slashDismissed = false;
    slashActiveIndex = 0;
    composerState.mentionDismissed = false;
    mentionActiveIndex = 0;
    const slashArmed = slashQuery(composerState.draft) !== null;
    const mentionArmed = mentionQuery(composerState.draft) !== null;
    if (slashArmed && skillsCache === null && !skillsLoading) void loadSkills(agent);
    const popoverShown = Boolean(ctx.chat.state.host?.querySelector(".slash-popover, .mention-autocomplete"));
    if (slashArmed || mentionArmed || popoverShown || hadError) {
      ctx.chat.drawActiveChat(agent);
      return;
    }
    syncComposerControls(agent);
    resizeComposer();
    syncComposerMirror(agent);
  }

  function composerCanSend(): boolean {
    return (
      Boolean(composerState.draft.trim() || composerState.attachments.length) &&
      !composerState.processingFiles &&
      activeRuntimeConfig !== null &&
      ctx.chat.state.resolvingApprovals.size === 0 &&
      !ctx.chat.hasUnresolvedApproval()
    );
  }

  function syncComposerControls(agent: Agent): void {
    if (!ctx.chat.state.host || agent !== ctx.chat.state.agent) return;
    const send = ctx.chat.state.host.querySelector<HTMLButtonElement>(".send-btn");
    if (send) send.disabled = agent.state.isStreaming ? !composerState.draft.trim() : !composerCanSend();
  }

  function clearComposerDom(agent: Agent): void {
    if (!ctx.chat.state.host || agent !== ctx.chat.state.agent) return;
    const input = ctx.chat.state.host.querySelector<HTMLTextAreaElement>(".composer-input");
    if (input) {
      input.value = "";
      input.style.height = "auto";
      input.style.overflowY = "hidden";
      input.scrollTop = 0;
    }
    const send = ctx.chat.state.host.querySelector<HTMLButtonElement>(".send-btn");
    if (send) send.disabled = true;
  }

  function onComposerKeydown(e: KeyboardEvent, agent: Agent): void {
    const slash = currentSlashMenu();
    if (slash.open) {
      if (e.key === "Escape") {
        e.preventDefault();
        return closeSlashMenu(agent);
      }
      if (slash.matches.length) {
        const count = slash.matches.length;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          slashActiveIndex = (clampedActive(count) + 1) % count;
          return ctx.chat.drawActiveChat(agent);
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          slashActiveIndex = (clampedActive(count) - 1 + count) % count;
          return ctx.chat.drawActiveChat(agent);
        }
        if (!e.shiftKey && (e.key === "Enter" || e.key === "Tab")) {
          e.preventDefault();
          return acceptSkill(slash.matches[clampedActive(count)]!.skill, agent);
        }
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        return;
      }
    }
    const mention = currentMentionMenu();
    if (mention.open) {
      if (e.key === "Escape") {
        e.preventDefault();
        return closeMentionMenu(agent);
      }
      const count = mention.matches.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mentionActiveIndex = (clampedMentionActive(count) + 1) % count;
        return ctx.chat.drawActiveChat(agent);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mentionActiveIndex = (clampedMentionActive(count) - 1 + count) % count;
        return ctx.chat.drawActiveChat(agent);
      }
      if (!e.shiftKey && (e.key === "Enter" || e.key === "Tab")) {
        e.preventDefault();
        return acceptMention(mention.matches[clampedMentionActive(count)]!.candidate, agent);
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void sendPrompt(agent);
  }

  function stopStreaming(agent: Agent): void {
    void ctx.chat.signalLiveRun("abort").catch((e) => swallow("web-ui: abort signal", e));
    agent.abort();
  }

  async function sendSteer(agent: Agent): Promise<void> {
    const text = composerState.draft.trim();
    if (!text) return;
    if (ctx.chat.state.threadRef) bumpSessionActivity(ctx.chat.state.threadRef);
    clearActiveDraft();
    composerState.draft = "";
    composerState.error = "";
    agent.state.messages.push({
      role: "user",
      content: text,
      timestamp: Date.now(),
      steered: true,
    } as unknown as AgentMessage);
    ctx.chat.drawActiveChat(agent);
    clearComposerDom(agent);
    if (!ctx.chat.hasLiveRun()) {
      // The turn is between run states: submitted but /api/turn hasn't returned the
      // run id yet, or the stream is tearing down. Dropping the message here is a
      // silent no-op the user reads as a dead composer — hold it and deliver when
      // the run slot settles (steer the live run, or resend as an ordinary prompt).
      steerWhenLive(agent, text, 0);
      return;
    }
    await deliverSteer(agent, text);
  }

  async function deliverSteer(agent: Agent, text: string): Promise<void> {
    try {
      const outcome = await ctx.chat.signalLiveRun("steer", text);
      if (!outcome.ok) recoverEndedRunSteer(agent, text, outcome);
    } catch (err) {
      composerState.error = errMessage(err, "Could not steer the running task.");
      ctx.chat.drawActiveChat(agent);
    }
  }

  function steerWhenLive(agent: Agent, text: string, attempt: number): void {
    if (agent !== ctx.chat.state.agent) return;
    if (ctx.chat.hasLiveRun()) {
      void deliverSteer(agent, text);
      return;
    }
    if (!agent.state.isStreaming) {
      // The run ended without the slot ever going live — recover exactly like a
      // steer that raced the run's end: resend the text as an ordinary prompt.
      recoverEndedRunSteer(agent, text, {});
      return;
    }
    if (attempt < 40) {
      window.setTimeout(() => steerWhenLive(agent, text, attempt + 1), 250);
      return;
    }
    const last = agent.state.messages[agent.state.messages.length - 1] as
      { role?: string; content?: unknown } | undefined;
    if (last?.role === "user" && last.content === text) agent.state.messages.pop();
    // Don't clobber anything typed while the message was held: put the held text
    // back in front of the newer draft instead of overwriting it.
    composerState.draft = composerState.draft.trim() ? `${text}\n\n${composerState.draft}` : text;
    composerState.error = "Could not deliver the message — the running task never settled. It is back in the composer.";
    ctx.chat.drawActiveChat(agent);
  }

  // The run ended before the steer landed (the client believed it was still live).
  // Core either replayed the text as a fresh turn (`replayed`) or never stored it.
  // Either way the message must not silently vanish: detach from the stale stream,
  // then attach to the replay run — or resend the text as an ordinary prompt.
  function recoverEndedRunSteer(agent: Agent, text: string, outcome: { replayed?: boolean }): void {
    agent.abort();
    if (outcome.replayed) {
      const last = agent.state.messages[agent.state.messages.length - 1] as
        { role?: string; content?: unknown; steered?: boolean } | undefined;
      // It is now an ordinary user turn in the transcript, not a mid-run steer.
      if (last?.role === "user" && last.content === text && last.steered) delete last.steered;
      ctx.chat.drawActiveChat(agent);
      attachWhenIdle(agent, 0);
      return;
    }
    const last = agent.state.messages[agent.state.messages.length - 1] as
      { role?: string; content?: unknown } | undefined;
    if (last?.role === "user" && last.content === text) agent.state.messages.pop();
    composerState.draft = text;
    ctx.chat.drawActiveChat(agent);
    resendWhenIdle(agent, text, 0);
  }

  function attachWhenIdle(agent: Agent, attempt: number): void {
    if (agent !== ctx.chat.state.agent) return;
    if (agent.state.isStreaming) {
      if (attempt < 20) window.setTimeout(() => attachWhenIdle(agent, attempt + 1), 250);
      return;
    }
    ctx.chat.resumeIfIdle();
  }

  function resendWhenIdle(agent: Agent, text: string, attempt: number): void {
    if (agent !== ctx.chat.state.agent) return;
    if (agent.state.isStreaming) {
      if (attempt < 20) window.setTimeout(() => resendWhenIdle(agent, text, attempt + 1), 250);
      else {
        composerState.error =
          "Could not deliver the message — the running task ended mid-send. It is back in the composer.";
        ctx.chat.drawActiveChat(agent);
      }
      return;
    }
    if (composerState.draft === text) void sendPrompt(agent);
  }

  /**
   * One send path, two callers. `text` is what the thread panel hands in — it keeps its own
   * draft, so writing into the composer first and sending that would be a detour through
   * state the person can see change. `replyToSeq` is what makes the turn a reply into a
   * thread rather than to the conversation.
   */
  async function sendPrompt(agent: Agent, opts: SendOptions = {}): Promise<void> {
    // "Aside" = typed somewhere other than the main composer, so none of the composer's own
    // state (draft, attachments, paste view, its DOM) is this send's to spend or clear.
    const aside = typeof opts.text === "string";
    if (!aside && composerState.processingFiles) return;
    if (!activeRuntimeConfig && !agent.state.isStreaming) return;
    if (!aside && composerState.pasteView) closePasteView(agent);
    if (ctx.chat.state.resolvingApprovals.size > 0) return;
    if (ctx.chat.hasUnresolvedApproval()) return;
    // Steering is the main composer's affordance over the running task. A thread reply is a
    // message to a thread, not an interruption of whatever is streaming, so it waits.
    if (agent.state.isStreaming) return aside ? undefined : sendSteer(agent);
    const text = (aside ? opts.text! : composerState.draft).trim();
    const attachments = aside ? [] : composerState.attachments;
    if (!text && attachments.length === 0) return;
    if (ctx.chat.state.threadRef) {
      bumpSessionActivity(ctx.chat.state.threadRef);
      ctx.chat.state.pendingSend = ctx.chat.state.threadRef;
      renderList();
    }
    ctx.chat.notePendingSessionOnSend();
    if (!aside) {
      clearActiveDraft();
      resetComposer();
    }
    // Read back out by `currentTurnOptions()` when `drive()` builds the turn body, and
    // cleared once this turn is over so nothing else inherits the thread.
    ctx.chat.state.replyToSeq = opts.replyToSeq ?? null;
    ctx.chat.drawActiveChat(agent);
    if (!aside) clearComposerDom(agent);
    try {
      // The outgoing message carries the thread link itself, not just the request body, so
      // the transcript folds it into the thread on the spot rather than after the refresh
      // that ends the turn — the same `parentSeq` core will stamp on the entry it writes.
      const link = typeof opts.replyToSeq === "number" ? { parentSeq: opts.replyToSeq } : {};
      if (attachments.length) {
        await agent.prompt({
          role: "user-with-attachments",
          content: text,
          attachments,
          timestamp: Date.now(),
          ...link,
        });
      } else if (typeof opts.replyToSeq === "number") {
        await agent.prompt({ role: "user", content: text, timestamp: Date.now(), ...link } as AgentMessage);
      } else {
        await agent.prompt(text);
      }
    } catch (err) {
      ctx.chat.state.pendingSend = null;
      if (ctx.chat.state.threadRef && ctx.chat.state.sessionId === null) dropPendingSession(ctx.chat.state.threadRef);
      renderList();
      const message = errMessage(err, "Could not send message.");
      // An aside owns its own error surface (and still holds the text the person typed), so
      // it is told rather than having the failure land under a composer it did not use.
      if (aside) throw new Error(message);
      composerState.error = message;
      ctx.chat.drawActiveChat(agent);
    } finally {
      ctx.chat.state.replyToSeq = null;
    }
  }

  const LARGE_PASTE_CHARS = 2000;

  async function onComposerPaste(e: ClipboardEvent, agent: Agent): Promise<void> {
    const data = e.clipboardData;
    if (!data) return;
    const files = Array.from(data.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length) {
      e.preventDefault();
      await addFiles(files, agent);
      return;
    }
    const text = data.getData("text/plain");
    if (text.length <= LARGE_PASTE_CHARS) return;
    if (ctx.chat.hasUnresolvedApproval() || ctx.chat.state.resolvingApprovals.size > 0 || composerState.processingFiles)
      return;
    e.preventDefault();
    const names = new Set(composerState.attachments.map((a) => a.fileName));
    let n = 1;
    while (names.has(n === 1 ? "pasted-text.txt" : `pasted-text-${n}.txt`)) n++;
    const bytes = new TextEncoder().encode(text);
    const attachment: Attachment = {
      id: `paste_${Date.now()}_${Math.random()}`,
      type: "document",
      fileName: n === 1 ? "pasted-text.txt" : `pasted-text-${n}.txt`,
      mimeType: "text/plain",
      size: bytes.length,
      content: bytesToBase64(bytes),
      extractedText: text,
    };
    pastedTextIds.add(attachment.id);
    composerState.attachments = [...composerState.attachments, attachment];
    ctx.chat.drawActiveChat(agent);
  }

  async function onFilesSelected(e: Event, agent: Agent): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await addFiles(files, agent);
  }

  async function fileToBase64(file: File): Promise<string> {
    return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  }

  async function loadAnyAttachment(file: File): Promise<Attachment> {
    try {
      const { loadAttachment } = await import("@earendil-works/pi-web-ui");
      return await loadAttachment(file);
    } catch {
      return {
        id: `${file.name}_${Date.now()}_${Math.random()}`,
        type: "document",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        content: await fileToBase64(file),
      };
    }
  }

  async function addFiles(files: File[], agent: Agent, folders: DropEntryLike[] = []): Promise<void> {
    if (
      (!files.length && !folders.length) ||
      ctx.chat.hasUnresolvedApproval() ||
      ctx.chat.state.resolvingApprovals.size > 0
    )
      return;
    if (composerState.processingFiles) {
      composerState.error = "Still preparing the previous drop — try again in a moment.";
      ctx.chat.drawActiveChat(agent);
      return;
    }
    composerState.processingFiles = true;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    try {
      const zipped: File[] = [];
      for (const folder of folders) zipped.push(await folderToZipFile(folder));
      const loaded = await Promise.all([...files, ...zipped].map((file) => loadAnyAttachment(file)));
      composerState.attachments = [...composerState.attachments, ...loaded];
    } catch (err) {
      if (err instanceof FolderDropError) composerState.error = err.message;
      else if (isFolderReadError(err))
        composerState.error =
          "That drop included a folder this browser can't read — zip it and drop the archive instead.";
      else composerState.error = errMessage(err, "Could not attach that file.");
    } finally {
      composerState.processingFiles = false;
      ctx.chat.drawActiveChat(agent);
    }
  }

  function dragHasFiles(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    return types ? Array.from(types).includes("Files") : false;
  }

  function onDragEnter(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    if (!composerState.dragging) {
      composerState.dragging = true;
      ctx.chat.drawActiveChat();
    }
  }

  function onDragOver(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && composerState.dragging) {
      composerState.dragging = false;
      ctx.chat.drawActiveChat();
    }
  }

  async function onDrop(e: DragEvent, agent: Agent): Promise<void> {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    composerState.dragging = false;
    const { files, folders } = splitDropItems(Array.from(e.dataTransfer?.items ?? []));
    if (!files.length && !folders.length) files.push(...Array.from(e.dataTransfer?.files ?? []));
    ctx.chat.drawActiveChat(agent);
    await addFiles(files, agent, folders);
  }

  function pickFiles(): void {
    if (ctx.chat.hasUnresolvedApproval() || ctx.chat.state.resolvingApprovals.size > 0) return;
    ctx.chat.state.host?.querySelector<HTMLInputElement>(".file-input")?.click();
  }

  function removeAttachment(id: string, agent: Agent): void {
    composerState.attachments = composerState.attachments.filter((a) => a.id !== id);
    pastedTextIds.delete(id);
    if (composerState.pasteView?.id === id) composerState.pasteView = null;
    ctx.chat.drawActiveChat(agent);
  }

  function selectModel(value: string, agent: Agent): void {
    const option = getModelOptions(scopeKey()).find((candidate) => candidate.value === value);
    if (!option) return;
    const previousDefaultEffort = defaultEffortForModel(currentModelOption().model);
    if (ctx.chat.state.threadRef) rememberThreadPick(ctx.chat.state.threadRef, option.value);
    agent.state.model = option.model;
    if (composerState.effortLevel === previousDefaultEffort) {
      composerState.effortLevel = defaultEffortForModel(option.model);
      persistPreference(EFFORT_STORAGE_KEY, composerState.effortLevel);
    }
    if (composerState.openMenu !== "settings") composerState.openMenu = null;
    ctx.chat.drawActiveChat(agent);
  }

  function selectHarness(harnessId: string, agent: Agent): void {
    const current = currentModelOption();
    const options = getModelOptionsForHarness(harnessId, scopeKey());
    const option = options.find((candidate) => candidate.model.id === current.model.id) ?? options[0];
    if (option) selectModel(option.value, agent);
  }

  function selectEffort(level: EffortLevel, agent: Agent): void {
    composerState.effortLevel = level;
    persistPreference(EFFORT_STORAGE_KEY, level);
    if (composerState.openMenu !== "settings") composerState.openMenu = null;
    ctx.chat.drawActiveChat(agent);
  }

  function toggleFastMode(agent: Agent): void {
    if (ctx.chat.hasUnresolvedApproval() || ctx.chat.state.resolvingApprovals.size > 0) return;
    if (!modelSupportsFastMode(scopeKey(), currentModelOption().model.id)) return;
    composerState.fastMode = !effectiveFastMode();
    persistPreference(FAST_MODE_STORAGE_KEY, composerState.fastMode ? "1" : "0");
    if (fastModeChargeTimer) {
      clearTimeout(fastModeChargeTimer);
      fastModeChargeTimer = null;
    }
    fastModeCharging = composerState.fastMode === true;
    ctx.chat.drawActiveChat(agent);
    if (fastModeCharging) {
      fastModeChargeTimer = setTimeout(() => {
        fastModeCharging = false;
        fastModeChargeTimer = null;
        if (agent === ctx.chat.state.agent) ctx.chat.drawActiveChat(agent);
      }, 760);
    }
  }

  let autosizedTa: HTMLTextAreaElement | null = null;
  let autosizedValue: string | null = null;
  let autosizeObserver: ResizeObserver | null = null;

  function resizeComposer(): void {
    requestAnimationFrame(() => {
      const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!ta) return;
      if (autosizedTa !== ta && typeof ResizeObserver !== "undefined") {
        autosizeObserver ??= new ResizeObserver(() => {
          autosizedValue = null;
          resizeComposer();
        });
        if (autosizedTa) autosizeObserver.unobserve(autosizedTa);
        autosizeObserver.observe(ta);
        autosizedTa = ta;
        autosizedValue = null;
      }
      if (ta.value === autosizedValue) return;
      autosizedValue = ta.value;
      ta.style.height = "auto";
      const cap = parseFloat(getComputedStyle(ta).maxHeight) || 180;
      const content = ta.scrollHeight;
      ta.style.height = `${Math.min(cap, Math.max(ctx.pane ? 0 : 48, content))}px`;
      if (content > cap) {
        ta.style.overflowY = "auto";
      } else {
        ta.style.overflowY = "hidden";
        ta.scrollTop = 0;
      }
    });
  }

  function closeMenus(): boolean {
    let changed = false;
    if (composerState.openMenu) {
      composerState.openMenu = null;
      changed = true;
    }
    if (!composerState.slashDismissed && slashQuery(composerState.draft) !== null) {
      composerState.slashDismissed = true;
      changed = true;
    }
    if (!composerState.mentionDismissed && mentionQuery(composerState.draft) !== null) {
      composerState.mentionDismissed = true;
      changed = true;
    }
    return changed;
  }

  function dispose(): void {
    autosizeObserver?.disconnect();
    autosizeObserver = null;
    autosizedTa = null;
    if (fastModeChargeTimer !== null) clearTimeout(fastModeChargeTimer);
  }

  return {
    state: composerState,
    composerForm,
    resetComposer,
    focusComposerEnd,
    resizeComposer,
    sendPrompt,
    currentModelOption,
    carryModelPick,
    refreshRuntimeSelection,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    closeMenus,
    dispose,
  };
}

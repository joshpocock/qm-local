/**
 * "Import skills from a folder" — the browser-side half of bringing a `.claude/skills`
 * tree into QM.
 *
 * Core runs in a container with no view of the operator's filesystem, so the folder is
 * read here (`<input type="file" webkitdirectory>`), reviewed here, and then pushed one
 * skill at a time through the ordinary `POST /api/skills` route. Nothing is uploaded
 * until the operator picks rows and presses Import.
 *
 * Structured after `rooms.ts`: a detached host on `document.body`, a native `<dialog>`
 * shown modally, and a plain re-render on every state change.
 */

import { html, nothing, render, type TemplateResult } from "lit";
import { FolderInput, X } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect, icon } from "./ui";
import {
  groupSkillFiles,
  isSkippableImportPath,
  MAX_ATTACHED_FILES,
  MAX_FILE_CHARS,
  skillCreateBody,
  type ImportCandidate,
  type ImportFile,
} from "./skill-import";

export interface ImportScope {
  scopeId: string;
  name: string;
}

type ImportPhase = "pick" | "reading" | "choose" | "importing" | "done";

interface ImportOutcome {
  name: string;
  dir: string;
  ok: boolean;
  message: string;
}

interface ImportDialogState {
  open: boolean;
  phase: ImportPhase;
  folderName: string;
  candidates: ImportCandidate[];
  selected: Set<string>;
  scopes: ImportScope[];
  scopeId: string;
  error: string;
  done: number;
  total: number;
  outcomes: ImportOutcome[];
  onImported: (() => void) | null;
  opener: HTMLElement | null;
}

/** A skills folder is small; anything past this is the wrong folder, not a big one. */
const MAX_PICKED_FILES = 4000;

const state: ImportDialogState = {
  open: false,
  phase: "pick",
  folderName: "",
  candidates: [],
  selected: new Set(),
  scopes: [],
  scopeId: "",
  error: "",
  done: 0,
  total: 0,
  outcomes: [],
  onImported: null,
  opener: null,
};

let dialogHost: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (dialogHost?.isConnected) return dialogHost;
  dialogHost = document.createElement("div");
  dialogHost.className = "skill-import-dialog-host";
  document.body.appendChild(dialogHost);
  return dialogHost;
}

function importable(candidate: ImportCandidate): boolean {
  return candidate.name !== "";
}

function closeImportDialog(): void {
  if (!state.open || state.phase === "importing") return;
  state.open = false;
  state.error = "";
  state.candidates = [];
  state.selected = new Set();
  state.outcomes = [];
  state.onImported = null;
  const opener = state.opener;
  state.opener = null;
  drawImportDialog();
  queueMicrotask(() => opener?.isConnected && opener.focus());
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// Step 1 — reading the picked folder
// ---------------------------------------------------------------------------

async function readPickedFolder(input: HTMLInputElement): Promise<void> {
  const picked = [...(input.files ?? [])];
  input.value = "";
  if (!picked.length) return;
  state.phase = "reading";
  state.error = "";
  state.folderName = (picked[0]?.webkitRelativePath || picked[0]?.name || "").split("/")[0] ?? "";
  drawImportDialog();
  try {
    const usable = picked
      .filter((file) => {
        const path = file.webkitRelativePath || file.name;
        return !isSkippableImportPath(path) && file.size <= MAX_FILE_CHARS;
      })
      .slice(0, MAX_PICKED_FILES);
    const read: ImportFile[] = await Promise.all(
      usable.map(async (file) => ({
        relativePath: file.webkitRelativePath || file.name,
        text: await file.text(),
      })),
    );
    state.candidates = groupSkillFiles(read);
    state.selected = new Set(state.candidates.filter(importable).map((candidate) => candidate.dir));
    state.phase = state.candidates.length ? "choose" : "pick";
    if (!state.candidates.length) {
      state.error = `No SKILL.md found in "${state.folderName}". Pick the folder that holds your skill folders.`;
    }
  } catch (e) {
    state.phase = "pick";
    state.error = errMessage(e, "Could not read that folder.");
  }
  drawImportDialog();
}

function pickerTpl(): TemplateResult {
  if (state.phase === "reading") {
    return html`<p class="room-empty">Reading "${state.folderName}"…</p>`;
  }
  return html`<label class="skill-import-file">
    <input
      type="file"
      webkitdirectory
      directory
      multiple
      aria-label="Choose a skills folder"
      @change=${(event: Event) => void readPickedFolder(event.currentTarget as HTMLInputElement)}
    />
    <span class="skill-import-file-label">${icon(FolderInput, 18)}<span>Choose folder…</span></span>
    <span class="skill-import-file-hint">
      Your browser reads the folder; nothing is sent until you pick what to import.
    </span>
  </label>`;
}

// ---------------------------------------------------------------------------
// Step 2 — choosing what to import
// ---------------------------------------------------------------------------

function toggleCandidate(candidate: ImportCandidate): void {
  const next = new Set(state.selected);
  if (next.has(candidate.dir)) next.delete(candidate.dir);
  else next.add(candidate.dir);
  state.selected = next;
  drawImportDialog();
}

function setAllSelected(all: boolean): void {
  state.selected = all ? new Set(state.candidates.filter(importable).map((candidate) => candidate.dir)) : new Set();
  drawImportDialog();
}

function candidateRow(candidate: ImportCandidate): TemplateResult {
  const ok = importable(candidate);
  const selected = ok && state.selected.has(candidate.dir);
  const renamed = ok && candidate.name !== candidate.declaredName;
  const assets = candidate.files.length;
  const notes: string[] = [];
  if (assets) notes.push(`${assets} file${assets === 1 ? "" : "s"} alongside it`);
  if (candidate.omittedFiles) notes.push(`${candidate.omittedFiles} beyond the ${MAX_ATTACHED_FILES}-file cap`);
  if (candidate.skippedFiles) notes.push(`${candidate.skippedFiles} skipped`);
  return html`<button
    class="room-pick skill-import-pick ${selected ? "selected" : ""}"
    type="button"
    role="checkbox"
    aria-checked=${selected ? "true" : "false"}
    ?disabled=${!ok}
    title=${candidate.dir || candidate.name}
    @click=${() => toggleCandidate(candidate)}
  >
    <span class="room-pick-box" aria-hidden="true">${selected ? "✓" : ""}</span>
    <span class="room-pick-copy">
      <span class="room-pick-name">
        /${ok ? candidate.name : candidate.declaredName}
        ${candidate.collision ? html`<span class="badge">Duplicate name</span>` : nothing}
        ${candidate.needsReview && ok ? html`<span class="badge">Needs review</span>` : nothing}
        ${ok ? nothing : html`<span class="badge">Unsupported name</span>`}
      </span>
      <span class="room-pick-meta">${truncate(candidate.description, 96) || candidate.dir || "No description"}</span>
      ${
        candidate.warning
          ? html`<span class="skill-import-flag">${candidate.warning}</span>`
          : html`<span class="skill-import-flag portable">Portable — pure instructions</span>`
      }
      ${
        renamed || notes.length
          ? html`<span class="skill-import-note">
              ${renamed ? `Imported as /${candidate.name}` : nothing}${renamed && notes.length ? " · " : ""}${notes.join(" · ")}
            </span>`
          : nothing
      }
    </span>
  </button>`;
}

function chooseTpl(): TemplateResult {
  const selectable = state.candidates.filter(importable).length;
  const chosen = state.selected.size;
  return html`
    <div class="skill-import-head">
      <span class="skill-import-count" aria-live="polite">
        ${chosen} of ${state.candidates.length}
        selected${
          selectable === state.candidates.length ? "" : ` · ${state.candidates.length - selectable} cannot be imported`
        }
      </span>
      <button class="btn" type="button" @click=${() => setAllSelected(chosen < selectable)}>
        ${chosen < selectable ? "Select all" : "Select none"}
      </button>
    </div>
    <div class="room-pick-list skill-import-list" role="group" aria-label="Skills found in this folder">
      ${state.candidates.map(candidateRow)}
    </div>
    <label class="skill-import-scope">
      <span>Available to</span>
      ${fieldSelect({
        compact: true,
        ariaLabel: "Scope for imported skills",
        value: state.scopeId,
        disabled: state.phase === "importing",
        onChange: (value) => {
          state.scopeId = value;
          drawImportDialog();
        },
        options: state.scopes.map((scope) => html`<option value=${scope.scopeId}>${scope.name}</option>`),
      })}
    </label>
    <p class="room-hint">
      Instructions and descriptions are imported. Sibling files stay on your machine — the skills API takes a name, a
      description, and a body, so referenced assets have to be added separately.
    </p>
  `;
}

// ---------------------------------------------------------------------------
// Step 3 — importing
// ---------------------------------------------------------------------------

async function runImport(): Promise<void> {
  const chosen = state.candidates.filter((candidate) => importable(candidate) && state.selected.has(candidate.dir));
  if (!chosen.length || state.phase === "importing") return;
  state.phase = "importing";
  state.error = "";
  state.outcomes = [];
  state.done = 0;
  state.total = chosen.length;
  drawImportDialog();
  for (const candidate of chosen) {
    // Sequential on purpose: core serialises skill mutations, and a burst of parallel
    // creates would turn one bad row into a wall of unrelated failures.
    try {
      await api("/api/skills", {
        method: "POST",
        body: JSON.stringify(skillCreateBody(candidate, state.scopeId)),
      });
      state.outcomes.push({ name: candidate.name, dir: candidate.dir, ok: true, message: "" });
    } catch (e) {
      state.outcomes.push({
        name: candidate.name,
        dir: candidate.dir,
        ok: false,
        message: errMessage(e, "Import failed."),
      });
    }
    state.done += 1;
    drawImportDialog();
  }
  state.phase = "done";
  drawImportDialog();
  state.onImported?.();
}

function progressTpl(): TemplateResult {
  return html`<p class="skill-import-progress" aria-live="polite">
    Importing ${Math.min(state.done + 1, state.total)} of ${state.total}…
  </p>`;
}

function summaryTpl(): TemplateResult {
  const failed = state.outcomes.filter((outcome) => !outcome.ok);
  const imported = state.outcomes.length - failed.length;
  return html`
    <p class="skill-import-progress" aria-live="polite">
      Imported ${imported} skill${imported === 1 ? "" : "s"}${failed.length ? `, ${failed.length} failed` : ""}.
    </p>
    ${
      failed.length
        ? html`<ul class="skill-import-results">
            ${failed.map(
              (outcome) =>
                html`<li>
                  <code>/${outcome.name}</code>
                  <span>${outcome.message}</span>
                </li>`,
            )}
          </ul>`
        : nothing
    }
  `;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function bodyTpl(): TemplateResult {
  if (state.phase === "importing") return progressTpl();
  if (state.phase === "done") return summaryTpl();
  if (state.phase === "choose" && state.candidates.length) return chooseTpl();
  return pickerTpl();
}

function actionsTpl(): TemplateResult {
  if (state.phase === "done") {
    return html`<button class="btn primary" type="button" @click=${closeImportDialog}>Done</button>`;
  }
  const ready = state.phase === "choose" && state.selected.size > 0;
  return html`<button class="btn" type="button" ?disabled=${state.phase === "importing"} @click=${closeImportDialog}>
      Cancel</button
    ><button class="btn primary skill-import-confirm" type="submit" ?disabled=${!ready}>
      ${icon(FolderInput, 15)}<span
        >${state.selected.size ? `Import ${state.selected.size} skill${state.selected.size === 1 ? "" : "s"}` : "Import"}</span
      >
    </button>`;
}

function importDialogTpl(): TemplateResult {
  return html`
    <dialog
      class="project-dialog skill-import-dialog"
      aria-labelledby="skill-import-title"
      @close=${closeImportDialog}
      @cancel=${(event: Event) => state.phase === "importing" && event.preventDefault()}
      @click=${(event: MouseEvent) =>
        event.target === event.currentTarget &&
        state.phase !== "importing" &&
        (event.currentTarget as HTMLDialogElement).close()}
    >
      <form
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          void runImport();
        }}
      >
        <div class="project-dialog-head">
          <span class="context-glyph large">${icon(FolderInput, 21)}</span>
          <div><h2 id="skill-import-title">Import skills</h2></div>
          <button
            class="project-icon-button"
            type="button"
            aria-label="Close import skills"
            title="Close"
            data-dialog-cancel
            ?disabled=${state.phase === "importing"}
            @click=${closeImportDialog}
          >
            ${icon(X, 16)}
          </button>
        </div>
        <p class="room-dialog-lead">
          Pick your skills folder — <code>.claude/skills</code>, or anything shaped like it. Every subfolder holding a
          <code>SKILL.md</code> becomes a skill here.
        </p>
        ${bodyTpl()}
        <div class="form-error" aria-live="polite">${state.error}</div>
        <div class="project-dialog-actions">${actionsTpl()}</div>
      </form>
    </dialog>
  `;
}

function drawImportDialog(): void {
  const host = ensureHost();
  render(state.open ? importDialogTpl() : nothing, host);
  const dialog = host.querySelector<HTMLDialogElement>(".skill-import-dialog");
  if (dialog && !dialog.open) dialog.showModal();
}

/**
 * Opens the importer. `scopes` mirrors the Skills create form's scope list, and
 * `onImported` runs once after a completed run so the registry behind the dialog refreshes.
 */
export function openSkillImportDialog(scopes: ImportScope[], onImported: () => void): void {
  state.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.open = true;
  state.phase = "pick";
  state.folderName = "";
  state.candidates = [];
  state.selected = new Set();
  state.scopes = scopes;
  state.scopeId = scopes[0]?.scopeId ?? "";
  state.error = "";
  state.done = 0;
  state.total = 0;
  state.outcomes = [];
  state.onImported = onImported;
  drawImportDialog();
}

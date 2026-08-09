/**
 * Wires `mentions.ts` to the chat: who a room's `@Name` tokens can resolve to, when the
 * chips get painted, and the identity card a chip opens.
 *
 * ## Where this hooks into the markdown pipeline, and why it is safe
 *
 * Message bodies render through mini-lit's `<markdown-block>`, which parses with `marked`
 * and sanitises with DOMPurify (see `markdown-sanitize.ts`). The chips are painted on the
 * *output* of that pipeline — in `updated()`, after lit has committed the sanitised HTML to
 * the block's light DOM — and never on the markdown source. That ordering is the whole
 * safety argument:
 *
 * - A fenced block has already become a `<code-block>` custom element carrying its source
 *   base64-encoded in an attribute. There is no text node to touch.
 * - Inline code has already become `<code>`, and any other fence a `<pre>`. Both are in
 *   `SKIP_TAGS`, so the walk steps over them.
 * - Link text and hrefs live under `<a>`, also skipped.
 * - Nothing is ever fed back through `marked` or `innerHTML`; the chips are built with
 *   `createElement` and `textContent`, so no markup can be injected by a message body.
 *
 * The hook itself is a prototype patch on the vendored `MarkdownBlock`, following the
 * precedent in `marked-dedupe.ts`. A subclass under a new tag would have meant renaming
 * `markdown-block` in a dozen `:first-of-type`-sensitive CSS rules; patching `updated()`
 * leaves the element, its tag, and every selector exactly as they are.
 */

import { MarkdownBlock } from "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { html, nothing, render, type TemplateResult } from "lit";
import { ExternalLink } from "lucide";
import { icon } from "./ui";
import { UI_BASE } from "./deep-link";
import { appState } from "./shell-state";
import { cachedAgent, cachedPersona, roomFor } from "./room-state";
import {
  decorateMentions,
  mentionTargetsKey,
  undecorateMentions,
  viewerMentionName,
  type MentionTarget,
} from "./mentions";

/**
 * Attribute the transcript stamps on its message stack, naming the thread its messages
 * belong to. A chip has to resolve its roster from the DOM rather than a module-level
 * "current room" because split view mounts two conversations at once.
 */
export const MENTION_THREAD_ATTR = "data-mention-thread";
/** The targets key last painted onto a stack, so an unchanged draw repaints nothing. */
const MENTION_KEY_ATTR = "data-mention-key";

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * Who `@Name` can resolve to in this thread: the room's roster, plus the viewer.
 *
 * Outside a room the list is empty and no chip is ever painted — an `@` in a one-agent
 * chat means nothing to core, so it must go on meaning nothing on screen. Roster ids the
 * persona cache has not seen yet are dropped rather than guessed at; the cache warms and
 * `syncMentionTargets` repaints.
 */
export function mentionTargetsForThread(threadRef: string | null): MentionTarget[] {
  const room = roomFor(threadRef);
  if (!room?.personaIds.length) return [];
  const targets: MentionTarget[] = [];
  for (const id of room.personaIds) {
    const chip = cachedPersona(id);
    if (!chip?.name) continue;
    targets.push({
      kind: "agent",
      id: chip.id,
      name: chip.name,
      ...(chip.color ? { color: chip.color } : {}),
      ...(chip.glyph ? { glyph: chip.glyph } : {}),
    });
  }
  const me = viewerMentionName(appState.me?.user);
  if (me) targets.push({ kind: "viewer", id: "", name: me });
  return targets;
}

function stackFor(node: Element): Element | null {
  return node.closest(`[${MENTION_THREAD_ATTR}]`);
}

function targetsForNode(node: Element): MentionTarget[] {
  const stack = stackFor(node);
  if (!stack) return [];
  return mentionTargetsForThread(stack.getAttribute(MENTION_THREAD_ATTR) || null);
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

let patched = false;

/**
 * Installs the paint. Idempotent, and called once from `chat.ts` next to
 * `installMarkdownSanitizer()` so the ordering of the two is obvious at the call site.
 */
export function installMentionChips(): void {
  if (patched) return;
  patched = true;
  installMentionChipListeners();
  const proto = MarkdownBlock.prototype as unknown as {
    updated?: (changed: Map<PropertyKey, unknown>) => void;
  };
  const original = proto.updated;
  proto.updated = function (this: MarkdownBlock, changed: Map<PropertyKey, unknown>): void {
    original?.call(this, changed);
    const el = this as unknown as Element;
    const targets = targetsForNode(el);
    if (!targets.length) return;
    decorateMentions(el, targets);
  };
}

/**
 * Repaints a whole message stack when its roster changed value — which is what happens when
 * `/api/agents` lands after the transcript has already been drawn. Cheap on the common path:
 * an unchanged key is a single attribute read, and the per-block `updated()` hook covers
 * everything that rendered fresh.
 */
export function syncMentionTargets(host: Element | null | undefined): void {
  if (!host) return;
  const stacks = host.matches(`[${MENTION_THREAD_ATTR}]`)
    ? [host]
    : Array.from(host.querySelectorAll(`[${MENTION_THREAD_ATTR}]`));
  for (const stack of stacks) {
    const targets = mentionTargetsForThread(stack.getAttribute(MENTION_THREAD_ATTR) || null);
    const key = mentionTargetsKey(targets);
    if (stack.getAttribute(MENTION_KEY_ATTR) === key) continue;
    stack.setAttribute(MENTION_KEY_ATTR, key);
    undecorateMentions(stack);
    if (targets.length) decorateMentions(stack, targets);
  }
}

// ---------------------------------------------------------------------------
// The identity popover
// ---------------------------------------------------------------------------

/**
 * Deliberately the same shape as the composer's `menuControl` popover — a `.menu-popover`
 * card with a `.menu-title`, dismissed by the document-level click and Escape handlers in
 * `main.ts` that already close every other menu in the shell. It differs in one way only:
 * a chip is injected imperatively into markdown output rather than rendered from a lit
 * template, so the card is rendered into its own host next to the chip instead of inline.
 */
interface PopoverState {
  chip: HTMLElement | null;
  target: MentionTarget | null;
}

const popoverState: PopoverState = { chip: null, target: null };
let popoverHost: HTMLElement | null = null;

function ensurePopoverHost(): HTMLElement {
  if (popoverHost?.isConnected) return popoverHost;
  popoverHost = document.createElement("div");
  popoverHost.className = "mention-popover-host";
  document.body.appendChild(popoverHost);
  return popoverHost;
}

/** The first line or two of an agent's instructions — enough to recognise it, never a wall. */
function instructionsLead(instructions: string): string {
  const lines = instructions
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  return lines.length > 220 ? `${lines.slice(0, 219).trimEnd()}…` : lines;
}

function popoverBody(target: MentionTarget): TemplateResult {
  if (target.kind === "viewer") {
    return html`<div class="menu-title">You</div>
      <div class="mention-card-head">
        <span class="persona-dot">${target.name.slice(0, 1).toUpperCase()}</span>
        <span class="mention-card-name">@${target.name}</span>
      </div>
      <p class="mention-card-note">This is you — the person in the room. Agents address you by this name.</p>`;
  }
  const agent = cachedAgent(target.id);
  const lead = agent ? instructionsLead(agent.instructions) : "";
  return html`<div class="menu-title">Agent</div>
    <div class="mention-card-head" style=${target.color ? `--persona-color: ${target.color};` : ""}>
      <span class="persona-dot">${target.glyph ?? target.name.slice(0, 1).toUpperCase()}</span>
      <span class="mention-card-name">@${target.name}</span>
      ${agent && !agent.enabled ? html`<span class="badge">Disabled</span>` : nothing}
    </div>
    ${
      agent
        ? html`<dl class="mention-card-meta">
            <div>
              <dt>Harness</dt>
              <dd>${agent.harnessId}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>${agent.modelId}</dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>${agent.scope}</dd>
            </div>
          </dl>`
        : html`<p class="mention-card-note">Details are still loading, or this agent has been archived.</p>`
    }
    ${lead ? html`<p class="mention-card-instructions">${lead}</p>` : nothing}
    <a class="mention-card-link" href=${`${UI_BASE}/agents`}>
      ${icon(ExternalLink, 14)}<span>Edit on the Agents page</span>
    </a>`;
}

function placePopover(card: HTMLElement, chip: HTMLElement): void {
  const rect = chip.getBoundingClientRect();
  const width = card.offsetWidth || 250;
  const height = card.offsetHeight || 180;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 8;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 8) : below;
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function drawPopover(): void {
  const host = ensurePopoverHost();
  const target = popoverState.target;
  const chip = popoverState.chip;
  render(
    target
      ? html`<div class="menu-popover mention-popover" role="dialog" aria-label=${`${target.name} details`}>
          ${popoverBody(target)}
        </div>`
      : nothing,
    host,
  );
  const card = host.querySelector<HTMLElement>(".mention-popover");
  if (card && chip) placePopover(card, chip);
  if (chip) chip.setAttribute("aria-expanded", target ? "true" : "false");
}

function openMentionPopover(chip: HTMLElement): void {
  const kind = chip.getAttribute("data-mention-kind") === "viewer" ? "viewer" : "agent";
  const id = chip.getAttribute("data-mention-id") ?? "";
  // The chip is now just the compact `@Name` text itself (see `chipElement` in mentions.ts) —
  // there is no nested `.persona-name` span to read it off of.
  const name = (chip.textContent ?? "").replace(/^@/, "");
  if (!name) return;
  const cached = id ? cachedPersona(id) : undefined;
  popoverState.chip?.setAttribute("aria-expanded", "false");
  popoverState.chip = chip;
  popoverState.target = {
    kind,
    id,
    name: cached?.name || name,
    ...(cached?.color ? { color: cached.color } : {}),
    ...(cached?.glyph ? { glyph: cached.glyph } : {}),
  };
  drawPopover();
}

/**
 * Dismissal. `target` is the thing that was clicked, or omitted for Escape: a click inside
 * the card, or on a chip (which the delegated handler below has already dealt with), leaves
 * it alone. Returns whether it closed anything, matching `closeOpenSessionMenu`.
 */
export function closeMentionPopover(target?: EventTarget | null, force = false): boolean {
  if (!popoverState.target) return false;
  if (!force && target instanceof Element && target.closest(".mention-popover, .mention-chip")) return false;
  const chip = popoverState.chip;
  popoverState.chip = null;
  popoverState.target = null;
  drawPopover();
  chip?.setAttribute("aria-expanded", "false");
  if (force) chip?.focus?.();
  return true;
}

let listenersInstalled = false;

/** Delegated, because chips are created imperatively and there is nowhere to bind `@click`. */
function installMentionChipListeners(): void {
  if (listenersInstalled || typeof document === "undefined") return;
  listenersInstalled = true;
  document.addEventListener("click", (event) => {
    const chip = (event.target as Element | null)?.closest<HTMLElement>(".mention-chip");
    if (!chip) return;
    event.preventDefault();
    if (popoverState.chip === chip) closeMentionPopover(null, true);
    else openMentionPopover(chip);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const chip = (event.target as Element | null)?.closest<HTMLElement>(".mention-chip");
    if (!chip) return;
    event.preventDefault();
    if (popoverState.chip === chip) closeMentionPopover(null, true);
    else openMentionPopover(chip);
  });
  window.addEventListener("resize", () => closeMentionPopover(null, true), { passive: true });
}

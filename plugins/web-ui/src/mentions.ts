/**
 * `@Name` in a room message, rendered as a chip instead of raw prose.
 *
 * Two halves live here, and only the first touches the DOM:
 *
 * - **The rule** (`mentionSegments`) — pure, so the matching is unit-testable without a
 *   browser. It splits one run of plain text into literal spans and mention hits.
 * - **The paint** (`decorateMentions` / `undecorateMentions`) — walks already-rendered
 *   markdown and swaps matched text nodes for chip elements. It runs *after* markdown has
 *   been parsed and sanitised, never before, which is what makes it safe: by the time it
 *   looks at the tree, a fenced block is a `<code-block>` element carrying its source in an
 *   attribute and inline code is a `<code>` element — neither is a text node this walk will
 *   touch. See `SKIP_TAGS`.
 *
 * Nothing here imports lit or the persona cache, so the module is importable from a plain
 * `node --test` process; `mention-markdown.ts` is the piece that wires it to the chat.
 */

/** Who a chip can point at. The viewer is not on the roster, hence the discriminant. */
export interface MentionTarget {
  kind: "agent" | "viewer";
  /** Persona id. Empty for the viewer, who has none. */
  id: string;
  name: string;
  color?: string;
  glyph?: string;
}

export interface MentionSegment {
  /** Exactly the source text this segment covers — concatenating them rebuilds the input. */
  text: string;
  /** Null for literal prose; set when `text` is an `@Name` token that resolved. */
  target: MentionTarget | null;
}

/**
 * Elements whose text is not prose and must never be chipped. `CODE`/`PRE` cover inline
 * code and any fence marked renders as a `<pre><code>`; `CODE-BLOCK` is the custom element
 * mini-lit swaps fenced blocks for (its source rides in a base64 attribute, so it has no
 * text node here at all); `A` keeps us out of link text and, by extension, out of anything
 * that could look like an address.
 */
const SKIP_TAGS = new Set(["CODE", "PRE", "CODE-BLOCK", "A", "KBD", "SAMP", "SCRIPT", "STYLE", "TEXTAREA"]);

/** Marks a chip we injected, so a second pass neither nests nor double-counts it. */
export const MENTION_CHIP_CLASS = "mention-chip";
/** Holds the exact source text a chip replaced, so the paint is reversible. */
const RAW_ATTR = "data-mention-raw";

/**
 * The name-side boundary, mirrored verbatim from core's `mentionAt`
 * (`src/agents/panel-driver.ts`): case-insensitive, and the token must end at a
 * non-name character so `@Scoutmaster` does not summon `Scout`. Core is a separate build,
 * so the rule is copied rather than imported — change it there and change it here.
 *
 * `LEFT_BOUNDARY` is a deliberate *addition* core does not have. Core only asks "does this
 * message contain `@Name` anywhere", which is the right question for routing a reply. A
 * renderer has to answer a stricter one, because painting a chip over part of
 * `contact@scout.example` would corrupt an address on screen — so the `@` must not follow a
 * character an email local part can end with. The consequence is a knowingly narrow
 * divergence: core may route a turn on a hit this renderer leaves as plain text.
 */
const LEFT_BOUNDARY = /[A-Za-z0-9._%+@-]/;

function matchesAt(text: string, at: number, name: string): boolean {
  if (text.charAt(at) !== "@") return false;
  if (at > 0 && LEFT_BOUNDARY.test(text.charAt(at - 1))) return false;
  const end = at + 1 + name.length;
  if (text.slice(at + 1, end).toLowerCase() !== name.toLowerCase()) return false;
  return !/[A-Za-z0-9-]/.test(text.charAt(end));
}

/**
 * Targets sorted so the longest name is tried first: with both `Scout` and `Scoutmaster`
 * on the roster, `@Scoutmaster` must resolve to the longer one rather than failing the
 * boundary check against the shorter and falling through to plain text.
 */
function byNameLength(targets: readonly MentionTarget[]): MentionTarget[] {
  return [...targets].filter((t) => t.name.trim().length > 0).sort((a, b) => b.name.length - a.name.length);
}

/**
 * Splits one run of plain text into literal and mention segments. Never throws, never
 * drops characters: `segments.map((s) => s.text).join("")` is always the input.
 */
export function mentionSegments(text: string, targets: readonly MentionTarget[]): MentionSegment[] {
  const ordered = byNameLength(targets);
  if (!ordered.length || !text.includes("@")) return [{ text, target: null }];
  const out: MentionSegment[] = [];
  let literal = "";
  for (let i = 0; i < text.length;) {
    if (text.charAt(i) !== "@") {
      literal += text.charAt(i);
      i++;
      continue;
    }
    const hit = ordered.find((target) => matchesAt(text, i, target.name));
    if (!hit) {
      literal += "@";
      i++;
      continue;
    }
    if (literal) out.push({ text: literal, target: null });
    literal = "";
    const raw = text.slice(i, i + 1 + hit.name.length);
    out.push({ text: raw, target: hit });
    i += raw.length;
  }
  if (literal) out.push({ text: literal, target: null });
  return out.length ? out : [{ text, target: null }];
}

/** True when `text` carries at least one resolvable mention — the cheap pre-check. */
export function hasMention(text: string, targets: readonly MentionTarget[]): boolean {
  return mentionSegments(text, targets).some((seg) => seg.target !== null);
}

/**
 * Value identity for a roster, so a caller can tell "the targets changed, repaint" from
 * "same targets, leave the DOM alone" without deep-comparing on every draw.
 */
export function mentionTargetsKey(targets: readonly MentionTarget[]): string {
  return targets.map((t) => [t.kind, t.id, t.name, t.color ?? "", t.glyph ?? ""].join("")).join("");
}

/**
 * A principal turned into something an agent could plausibly have typed after an `@`.
 *
 * The web UI's only handle on the viewer is `appState.me.user`, which is a principal id —
 * usually an email. `hello@josh@example.com` is not a thing anyone writes, so the local
 * part is what a mention would use. It is accepted only when it has the exact shape core
 * demands of an agent name (`AGENT_NAME_PATTERN`), because that is the shape the `@` token
 * grammar is defined over; anything else (dots, spaces, an opaque uuid) yields null and the
 * viewer simply never chips, rather than the renderer guessing at a handle.
 */
const VIEWER_HANDLE = /^[A-Za-z][A-Za-z0-9-]{1,31}$/;

export function viewerMentionName(principal: string | null | undefined): string | null {
  const raw = (principal ?? "").trim();
  if (!raw) return null;
  const local = raw.includes("@") ? raw.slice(0, raw.indexOf("@")) : raw;
  return VIEWER_HANDLE.test(local) ? local : null;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

function ownerDoc(root: Element): Document {
  return root.ownerDocument;
}

/** True when this node sits inside something whose text is not prose. */
function inSkippedContext(node: Node, root: Element): boolean {
  let el = node.parentElement;
  while (el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.classList.contains(MENTION_CHIP_CLASS)) return true;
    if (el === root) return false;
    el = el.parentElement;
  }
  return false;
}

function textNodesIn(root: Element): Text[] {
  const doc = ownerDoc(root);
  const walker = doc.createTreeWalker(root, 0x4 /* NodeFilter.SHOW_TEXT */);
  const out: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node as Text);
  return out;
}

/** The two-letter fallback when a target carries no glyph of its own. */
function glyphFor(target: MentionTarget): string {
  return target.glyph ?? target.name.slice(0, 1).toUpperCase();
}

/**
 * One chip. Built from the same `persona-chip`/`persona-dot` parts the author chips and
 * roster chips use, so a mention reads as the same family of label, plus `inline-mention`
 * for the sizing that only makes sense mid-sentence.
 */
function chipElement(doc: Document, target: MentionTarget, raw: string): HTMLElement {
  const chip = doc.createElement("span");
  chip.className = `${MENTION_CHIP_CLASS} persona-chip inline-mention${target.color ? "" : " neutral"}${
    target.kind === "viewer" ? " mention-viewer" : ""
  }`;
  if (target.color) chip.setAttribute("style", `--persona-color: ${target.color};`);
  chip.setAttribute(RAW_ATTR, raw);
  chip.setAttribute("data-mention-kind", target.kind);
  if (target.id) chip.setAttribute("data-mention-id", target.id);
  chip.setAttribute("role", "button");
  chip.setAttribute("tabindex", "0");
  chip.setAttribute(
    "title",
    target.kind === "viewer" ? `${target.name} — you` : `${target.name} — open this agent's details`,
  );
  const dot = doc.createElement("span");
  dot.className = "persona-dot";
  dot.setAttribute("aria-hidden", "true");
  dot.textContent = glyphFor(target);
  const name = doc.createElement("span");
  name.className = "persona-name";
  name.textContent = `@${target.name}`;
  chip.append(dot, name);
  return chip;
}

/**
 * Replaces every resolvable `@Name` under `root` with a chip. Idempotent: chips already
 * painted are skipped, so calling it twice changes nothing. Returns how many it added.
 */
export function decorateMentions(root: Element, targets: readonly MentionTarget[]): number {
  const ordered = byNameLength(targets);
  if (!ordered.length) return 0;
  const doc = ownerDoc(root);
  let painted = 0;
  for (const node of textNodesIn(root)) {
    const text = node.data;
    if (!text.includes("@")) continue;
    if (inSkippedContext(node, root)) continue;
    const segments = mentionSegments(text, ordered);
    if (!segments.some((seg) => seg.target)) continue;
    const frag = doc.createDocumentFragment();
    for (const seg of segments) {
      if (!seg.target) {
        frag.appendChild(doc.createTextNode(seg.text));
        continue;
      }
      frag.appendChild(chipElement(doc, seg.target, seg.text));
      painted++;
    }
    node.parentNode?.replaceChild(frag, node);
  }
  return painted;
}

/**
 * Puts every chip under `root` back to the text it replaced. The paint has to be reversible
 * because the roster can arrive *after* a message is on screen (the persona cache warms
 * asynchronously), and the second pass needs the original `@Name` text to match against.
 */
export function undecorateMentions(root: Element): number {
  const doc = ownerDoc(root);
  const chips = Array.from(root.querySelectorAll(`.${MENTION_CHIP_CLASS}[${RAW_ATTR}]`));
  for (const chip of chips) {
    const raw = chip.getAttribute(RAW_ATTR) ?? "";
    const parent = chip.parentNode;
    if (!parent) continue;
    parent.replaceChild(doc.createTextNode(raw), chip);
    (parent as Element).normalize?.();
  }
  return chips.length;
}

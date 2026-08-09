/**
 * Reading a folder of Claude-Code-style skills in the browser.
 *
 * QM's core runs in a container that cannot see the operator's filesystem, so there is no
 * server-side directory scan to call. The browser reads the chosen folder instead
 * (`<input type="file" webkitdirectory>`), these pure functions turn the resulting file
 * list into importable skills, and the dialog POSTs the chosen ones to the ordinary
 * skills API. Everything here is deliberately IO-free so it can be unit tested and so the
 * same parsing works unchanged for a hosted deployment.
 *
 * A skill on disk is a directory holding `SKILL.md`: YAML frontmatter with `name` and
 * `description`, then a markdown body, plus optional sibling files (references/, scripts/).
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One file read out of the picked folder. `relativePath` is `webkitRelativePath`. */
export interface ImportFile {
  relativePath: string;
  text: string;
}

/** A sibling file carried along with a skill, at a path relative to the skill directory. */
export interface SkillAttachment {
  path: string;
  text: string;
}

export interface ParsedSkill {
  /** Directory the SKILL.md lives in, "" when it sits at the root of the pick. */
  dir: string;
  /** Name as declared (frontmatter `name`, else the containing directory). */
  name: string;
  description: string;
  body: string;
  /** Frontmatter was missing or incomplete — the operator should look before importing. */
  needsReview: boolean;
}

export interface ImportCandidate extends ParsedSkill {
  /** The name as written on disk, kept so the row can show what was renamed. */
  declaredName: string;
  files: SkillAttachment[];
  /** Eligible sibling files dropped because the per-skill cap was reached. */
  omittedFiles: number;
  /** Sibling files skipped for being binary-looking, oversized, or editor junk. */
  skippedFiles: number;
  /** Another picked directory produced the same skill name. */
  collision: boolean;
  /** Short "this wants your desktop" note, or null when the skill is pure instructions. */
  warning: string | null;
}

/** Attachments are capped per skill so one asset-heavy folder cannot dominate a run. */
export const MAX_ATTACHED_FILES = 20;
/** Roughly 256KB of text. Anything larger is a data blob, not skill instructions. */
export const MAX_FILE_CHARS = 256 * 1024;

const MANIFEST_NAME = "skill.md";
const JUNK_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const SKIPPABLE_DIRS = ["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build"];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function normalizeImportPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/(^|\/)\.\//g, "$1");
}

function baseOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

/**
 * Directories never worth reading. A skills folder often sits next to a checkout or a
 * virtualenv, and reading those would stall the picker for nothing.
 */
export function isSkippableImportPath(path: string): boolean {
  const segments = normalizeImportPath(path).split("/");
  if (JUNK_FILES.has((segments.at(-1) ?? "").toLowerCase())) return true;
  return segments.slice(0, -1).some((segment) => SKIPPABLE_DIRS.includes(segment.toLowerCase()));
}

/** Control characters that no text file has any business containing. */
export function looksBinary(text: string): boolean {
  if (text.includes("\u0000") || text.includes("\uFFFD")) return true;
  const sample = text.slice(0, 4096);
  if (!sample) return false;
  let control = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control += 1;
  }
  return control / sample.length > 0.02;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function unquote(value: string): string {
  const s = value.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/**
 * Enough YAML for a skill header: top-level `key: value`, quoted or bare (so a description
 * may itself contain colons), plus block scalars and indented continuation lines, which is
 * how long descriptions are usually written. Anything nested is folded into the value it
 * follows rather than mistaken for a new key.
 */
function parseFrontmatterFields(block: string): Record<string, string> {
  const lines = block.split(/\r?\n/);
  const out: Record<string, string> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index++]!;
    const entry = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!entry) continue;
    const key = entry[1]!.toLowerCase();
    const head = entry[2] ?? "";
    const blockScalar = /^[|>][+-]?$/.test(head.trim()) ? head.trim()[0] : "";
    const continued: string[] = [];
    while (index < lines.length) {
      const next = lines[index]!;
      if (!next.trim()) {
        if (!blockScalar) break;
        continued.push("");
        index++;
        continue;
      }
      if (!/^[ \t]/.test(next)) break;
      continued.push(next.trim());
      index++;
    }
    let value: string;
    if (blockScalar) value = continued.join(blockScalar === "|" ? "\n" : " ").trim();
    else value = unquote([head, ...continued].join(" ").trim());
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * Parses one `SKILL.md`. Returns null for any other file, and for a manifest that has
 * neither a frontmatter name nor a containing directory to borrow a name from.
 */
export function parseSkillFile(path: string, text: string): ParsedSkill | null {
  const normalized = normalizeImportPath(path);
  if (baseOf(normalized).toLowerCase() !== MANIFEST_NAME) return null;
  const dir = dirOf(normalized);
  const source = stripBom(text ?? "");
  const matched = FRONTMATTER.exec(source);
  const fields = matched ? parseFrontmatterFields(matched[1]!) : null;
  const declared = (fields?.name ?? "").trim();
  const description = (fields?.description ?? "").trim();
  const body = (matched ? source.slice(matched[0].length) : source).replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
  const name = declared || (dir ? baseOf(dir) : "");
  if (!name) return null;
  return { dir, name, description, body, needsReview: !matched || !declared || !description };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Mirrors core's `isSafeSkillName` so a doomed create never leaves the browser. */
const SAFE_SKILL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_-])?$/;

export function isSafeSkillName(name: string): boolean {
  return SAFE_SKILL_NAME.test(name);
}

/**
 * Coerces an on-disk name into one core will accept. Plugin skills arrive namespaced
 * (`vercel:deploy`), which core rejects outright, so the separator becomes a hyphen rather
 * than the whole skill being unimportable. Returns "" when nothing usable survives.
 */
export function normalizeSkillName(raw: string): string {
  let name = raw
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9_-]+$/, "");
  if (name.length > 128) name = name.slice(0, 128).replace(/[^A-Za-z0-9_-]+$/, "");
  return isSafeSkillName(name) ? name : "";
}

// ---------------------------------------------------------------------------
// Portability
// ---------------------------------------------------------------------------

const LOCAL_PATHS: Array<[RegExp, string]> = [
  [/[A-Za-z]:\\/, "C:\\"],
  [/~[\\/]\.claude/, "~/.claude"],
  [/\.claude[\\/]skills/i, ".claude/skills"],
  [/%APPDATA%/i, "%APPDATA%"],
];

const LOCAL_TOOLS: Array<[RegExp, string]> = [
  [/\brtk\b/i, "rtk"],
  [/\bcodex\s/i, "codex"],
  [/\bclaude\s+-p\b/i, "claude -p"],
  [/\bffmpeg\b/i, "ffmpeg"],
  [/\bwhisperx\b/i, "whisperx"],
  [/\bapify\b/i, "apify"],
  [/\byt-dlp\b/i, "yt-dlp"],
  [/\bplaywright\b/i, "playwright"],
  [/\bdocker\s/i, "docker"],
];

function hits(patterns: Array<[RegExp, string]>, text: string): string[] {
  return patterns.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

function shortList(labels: string[]): string {
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")}, +${labels.length - 3} more`;
}

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * A one-line "this skill wants your desktop, not QM's sandbox" note, or null when the
 * skill is pure instructions. Deliberately conservative: it reports what it saw rather
 * than deciding the skill is broken, because plenty of skills mention a tool in passing.
 */
export function portabilityWarning(skill: { body?: string; description?: string }): string | null {
  const text = `${skill.description ?? ""}\n${skill.body ?? ""}`;
  const paths = hits(LOCAL_PATHS, text);
  const tools = hits(LOCAL_TOOLS, text);
  const parts: string[] = [];
  if (paths.length) parts.push(`local paths (${shortList(paths)})`);
  if (tools.length) parts.push(`local tools (${shortList(tools)})`);
  if (/mcp__/.test(text)) parts.push("MCP tools");
  if (!parts.length) return null;
  return `References ${joinClauses(parts)} — may not run in QM's sandbox`;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Finds every SKILL.md at any depth and hands each one the sibling files under its own
 * directory. A file is claimed by the deepest skill directory that contains it, so a skill
 * nested inside another folder of skills keeps its own assets.
 */
export function groupSkillFiles(files: readonly ImportFile[]): ImportCandidate[] {
  const normalized = files.map((file) => ({ path: normalizeImportPath(file.relativePath), text: file.text ?? "" }));
  const manifests = normalized.filter((file) => baseOf(file.path).toLowerCase() === MANIFEST_NAME);
  const skillDirs = [...new Set(manifests.map((file) => dirOf(file.path)))].sort((a, b) => b.length - a.length);
  const manifestPaths = new Set(manifests.map((file) => file.path));

  const siblings = new Map<string, Array<{ path: string; text: string }>>();
  for (const file of normalized) {
    if (manifestPaths.has(file.path)) continue;
    const owner = skillDirs.find((dir) => (dir === "" ? true : file.path.startsWith(`${dir}/`)));
    if (owner === undefined) continue;
    const bucket = siblings.get(owner) ?? [];
    bucket.push(file);
    siblings.set(owner, bucket);
  }

  const candidates: ImportCandidate[] = [];
  for (const manifest of manifests) {
    const parsed = parseSkillFile(manifest.path, manifest.text);
    if (!parsed) continue;
    const dir = dirOf(manifest.path);
    const prefix = dir ? dir.length + 1 : 0;
    const bucket = (siblings.get(dir) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
    const attachments: SkillAttachment[] = [];
    let omittedFiles = 0;
    let skippedFiles = 0;
    for (const file of bucket) {
      if (isSkippableImportPath(file.path) || file.text.length > MAX_FILE_CHARS || looksBinary(file.text)) {
        skippedFiles += 1;
        continue;
      }
      if (attachments.length >= MAX_ATTACHED_FILES) {
        omittedFiles += 1;
        continue;
      }
      attachments.push({ path: file.path.slice(prefix), text: file.text });
    }
    const declaredName = parsed.name;
    const name = normalizeSkillName(declaredName);
    candidates.push({
      ...parsed,
      name,
      declaredName,
      files: attachments,
      omittedFiles,
      skippedFiles,
      collision: false,
      warning: portabilityWarning(parsed),
      needsReview: parsed.needsReview || !name,
    });
  }

  // Two directories can legitimately declare the same name (a personal copy shadowing a
  // plugin one). Keep both rows and flag them — core rejects the second create per scope,
  // and silently dropping one would hide that.
  const seen = new Map<string, number>();
  for (const candidate of candidates) seen.set(candidate.name, (seen.get(candidate.name) ?? 0) + 1);
  for (const candidate of candidates) candidate.collision = (seen.get(candidate.name) ?? 0) > 1;

  return candidates.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
}

// ---------------------------------------------------------------------------
// Mapping onto the skills API
// ---------------------------------------------------------------------------

export const IMPORT_NO_DESCRIPTION = "Imported skill (its SKILL.md declared no description)";
export const IMPORT_NO_BODY = "(the imported SKILL.md had no instructions below its frontmatter)";

export interface SkillCreateBody {
  name: string;
  description: string;
  body: string;
  scopeId?: string;
}

/**
 * `POST /api/skills` takes exactly name, description, body, and scopeId — it has no
 * attachment channel — and core rejects any of the three strings being empty, so a
 * manifest that declared nothing still has to say something. An unknown scope is left
 * off entirely rather than sent blank, so core falls back to the caller's personal scope.
 */
export function skillCreateBody(candidate: ImportCandidate, scopeId: string): SkillCreateBody {
  const description = candidate.description.trim();
  const body = candidate.body.trim();
  return {
    name: candidate.name,
    description: description || IMPORT_NO_DESCRIPTION,
    body: body || description || IMPORT_NO_BODY,
    ...(scopeId ? { scopeId } : {}),
  };
}

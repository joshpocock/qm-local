import assert from "node:assert/strict";
import test from "node:test";
import {
  groupSkillFiles,
  IMPORT_NO_BODY,
  IMPORT_NO_DESCRIPTION,
  isSkippableImportPath,
  MAX_ATTACHED_FILES,
  MAX_FILE_CHARS,
  normalizeSkillName,
  parseSkillFile,
  portabilityWarning,
  skillCreateBody,
  type ImportFile,
} from "../src/skill-import.ts";

function manifest(front: string, body = "Do the thing."): string {
  return `---\n${front}\n---\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// parseSkillFile
// ---------------------------------------------------------------------------

test("parses frontmatter name and description and keeps the body below it", () => {
  const parsed = parseSkillFile(
    "skills/deploy/SKILL.md",
    manifest("name: deploy\ndescription: Ship an application", "## Steps\n\n1. Build\n"),
  );
  assert.deepEqual(parsed, {
    dir: "skills/deploy",
    name: "deploy",
    description: "Ship an application",
    body: "## Steps\n\n1. Build",
    needsReview: false,
  });
});

test("a description may be quoted and may contain colons", () => {
  const quoted = parseSkillFile("a/SKILL.md", manifest(`name: a\ndescription: "Use when: the build fails, e.g. CI"`));
  assert.equal(quoted?.description, "Use when: the build fails, e.g. CI");
  const bare = parseSkillFile("b/SKILL.md", manifest("name: b\ndescription: Use when: the build fails"));
  assert.equal(bare?.description, "Use when: the build fails");
  const single = parseSkillFile("c/SKILL.md", manifest("name: c\ndescription: 'It''s a wrap: really'"));
  assert.equal(single?.description, "It's a wrap: really");
});

test("a long description folded over indented continuation lines survives intact", () => {
  const parsed = parseSkillFile(
    "long/SKILL.md",
    manifest("name: long\ndescription: >-\n  First clause here.\n  Second clause here.\nallowed-tools: Read"),
  );
  assert.equal(parsed?.description, "First clause here. Second clause here.");
  const plain = parseSkillFile("plain/SKILL.md", manifest("name: plain\ndescription: One line\n  wrapped onward"));
  assert.equal(plain?.description, "One line wrapped onward");
});

test("missing frontmatter falls back to the directory name and flags the skill for review", () => {
  const parsed = parseSkillFile("skills/orphan/SKILL.md", "# Orphan\n\nJust markdown, no header.\n");
  assert.equal(parsed?.name, "orphan");
  assert.equal(parsed?.description, "");
  assert.equal(parsed?.body, "# Orphan\n\nJust markdown, no header.");
  assert.equal(parsed?.needsReview, true);
});

test("frontmatter without a name still borrows the directory, and a missing description needs review", () => {
  const noName = parseSkillFile("skills/tidy/SKILL.md", manifest("description: Tidy things"));
  assert.equal(noName?.name, "tidy");
  assert.equal(noName?.needsReview, true);
  const noDescription = parseSkillFile("skills/tidy/SKILL.md", manifest("name: tidy"));
  assert.equal(noDescription?.description, "");
  assert.equal(noDescription?.needsReview, true);
});

test("only a SKILL.md parses, and a nameless one at the root parses to nothing", () => {
  assert.equal(parseSkillFile("skills/deploy/README.md", manifest("name: deploy\ndescription: x")), null);
  assert.equal(parseSkillFile("SKILL.md", "no frontmatter, no directory"), null);
  assert.equal(parseSkillFile("SKILL.md", manifest("name: rooted\ndescription: x"))?.name, "rooted");
});

test("windows separators and a leading BOM do not defeat the parser", () => {
  const parsed = parseSkillFile("skills\\deploy\\SKILL.md", `\uFEFF${manifest("name: deploy\ndescription: Ship it")}`);
  assert.equal(parsed?.dir, "skills/deploy");
  assert.equal(parsed?.description, "Ship it");
});

// ---------------------------------------------------------------------------
// groupSkillFiles
// ---------------------------------------------------------------------------

test("finds SKILL.md at both nesting depths", () => {
  const files: ImportFile[] = [
    { relativePath: "skills/alpha/SKILL.md", text: manifest("name: alpha\ndescription: A") },
    { relativePath: "beta/SKILL.md", text: manifest("name: beta\ndescription: B") },
    { relativePath: "skills/deep/nested/gamma/SKILL.md", text: manifest("name: gamma\ndescription: G") },
    { relativePath: "skills/README.md", text: "not a skill" },
  ];
  assert.deepEqual(
    groupSkillFiles(files).map((c) => c.name),
    ["alpha", "beta", "gamma"],
  );
});

test("sibling files ride along at paths relative to the skill directory", () => {
  const candidates = groupSkillFiles([
    { relativePath: "skills/alpha/SKILL.md", text: manifest("name: alpha\ndescription: A") },
    { relativePath: "skills/alpha/references/notes.md", text: "notes" },
    { relativePath: "skills/alpha/scripts/run.py", text: "print(1)" },
    { relativePath: "skills/beta/SKILL.md", text: manifest("name: beta\ndescription: B") },
    { relativePath: "skills/beta/only.txt", text: "b" },
  ]);
  assert.deepEqual(
    candidates[0]!.files.map((f) => f.path),
    ["references/notes.md", "scripts/run.py"],
  );
  assert.deepEqual(
    candidates[1]!.files.map((f) => f.path),
    ["only.txt"],
  );
});

test("a skill nested inside another skill's folder keeps its own assets", () => {
  const candidates = groupSkillFiles([
    { relativePath: "outer/SKILL.md", text: manifest("name: outer\ndescription: O") },
    { relativePath: "outer/mine.md", text: "outer asset" },
    { relativePath: "outer/inner/SKILL.md", text: manifest("name: inner\ndescription: I") },
    { relativePath: "outer/inner/mine.md", text: "inner asset" },
  ]);
  const inner = candidates.find((c) => c.name === "inner")!;
  const outer = candidates.find((c) => c.name === "outer")!;
  assert.deepEqual(
    inner.files.map((f) => f.path),
    ["mine.md"],
  );
  assert.deepEqual(
    outer.files.map((f) => f.path),
    ["mine.md"],
  );
  assert.equal(outer.files.length, 1);
});

test("attachments stop at the cap and oversized or binary siblings are skipped, both counted", () => {
  const files: ImportFile[] = [{ relativePath: "a/SKILL.md", text: manifest("name: a\ndescription: A") }];
  for (let i = 0; i < MAX_ATTACHED_FILES + 3; i++) {
    files.push({ relativePath: `a/ref-${String(i).padStart(2, "0")}.md`, text: `note ${i}` });
  }
  files.push({ relativePath: "a/huge.md", text: "x".repeat(MAX_FILE_CHARS + 1) });
  files.push({ relativePath: "a/logo.png", text: "\u0000PNG\u0000\u0000" });
  const [candidate] = groupSkillFiles(files);
  assert.equal(candidate!.files.length, MAX_ATTACHED_FILES);
  assert.equal(candidate!.omittedFiles, 3);
  assert.equal(candidate!.skippedFiles, 2);
});

test("two folders declaring the same name are both kept and both flagged", () => {
  const candidates = groupSkillFiles([
    { relativePath: "personal/deploy/SKILL.md", text: manifest("name: deploy\ndescription: Mine") },
    { relativePath: "plugins/deploy/SKILL.md", text: manifest("name: deploy\ndescription: Theirs") },
    { relativePath: "plugins/other/SKILL.md", text: manifest("name: other\ndescription: Fine") },
  ]);
  assert.equal(candidates.length, 3);
  assert.deepEqual(
    candidates.filter((c) => c.collision).map((c) => c.dir),
    ["personal/deploy", "plugins/deploy"],
  );
  assert.equal(candidates.find((c) => c.name === "other")!.collision, false);
});

test("a namespaced plugin name is coerced into one core will accept", () => {
  const [candidate] = groupSkillFiles([
    { relativePath: "vercel:deploy/SKILL.md", text: manifest("name: vercel:deploy\ndescription: Ship") },
  ]);
  assert.equal(candidate!.declaredName, "vercel:deploy");
  assert.equal(candidate!.name, "vercel-deploy");
  assert.equal(normalizeSkillName("  --weird!! name..  "), "weird-name");
  assert.equal(normalizeSkillName("!!!"), "");
});

test("checkouts and editor junk inside a skills folder are never read", () => {
  assert.equal(isSkippableImportPath("a/node_modules/pkg/index.js"), true);
  assert.equal(isSkippableImportPath("a/.git/config"), true);
  assert.equal(isSkippableImportPath("a/.DS_Store"), true);
  assert.equal(isSkippableImportPath("a/references/notes.md"), false);
});

// ---------------------------------------------------------------------------
// portabilityWarning
// ---------------------------------------------------------------------------

test("a prompt-only skill is not flagged", () => {
  assert.equal(
    portabilityWarning({
      description: "Review a pull request and summarise the risky changes.",
      body: "Read the diff, group the changes by intent, and call out anything untested.",
    }),
    null,
  );
});

test("each portability heuristic fires and reads as one line", () => {
  const cases: Array<[string, string]> = [
    ["Save it to C:\\Users\\me\\out", "local paths (C:\\)"],
    ["Skills live in ~/.claude/skills", "local paths (~/.claude"],
    ["Copy it under .claude/skills/foo", "local paths (.claude/skills)"],
    ["Write to %APPDATA%\\qm", "local paths (%APPDATA%)"],
    ["Run rtk gain to see savings", "local tools (rtk)"],
    ["Delegate with codex exec -s read-only", "local tools (codex)"],
    ["Shell out to claude -p 'summarise'", "local tools (claude -p)"],
    ["Trim it with ffmpeg -i in.mp4", "local tools (ffmpeg)"],
    ["Transcribe using whisperx", "local tools (whisperx)"],
    ["Scrape it through the apify actor", "local tools (apify)"],
    ["Download with yt-dlp", "local tools (yt-dlp)"],
    ["Drive the page with playwright", "local tools (playwright)"],
    ["Then docker compose up", "local tools (docker)"],
    ["Call mcp__tokensave__search", "MCP tools"],
  ];
  for (const [body, expected] of cases) {
    const warning = portabilityWarning({ body });
    assert.ok(warning, `expected a warning for: ${body}`);
    assert.ok(warning!.includes(expected), `"${warning}" should mention ${expected}`);
    assert.ok(warning!.endsWith("may not run in QM's sandbox"), warning!);
    assert.ok(warning!.length < 140, `warning should stay on one line: ${warning}`);
  }
});

test("a warning names several offenders at once without growing unbounded", () => {
  const warning = portabilityWarning({
    description: "Cut a clip",
    body: "Read C:\\clips, run ffmpeg, then apify, then yt-dlp, then playwright, then mcp__foo__bar.",
  })!;
  assert.match(
    warning,
    /^References local paths \(C:\\\), local tools \(ffmpeg, apify, yt-dlp, \+1 more\) and MCP tools/,
  );
});

test("descriptions are scanned too, and ordinary prose is left alone", () => {
  assert.match(
    portabilityWarning({ description: "Wraps ffmpeg", body: "Follow the steps." })!,
    /local tools \(ffmpeg\)/,
  );
  assert.equal(portabilityWarning({ body: "Keep the dockerfile in mind and codexes are books." }), null);
});

test("grouped candidates carry their own portability flag", () => {
  const candidates = groupSkillFiles([
    { relativePath: "a/SKILL.md", text: manifest("name: a\ndescription: A", "Run ffmpeg on the input.") },
    { relativePath: "b/SKILL.md", text: manifest("name: b\ndescription: B", "Summarise the document.") },
  ]);
  assert.match(candidates[0]!.warning!, /ffmpeg/);
  assert.equal(candidates[1]!.warning, null);
});

// ---------------------------------------------------------------------------
// skillCreateBody
// ---------------------------------------------------------------------------

test("the create body carries name, description, body, and scope, with stand-ins for empties", () => {
  const [full] = groupSkillFiles([
    { relativePath: "a/SKILL.md", text: manifest("name: a\ndescription: Does a thing", "Step one.") },
  ]);
  assert.deepEqual(skillCreateBody(full!, "personal:jordan"), {
    name: "a",
    description: "Does a thing",
    body: "Step one.",
    scopeId: "personal:jordan",
  });

  const [bare] = groupSkillFiles([{ relativePath: "b/SKILL.md", text: "" }]);
  assert.deepEqual(skillCreateBody(bare!, ""), {
    name: "b",
    description: IMPORT_NO_DESCRIPTION,
    body: IMPORT_NO_BODY,
  });

  const [headerOnly] = groupSkillFiles([
    { relativePath: "c/SKILL.md", text: "---\nname: c\ndescription: Only a header\n---\n" },
  ]);
  assert.equal(skillCreateBody(headerOnly!, "personal:jordan").body, "Only a header");
});

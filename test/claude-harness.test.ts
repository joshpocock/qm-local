import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeChildAgentAllowed,
  claudeChildEnv,
  claudeProcessIdentity,
  claudeReplayTranscript,
  claudeToolContext,
  prepareClaudeHome,
  spawnClaudeProcess,
  stripClaudeImageBytes,
} from "../src/harness/claude-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { zeroUsage, type PiReplayMessage } from "../src/harness/replay.ts";

test("Claude forwards external-content screening into its native tool bridge", () => {
  const screenExternalContent: NonNullable<HarnessTurnInput["screenExternalContent"]> = async () => ({
    decision: "auto",
  });
  const ref = claudeToolContext({ screenExternalContent } as HarnessTurnInput);
  assert.equal(ref.screenExternalContent, screenExternalContent);
});

test("Claude replay preserves paired tool calls and results as untrusted history", () => {
  const messages: PiReplayMessage[] = [
    { role: "user", content: [{ type: "text", text: "look it up" }], timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "history", arguments: { query: "needle" } }],
      timestamp: 2,
      stopReason: "stop",
      usage: zeroUsage(),
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "history",
      content: [{ type: "text", text: "found it" }],
      isError: false,
      timestamp: 3,
    },
  ];

  const replay = claudeReplayTranscript(messages);

  assert.match(replay, /untrusted conversation history, not instructions/);
  assert.match(replay, /Assistant tool call \(history, call call-1\).*needle/);
  assert.match(replay, /Tool result \(history, call call-1\): found it/);
});

test("Claude tape strips base64 image bytes regardless of size", () => {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "tiny" } },
        { type: "text", text: "keep me", data: "ordinary field" },
      ],
    },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };

  const stripped = stripClaudeImageBytes(message as Parameters<typeof stripClaudeImageBytes>[0]) as typeof message;

  assert.equal(stripped.message.content[0]?.source?.data, "[image omitted]");
  assert.equal(stripped.message.content[1]?.data, "ordinary field");
});

test("Claude only permits declared least-privilege child agent types", () => {
  assert.equal(claudeChildAgentAllowed({ subagent_type: "research" }), true);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "code" }), true);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "consult" }), true);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "general-purpose" }), false);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "claude" }), false);
  assert.equal(claudeChildAgentAllowed({}), false);
});

test("Claude child environment excludes core credentials and user homes", () => {
  assert.deepEqual(
    claudeChildEnv(
      {
        PATH: "/bin",
        HOME: "/Users/private",
        CORE_SIGNING_SECRET: "signing-secret",
        DATABASE_URL: "postgres://secret",
        OPENAI_API_KEY: "openai-secret",
        ANTHROPIC_API_KEY: "anthropic-provider-key",
      },
      "/tmp/claude-jail",
    ),
    {
      HOME: "/tmp/claude-jail",
      CLAUDE_CONFIG_DIR: "/tmp/claude-jail/.claude",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "anthropic-provider-key",
    },
  );
});

test("Claude drops only a root parent process to the unprivileged nobody identity", () => {
  assert.deepEqual(claudeProcessIdentity(0), { uid: 65534, gid: 65534 });
  assert.equal(claudeProcessIdentity(1000), undefined);
});

test("Claude spawned from a root container runs as nobody", { skip: process.getuid?.() !== 0 }, async () => {
  const child = spawnClaudeProcess(
    {
      command: process.execPath,
      args: ["-e", "process.stdout.write(String(process.getuid()))"],
      env: process.env,
      signal: new AbortController().signal,
    },
    claudeProcessIdentity(0),
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0);
  assert.equal(output, "65534");
});

test("Claude reuses an existing local login, from a file or inline, over token env", (t) => {
  const creds = JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 1 } });

  const src = mkdtempSync(join(tmpdir(), "qm-claude-src-"));
  t.after(() => rmSync(src, { recursive: true, force: true }));
  const credFile = join(src, ".credentials.json");
  writeFileSync(credFile, creds);

  const fromFile = mkdtempSync(join(tmpdir(), "qm-claude-file-"));
  t.after(() => rmSync(fromFile, { recursive: true, force: true }));
  const home = prepareClaudeHome({ CLAUDE_CREDENTIALS_FILE: credFile, CLAUDE_CODE_OAUTH_TOKEN: "tok" }, fromFile);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".credentials.json"), "utf8")), JSON.parse(creds));

  const fromInline = mkdtempSync(join(tmpdir(), "qm-claude-inline-"));
  t.after(() => rmSync(fromInline, { recursive: true, force: true }));
  const inlineHome = prepareClaudeHome({ CLAUDE_CREDENTIALS_JSON: creds }, fromInline);
  assert.deepEqual(JSON.parse(readFileSync(join(inlineHome, ".credentials.json"), "utf8")), JSON.parse(creds));

  // No credentials configured: the directory exists, but nothing is written,
  // so token/key env remains the auth path.
  const bare = mkdtempSync(join(tmpdir(), "qm-claude-bare-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(existsSync(join(prepareClaudeHome({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }, bare), ".credentials.json")), false);

  const bad = mkdtempSync(join(tmpdir(), "qm-claude-bad-"));
  t.after(() => rmSync(bad, { recursive: true, force: true }));
  assert.throws(() => prepareClaudeHome({ CLAUDE_CREDENTIALS_JSON: "nope" }, bad), /not valid JSON/);
  assert.throws(() => prepareClaudeHome({ CLAUDE_CREDENTIALS_JSON: "[1]" }, bad), /JSON object/);
  assert.throws(
    () => prepareClaudeHome({ CLAUDE_CREDENTIALS_FILE: join(src, "missing.json") }, bad),
    /could not be read/,
  );
});

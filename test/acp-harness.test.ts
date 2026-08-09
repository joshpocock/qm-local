import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acpChildEnv,
  acpNonRetryable,
  acpPermissionDecision,
  createAcpHarness,
} from "../src/harness/acp-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import { configuredModelForHarness, loadConfig } from "../src/config.ts";
import { modelSupportedByHarness } from "../src/model/pi-models.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const scope = { kind: "org", id: "acp-test" } as unknown as ScopeId;

interface FakeResult {
  pid: number;
  stage: string;
  permission?: { outcome: { outcome: string; optionId?: string } };
  prompt?: Array<{ type: string; text?: string }>;
  readError?: { code?: number };
  terminalError?: { code?: number };
}

function readResult(path: string): FakeResult {
  return JSON.parse(readFileSync(path, "utf8")) as FakeResult;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeTurn(
  id: string,
  entries: SessionEntry[],
  overrides: Partial<HarnessTurnInput> = {},
): HarnessTurnInput {
  const session = { id } as Session;
  return {
    session,
    input: "current question",
    environment: "current environment",
    systemPrompt: "be concise",
    history: [
      {
        sessionId: id,
        seq: 1,
        type: "user",
        payload: { text: "earlier question" },
        scopeLabel: scope,
        createdAt: 1,
      } as SessionEntry,
      {
        sessionId: id,
        seq: 2,
        type: "assistant",
        payload: { text: "earlier answer" },
        scopeLabel: scope,
        createdAt: 2,
      } as SessionEntry,
    ],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    emit: async (entry) => {
      const saved = {
        ...entry,
        sessionId: id,
        seq: entries.length + 3,
        createdAt: Date.now(),
      } as SessionEntry;
      entries.push(saved);
      return saved;
    },
    recordModelCall: () => {},
    ...overrides,
  };
}

function fakeHarness(resultFile: string, scenario = "happy", permissionMode: "auto" | "deny" = "auto") {
  return createAcpHarness({
    agentCmd: process.execPath,
    agentArgs: [fixture, scenario, resultFile],
    env: {
      ...process.env,
      CORE_SIGNING_SECRET: "must-not-leak",
      DATABASE_URL: "must-not-leak",
    },
    permissionMode,
    turnWallClockMs: 5_000,
  });
}

test("ACP harness streams ordered chunks, replays history, and assembles final text", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-acp-test-"));
  const resultFile = join(dir, "result.json");
  const harness = fakeHarness(resultFile);
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const entries: SessionEntry[] = [];
  const deltas: string[] = [];
  const textStarts: number[] = [];
  const progress: number[] = [];
  const modelCalls: number[] = [];
  const result = await harness.turns.runTurn(
    makeTurn("stream", entries, {
      onDelta: (chunk) => deltas.push(chunk),
      onTextBlockStart: () => textStarts.push(1),
      onProgress: ({ toolCalls }) => progress.push(toolCalls),
      recordModelCall: ({ inputTokens }) => modelCalls.push(inputTokens),
    }),
  );
  const fake = readResult(resultFile);
  const promptText = fake.prompt?.find((block) => block.type === "text")?.text ?? "";

  assert.equal(result.reply, "Hello ACP");
  assert.equal(result.modelCalls, 1);
  assert.deepEqual(deltas, ["Hello ", "ACP"]);
  assert.deepEqual(textStarts, [1]);
  assert.deepEqual(progress, [1, 1]);
  assert.equal(modelCalls.length, 1);
  assert.ok(modelCalls[0]! > 0);
  assert.match(promptText, /## System instructions\nbe concise/);
  assert.match(promptText, /earlier question/);
  assert.match(promptText, /earlier answer/);
  assert.match(promptText, /current question/);
  assert.match(promptText, /current environment/);
  assert.equal(fake.permission?.outcome.optionId, "allow-once");
  assert.equal(fake.readError?.code, -32601);
  assert.equal(fake.terminalError?.code, -32601);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["user", "thinking", "assistant"],
  );
  assert.equal(processIsAlive(fake.pid), false);
});

for (const [name, permissionMode, readOnly, expected] of [
  ["auto", "auto", false, "allow-once"],
  ["deny", "deny", false, "reject-once"],
  ["readOnly", "auto", true, "reject-once"],
] as const) {
  test(`ACP permission posture selects ${expected} in ${name} mode`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "qm-acp-permission-test-"));
    const resultFile = join(dir, "result.json");
    const harness = fakeHarness(resultFile, "happy", permissionMode);
    t.after(async () => {
      await harness.turns.close?.();
      rmSync(dir, { recursive: true, force: true });
    });
    await harness.turns.runTurn(makeTurn(name, [], { readOnly }));
    assert.equal(readResult(resultFile).permission?.outcome.optionId, expected);
  });
}

test("ACP auth-required errors are terminal while process exits remain retryable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-acp-error-test-"));
  const authHarness = fakeHarness(join(dir, "auth.json"), "auth");
  const exitHarness = fakeHarness(join(dir, "exit.json"), "exit");
  t.after(async () => {
    await authHarness.turns.close?.();
    await exitHarness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    authHarness.turns.runTurn(makeTurn("auth", [])),
    (error: unknown) => error instanceof NonRetryableTurnError && /Authentication required/i.test(error.message),
  );
  await assert.rejects(
    exitHarness.turns.runTurn(makeTurn("exit", [])),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof NonRetryableTurnError) &&
      /code 17/.test(error.message) &&
      /fake ACP process failure/.test(error.message),
  );
});

test("ACP cancellation returns stopped and leaves no child process", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-acp-cancel-test-"));
  const resultFile = join(dir, "result.json");
  const harness = fakeHarness(resultFile, "hang");
  const controller = new AbortController();
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const running = harness.turns.runTurn(makeTurn("cancel", [], { cancel: controller.signal }));
  await waitForFile(resultFile);
  const pid = readResult(resultFile).pid;
  controller.abort();

  assert.deepEqual(await running, { reply: "", stopped: true, modelCalls: 1 });
  assert.equal(processIsAlive(pid), false);
});

test("ACP config, environment, model, and permission helpers enforce the v1 surface", () => {
  assert.throws(() => loadConfig({ HARNESS: "acp" }), /ACP_AGENT_CMD/);
  const config = loadConfig({
    HARNESS: "acp",
    ACP_AGENT_CMD: "agent",
    ACP_AGENT_ARGS: "serve --stdio",
    ACP_PERMISSION_MODE: "deny",
    ACP_MODEL: "agent/model",
    ANTHROPIC_API_KEY: "anthropic",
    OPENAI_API_KEY: "openai",
    GEMINI_API_KEY: "gemini",
    CLAUDE_CODE_OAUTH_TOKEN: "claude",
    CORE_SIGNING_SECRET: "secret",
  });
  assert.deepEqual(config.acpAgentArgs, ["serve", "--stdio"]);
  assert.equal(config.acpPermissionMode, "deny");
  assert.equal(configuredModelForHarness(config, "acp"), "agent/model");
  assert.deepEqual(acpChildEnv(config.acpProcessEnv, "/jail"), {
    HOME: "/jail",
    CLAUDE_CODE_OAUTH_TOKEN: "claude",
    ANTHROPIC_API_KEY: "anthropic",
    OPENAI_API_KEY: "openai",
    GEMINI_API_KEY: "gemini",
  });
  assert.equal(modelSupportedByHarness("anything/non-empty", "acp"), true);
  assert.equal(modelSupportedByHarness("", "acp"), false);
  assert.equal(acpNonRetryable({ code: -32000, message: "Authentication required" }), true);
  assert.equal(acpNonRetryable("socket hang up"), false);
  const permission = {
    sessionId: "session",
    toolCall: { toolCallId: "tool" },
    options: [
      { optionId: "always", name: "Always", kind: "allow_always" as const },
      { optionId: "once", name: "Once", kind: "allow_once" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const },
    ],
  };
  assert.equal(acpPermissionDecision(permission, "auto", false).outcome.outcome, "selected");
  assert.equal(acpPermissionDecision(permission, "auto", true).outcome.outcome, "selected");
  assert.deepEqual(acpPermissionDecision(permission, "auto", false, true), {
    outcome: { outcome: "cancelled" },
  });
  assert.throws(
    () => loadConfig({ HARNESS: "acp", ACP_AGENT_CMD: "agent", ACP_PERMISSION_MODE: "always" }),
    /ACP_PERMISSION_MODE/,
  );
});

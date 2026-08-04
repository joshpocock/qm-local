# ACP Harness Design Notes

Reference for implementing `src/harness/acp-harness.ts`, a new QM harness speaking the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP: JSON-RPC over stdio, client
spawns an agent subprocess; `initialize` / `session_new` / `session_prompt`, streamed
`session/update` notifications, permission requests).

All line numbers are as of the commit checked out when this doc was written (repo:
`qm-local`, a fork of `yc-software/qm`). Re-check line numbers before relying on them if the
files have since moved.

---

## 1. The `Harness` contract (`src/harness/harness.ts`)

### 1.1 Top-level shape

A harness factory (`createXxxHarness(opts): Harness`) must return an object of this shape
(`src/harness/harness.ts:167-172`):

```ts
export interface Harness {
  profile: HarnessAdapterProfile;
  turns: HarnessTurnController;
  models: HarnessModelUtilities;
  tools: HarnessToolPresentation;
}
```

You build this with the `defineHarness` helper (`harness.ts:176-202`), which takes:

```ts
export function defineHarness(
  profile: HarnessAdapterProfile,
  implementation: HarnessImplementation,   // HarnessTurnController & HarnessModelUtilities
  tools: HarnessToolPresentation = { name: (coreName) => coreName },
): Harness
```

`defineHarness` only copies over the optional methods (`close`, `resetSession`,
`shouldRespond`, `compactHistory`, ...) that you actually implement on `implementation` — so
an ACP harness can start minimal (just `runTurn`) and grow.

### 1.2 `HarnessAdapterProfile` (harness.ts:151-161)

```ts
type HarnessControlTransport = "mock" | "in-process" | "sdk" | "http" | "json-rpc" | "api";
type HarnessToolTransport = "mock" | "in-process" | "plugin" | "dynamic" | "in-process-mcp" | "mcp";
type HarnessCapability = "abort" | "steer" | "images" | "thinking-level" | "fast-mode" | "provider-sessions";

export interface HarnessAdapterProfile {
  id: string;
  controlTransport: HarnessControlTransport;
  toolTransport: HarnessToolTransport;
  transcriptFormat: string;
  capabilities: ReadonlySet<HarnessCapability>;
}
```

Existing profiles, for calibration:
- codex (`codex-harness.ts:940-946`): `id: "codex"`, `controlTransport: "json-rpc"`,
  `toolTransport: "dynamic"`, `transcriptFormat: "responses-api"`,
  `capabilities: new Set(["abort", "steer", "images", "provider-sessions"])`.
- claude (`claude-harness.ts:863-869`): `controlTransport: "sdk"`,
  `toolTransport: "in-process-mcp"`, `transcriptFormat: "claude-agent-sdk"`,
  `capabilities: new Set(["abort", "steer", "images", "thinking-level", "fast-mode"])`.

For ACP, `controlTransport: "json-rpc"` is exact (ACP literally is JSON-RPC over stdio, same
transport shape as `codex-app-server`). `toolTransport` should be `"dynamic"` if you expose
QM's own tools to the ACP agent as dynamically-declared tools the way codex does (see §3.5),
or `"mcp"` if the plan is instead to hand the agent an MCP server descriptor and let it dial
in over MCP (ACP supports client-exposed MCP servers, see `agentclientprotocol.com`
`initialize`/`newSession` params in the ACP spec — not present in this repo, so consult the
protocol docs directly for MCP-over-ACP specifics).

### 1.3 `HarnessTurnInput` (harness.ts:44-89) — the single most important type

Every field a harness turn receives:

```ts
export interface HarnessTurnInput {
  session: Session;
  runId?: string;
  cancel?: AbortSignal;
  input: string;                     // the user's new message text
  triggerTs?: string;
  entryTs?: string;
  environment?: string;              // extra system-ish context appended to the prompt
  priorTurns?: ConversationTurn[];   // used only when `history` is empty (first-time seed)
  overheard?: OverheardEntryPayload[];
  attachments?: AttachmentMeta[];
  images?: HarnessImage[];           // { mimeType, dataBase64, artifactId? }
  model?: string;
  harness?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  readOnly?: boolean;                // true on read-only "wake" turns — must disable writes/subagents
  surfaceTools?: boolean;
  surfaceName?: string;
  pollFire?: boolean;
  turnWallClockMs?: number;          // 0/undefined = no deadline; else hard wall-clock budget
  systemPrompt: string;
  systemCacheBoundary?: number;
  history: SessionEntry[];           // QM's own durable transcript, replay this into the agent
  tools: ToolContext;                // the real backing implementation of QM's tool primitives
  screenExternalContent?(input: { content: string; tool: string; source: string }): Promise<SecurityScreenVerdict | undefined>;
  toolApprovalGate?(tool: string): boolean;
  emit(entry: NewEntry): Promise<SessionEntry>;   // MUST be called to persist user/assistant/tool_call/tool_result/thinking entries
  tape?(rec: NewTapeRecord): Promise<unknown>;    // raw provider-format transcript log, for shadow replay/debugging
  tapeRows?: TapeRecord[];
  tapeMode?: "shadow" | "serve";
  tapeFold?: unknown[];
  scopeLabel: ScopeId;
  orgScopeId: ScopeId;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: HarnessLlmRequestRecord): void | Promise<void>;
  onProgress?(p: { toolCalls: number; tokens?: number }): void;
  onGapWork?(sink: (work: GapWork) => void): void;
  onDelta?(chunk: string): void;              // streamed assistant text chunk
  onTextBlockStart?(): void;                  // signal a new text block is starting (for UI chunking)
  screenToolResult?(tool: string, result: string, unscreenable: boolean): Promise<boolean | "unscreened">;
}
```

Key points an ACP adapter must respect:
- **`emit` is the durability boundary.** Every user message, assistant reply, tool call,
  tool result, and thinking block that should be replayable/auditable goes through
  `turn.emit(...)`. `emit` returns the saved `SessionEntry` (with `.seq`) — codex and claude
  both capture the returned `userEntry.seq` to correlate `recordLlmRequest` rows
  (`codex-harness.ts:684-697`, `claude-harness.ts:374-382`).
- **`history` is QM's own append-only log**, not the ACP agent's own session state. On every
  turn you must replay it into whatever the ACP agent expects as prior context (or rely on
  ACP's own session persistence if the ACP agent is capable of `session/load`/resumption —
  see §7 risk 1). Codex/Claude both use `reconstructMessagesFromHistory(turn.history)` from
  `src/harness/replay.ts` to turn QM's `SessionEntry[]` into a provider-agnostic message list
  (`PiReplayMessage[]`), then have their own per-provider serializer (`replayItems` in
  codex-harness.ts:297-332, `claudeReplayTranscript` in claude-harness.ts:218-244).
- **`priorTurns` is a fallback** used only when `history` is empty, e.g. first-ever turn in
  a freshly split conversation (`codexTurnInputText`, codex-harness.ts:374-383).
- **`cancel` (AbortSignal) must be honored mid-turn** — both existing subprocess harnesses
  wire an abort listener that interrupts the child process/turn and still returns a
  best-effort partial reply (`stopped: true`) rather than throwing (see codex-harness.ts:
  801-813, claude-harness.ts:481-496).
- **`turnWallClockMs`** is a hard deadline; on expiry the harness must interrupt the running
  turn and throw `NonRetryableTurnError` (codex: `setupTimedOut`, codex-harness.ts:602,
  848-852; claude: claude-harness.ts:706-711). Default comes from
  `CONFIG_DEFAULTS.turnWallClockSec * 1000` (both harnesses' `defaultTurnWallClockMs`,
  codex-harness.ts:395, claude-harness.ts:323); `CONFIG_DEFAULTS.turnWallClockSec` is `0` by
  default (`config.ts:391`), meaning "no deadline" unless the operator sets
  `TURN_WALL_CLOCK_SEC`.
- **`readOnly`** turns must not allow writes, memory mutation, or child-agent/subagent
  spawning — `toolOptions()` in both harnesses passes `readOnly: turn.readOnly` straight into
  `PiToolsOptions` (codex-harness.ts:271-272, claude-harness.ts:201-202), and
  `pi-tools.ts:904-911` uses it to reject `memory` writes; claude additionally gates
  `allowSubagents = !turn.readOnly` (claude-harness.ts:339).
- **`onDelta`/`onTextBlockStart`** are the streaming hooks: call `onTextBlockStart()` when a
  new assistant text block begins, then `onDelta(chunk)` per incremental text chunk, mirroring
  claude's `streamDelta()` (claude-harness.ts:281-296) or codex's direct pass-through of
  `item/agentMessage/delta` (codex-harness.ts:491-494). ACP's `session/update` notifications
  with an `agent_message_chunk` (or similarly named streaming) update map directly onto this.

### 1.4 `HarnessTurnResult` (harness.ts:91-108) — what a turn must return

```ts
export interface HarnessTurnResult {
  reply: string;
  silent?: boolean;
  stopped?: true;
  pendingApprovals?: Array<{
    command: string;
    reason: string;
    kind?: "approval";
    matched?: string;
    purpose?: string;
    approvalKey?: string;
  }>;
  pausedOnApproval?: boolean;
  modelCalls?: number;
  cacheUsage?: { cacheRead: number; cacheWrite: number; uncachedInput: number };
  compileMs?: number;
  tapeWriteFailed?: boolean;
}
```

- `reply` — the final assistant text (empty string if `silent`/paused/stopped-with-no-text).
- `silent: true` — the agent explicitly chose not to reply (e.g. used a `finish_silently`
  tool). No `assistant` entry should have been emitted.
- `stopped: true` — turn was aborted/cancelled/timed out; a partial reply may still be
  present.
- `pendingApprovals` + `pausedOnApproval: true` — the turn is blocked on a human approval for
  one or more tool calls (see §1.5). This is QM's own approval-gate concept; map it to ACP's
  own `session/request_permission` flow (see §7 risk 2) — or, if ACP's own permission model
  can't be exposed synchronously the way QM's `execute` tool needs, fall back to policy-based
  auto-allow/auto-deny (§7 skeleton).
- `modelCalls` — count of distinct LLM invocations in the turn (used for cost/usage
  telemetry).

### 1.5 Error classification — `NonRetryableTurnError` (`src/core/turn-error.ts`)

```ts
export class NonRetryableTurnError extends Error {
  constructor(message: string) { super(message); this.name = "NonRetryableTurnError"; }
}
export function turnFailureMessage(err: unknown): string {
  return err instanceof NonRetryableTurnError && err.message.trim() ? err.message : GENERIC_TURN_FAILURE;
}
```

Throwing a plain `Error` from `runTurn` signals a **retryable/infrastructure** failure (the
run/queue layer above the harness will retry it up to `maxAttempts`). Throwing
`NonRetryableTurnError` signals a **terminal** failure the caller should not retry (bad
auth, quota exhausted, model not found, wall-clock exceeded, unsupported runtime
combination — see `resolveRuntimeChoice` in harness-router.ts:50).

Codex's pattern (copy this for ACP): classify provider-reported failures via a regex against
the raw error message (`codexNonRetryable`, `CODEX_NON_RETRYABLE_PATTERN`,
codex-harness.ts:106-115) — `401`/`402`/`403`, "unauthorized", "invalid api key", "quota",
"billing", "credits", "model not found", etc. — and wrap accordingly:

```ts
export function codexProviderFailure(message: string): Error {
  return codexNonRetryable(message) ? new NonRetryableTurnError(message) : new Error(message);
}
```

Test coverage for this exact classification lives in `test/codex-harness.test.ts:485-537`
("classifies deterministic provider failures as terminal and leaves transient ones
retryable" / "never classifies its own infrastructure failures as terminal" — the latter is
important: QM's *own* errors like `permission denied for table session_entries` must NOT be
misclassified as the provider's fault just because the message happens to contain "401").
An ACP harness should build an equivalent `acpNonRetryable(message)` once the ACP agent's
actual auth/quota error text is known (this is agent-implementation-specific — ACP itself
doesn't standardize error strings) and reuse the same "our infra vs their infra" test
discipline.

---

## 2. `harness-router.ts` — registration, resolution, and model validation

### 2.1 Registration shape (`src/wiring.ts:699-729`)

Harnesses are registered into a `Map<HarnessId, Harness>` at startup:

```ts
const adapters = new Map<HarnessId, Harness>([
  ["pi", createPiHarness({ ...piHarnessConfigOptions(config), resolveBaseModelId, resolveProviderKeys, signals: runSignals })],
  ["opencode", createOpenCodeHarness({ ...openCodeHarnessConfigOptions(config), signals: runSignals, tasks })],
  ["codex", createCodexHarness({ ...codexHarnessConfigOptions(config), signals: runSignals, tasks })],
  ["claude", createClaudeHarness({ ...claudeHarnessConfigOptions(config), signals: runSignals, tasks })],
  ["mock", createMockHarness()],
]);
const fallbackHarness = config.harness as HarnessId;
const fallback = {
  harnessId: fallbackHarness,
  modelId: defaultModelForHarness(fallbackHarness, configuredModelForHarness(config, fallbackHarness), baseModelProviders(config)),
};
const harness = createHarnessRouter(adapters, adapters.get(fallbackHarness)!, (input) =>
  resolveRuntimeChoiceDurable(configStore, runtimeOrgScope, input.scopeLabel, fallback, {
    ...(input.harness ? { harnessId: input.harness as HarnessId } : {}),
    ...(input.model ? { modelId: input.model } : {}),
  }),
);
```

For ACP: add `HARNESS_IDS` entry `"acp"` (see §2.2), a `createAcpHarness(opts)` factory, an
`acpHarnessConfigOptions(config)` helper mirroring `codexHarnessConfigOptions` /
`claudeHarnessConfigOptions`, and a `["acp", createAcpHarness({ ...acpHarnessConfigOptions(config), signals: runSignals, tasks })]`
entry in the map at `wiring.ts:699-712`.

### 2.2 `HarnessId` and env selection (`src/model/pi-models.ts:9-10`, `src/config.ts`)

```ts
export const HARNESS_IDS = ["pi", "opencode", "codex", "claude", "mock"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export function isHarnessId(value: unknown): value is HarnessId { ... }
```

The top-level `HARNESS` env var picks the **fallback/default** harness (per-conversation
overrides still flow through `HarnessTurnInput.harness`, resolved by `createHarnessRouter`,
see §2.4). It's parsed strictly in `src/config.ts:464-470`:

```ts
function harnessEnvStrict(value: string | undefined): Config["harness"] {
  ...
  const harness = value.trim();
  if (harness === "mock" || harness === "pi" || harness === "opencode" || harness === "codex" || harness === "claude")
    return harness;
  throw new Error(`HARNESS=${JSON.stringify(value)} is not recognized — use mock, pi, opencode, codex, or claude, or unset it.`);
}
```

`Config["harness"]` is typed at `config.ts:31`: `harness: "mock" | "pi" | "opencode" | "codex" | "claude"`.

**For ACP you must touch all three of these** to add "acp" as a first-class harness id:
1. `HARNESS_IDS` array in `pi-models.ts:9`.
2. `Config["harness"]` union in `config.ts:31`.
3. `harnessEnvStrict`'s accepted-values check and error message in `config.ts:464-470`.

Also mirror the per-harness model-id env override pattern
(`config.ts:718-723`, `configuredModelForHarness` at `config.ts:146-149`):

```ts
export function configuredModelForHarness(config: Config, harness: string): string | undefined {
  if (harness === "codex") return config.codexModel;
  if (harness === "claude") return config.claudeModel;
  if (harness === "opencode") return config.opencodeModel;
  // add: if (harness === "acp") return config.acpModel;
}
```

with `env.CODEX_MODEL`/`CODEX_BIN` → propose `env.ACP_AGENT_CMD` (binary/command to spawn)
and `env.ACP_AGENT_ARGS` (its argv), replacing the "binary path" concept since an ACP agent
isn't necessarily a single well-known binary the way `codex`/`claude` are — see §7 skeleton.

### 2.3 Model-id validation (`modelSupportedByHarness`, `pi-models.ts:169-176`)

```ts
export function modelSupportedByHarness(id: string | undefined, harness: string): boolean {
  if (!id) return false;
  if (harness === "pi" || harness === "opencode" || harness === "mock") return Boolean(resolveModel(id));
  const provider = resolveModel(id)?.provider;
  if (harness === "claude") return provider === "anthropic" || /^claude-/i.test(id);
  if (harness === "codex") return provider === "openai" || /^(?:gpt-|o\d|codex|openai\/)/i.test(id);
  return false;   // <-- unknown harness ids fall through to false
}
```

Every harness id must be explicitly enumerated here or `modelSupportedByHarness` returns
`false` for it — which means `resolveRuntimeChoice` (harness-router.ts:12-54) will always
treat a requested `acp/<model>` pair as unapproved and fall back to `org`/`safeFallback`
(harness-router.ts:44-52), silently refusing to ever actually route to the ACP harness. **You
must add an `if (harness === "acp") return ...` branch here.** Since ACP itself is
model-agnostic (the model choice, if any, lives inside the spawned ACP agent, not in QM's
model registry), the pragmatic options are:
- Accept any non-empty model id as "supported" (`if (harness === "acp") return Boolean(id);`)
  and let the ACP agent process ignore/interpret it, or
- Register a small `MODEL_REGISTRY` entry (or a sentinel id like `"acp-default"`) the way
  `DEFAULT_CODEX_MODEL_ID`/`DEFAULT_AGENT_MODEL_ID` do (`pi-models.ts:6-7`), and only accept
  that.

Also add a branch to `defaultModelForHarness` (`pi-models.ts:178-190`) and
`modelProviderAvailabilityFor` (`pi-models.ts:213-222`) if the ACP harness should participate
in provider-availability gating (e.g. only usable when some credential env var is present) —
otherwise it will fall through to the `ALL_PROVIDERS_AVAILABLE` default at line 221, which is
probably fine for a locally-spawned subprocess harness.

### 2.4 `createHarnessRouter` runtime behavior (`harness-router.ts:84-116`)

The router wraps the `adapters` map and a `resolve()` callback (here,
`resolveRuntimeChoiceDurable`) into a single `Harness` whose `turns.runTurn` does, per call:

```ts
async runTurn(input) {
  const choice = await resolve(input);                 // { harnessId, modelId }
  const adapter = adapters.get(choice.harnessId);
  if (!adapter) throw new Error(`harness ${choice.harnessId} is unavailable`);
  const prior = lastHarness.get(input.session.id);
  if (prior && prior !== choice.harnessId) {
    await adapters.get(prior)?.turns.resetSession?.(input.session.id);
    await adapter.turns.resetSession?.(input.session.id);
  }
  lastHarness.set(input.session.id, choice.harnessId);
  return adapter.turns.runTurn({ ...input, harness: choice.harnessId, model: choice.modelId });
}
```

Implication for ACP: **implement `resetSession(sessionId)`** if the ACP agent keeps any kind
of persistent session/thread state keyed by QM's `session.id` (e.g. if you map one ACP
`session_new` per QM session and reuse it across turns) — the router calls it both when a
conversation switches *away* from your harness and *into* it, so a stale ACP session on the
old harness doesn't leak state into the new one. If instead your ACP harness starts a brand
new ACP session per turn (like codex starts a brand-new `thread/start` every `runTurn`, see
§3.1), `resetSession` can be a no-op (`resetSession: () => {}`, as both codex and claude do —
codex-harness.ts:961, claude-harness.ts:876).

`turns.close()` on the router calls `close()` on every distinct adapter
(`harness-router.ts:111-113`) — implement it to tear down any long-lived ACP subprocess/app-
server the way `codex`'s `close` does (§3.1).

---

## 3. Codex's subprocess lifecycle (closest analog) — full trace

### 3.1 Binary path, spawn, jail

- **Binary path**: `opts.binaryPath ?? resolve("node_modules/.bin/codex")`
  (codex-harness.ts:468) — defaults to the locally-installed `codex` CLI shim; overridable
  via `CODEX_BIN` env → `config.codexBinPath` → `codexHarnessConfigOptions`
  (codex-harness.ts:41-52) → `CodexHarnessOptions.binaryPath`.
- **Jail**: a fresh temp dir per app-server lifetime — `mkdtempSync(join(tmpdir(), "qm-codex-"))`
  (codex-harness.ts:465), used as both `cwd` and the base for a synthetic `$HOME`.
- **Spawn** happens in `CodexAppServer`'s constructor (`codex-app-server.ts:41-47`):
  ```ts
  this.process = spawn(options.binaryPath, ["app-server"], {
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
  ```
  Plain `child_process.spawn`, **no uid/gid drop, no container/sandbox layer** — the codex
  app-server process runs with the same OS-level privileges as the QM server process itself;
  isolation is achieved entirely by (a) the ephemeral jail directory as `$HOME`/`cwd`, (b) a
  stripped-down env allowlist (§3.2), and (c) telling the *agent's own* sandbox config
  `sandbox: "read-only"` (its cwd is empty and read-only) so the agent's own shell tool can't
  write outside the jail — see `threadStartRequest.sandbox` (codex-harness.ts:642). Real
  work happens through QM's own `execute`/`read`/`write`/`background` tools (bridged in, see
  §3.5), which run against QM's actual sandboxed workspace via `ToolContext`
  (`src/tools/primitives.ts:146-176`) — **not** through the codex child process's own
  filesystem access. This is the crucial design point to replicate for ACP: **the spawned
  agent subprocess's own cwd is a decoy/empty control jail; all real file/exec work is routed
  back through QM's bridged tools.**
- **One app-server process is shared across turns** (`runtime`/`starting` module-level state,
  codex-harness.ts:396-398, `ensureRuntime()` at 461-595) — a new one is only spawned if none
  is alive (`runtime.server.process.exitCode === null` check, line 462) or a start is already
  in flight (dedup via `starting` promise). Each *turn*, however, calls `thread/start` fresh
  (codex-harness.ts:672-682) — i.e. one OS process, many logical ACP-style "threads"/sessions
  multiplexed over its single stdio JSON-RPC pipe.
- **Startup timeout**: `Promise.race([server.initialize(), timeout])`, default
  `CODEX_START_TIMEOUT_MS = 30_000`, overridable via `opts.appServerStartTimeoutMs`
  (codex-harness.ts:560-578). On timeout or init failure the jail is removed and the error
  propagates — a subsequent call retries from scratch (proven by
  `test/codex-harness.test.ts:419-448`, "discards a nonresponsive startup so a later turn can
  retry").
- **Process exit handling**: `server.process.once("close", ...)` rejects every in-flight
  `ActiveTurn` and clears the jail (codex-harness.ts:580-587) — an ACP harness needs the same
  "process died mid-turn → reject all pending turns with a real error, don't hang" handling.

### 3.2 Env passthrough allowlist and jail env (codex-harness.ts:171-197)

```ts
const CODEX_ENV_PASSTHROUGH = [
  "PATH", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_ACCESS_TOKEN",
] as const;

export function codexChildEnv(source: NodeJS.ProcessEnv, jail: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: jail, CODEX_HOME: join(jail, "codex-home") };
  for (const name of CODEX_ENV_PASSTHROUGH) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}
```

Everything not on the allowlist — crucially `CORE_SIGNING_SECRET`, `DATABASE_URL`, and any
other QM-internal secret — is dropped, proven by
`test/codex-harness.test.ts:269-291` ("excludes core credentials and user homes").

### 3.3 `prepareCodexHome` / auth materialization (codex-harness.ts:199-247)

```ts
export function prepareCodexHome(source: NodeJS.ProcessEnv, jail: string): string {
  const target = join(jail, "codex-home");
  mkdirSync(target, { recursive: true });
  const subscription = codexSubscriptionAuth(source);
  if (subscription) {
    writeFileSync(join(target, "auth.json"), subscription, { mode: 0o600 });
  } else if (source.OPENAI_API_KEY) {
    writeFileSync(join(target, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: source.OPENAI_API_KEY }), { mode: 0o600 });
  }
  return target;
}
```

Two auth modes, mutually exclusive, subscription wins: `CODEX_AUTH_JSON`
(or base64-encoded `CODEX_AUTH_JSON_B64`) carries a verbatim `~/.codex/auth.json` for
ChatGPT-subscription billing (`codexSubscriptionAuth`, codex-harness.ts:228-247, with an
explicit comment at 215-227 noting this is a **qm-local-specific** feature: "run Codex on the
operator's own ChatGPT subscription... The subscription belongs to one person... not for
serving other users' turns" — and a known limitation that a fresh jail per app-server
discards Codex's own token-refresh). Falls back to plain `OPENAI_API_KEY` → api-key auth
file. If neither is set, no `auth.json` is written at all (relies on whatever ambient auth
the real `codex` binary might already have, which the test at
`test/codex-harness.test.ts:302-304` explicitly checks does NOT leak the *server's own*
`$HOME` login even when unset). **This whole file-materialization pattern is exactly what an
ACP harness should do for whatever auth scheme its target agent expects** (see §5 for the
even more direct precedent, Claude's plain env-var passthrough).

### 3.4 `CodexAppServer` — JSON-RPC framing over stdio (`codex-app-server.ts`, read in full)

This is the **direct analog for an ACP client transport** and should be copied nearly
verbatim (rename to e.g. `AcpAgentClient`).

- **Wire format**: newline-delimited JSON, one message per line, both directions
  (`createInterface({ input: this.process.stdout! })`, line-based `send()` writing
  `${JSON.stringify(message)}\n"` to `process.stdin`). ACP uses the same NDJSON-over-stdio
  framing per its spec.
- **Message shape** (`codex-app-server.ts:12-19`):
  ```ts
  type JsonRpcId = number | string;
  type JsonRpcMessage = { id?: JsonRpcId; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
  ```
  Standard JSON-RPC 2.0 shape (minus an explicit `"jsonrpc": "2.0"` field — codex's app-server
  doesn't send/require it; **check whether the ACP spec requires that field literally present**
  and add it if so).
- **Outbound request/notify** (`request<T>()` / `notify()`, lines 92-108): `request` allocates
  a monotonic numeric `id` (`nextId++`), stores a `{resolve, reject}` pair in a `pending` Map
  keyed by that id, and returns a Promise that resolves/rejects when a matching response
  line arrives. `notify` is the same `send()` but with no `id` (fire-and-forget).
- **Inbound dispatch** (`receive()`, lines 119-151): parses each line as JSON; three cases:
  1. Has `id`, no `method` → it's a **response** to one of our own outbound requests: look up
     `pending.get(id)`, resolve on `result`, reject with `CodexRpcError` on `error`.
  2. Has `method`, no `id` → it's a **notification from the child** (streamed updates —
     ACP's `session/update`): call `onNotification(method, params)`.
  3. Has `method` AND `id` → it's a **request FROM the child back to us** (ACP's
     `session/request_permission`, or codex's `item/tool/call` for tool bridging, see §3.5):
     call `onRequest(method, params)`, `await` its result/throw, and reply with
     `{ id, result }` or `{ id, error: { code: -32000, message } }`.
- **Ordering guarantee**: both inbound processing (`eventTail`) and outbound writes
  (`writeTail`) are serialized through promise chains (lines 34-35, 54-59, 153-163) — lines
  are handled strictly in arrival order and writes strictly in call order, even though
  `receive`/`send` are individually async. Copy this pattern; don't let concurrent
  `session/update` notifications interleave-corrupt shared per-turn state.
- **Fatal-error propagation**: any JSON parse failure inside `receive()` throws, which the
  `eventTail.catch` handler in the constructor turns into `failAll(error)` +
  `process.kill("SIGTERM")` (lines 53-60) — one malformed line kills the whole app-server
  session and fails every pending call, rather than silently desyncing request/response
  pairing.
- **Process-level close/error** (lines 61-77): stderr is captured into a bounded ring buffer
  (`this.stderr`, kept to last 16KB) for inclusion in the eventual close error message;
  `process.once("error"/"close", ...)` both mark `closed = true`, synthesize a
  `closeError`, `failAll()` every pending call, and resolve a `processClosed` promise other
  code can await (used by `close()`).
- **`initialize()`** (lines 84-90): sends an `initialize` **request** with
  `clientInfo`/`capabilities`, awaits the response, then sends an `initialized`
  **notification** (no response expected) — this two-step request-then-notify handshake is
  exactly ACP's `initialize` → (implicit ready) pattern; adjust the exact params/capabilities
  payload to match ACP's schema (`clientInfo`, `protocolVersion`, etc., per
  agentclientprotocol.com — this repo doesn't define that shape, only the codex-specific one
  shown here).
- **Graceful shutdown** (`close()`, lines 110-117): `SIGTERM`, then a 2-second grace timer
  before `SIGKILL`, then await `processClosed`. Idempotent (`if (this.closed) return await
  this.processClosed`).

### 3.5 Turn ↔ protocol call mapping, and QM-tool bridging (codex-harness.ts:597-897)

Per `runTurn` call (`runPrompt`):

1. **Setup phase** (guarded by a cancellable/timeoutable `awaitSetup` wrapper,
   codex-harness.ts:616): `ensureRuntime()` (spawn-or-reuse the app-server) →
   `rt.server.request("thread/start", threadStartRequest)` (create a fresh logical
   session/thread) → optionally `thread/inject_items` to replay QM history → `turn.emit`
   the user message entry.
2. **`threadStartRequest`** (lines 638-671) is the single most important payload to study for
   an ACP `session_new` equivalent — it declares: the model, `cwd` (the decoy jail),
   `approvalPolicy: "never"` and `sandbox: "read-only"` (codex's OWN approval/sandbox system
   is fully disabled — QM's own approval gate, via bridged tools, is the only one that
   matters), `baseInstructions: turn.systemPrompt`, a `developerInstructions` string
   explicitly telling the model to use QM's bridged tools instead of any built-in
   file/exec tools, `dynamicTools` (the QM tool schemas, see below), and a `config.features`
   block that turns OFF every one of codex's own built-in capabilities (`shell_tool`,
   `unified_exec`, `browser_use`, `image_generation`, `apps`, `plugins`, etc.) so the only way
   the agent can act on the world is through QM's bridged tools. **This "disable everything
   native, expose only our own bridged tools" pattern is the thing to replicate for ACP** if
   the target ACP agent has its own built-in tool/sandbox story you don't want it using.
3. **Tool bridging**: `asTools(ref, toolOptions(opts, turn))` → `createPiTools(...)` from
   `pi-tools.ts` returns QM's tool set (`execute`, `read`, `write`, `publish`, `memory`,
   `history`, `background`, plus surface tools) as `{ name, description, parameters, execute }`
   objects; these are converted to the protocol's dynamic-tool declaration shape
   (`dynamicTools`, codex-harness.ts:631-636) and sent as part of `thread/start`.
4. **Child → parent tool-call bridge** happens through the JSON-RPC **request-from-child**
   channel (`onRequest`, codex-harness.ts:521-557): when the codex child wants to call a tool,
   it sends an `item/tool/call` **request** (not notification) with `{ threadId, tool, callId,
   arguments, turnId }`; the handler looks up the matching `BridgedTool` in
   `state.tools`, checks `codexChildToolAllowed(name)` if the call comes from a **different**
   (sub-agent) thread than the top-level one (codex-harness.ts:529-530, using the
   allowlist `CODEX_CHILD_TOOL_NAMES = new Set(["execute", "read", "write", "publish",
   "memory", "history", "background"])`, line 116), executes it, and returns
   `{ contentItems: [...], success }`. This is precisely ACP's likely tool-call-from-agent
   shape too — model it the same way: an `onRequest`-style handler dispatching into the
   bridged QM tool set, with a least-privilege allowlist for anything a spawned sub-session
   is allowed to touch.
5. **Streaming**: `item/agentMessage/delta` notifications feed `turn.onDelta(...)`
   (codex-harness.ts:491-494) — the direct ACP `session/update` (agent-message-chunk)
   analog. `thread/tokenUsage/updated` notifications feed `turn.recordModelCall(...)` for
   cost/usage accounting (lines 478-490). `item/started`/`item/completed` notifications feed
   the tape (`turn.tape(...)`, lines 495-514) and — for spawned sub-agent items
   (`collabAgentToolCall`) — task-store bookkeeping (`processCollabItem`, lines 400-459,
   creating/transitioning `TaskStore` rows and emitting `tool_call`/`tool_result` entries so
   sub-agent progress shows up in QM's own transcript).
6. **Completion**: a `turn/completed` notification resolves the `completed` promise for that
   thread (codex-harness.ts:515-519); the harness then extracts final text via
   `textFromTurn()` (prefers items with `phase === "final_answer"`, falling back to
   unphased items, lines 334-345) and reasoning via `reasoningFromTurn()` (lines 347-353,
   emitted as QM `thinking` entries).
7. **Interrupt/steer**: `turn/interrupt` (on cancel/timeout/terminal-tool) and `turn/steer`
   (mid-turn additional user input via `startSignalPoll`, codex-harness.ts:814-832) are both
   plain outbound `request()` calls against the running thread.
8. **Telemetry**: `recordLlmRequest` is called exactly once per turn in the `finally` block
   (`recordRequest()`, codex-harness.ts:753-770), carrying the full request payload (with
   image bytes stripped via `stripCodexImageBytes`), `ttftMs` (time to first streamed delta),
   `durationMs`, and summed token usage across every sub-thread (`sumUsage`, lines 145-155).

### 3.6 Transcript / replay handling

- **`replay.ts`** (`reconstructMessagesFromHistory`, `seedPriorTurns`) is the
  provider-agnostic layer: it turns QM's `SessionEntry[]` into a normalized
  `PiReplayMessage[]` (`role: "user" | "assistant" | "toolResult"`, with `content` parts of
  `text`/`toolCall`/... shape). Both codex and claude call this, then have their own
  provider-specific serializer downstream (`replayItems` for codex → native
  `function_call`/`function_call_output`/`message` items sent via `thread/inject_items`;
  `claudeReplayTranscript` for claude → a single flattened text block wrapped in
  `<<<BEGIN TRANSCRIPT...END TRANSCRIPT>>>` markers and injected as part of the prompt text,
  since the Claude Agent SDK has no native "inject prior items" RPC).
- **Tool-call id length limits**: codex's provider caps call ids at 64 chars, so replay
  hashes long QM-internal call ids down with SHA-256 (`codexReplayCallId`,
  codex-harness.ts:293-295, tested at `test/codex-harness.test.ts:37-43`). **Check whatever
  length/charset limit the target ACP agent's tool-call-id field has** and apply the same
  truncation-with-hash pattern if needed.
- **Image handling**: images are base64 data-URLs in the outbound protocol payload but must
  never be persisted verbatim into the tape/telemetry log — `stripCodexImageBytes`
  (codex-harness.ts:285-291) and `stripClaudeImageBytes` (claude-harness.ts:298-306) both
  replace the base64 payload with a placeholder string before writing to `recordLlmRequest`'s
  `request` field.
- **`turn.tape(...)`** is a best-effort raw-provider-format append (used for shadow-replay
  debugging / `tapeMode`); failures are swallowed and surfaced via `tapeWriteFailed: true`
  on the result rather than failing the turn (codex-harness.ts:499-511, 771-799,
  claude-harness.ts:404-426) — replicate this "never let telemetry/tape failures break a
  real turn" discipline.

---

## 4. Where the spawned process actually runs — no extra sandbox layer

Both `spawn(binaryPath, ["app-server"], { cwd, env, stdio: ["pipe","pipe","pipe"] })`
(codex, `codex-app-server.ts:43-47`) and claude's `spawnClaudeProcess`
(`claude-harness.ts:133-141`):

```ts
export function spawnClaudeProcess(options: SpawnOptions, identity?: { uid: number; gid: number }): SpawnedProcess {
  return spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "inherit"],
    ...identity,
  });
}
```

are **plain Node `child_process.spawn` calls in the QM server process's own container** —
there is no separate sandbox/VM/gVisor layer wrapping the *agent CLI subprocess itself* in
this codebase. The only privilege-drop mechanism present is claude's optional uid/gid switch:

```ts
export function claudeProcessIdentity(uid = process.getuid?.()): { uid: number; gid: number } | undefined {
  return uid === 0 ? { uid: 65534, gid: 65534 } : undefined;   // drop root -> nobody
}
```

applied only `if (uid === 0)` — i.e. only when the *QM server itself* is (unusually) running
as root, in which case the Claude Agent SDK child is forced down to the unprivileged `nobody`
(65534/65534) identity rather than inheriting root (`claude-harness.ts:328-330`, tested at
`test/claude-harness.test.ts:101-127`, including a real-spawn assertion gated on
`process.getuid?.() !== 0`). Codex has **no equivalent uid/gid drop** — its jail-directory +
env-allowlist + "tell the agent's own sandbox to be read-only" strategy (§3.1, §3.2) is its
entire isolation story.

**The real sandbox — the one that matters for actual file/exec safety — is `scratchExec` /
`ownerAuthExec` / `reachExec` inside `pi-tools.ts`** (`PiToolsOptions`, pi-tools.ts:232-244),
which is a QM-level concept completely orthogonal to "which harness/CLI process is running":
it controls which of QM's own **backing `ToolContext.execute()` sandbox targets**
(`"scoped"` = this conversation's durable box, `"scratch"` = ephemeral no-credential box,
`"owner"` = owner-authenticated invocation-only box, or a named room to "reach") the bridged
`execute` tool is allowed to route to (`runScopedExecute`, pi-tools.ts:563-612). This sandbox
selection happens **inside QM**, behind the `ToolContext` interface
(`src/tools/primitives.ts:146-176`) that's handed to the harness as `turn.tools` — the actual
container/VM/process-isolation implementation backing `tc.execute(...)` lives further down
the stack (in `ToolContextDeps`/`Sandbox`, `primitives.ts:337+`), out of scope for a harness
author. **An ACP harness does not need to build any new sandboxing — it just needs to bridge
QM's existing tool set the same way codex/claude do (§3.5) and pass through
`opts.scratchExec`/`ownerAuthExec`/`reachExec`/`readOnly` from `CodexHarnessOptions`-shaped
options into `toolOptions()`/`createPiTools()` exactly like the existing two harnesses.**

So: the ACP agent subprocess itself runs as an ordinary unsandboxed child of the QM server
process (same container as QM), with an empty/decoy read-only cwd; all *real* work happens
through QM's own already-sandboxed tool primitives, reached only via the bridged-tool RPC
channel.

---

## 5. Credential passthrough pattern (`CLAUDE_CODE_OAUTH_TOKEN`) — copy this for ACP

`claude-harness.ts:103-127`:

```ts
const CLAUDE_ENV_PASSTHROUGH = [
  "PATH", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export function claudeChildEnv(source: NodeJS.ProcessEnv, jail: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: jail, CLAUDE_CONFIG_DIR: join(jail, ".claude") };
  for (const name of CLAUDE_ENV_PASSTHROUGH) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}
```

This is deliberately the **simplest possible pattern** — an explicit allowlist of env-var
names, copied verbatim from `opts.env` (itself sourced from `config.claudeProcessEnv`, which
`src/config.ts:659-676` builds by filtering `process.env` down to the same allowlist at
config-parse time — i.e. the allowlisting happens *twice*, once when `Config` is built from
`process.env`, once again when the harness builds the child's env from `Config`). No
credential-file materialization is needed for claude (unlike codex's `auth.json` dance,
§3.3) because `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` are read directly from env by the
Claude Agent SDK/CLI itself. `HOME`/`CLAUDE_CONFIG_DIR` are still pointed at the ephemeral
jail so the child never touches the QM server operator's own `~/.claude`.

**For an ACP harness**, follow this exact recipe:
1. Define an `ACP_ENV_PASSTHROUGH` allowlist covering whatever transport/proxy vars are
   generically needed (`PATH`, `TMPDIR`, `LANG`, `LC_ALL`, `SSL_CERT_*`, `*_PROXY`) plus
   whatever auth env var(s) the specific target ACP agent needs — this is necessarily
   agent-specific since ACP itself doesn't define an auth scheme (unlike, say, OpenAI's
   `OPENAI_API_KEY` convention that both codex and third-party ACP agents built on it might
   share). Expose it as an `ACP_AGENT_ENV_PASSTHROUGH` config knob or hardcode common ones
   (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ...) plus a generic
   `ACP_AGENT_EXTRA_ENV` (comma-separated var-name list, or a JSON blob) so operators can add
   arbitrary passthroughs for arbitrary ACP-speaking agents without a code change per agent.
2. Point `HOME` (and any agent-specific config-dir env var, mirroring
   `CLAUDE_CONFIG_DIR`/`CODEX_HOME`) at the per-turn (or per-app-server-lifetime) jail.
3. Add the same three-layer allowlisting: `config.ts` env parse → `Config.acpProcessEnv` →
   `acpHarnessConfigOptions(config)` → `opts.env` → `acpChildEnv(opts.env, jail)`.
4. If the target agent expects a token/credentials *file* rather than an env var (like codex
   does), replicate `prepareCodexHome`'s pattern (§3.3) instead: write it into the jail with
   `mode: 0o600`, and support both a raw-JSON and base64 env-var input form.

---

## 6. Existing lifecycle tests to mirror (`test/codex-harness.test.ts`, `test/claude-harness.test.ts`)

### 6.1 `test/codex-harness.test.ts` — fakes a **real app-server subprocess** over stdio

The dominant pattern here is `fakeCodexBinary(dir)` and its siblings
(`terminatingCodexBinary`, `concurrentCodexBinary`, `nonresponsiveCodexBinary`,
`failingProviderCodexBinary`) — each writes out a **tiny standalone Node script** to a temp
dir, `chmodSync`'s it executable, and passes its path as `binaryPath` to
`createCodexHarness({ binaryPath, ... })`. The fake script itself speaks the real NDJSON
JSON-RPC protocol via `readline` on stdin / `process.stdout.write` — i.e. **these are true
subprocess-level integration tests**, not mocks of `CodexAppServer`. This is the pattern to
copy for ACP: write a `fakeAcpAgentBinary(dir)` Node script implementing just enough of the
ACP protocol handshake to drive each test scenario. Test names present (and what they
exercise):
- "Codex replay keeps paired tool ids within the provider's 64-character limit" — pure
  function test on `codexReplayCallId`, no subprocess.
- "Codex forwards external-content screening into its native tool bridge" — pure function
  test on `codexToolContext`.
- "Codex harness drives app-server JSON-RPC with a read-only jail" — full happy-path turn:
  asserts final `reply`, streamed `deltas`, `modelCalls` sequence, emitted entry-type
  sequence (`["user","tool_call","tool_result","assistant"]`), and that a spawned sub-agent
  (`collabAgentToolCall`) produces a completed `TaskStore` row. The fake binary itself
  **asserts inbound protocol correctness** (checks `sandbox === "read-only"`,
  `approvalPolicy === "never"`, `dynamicTools` is an array, `environments.length === 0`,
  `features.shell_tool === false`/`unified_exec === false`, and critically that
  `CORE_SIGNING_SECRET`/`DATABASE_URL` are **absent** from its own env and that
  `HOME === msg.params.cwd` / `CODEX_HOME` is under that cwd) — replicate this
  "fake binary self-validates what it was sent" style for ACP's `session_new`/`initialize`
  params.
- "Codex task titles stay concise..." / "maps the web effort control..." / "reads cumulative
  app-server token usage..." / "seeds prior surface turns..." — pure function unit tests
  (`codexTaskTitle`, `codexReasoningEffort`, `codexTokenUsageUpdate`, `codexTurnInputText`).
- "Codex child environment excludes core credentials and user homes" — pure `codexChildEnv`
  unit test (exact expected-env `deepEqual`).
- "Codex materializes API-key auth into its isolated home, and never an ambient login" /
  "Codex subscription auth wins over the API key and validates its JSON" — pure
  `prepareCodexHome` unit tests, including malformed-JSON and non-object-JSON error paths.
- "Codex children cannot use parent surface, control, or terminal tools" — pure
  `codexChildToolAllowed` allowlist test.
- "Codex observability preserves image presence without persisting bytes" — pure
  `stripCodexImageBytes` unit test.
- "Codex interrupts the provider after a terminal QM tool" — subprocess test via
  `terminatingCodexBinary`: verifies that after a "terminal" tool call
  (`finish_silently`), the harness sends `turn/interrupt` and a **later-arriving** tool call
  from the child (`late-1`) never actually executes / never produces an `assistant` entry —
  i.e. race-safety around interrupt-vs-in-flight-request.
- "Codex spawn failure does not hang run or cleanup" — binary path points at a nonexistent
  file (`/definitely/missing/qm-codex`); asserts the turn promise rejects (matching
  `/ENOENT|spawn/`) within a 2s race-timeout, AND that `close()` afterward also completes
  within 2s (no hang).
- "Codex discards a nonresponsive startup so a later turn can retry" — binary that never
  responds to `initialize`; asserts `appServerStartTimeoutMs` fires
  (`/initialization timed out/`), **twice in a row** (proving no bad cached `starting`/
  `runtime` state survives a failed start), by asserting the fake binary's own start-count
  side-channel file shows exactly two starts.
- "cancelling one Codex setup does not kill another active turn" — two concurrent turns
  share one process; cancelling turn 2's `cancel` AbortSignal during its `thread/start` setup
  must not affect turn 1's already-running `turn/start`, asserted by turn 1 completing with
  `FIRST-OK` while turn 2 resolves `{ reply: "", stopped: true }`.
- "Codex classifies deterministic provider failures as terminal and leaves transient ones
  retryable" / "Codex never classifies its own infrastructure failures as terminal" — pure
  `codexNonRetryable`/`codexProviderFailure` table-driven tests (see §1.5).
- "Codex reads cumulative usage totals off the app-server's token notification" — pure
  `codexUsageTotals` unit test.
- Two parametrized tests over `["turnFailed", "startRejected"]` — "Codex parks the run on a
  provider auth/quota failure (...) instead of burning retries" — subprocess test asserting
  the whole turn rejects with a `NonRetryableTurnError` regardless of whether the provider
  failure surfaced as a JSON-RPC error on `turn/start` itself or as a `status: "failed"` on
  the eventual `turn/completed`.
- "Codex records one llm row per turn carrying real timings and usage, even when the turn
  fails" — asserts `recordLlmRequest` fires exactly once per turn (success or failure) with
  real `ttftMs`/`durationMs`/`usage` numbers, not placeholders.
- "the installed Codex app-server accepts the exact thread/start this adapter sends" — an
  **opt-in real-binary integration test**, `skip`ped unless `@openai/codex` is actually
  resolvable via `createRequire(...).resolve(...)`; spawns the genuine installed codex
  app-server and sends the harness's literal `thread/start` payload shape, asserting it's
  accepted. **Write an equivalent for ACP** if any concrete ACP-speaking agent binary is
  vendored/installable in this repo's dependency tree — skip-gated the same way if not always
  present in CI.

### 6.2 `test/claude-harness.test.ts` — pure function tests only (no fake subprocess)

Because the Claude Agent SDK's `query()` is an in-process JS API (not a subprocess protocol
QM drives directly — the SDK itself spawns/drives the CLI), this file only unit-tests the
small harness-owned helper functions, not a full turn lifecycle:
`claudeToolContext`, `claudeReplayTranscript`, `stripClaudeImageBytes`,
`claudeChildAgentAllowed`, `claudeChildEnv`, `claudeProcessIdentity`, and a real (uid-gated)
`spawnClaudeProcess` smoke test. Full-turn-lifecycle behavior for claude lives instead in
`test/claude-harness-turn.test.ts` (steering/replies, model-call/token accounting, LLM
request-record timing/usage, per-step-record-per-steer, "a turn that dies before its first
result still records exactly one request row", and that claude also exposes
`compactHistory`/`shouldRespond` so a "utility role" can't silently disable them). **Since
ACP is a true out-of-process JSON-RPC subprocess protocol (like codex, not like the in-process
Claude SDK), model your ACP test suite primarily on `test/codex-harness.test.ts`'s
fake-binary-over-real-stdio style**, plus a `test/acp-harness-turn.test.ts` analog to
`claude-harness-turn.test.ts` for steering/telemetry/record-count assertions that don't need
a fresh fake binary per test.

### 6.3 `test/harness-adapter.test.ts` — cross-harness contract tests

Three tests, generic across whichever harnesses are registered: "harness adapters declare
their native control and tool transports" (asserts `profile.controlTransport`/
`toolTransport` are populated correctly per adapter), "tool presentation belongs to the
adapter" (the third `HarnessToolPresentation` argument to `defineHarness`), and "model
utilities are independent from turn control" (that `models.*` methods work without ever
calling `turns.runTurn`). Add the ACP harness into whatever fixture list this file iterates
so it's covered by these three contract checks for free.

---

## 7. Recommended shape for `acp-harness.ts`

### 7.1 Config surface (mirror `CodexHarnessOptions`)

```ts
export interface AcpHarnessOptions {
  modelId?: string | ((scope?: ScopeId) => string | undefined);
  defaultModelId?: string;
  judgeModelId?: string;
  agentCmd?: string;          // propose ACP_AGENT_CMD env — path/name of the ACP agent binary
  agentArgs?: string[];       // propose ACP_AGENT_ARGS env (space-split, or JSON array) — argv passed to agentCmd
  env?: NodeJS.ProcessEnv;
  scratchExec?: boolean;
  ownerAuthExec?: boolean;
  reachExec?: boolean;
  controlTools?: boolean;
  turnWallClockMs?: number;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  appServerStartTimeoutMs?: number;   // rename "appServer" -> "agent" if desired
  signals?: RunSignalStore;
  tasks?: TaskStore;
  permissionPolicy?: AcpPermissionPolicy;   // see §7.4
}

export function acpHarnessConfigOptions(config: Config): AcpHarnessOptions {
  return {
    ...(config.acpModel ? { defaultModelId: config.acpModel } : {}),
    ...(config.judgeModelId && modelSupportedByHarness(config.judgeModelId, "acp") ? { judgeModelId: config.judgeModelId } : {}),
    ...(config.acpAgentCmd ? { agentCmd: config.acpAgentCmd } : {}),
    ...(config.acpAgentArgs ? { agentArgs: config.acpAgentArgs } : {}),
    env: config.acpProcessEnv,
    ...coreToolOptions(config),
    turnWallClockMs: config.turnWallClockMs,
  };
}
```

Config additions needed in `src/config.ts` (mirroring `codexModel`/`codexBinPath`/
`codexProcessEnv` at `config.ts:40-42`, `146-149`, `464-470` (harness id enum), `639-658`
(env allowlist), `718-720` (env → Config)):
- `ACP_AGENT_CMD` → `config.acpAgentCmd` (spawned command — this replaces the
  `node_modules/.bin/codex`-style implicit default, since there's no single canonical ACP
  agent binary; require this to be explicitly set, and fail fast/clearly if `HARNESS=acp` but
  `ACP_AGENT_CMD` is unset).
- `ACP_AGENT_ARGS` → `config.acpAgentArgs: string[]` (shell-split or JSON array; e.g.
  `ACP_AGENT_ARGS='["acp","--stdio"]'`).
- `ACP_MODEL` → `config.acpModel` (only meaningful if the target agent takes a model
  override — pass through, otherwise ignore).
- `ACP_BIN`-style separate binary-path override is subsumed by `ACP_AGENT_CMD` above.
- An env-passthrough allowlist analogous to `CODEX_ENV_PASSTHROUGH`/`CLAUDE_ENV_PASSTHROUGH`
  — likely needs to be operator-configurable (`ACP_AGENT_EXTRA_ENV`) rather than hardcoded,
  since the set of ACP-speaking agents (and their auth env vars) isn't fixed by the protocol.

And in `pi-models.ts`: add `"acp"` to `HARNESS_IDS` (line 9), a branch in
`modelSupportedByHarness` (line 169), and (optionally) branches in `defaultModelForHarness`
and `modelProviderAvailabilityFor` (§2.3). In `config.ts:31` and `harnessEnvStrict`
(`config.ts:464-470`) add `"acp"` to the accepted-value list/union.

### 7.2 Transport layer: `AcpAgentClient` (copy `CodexAppServer` almost verbatim)

```ts
export interface AcpAgentClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onSessionUpdate(sessionId: string, update: unknown): void | Promise<void>;   // session/update notifications
  onPermissionRequest(sessionId: string, params: unknown): Promise<unknown>;   // session/request_permission
  onToolCall?(sessionId: string, params: unknown): Promise<unknown>;           // if ACP routes tool calls as requests-from-agent, same shape as codex's item/tool/call
}

export class AcpAgentClient {
  readonly process: ChildProcess;
  // same nextId/pending/writeTail/eventTail/stderr-ring-buffer/closed/closeError/processClosed
  // fields and request()/notify()/close()/receive()/send()/failAll() methods as CodexAppServer,
  // copy codex-app-server.ts:29-169 near-verbatim and rename onNotification/onRequest params
  // to the ACP method names (initialize, session/new, session/prompt, session/update,
  // session/request_permission, session/cancel, ...) once confirmed against the live ACP spec.
}
```

Reuse `spawn(command, args, { cwd, env, stdio: ["pipe","pipe","pipe"] })` exactly as codex
does — no uid/gid drop needed by default (mirror claude's `claudeProcessIdentity`-style
root-only drop only if this deployment ever runs its QM server as root).

### 7.3 Turn ↔ ACP session mapping

- On harness creation: no eager spawn — spawn a single long-lived agent process lazily on
  first `runTurn`, exactly like codex's `ensureRuntime()` (respawn if
  `process.exitCode !== null`; dedupe concurrent starts via a `starting` promise; timeout via
  `appServerStartTimeoutMs`).
- Decide the **session-per-turn vs. session-per-QM-session** question up front (this is ACP's
  biggest divergence point from codex — see §7.5 risk 1):
  - **Session-per-turn** (matches codex's `thread/start`-every-turn model): call
    `session_new` fresh each `runTurn`, replay `turn.history` into it via whatever ACP
    supports for seeding prior context (if ACP has no bulk-inject RPC, fall back to claude's
    approach — flatten history into a text block prepended to the prompt, `claudeReplayTranscript`
    equivalent). `resetSession()` can be a no-op.
  - **Session-per-QM-session** (reuse one ACP session across a whole QM conversation): call
    `session_new` once, keyed by `turn.session.id`, cached in a `Map<string, AcpSessionState>`;
    subsequent turns call `session_prompt` directly with no replay needed (ACP's own
    session state carries history). **Must** implement `resetSession(sessionId)` to end/discard
    the ACP session so `createHarnessRouter`'s cross-harness-switch logic
    (harness-router.ts:100-103) doesn't leak stale ACP session state into an unrelated later
    conversation on the same `session.id`.
- Map `turn.cancel` (AbortSignal) → ACP's session cancel/interrupt RPC (whatever it's
  literally called — `session/cancel`?), exactly like codex's `interrupt()` helper
  (codex-harness.ts:801-813) that both fires on explicit cancel and on a terminal QM tool
  call (`finish_silently`/similar).
- Map `turn.turnWallClockMs` → a `setTimeout` racing the completion promise, calling the same
  interrupt path on expiry and throwing `NonRetryableTurnError` (codex-harness.ts:833-854).
- Map streamed `session/update` (agent-message-chunk-shaped notifications) → `turn.onDelta`/
  `turn.onTextBlockStart`; map any reasoning/thought update variant → `turn.emit({ type:
  "thinking", ... })`.
- Bridge QM's tool set (`createPiTools`) the same way codex does: declare them to the agent
  at session-start time in whatever shape ACP expects for client-provided tools (dynamic
  function-call declarations, or an MCP server descriptor per ACP's MCP-server-in-initialize
  option — decide per §7.5 risk 3), and handle inbound tool-call requests from the agent by
  looking up the matching `BridgedTool`, executing it via `ref.current` (`ToolContext`), and
  replying with its result. Apply the same least-privilege allowlist as
  `codexChildToolAllowed`/`CLAUDE_CHILD_TOOL_NAMES` for any nested/sub-session tool calls.
- On successful completion: extract final text, emit `assistant`/`thinking` entries exactly
  like codex's `textFromTurn`/`reasoningFromTurn`, return the same `HarnessTurnResult` shape
  (§1.4), including `modelCalls`, `cacheUsage` if the agent reports token usage, and
  `tapeWriteFailed` if tape writes failed.

### 7.4 Permission-request → QM-approval mapping

This is the biggest **new** design surface ACP introduces relative to codex/claude (neither
existing subprocess harness has a "the child asks permission mid-turn over the wire" RPC —
codex disables its own approval system entirely via `approvalPolicy: "never"`,
codex-harness.ts:641, and routes all gating through QM's own `NeedsApproval`/tool-approval-gate
mechanism instead). Two compatible strategies, not mutually exclusive:

1. **Policy-based auto-answer** (simplest, matches codex's `approvalPolicy: "never"` +
   QM-side gating philosophy): have `onPermissionRequest` **never surface to a human directly
   over ACP**; instead auto-allow or auto-deny based on a `permissionPolicy` callback
   (default: auto-deny anything not already covered by QM's own tool bridge, since any
   filesystem/exec action the agent needs should be happening through a bridged QM tool
   call, not the agent's own native tool use — same "disable native capability, force through
   our bridge" pattern as codex's `config.features` block, §3.5 point 2). If the ACP agent
   has native tools you intentionally leave enabled (rather than routing everything through
   QM's bridge), map its permission request onto QM's own `pendingApprovals`/
   `pausedOnApproval` result fields (§1.4) — i.e. **treat an ACP `session/request_permission`
   exactly like codex's `NeedsApproval` exception path** (`runExecute`'s catch block,
   pi-tools.ts:485-501): push `{ command, reason, kind: "approval", approvalKey }` onto
   `ref.pendingApprovals`, set `pausedOnApproval = true`, and return a "denied for now,
   pending human approval" response to the ACP agent so it stops rather than blocking
   forever, exactly mirroring the `terminate: true` short-circuit at pi-tools.ts:498.
2. **Synchronous human-in-the-loop over ACP** (if a specific deployment wants literal
   pass-through prompts) — only viable if QM's surface layer (Slack/etc.) can pause a live
   turn and resume it later; this repo's existing turn model is not built for a suspended
   mid-flight synchronous callback (turns run to completion or are aborted), so prefer
   strategy 1 (surface it as a **paused turn** the human answers on a *later* turn, the same
   way `pausedOnApproval`/`pendingApprovals` already work today for QM's own `execute` tool)
   over trying to block the ACP JSON-RPC exchange open across an external human response.

### 7.5 Biggest open risks (see §8 summary too)

1. **Session lifecycle mismatch**: QM's turn model is "one `runTurn` call, replay full
   history via `HarnessTurnInput.history` every time" (codex's model). ACP's `session_new` /
   `session_prompt` split implies the *agent* may want to own persistent session state across
   turns (matching claude's SDK-session and provider-sessions capability, not codex's
   stateless-per-turn-with-explicit-replay model). Decide up front which model to use (§7.3)
   — get this wrong and you either double-feed history (agent has it AND QM replays it) or
   lose it (agent discards it between turns and QM doesn't replay).
2. **No standardized ACP auth/permission-request schema in this repo** — everything in §3-§5
   is codex/claude-specific; the actual ACP JSON-RPC method names, params, and the exact
   `session/request_permission` response shape must be taken from the live ACP spec
   (agentclientprotocol.com), not from this codebase, before `AcpAgentClient`'s method names
   can be finalized.
3. **Tool-bridging transport choice** (dynamic function-call declarations at session-start,
   like codex, vs. exposing QM's tools as an MCP server ACP's `initialize` can reference) has
   real implications for what `toolTransport` profile value is correct (§1.2) and for how
   much of `createPiTools`'s output needs reshaping — confirm which one the target ACP
   agent(s) actually support before committing to an implementation.

---

## 8. Summary of files to touch for a complete `acp` harness

| File | Change |
|---|---|
| `src/harness/acp-harness.ts` | **new** — `createAcpHarness`, `acpHarnessConfigOptions`, per §7 |
| `src/harness/acp-agent-client.ts` (or inline in acp-harness.ts) | **new** — JSON-RPC/NDJSON stdio transport, copy `codex-app-server.ts` |
| `src/model/pi-models.ts:9` | add `"acp"` to `HARNESS_IDS` |
| `src/model/pi-models.ts:169-176` | add `acp` branch to `modelSupportedByHarness` |
| `src/model/pi-models.ts:178-190, 213-222` | optional: `defaultModelForHarness`, `modelProviderAvailabilityFor` branches |
| `src/config.ts:31` | add `"acp"` to `Config["harness"]` union |
| `src/config.ts:464-470` | add `"acp"` to `harnessEnvStrict` accepted values + error message |
| `src/config.ts` (near 40-45, 146-149, 639-676, 718-723) | `acpModel`, `acpAgentCmd`, `acpAgentArgs`, `acpProcessEnv` config fields + env parsing |
| `src/wiring.ts:699-712` | register `["acp", createAcpHarness({...})]` in the `adapters` map |
| `test/acp-harness.test.ts` | **new** — fake-binary NDJSON subprocess tests, modeled on `test/codex-harness.test.ts` |
| `test/acp-harness-turn.test.ts` | **new** — telemetry/steering tests, modeled on `test/claude-harness-turn.test.ts` |
| `test/harness-adapter.test.ts` | add `acp` to whatever cross-harness fixture list exists |

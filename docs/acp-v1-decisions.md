# ACP harness v1 — locked decisions (implementation spec addendum)

These decisions are FINAL for v1; do not relitigate them in implementation. They resolve the three open risks in acp-harness-design-notes.md §8.

1. **Use the official SDK, not hand-rolled JSON-RPC.** `@zed-industries/agent-client-protocol` (installed, v0.4.5) provides `ClientSideConnection`, `ndJsonStream`, and the full `schema` types. The adapter spawns the agent process and wraps its stdio with `ndJsonStream`, then drives `initialize` → `newSession` → `prompt`. This kills the design doc's risk #2 (protocol specifics) at the source.

2. **Session lifecycle: stateless session-per-turn (codex-style).** Every QM turn creates a fresh ACP session (`newSession`) and replays conversation history into the prompt, exactly like the codex harness replays `replaySmokeItems`. Rationale: QM's turn contract already carries full history; persistent ACP sessions across QM turns would double-feed or drift. A persistent-session mode can be v2.

3. **Tool bridging: NONE in v1.** The ACP agent brings its own tools (that is the point of ACP agents like claude-code-acp or Gemini CLI). QM's `capabilities` in `initialize` advertise `fs: false` (no readTextFile/writeTextFile) and no terminal. `Client.readTextFile`/`writeTextFile`/terminal methods reject with RequestError.methodNotFound. QM tools are NOT exposed as MCP into the agent in v1. This resolves design risk #3 by deferring it.

4. **Permission policy: posture-mapped, conservative.** `Client.requestPermission` resolves as: if the turn is `readOnly` → choose the first "reject"-kind option; otherwise honor env `ACP_PERMISSION_MODE`: `auto` (default; choose the first "allow-once"-kind option) or `deny` (always reject). Never persist "always allow" choices in v1 (never pick allow-always options). Log every decision via the harness's existing logging pattern.

5. **Config surface (mirrors codex):**
   - `HARNESS=acp` selects it (add to `HARNESS_IDS`).
   - `ACP_AGENT_CMD` (required when HARNESS=acp; absolute path or binary name of the ACP agent) and `ACP_AGENT_ARGS` (space-separated, optional).
   - Env passthrough allowlist for the child: same base set as codex (`PATH`, `TMPDIR`, `LANG`, `LC_ALL`, SSL vars, proxy vars, `HOME`→jail) PLUS `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` so agents can auth their own way.
   - Model id: ACP agents choose their own model; `modelSupportedByHarness(id, "acp")` accepts anything non-empty (the id is passed through to the session if the agent supports model selection, else ignored).

6. **Streaming:** `session/update` notifications with `agent_message_chunk` content map to the turn's `onDelta`; the final `prompt` response's stop reason ends the turn. Tool-call updates surface as progress via the existing emit pattern the codex harness uses for its child events (do not fabricate tool rows in QM's ledger for v1; log them).

7. **Errors:** map agent auth failures (RequestError codes, or `authenticate` required) to `NonRetryableTurnError` the same way codex-harness classifies its authy stderr patterns. Process exit before prompt completes = retryable turn error with stderr tail.

8. **Tests (test/acp-harness.test.ts):** mirror the codex test strategy — a FAKE ACP agent implemented as a real child process using the SAME SDK's `AgentSideConnection`, scripted to: negotiate init, echo a session, stream two chunks, request one permission, then end turn. Assert: streamed deltas arrive in order, permission policy applied per mode (auto/deny/readOnly), final text assembled, auth-failure classification, and clean shutdown (no orphan process).

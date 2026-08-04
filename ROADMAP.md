# qm-local

A fork of [yc-software/qm](https://github.com/yc-software/qm) focused on one thing: running multiplayer agents **locally, on hardware you own, with accounts you already have**.

Upstream QM is a genuinely well-designed system with a cloud-first deployment story. This fork keeps the core in sync with upstream (using QM's own deployment-directory and sync tooling wherever possible) and carries a small set of local-first patches.

## Shipped

- **No Fly account needed for the local test drive.** Upstream's docker target refuses to start without a Fly agent-computer app (`sandbox.app`), even though agent sandboxes on that target execute as local Docker containers. The gate is removed; the Fly layer-image path remains an explicit opt-in.
- **Works on native Windows.** Upstream probes for external tools by exec'ing `/bin/sh`, which native Windows Node cannot resolve, so `qm doctor` and `qm up` claimed docker/flyctl were missing on any Windows machine. Tool detection now uses `where` on win32. (WSL2 remains the smoothest path; native Windows is no longer a hard wall.)

## In progress

- **Use the subscriptions you already pay for.** Upstream already passes `CLAUDE_CODE_OAUTH_TOKEN` through to the Claude Code harness (subscription billing, no API key). We're verifying that path end to end, and adding the equivalent for Codex: subscription-mode `auth.json` materialization instead of API-key-only.
- **ACP harness adapter.** An [Agent Client Protocol](https://agentclientprotocol.com) harness alongside pi/claude/codex/opencode, so any ACP-speaking agent plugs into QM's scoped sandboxes with its own local auth.
- **Open-model recipes.** Documented, tested configs for OpenRouter-hosted open models (Kimi, DeepSeek, Qwen) and fully local serving (Ollama/vLLM) via the existing base-URL overrides. No code changes needed; the recipes just make it obvious.
- **QM Local desktop app.** A lightweight desktop shell (Windows first) for the web UI, in a separate repo. Unofficial; not affiliated with or endorsed by Y Combinator.

## Non-goals

- Diverging from upstream's architecture. Patches are kept minimal and PR-able.
- Hosting subscription-backed model access for other users. Subscription terms tie usage to an individual; this fork's subscription features are for your own local instance.

## License

MIT, same as upstream. "Y Combinator" and the YC logo are trademarks of Y Combinator; this fork is not affiliated with, sponsored by, or endorsed by Y Combinator.

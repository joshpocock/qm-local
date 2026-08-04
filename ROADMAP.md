# qm-local

A fork of [yc-software/qm](https://github.com/yc-software/qm) focused on one thing: running multiplayer agents **locally, on hardware you own, with accounts you already have**.

Upstream QM is a genuinely well-designed system with a cloud-first deployment story. This fork keeps the core in sync with upstream (using QM's own deployment-directory and sync tooling wherever possible) and carries a small set of local-first patches.

## Shipped

- **No Fly account needed for the local test drive.** Upstream's docker target refuses to start without a Fly agent-computer app (`sandbox.app`), even though agent sandboxes on that target execute as local Docker containers. The gate is removed; the Fly layer-image path remains an explicit opt-in.
- **Agent sandboxes actually run locally on the docker target.** Upstream's local sandbox backend dials the exec daemon on the host's loopback, which cannot work when core itself is a container — the deep reason the docker target wanted Fly. Sandboxes now join the deployment's docker network and are dialed by container name (`LOCAL_SANDBOX_SHARED_NETWORK`, wired automatically by the CLI, plus the docker socket mount and `docker-cli` in the core image). Verified end to end: a real model turn executed `uname -a` inside a per-person scoped sandbox container with zero cloud accounts involved.
- **Works on native Windows.** Upstream probes for external tools by exec'ing `/bin/sh`, which native Windows Node cannot resolve, so `qm doctor` and `qm up` claimed docker/flyctl were missing on any Windows machine. Tool detection now uses `where` on win32. (WSL2 remains the smoothest path; native Windows is no longer a hard wall.)
- **Builds from source reliably.** Upstream runs `npm audit` inside `docker build`, so the same commit stops building the day a new advisory lands in the registry (true of upstream HEAD as of 2026-08-04). The audit gate belongs in CI and is removed from the image build.
- **Browser sign-in works on a local test drive.** Two upstream blockers made this impossible: the auth broker only spoke Resend or SMTP (so signing in needed real email infrastructure), and the service images bake `NODE_ENV=production`, under which the broker refuses the `http://localhost` issuer the CLI itself derived and the portal refuses its own `PORTAL_LOCAL_AUTH_BYPASS`. Now `AUTH_EMAIL_TRANSPORT=console` prints the sign-in link to the auth service log (refused in production), and the docker target runs portal and auth in development mode while core stays strict. Verified: a real sign-in link minted and printed on a localhost deployment with no email provider configured.

  ```bash
  # start the flow at http://localhost:8191, enter your email, then:
  docker logs qm-<org>-auth 2>&1 | grep -A3 "QM SIGN-IN LINK" | tail -4
  ```

- **Codex on your ChatGPT subscription.** `CODEX_AUTH_JSON` / `CODEX_AUTH_JSON_B64` materialize a subscription-mode `auth.json` (the contents of `~/.codex/auth.json` minted by `codex login`), winning over `OPENAI_API_KEY`. For your own instance only — subscriptions are personal; do not serve other users' turns with one. (Claude Code subscriptions already work upstream via `CLAUDE_CODE_OAUTH_TOKEN`.)

## In progress

- **ACP harness adapter.** An [Agent Client Protocol](https://agentclientprotocol.com) harness alongside pi/claude/codex/opencode, so any ACP-speaking agent plugs into QM's scoped sandboxes with its own local auth.
- **Open-model recipes.** Documented configs for OpenRouter-hosted open models (Kimi, DeepSeek, Qwen — first-class on the pi harness) and local serving via the existing base-URL passthroughs.
- **QM Local desktop app.** A lightweight desktop shell (Windows first) for the web UI, in a separate repo. Unofficial; not affiliated with or endorsed by Y Combinator.

## Non-goals

- Diverging from upstream's architecture. Patches are kept minimal and PR-able.
- Hosting subscription-backed model access for other users. Subscription terms tie usage to an individual; this fork's subscription features are for your own local instance.

## License

MIT, same as upstream. "Y Combinator" and the YC logo are trademarks of Y Combinator; this fork is not affiliated with, sponsored by, or endorsed by Y Combinator.

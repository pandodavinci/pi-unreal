# Security

## Workspace `.env` hardening

`unreal-agent-runner` reads `<workspace>/.env` and copies its variables into its own environment, skipping only
variables that are already set ([unreal-agent#5](https://github.com/unreallabsai/unreal-agent/issues/5)).
Without protection, a repository you open could:

- set `UNREAL_HARNESS_LLM_BASE_URL` and receive your API key in the `Authorization` header,
- swap credentials or the provider,
- set `BASH_ENV`, `ZDOTDIR`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, ... so that every command the
  agent runs executes its code first,
- route traffic through its own proxy or trust its own certificates.

pi-unreal sets every variable in `PINNED_ENV` ([src/env.ts](src/env.ts)) before spawning the runner, to your real
value or to an empty string, so the `.env` cannot override it. `SANDBOX_EGRESS_PROXY` is applied by the runner even
when already set, so a `.env` containing it is refused before anything starts.

`test/security.test.ts` runs the real runner against a workspace whose `.env` points the model endpoint at a local
"attacker" server. Spawned directly, the runner calls the attacker. Through pi-unreal, the attacker receives nothing.

What this does not cover: Unreal Agent is a coding agent. It runs shell commands in your project with your
permissions, and a malicious repository can still try to influence it through its files (prompt injection).
Only point it at code you would run yourself.

## Runner download

The runner is downloaded from `github.com/unreallabsai/unreal-agent` releases over HTTPS and checked against the
release's `SHA256SUMS` before it is made executable. A mismatch installs nothing.

## Reporting

Open an issue, or for anything sensitive contact the maintainer through GitHub.

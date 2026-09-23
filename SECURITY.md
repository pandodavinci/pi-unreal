# Security

## The problem: Unreal loads the project's `.env`

`unreal-agent-runner` reads `<workspace>/.env` and copies its variables into its own environment, skipping
only variables that are already set ([unreal-agent#5](https://github.com/unreallabsai/unreal-agent/issues/5)).
Every shell command the agent runs inherits the result. A repository you open with the plain runner can:

- set `UNREAL_HARNESS_LLM_BASE_URL` and receive your API key in the `Authorization` header,
- run its own code in every command, for example with `BASH_ENV`, `SHELLOPTS=xtrace` plus `PS4=$(...)`,
  exported Bash functions (`BASH_FUNC_*`), `LD_PRELOAD` or `DYLD_INSERT_LIBRARIES`,
- route model traffic through its own proxy (`SANDBOX_EGRESS_PROXY`).

## What pi-unreal does

By default the project's `.env` never reaches Unreal:

1. pi-unreal parses the `.env` with the same rules as the runner's Go parser (including Go's definition of
   whitespace), so both always agree on which variable names it defines.
2. Right before the runner starts, every one of those names is set: to your own value if you have one,
   otherwise to an empty string (`ZDOTDIR` to `$HOME`, which is what zsh does when it is unset). The runner
   skips variables that are already set, so it ignores the file's values.
3. Names that an empty value cannot neutralize cause a refusal before anything runs:
   `SANDBOX_EGRESS_PROXY` (the runner applies it even when already set), `BASH_FUNC_*` (an empty value is still
   a function definition for Bash) and every `GIT_*` variable (for git, set-but-empty often differs from unset:
   `GIT_SSL_NO_VERIFY` disables certificate checks when merely present).
4. The runner's own credentials and endpoints (`UNREAL_HARNESS_LLM_*`, provider API keys, Codex auth, proxy and
   TLS settings) are pinned in every mode, and `SANDBOX_EGRESS_PROXY` is refused in every mode.

Side effect: tools the agent runs will not see the project's `.env` values either; a tool that loads the `.env`
itself sees them as already set (to empty). For a repository you trust, `PI_UNREAL_TRUST_DOTENV=1` lets the
`.env` through; step 4 still applies.

Limits:

- An empty value equals unset for almost every program, but not all. A variable whose mere presence changes a
  tool's behavior, and that is not in the refusal list, still reaches the agent's commands as an empty value.
- pi-unreal and the runner read the `.env` separately, a moment apart. A process that rewrites the file in that
  instant is outside this protection.

The complete fix belongs upstream: a runner option to not load the workspace `.env` at all.

`test/security.test.ts` checks this against the real runner with a local fake model that asks for one shell
command:

| Attack | Plain runner | Through pi-unreal |
| --- | --- | --- |
| `.env` sets `UNREAL_HARNESS_LLM_BASE_URL` to an attacker | attacker receives `Bearer <your key>` | attacker receives nothing |
| `.env` sets `BASH_ENV` | attacker code runs | no attacker code runs; the agent's command still runs |
| `.env` sets `SHELLOPTS=xtrace`, `PS4=$(...)` | attacker code runs | no attacker code runs; the agent's command still runs |
| `.env` defines `BASH_FUNC_*` | | refused before start |

## What it does not cover

Unreal Agent is a coding agent: it runs shell commands in your project with your permissions, and a malicious
repository can still try to influence it through its files (prompt injection). Only point it at code you
would be willing to run yourself.

Files pi-unreal writes (pasted images, debug log, downloaded runner) live under `~/.cache/pi-unreal` with
private permissions; directories and the debug log from older versions are tightened on use.

## Runner download

The runner is downloaded over HTTPS from `github.com/unreallabsai/unreal-agent` releases and checked against
the release's `SHA256SUMS` before it is made executable. A mismatch installs nothing. The cache is separated
per version and platform, and a cached binary is re-hashed on every use against the hash recorded when it was
verified, so a corrupted binary is replaced. This detects damage, not tampering by someone who can already write
to your cache.

## Reporting

Open an issue, or for anything sensitive contact the maintainer through GitHub.

# Changelog

## 0.1.0

First release.

- `--unreal` / `/harness`: Unreal Agent answers every message typed in Pi or Oh My Pi, with live progress, streaming replies (with a runner that supports `include_partial_messages`), image paste, Esc to stop, and conversation carry-over between harnesses.
- Unreal keeps a persisted session per conversation branch: forks, `/tree` and interrupted turns start a fresh session seeded with the visible history. Stopped and dropped messages are never replayed.
- `/unreal`, `/unreal-jobs`, `/unreal-cancel` and the `unreal_delegate` tool: Unreal as a background worker. `/unreal-jobs` shows a job's full result.
- Works with Pi (Node) and Oh My Pi (Bun): in the interactive terminal and Pi's RPC mode; elsewhere `--unreal` turns itself off with a visible warning. `/unreal` in print mode waits and prints its result.
- Downloads and verifies the official `unreal-agent-runner` release (v0.2.0) on first use, with a visible status line and actionable setup errors.
- Keeps a workspace `.env` away from Unreal Agent (unreal-agent#5), tested against the real runner for API key exfiltration and shell code injection. With bash and zsh, Unreal's commands still start with your own environment, so a project's own tools can load its `.env`.
- Kills the commands Unreal started on Esc, crash or exit; never blocks the host's UI thread.
- Housekeeping: old logs, job output, sessions, images and runner downloads are pruned automatically, only in the default directory or one pi-unreal created (or found empty).
- CI: unit and integration tests on macOS and Linux, a Node load test, and end-to-end runs of the real `pi` and `omp` binaries.

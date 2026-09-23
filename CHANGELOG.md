# Changelog

## 0.1.0

First release.

- `--unreal` / `/harness`: Unreal Agent answers every message typed in Pi or Oh My Pi, with live progress, streaming replies (with a runner that supports `include_partial_messages`), image paste, Esc to stop, and conversation carry-over between harnesses.
- `/unreal`, `/unreal-jobs`, `/unreal-cancel` and the `unreal_delegate` tool: Unreal as a background worker.
- Downloads and verifies the official `unreal-agent-runner` release on first use.
- Neutralizes a workspace `.env` (unreal-agent#5): tested against the real runner for API key exfiltration and shell code injection.
- Works with Pi (Node) and Oh My Pi (Bun), in the interactive terminal and Pi's RPC mode; elsewhere `--unreal` turns itself off with a visible warning, and `/unreal` in print mode waits and prints its result.
- One Unreal session per conversation branch; Esc drops queued messages for good; `/unreal-jobs` shows a job's full result.
- Housekeeping: old logs, job output and images are pruned automatically.

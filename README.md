# pi-unreal

Run [Unreal Agent](https://github.com/unreallabsai/unreal-agent) inside [Pi](https://github.com/badlogic/pi-mono) and [Oh My Pi](https://github.com/can1357/oh-my-pi).

Pi keeps the terminal UI. Unreal Agent becomes the brain.

- **Unreal as the harness.** Start with `--unreal` and every message you type goes to Unreal Agent. Pi makes zero model calls. `/harness pi` switches the same chat back to Pi.
- **Unreal as a background worker.** Stay in Pi and run `/unreal fix the failing tests`. Unreal works in the background, its progress streams above the editor, and the result lands in your chat when it is done.

<!-- demo: add demo.gif here -->

## Install

Pi:

```sh
pi install git:github.com/pandodavinci/pi-unreal
```

Oh My Pi:

```sh
omp plugin install github:pandodavinci/pi-unreal
```

On first use the plugin downloads the official `unreal-agent-runner` release for your platform (macOS or Linux, x64 or arm64) and verifies its SHA-256 checksum. Already have it on your `PATH`, or want your own build? Set `UNREAL_AGENT_RUNNER=/path/to/unreal-agent-runner`.

**Model access.** By default Unreal uses your Codex login (`~/.codex/auth.json`, from `codex login`) with `gpt-6-astra`. To use something else:

```sh
export UNREAL_HARNESS_LLM_PROVIDER=openai        # openai | openai-codex | openrouter | fireworks | ollama
export UNREAL_HARNESS_LLM_MODEL=gpt-6-astra
export OPENAI_API_KEY=...                         # or OPENROUTER_API_KEY / FIREWORKS_API_KEY
```

## Use

### Unreal as the harness

```sh
pi --unreal          # or: omp --unreal
```

| You do | What happens |
| --- | --- |
| Type a message | Unreal Agent answers. Its steps and reply stream live above the editor, then land in the chat with time, model calls, tool calls and tokens. Ctrl+O shows every step. |
| Paste an image (Ctrl+V) | Saved to a file and opened by Unreal's ViewImage tool. |
| Press Esc | Stops Unreal and every command it started. |
| Keep typing while it works | Messages queue and run in order. |
| `/harness pi` / `/harness unreal` | Switch who answers, in the same chat. |
| `/new` | Fresh conversation. Unreal remembers everything within one session. |

Slash commands and `!bash` still go to Pi.

### Unreal as a background worker

| Command | |
| --- | --- |
| `/unreal <task>` | Start a background job. Pi stays interactive. |
| `/unreal-jobs` | See every job and its latest steps. |
| `/unreal-cancel [id\|all]` | Stop a job (defaults to the most recent). |

Pi's own model also gets an `unreal_delegate` tool, so you can say "hand this to Unreal" and it will, in the foreground or in the background.

## Live streaming

Word-by-word streaming needs an Unreal runner that implements `include_partial_messages`. Released runners (v0.1.1) accept the flag but ignore it, so with them each reply appears when it is complete, while the step list still updates live. pi-unreal already asks for streaming and renders it as soon as the runner supports it.

## Security

Unreal's runner loads the `.env` file of the folder it works in ([unreal-agent#5](https://github.com/unreallabsai/unreal-agent/issues/5)). A repo you open could use it to send your API key to someone else's server, or to make every shell command run their code.

pi-unreal closes that hole without changing Unreal: before starting the runner it pins your credentials, model endpoints, proxy and TLS settings, and shell startup hooks, so the `.env` can no longer override them. The one setting the runner always takes from `.env` (`SANDBOX_EGRESS_PROXY`) makes pi-unreal refuse to run. A test reproduces the attack against the real runner and checks that it fails. Details in [SECURITY.md](SECURITY.md).

Unreal Agent still runs shell commands in your project with your permissions, like any coding agent.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `UNREAL_HARNESS_LLM_PROVIDER` | `openai-codex` | Unreal's model provider |
| `UNREAL_HARNESS_LLM_MODEL` | `gpt-6-astra` with openai-codex | Model ID |
| `UNREAL_AGENT_RUNNER` | downloaded release | Path to your own runner |
| `PI_UNREAL_MODE=1` | off | Same as `--unreal` |
| `PI_UNREAL_THINKING` | runner default (`high`) | `low`, `medium`, `high`, `xhigh`, `max` |
| `PI_UNREAL_STATE_DIR` | `~/.cache/pi-unreal` | Runner download, sessions, logs, pasted images |
| `PI_UNREAL_DEBUG=1` | off | Log every runner event to `<state>/debug.log` |

## How it works

```
Pi / Oh My Pi
  └─ pi-unreal extension
       ├─ input hook (--unreal): your message never reaches Pi's agent loop
       ├─ /unreal, unreal_delegate: background jobs
       └─ unreal-agent-runner (subprocess, own process group)
            stdout: JSONL session items (+ partial deltas when supported) ──► live widget, chat messages
            Esc / cancel: SIGINT, then SIGKILL of the runner and every command it started
```

The same extension works in both hosts. It uses Node APIs only (Pi runs extensions on Node, Oh My Pi on Bun) and the shared `@earendil-works/*` imports both hosts provide. Unreal keeps one persisted session per Pi session, so it remembers the conversation across messages.

## Limitations

- Unreal uses its own tools (Bash, ViewImage, and skills in `.harness/skills`). Pi's tools, skills and MCP servers are not available to it. That is the point of an Unreal vs Pi comparison, but it also means fewer capabilities than Pi's built-in harness.
- Windows is not supported (Unreal publishes macOS and Linux runners only).
- Very new. Tested on Pi 0.87.1 and Oh My Pi 18.2.10, macOS arm64.

## Development

```sh
bun install
bun test          # 29 tests, including the real-runner .env attack test (PI_UNREAL_SKIP_LIVE=1 to skip)
bun run check     # typecheck
pi -e ./src/index.ts --unreal
```

## License

MIT. Unreal Agent is MIT licensed by Unreal Labs; Pi by Mario Zechner; Oh My Pi by its authors.

/**
 * Environment hardening for unreal-agent-runner.
 *
 * The runner loads <workspace>/.env into its own environment, but skips any variable that is
 * already present (see unreal-agent cmd/internal/agentrunner/run.go loadDotEnv). A repo you open
 * could therefore redirect your API key to another server (UNREAL_HARNESS_LLM_BASE_URL), swap
 * credentials, or make every Bash call source attacker code (BASH_ENV, ZDOTDIR, ...).
 * See https://github.com/unreallabsai/unreal-agent/issues/5.
 *
 * Mitigation without changing Unreal: every variable below is set before spawn (to your real
 * value, or to an empty string), so the workspace .env can no longer override it.
 * SANDBOX_EGRESS_PROXY is the one variable the runner always takes from .env, so a .env that sets
 * it is refused outright.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Variables a workspace .env must never control. */
export const PINNED_ENV = [
	// Runner configuration and credentials
	"UNREAL_HARNESS_LLM_PROVIDER",
	"UNREAL_HARNESS_LLM_MODEL",
	"UNREAL_HARNESS_LLM_BASE_URL",
	"UNREAL_HARNESS_LLM_API_KEY",
	"UNREAL_HARNESS_LLM_MAX_ATTEMPTS",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"FIREWORKS_API_KEY",
	"CUSTOM_API_KEY",
	"OPENAI_CODEX_ACCESS_TOKEN",
	"OPENAI_CODEX_ACCOUNT_ID",
	"OPENAI_CODEX_AUTH_FILE",
	"CODEX_HOME",
	"HARNESS_CREATE_FILE_HELPER",
	"HARNESS_CREATE_FILE_PATH",
	// Network routing and TLS trust
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"https_proxy",
	"http_proxy",
	"all_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"GODEBUG",
	// Code the agent's shell would execute or load implicitly
	"HOME",
	"PATH",
	"SHELL",
	"BASH_ENV",
	"ENV",
	"ZDOTDIR",
	"PROMPT_COMMAND",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FRAMEWORK_PATH",
	"NODE_OPTIONS",
	"PYTHONSTARTUP",
	"PYTHONPATH",
	"GIT_CONFIG_GLOBAL",
	"GIT_SSH_COMMAND",
] as const;

/** Returns a copy of env where every PINNED_ENV variable is present (real value or ""). */
export function pinEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const out = { ...env };
	for (const name of PINNED_ENV) {
		if (out[name] !== undefined) continue;
		// Empty ZDOTDIR would make zsh read /.zshenv; point it at the user's real home instead.
		out[name] = name === "ZDOTDIR" ? (out.HOME ?? "") : "";
	}
	return out;
}

export interface DotEnvReport {
	exists: boolean;
	/** Variable names the .env sets (values are never read into memory beyond the name). */
	names: string[];
	/** Names the runner would still honor despite pinning (currently only SANDBOX_EGRESS_PROXY). */
	unpinnable: string[];
}

export function inspectDotEnv(workspace: string): DotEnvReport {
	let text: string;
	try {
		text = fs.readFileSync(path.join(workspace, ".env"), "utf8");
	} catch {
		return { exists: false, names: [], unpinnable: [] };
	}
	const names: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		names.push(line.slice(0, eq).trim());
	}
	return { exists: true, names, unpinnable: names.filter(n => n === "SANDBOX_EGRESS_PROXY") };
}

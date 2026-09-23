/**
 * Workspace .env neutralization for unreal-agent-runner.
 *
 * The runner copies <workspace>/.env into its own environment, skipping only variables that are
 * already present (unreal-agent cmd/internal/agentrunner/run.go loadDotEnv), and every Bash command it
 * runs inherits the result. A repo you open could therefore redirect your API key
 * (UNREAL_HARNESS_LLM_BASE_URL), or run code in every command (BASH_ENV, SHELLOPTS + PS4, BASH_FUNC_*,
 * LD_PRELOAD, ...). See https://github.com/unreallabsai/unreal-agent/issues/5.
 *
 * Default: every name the .env defines is made present before spawn (your own value if you have one,
 * otherwise an empty string), so the runner ignores the whole file. Names that an empty value cannot
 * neutralize are refused. PI_UNREAL_TRUST_DOTENV=1 lets a trusted repo's .env through, while runner
 * credentials and endpoints stay pinned.
 *
 * The .env is parsed exactly like the runner's Go parser so the two can never disagree about a name.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Runner configuration a workspace must never control, even with PI_UNREAL_TRUST_DOTENV=1. */
export const PINNED_ENV = [
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
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"ALL_PROXY",
	"https_proxy",
	"http_proxy",
	"all_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

/**
 * Names that must not come from an untrusted .env and cannot be neutralized with an empty value:
 * the runner applies SANDBOX_EGRESS_PROXY even when it is already set; an empty BASH_FUNC_* entry is still a
 * (broken) function definition for Bash to import; and for git, set-but-empty often differs from unset
 * (GIT_SSL_NO_VERIFY disables certificate checks when merely present, GIT_CONFIG_GLOBAL="" is a file named "").
 */
export function isUnpinnable(name: string): boolean {
	return name === "SANDBOX_EGRESS_PROXY" || name.startsWith("BASH_FUNC_") || name.startsWith("GIT_");
}

/** Go's unicode.IsSpace, which strings.TrimSpace uses. JavaScript's \s differs (U+0085, U+FEFF). */
const GO_SPACE = "\t\n\v\f\r \u0085                 　";

export function goTrimSpace(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && GO_SPACE.includes(text[start]!)) start++;
	while (end > start && GO_SPACE.includes(text[end - 1]!)) end--;
	return text.slice(start, end);
}

/** Variable names the runner would read from this .env text (mirrors loadDotEnv line by line). */
export function dotEnvNames(text: string): string[] {
	const names = new Set<string>();
	for (const rawLine of text.split("\n")) {
		const line = goTrimSpace(rawLine);
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const name = goTrimSpace(line.slice(0, eq));
		if (name !== "") names.add(name);
	}
	return [...names];
}

export interface DotEnvReport {
	exists: boolean;
	/** Names the .env defines. Values are never kept. */
	names: string[];
	/** Names that cause a refusal unless the .env is trusted (and SANDBOX_EGRESS_PROXY even then). */
	unpinnable: string[];
}

export function inspectDotEnv(workspace: string): DotEnvReport {
	let text: string;
	try {
		text = fs.readFileSync(path.join(workspace, ".env"), "utf8");
	} catch {
		return { exists: false, names: [], unpinnable: [] };
	}
	const names = dotEnvNames(text);
	return { exists: true, names, unpinnable: names.filter(isUnpinnable) };
}

/**
 * Environment for the runner: every name in `neutralize` and in PINNED_ENV is present (your value or ""),
 * so the workspace .env cannot supply it.
 */
export function hardenEnvironment(
	env: Record<string, string | undefined>,
	neutralize: readonly string[] = [],
): Record<string, string | undefined> {
	const out = { ...env };
	for (const name of [...PINNED_ENV, ...neutralize]) {
		if (out[name] === undefined) out[name] = neutralValue(name, env);
	}
	return out;
}

/** zsh reads ZDOTDIR="" as "/"; unset means $HOME. Everything else is neutralized with an empty value. */
function neutralValue(name: string, env: Record<string, string | undefined>): string {
	return name === "ZDOTDIR" ? (env.HOME ?? "") : "";
}

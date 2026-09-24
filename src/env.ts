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
 * otherwise an empty placeholder), so the runner ignores the whole file. Names that an empty value cannot
 * neutralize are refused. PI_UNREAL_TRUST_DOTENV=1 lets a trusted repo's .env through, while runner
 * credentials and endpoints stay pinned.
 *
 * Unreal runs every command as `$SHELL -c <command>`. For bash and zsh, a startup file (shellHook) removes the
 * placeholders again before the command starts, so commands get your own environment, as in your
 * terminal, and a project's own tools can still load its .env themselves (dotenv and the like).
 *
 * The .env is parsed exactly like the runner's Go parser so the two can never disagree about a name.
 */
import { spawnSync } from "node:child_process";
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
 * Build metadata that CI and deploy setups commonly keep in a .env under a GIT_ name. Git itself reads none
 * of them (checked against git's documentation and the names in the git binary), so an empty value is safe.
 */
const GIT_METADATA = new Set([
	"GIT_BRANCH",
	"GIT_COMMIT",
	"GIT_COMMIT_HASH",
	"GIT_COMMIT_SHA",
	"GIT_HASH",
	"GIT_REPO_URL",
	"GIT_REPOSITORY_URL",
	"GIT_REVISION",
	"GIT_SHA",
	"GIT_TAG",
	"GIT_VERSION",
]);

/**
 * The shells' own variables that bash (3.2, macOS's) or zsh take from the environment at startup, where an
 * empty value breaks them: bash's BASH_SOURCE and friends (a startup file that finds its helpers through
 * BASH_SOURCE would load them from the project instead), zsh's function path, nesting limit, temp file prefix
 * and the tables of its parameter module ($commands, $options, ...). No project needs these in a .env.
 * BASH_ENV and ZDOTDIR are handled by the startup hook (and neutralized for other shells).
 */
const SHELL_INTERNAL = new Set([
	// bash
	"BASH",
	"BASHOPTS",
	"BASHPID",
	"BASH_ALIASES",
	"BASH_ARGC",
	"BASH_ARGV",
	"BASH_ARGV0",
	"BASH_CMDS",
	"BASH_COMMAND",
	"BASH_COMPAT",
	"BASH_EXECUTION_STRING",
	"BASH_LINENO",
	"BASH_LOADABLES_PATH",
	"BASH_MONOSECONDS",
	"BASH_REMATCH",
	"BASH_SOURCE",
	"BASH_SUBSHELL",
	"BASH_TRAPSIG",
	"BASH_VERSINFO",
	"BASH_VERSION",
	"BASH_XTRACEFD",
	"DIRSTACK",
	"FUNCNAME",
	"GROUPS",
	"POSIXLY_CORRECT",
	// zsh
	"FPATH",
	"FUNCNEST",
	"MODULE_PATH",
	"NULLCMD",
	"READNULLCMD",
	"TMPPREFIX",
	// zsh's zsh/parameter module
	"aliases",
	"builtins",
	"commands",
	"dirstack",
	"dis_aliases",
	"dis_builtins",
	"dis_functions",
	"dis_functions_source",
	"dis_galiases",
	"dis_patchars",
	"dis_reswords",
	"dis_saliases",
	"funcfiletrace",
	"funcsourcetrace",
	"funcstack",
	"functions",
	"functions_source",
	"functrace",
	"galiases",
	"history",
	"historywords",
	"jobdirs",
	"jobstates",
	"jobtexts",
	"keymaps",
	"modules",
	"nameddirs",
	"options",
	"parameters",
	"patchars",
	"reswords",
	"saliases",
	"termcap",
	"terminfo",
	"userdirs",
	"usergroups",
	"widgets",
	"zsh_scheduled_events",
]);

/**
 * Why a name must not come from an untrusted .env even though it cannot be neutralized with an empty value,
 * or undefined when an empty value is safe. The runner applies SANDBOX_EGRESS_PROXY even when it is already
 * set; an empty BASH_FUNC_* entry is still a (broken) function definition for Bash to import; and for git,
 * set-but-empty often differs from unset (GIT_SSL_NO_VERIFY disables certificate checks when merely present,
 * GIT_CONFIG_GLOBAL="" is a file named "").
 */
export function unpinnableReason(name: string): string | undefined {
	if (name === "SANDBOX_EGRESS_PROXY") return "Unreal Agent would send all its traffic through that proxy";
	if (name.startsWith("BASH_FUNC_")) return "it defines a shell function for every command";
	if (SHELL_INTERNAL.has(name)) return "it is one of the shell's own variables, which an empty value breaks";
	if (name.startsWith("GIT_") && !GIT_METADATA.has(name)) return "git acts on GIT_ settings even when they are empty";
	return undefined;
}

export function isUnpinnable(name: string): boolean {
	return unpinnableReason(name) !== undefined;
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
	// No prototype: a .env name like `constructor` or `__proto__` must become an entry like any other.
	const out: Record<string, string | undefined> = Object.assign(Object.create(null), env);
	for (const name of [...PINNED_ENV, ...neutralize]) {
		if (own(out, name) === undefined) out[name] = neutralValue(name, env);
	}
	return out;
}

/** env[name], ignoring anything inherited from Object.prototype. */
export function own(env: Record<string, string | undefined>, name: string): string | undefined {
	return Object.hasOwn(env, name) ? env[name] : undefined;
}

/** zsh reads ZDOTDIR="" as "/"; unset means $HOME. Everything else is neutralized with an empty value. */
function neutralValue(name: string, env: Record<string, string | undefined>): string {
	return name === "ZDOTDIR" ? (env.HOME ?? "") : "";
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Whether zsh, started the way the runner starts it (`zsh -c`) and with this environment, still has the
 * ZDOTDIR it was given after its system zshenv, which runs first. The probe directory does not exist, so zsh
 * reads nothing else. A zsh that does not answer within 2 seconds counts as no.
 */
export function zshHonorsZdotdir(shell: string, env: Record<string, string | undefined>): boolean {
	const probe = path.join(path.sep, "nonexistent", "pi-unreal-zdotdir-probe");
	const result = spawnSync(shell, ["-c", 'print -rn -- "${ZDOTDIR-}"'], {
		env: { ...env, ZDOTDIR: probe } as NodeJS.ProcessEnv,
		encoding: "utf8",
		timeout: 2_000,
	});
	return result.status === 0 && result.stdout === probe;
}
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/**
 * Bash variables that lose their special meaning when unset (bash(1), "Shell Variables"). Left alone.
 * Variables bash only fills in when the environment lacks them (UID, HOSTNAME, ...) are unset like any other:
 * that keeps them out of the environment of the tools a command runs, as in your terminal.
 */
const BASH_SPECIAL = new Set([
	"BASH_ALIASES",
	"BASH_ARGV0",
	"BASH_CMDS",
	"BASH_COMMAND",
	"BASH_SUBSHELL",
	"BASHPID",
	"COMP_WORDBREAKS",
	"DIRSTACK",
	"EPOCHREALTIME",
	"EPOCHSECONDS",
	"FUNCNAME",
	"GROUPS",
	"HISTCMD",
	"LINENO",
	"RANDOM",
	"SECONDS",
	"SRANDOM",
]);

/**
 * A startup file that removes the placeholders hardenEnvironment added, for commands run by bash or zsh.
 * `original` is the environment before hardening, `hardened` the one the runner gets. The file restores the
 * startup variable it hijacks (BASH_ENV or ZDOTDIR) and runs your own startup file, so every command sees the
 * environment it would see in your terminal. Nested shells are unaffected. Returns the variables to add to
 * the runner's environment, or undefined for other shells (which keep the empty placeholders) and when
 * `leave` (a trusted .env's names) includes the startup variable.
 */
export function shellHook(
	original: Record<string, string | undefined>,
	hardened: Record<string, string | undefined>,
	dir: string,
	leave: readonly string[] = [],
	zdotdirHonored: (shell: string, env: Record<string, string | undefined>) => boolean = zshHonorsZdotdir,
): Record<string, string> | undefined {
	const shell = path.basename(hardened.SHELL?.trim() ?? "");
	const hookVar = shell === "bash" ? "BASH_ENV" : shell === "zsh" ? "ZDOTDIR" : undefined;
	if (!hookVar || leave.includes(hookVar)) return undefined;
	// zsh reads the system zshenv first; if that sets ZDOTDIR, the hook would never run.
	if (hookVar === "ZDOTDIR" && !zdotdirHonored(hardened.SHELL!.trim(), hardened)) return undefined;
	const placeholders = Object.keys(hardened).filter(
		name => own(original, name) === undefined && own(hardened, name) !== undefined && name !== hookVar && IDENTIFIER.test(name),
	);
	if (placeholders.length === 0 && hardened[hookVar] === original[hookVar]) return undefined;
	const mine = original[hookVar];
	const lines = ["# pi-unreal: give this command your own environment back (see pi-unreal src/env.ts)."];
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (hookVar === "BASH_ENV") {
		const file = path.join(dir, "bash_env");
		// Bash expands BASH_ENV (including command substitution) before reading it.
		if (/[$`\\]/.test(file)) return undefined;
		// Only what still holds its placeholder: a variable the shell set itself keeps its value.
		for (const name of placeholders) {
			if (!BASH_SPECIAL.has(name)) lines.push(`[ "\${${name}-}" != ${shellQuote(hardened[name]!)} ] || unset -v ${name} 2>/dev/null`);
		}
		if (mine === undefined) {
			lines.push("unset -v BASH_ENV");
		} else {
			// Your own BASH_ENV, which bash expands before reading it: rather than imitate that, run the command
			// in a fresh bash (same process) that reads it itself, from this clean environment.
			lines.push(
				`export BASH_ENV=${shellQuote(mine)}`,
				'if [ -n "${BASH_EXECUTION_STRING-}" ]; then exec "$BASH" -c "$BASH_EXECUTION_STRING" "$0" "$@"; fi',
				'if [ -r "$BASH_ENV" ]; then . "$BASH_ENV"; fi',
			);
		}
		fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
		return { BASH_ENV: file };
	}
	// Only what still holds its placeholder (zsh keeps its own ZSH_VERSION, ...), and never a special
	// parameter (zsh ties some names to others: unsetting `path` empties PATH).
	for (const name of placeholders) {
		lines.push(`[[ \${${name}-} != ${shellQuote(hardened[name]!)} || \${(t)${name}} == *special* ]] || unset ${name} 2>/dev/null`);
	}
	const zdotdir = path.join(dir, "zsh");
	fs.mkdirSync(zdotdir, { recursive: true, mode: 0o700 });
	lines.push(mine === undefined ? "unset ZDOTDIR" : `export ZDOTDIR=${shellQuote(mine)}`);
	lines.push('if [[ -r "${ZDOTDIR:-$HOME}/.zshenv" ]]; then source "${ZDOTDIR:-$HOME}/.zshenv"; fi');
	fs.writeFileSync(path.join(zdotdir, ".zshenv"), `${lines.join("\n")}\n`, { mode: 0o600 });
	return { ZDOTDIR: zdotdir };
}

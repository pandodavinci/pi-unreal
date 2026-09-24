import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dotEnvNames, goTrimSpace, hardenEnvironment, inspectDotEnv, isUnpinnable, PINNED_ENV, shellHook, unpinnableReason, zshHonorsZdotdir, zshHonorsZdotdirAsync } from "../src/env";
import { formatSummary, runUnreal } from "../src/runner";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-env-"));

describe("dotEnvNames matches the runner's Go parser", () => {
	test("comments, blank lines, missing '=' and empty names are skipped; names are trimmed", () => {
		expect(dotEnvNames("# c\n\nFOO=1\nNOEQUALS\n=value\n  BAR = x\r\nexport BAZ=1\n")).toEqual(["FOO", "BAR", "export BAZ"]);
	});

	test("U+0085 is whitespace for Go (not for JavaScript's trim), so the name is still found", () => {
		expect(dotEnvNames("\u0085SANDBOX_EGRESS_PROXY=http://evil")).toEqual(["SANDBOX_EGRESS_PROXY"]);
	});

	test("U+FEFF is not whitespace for Go, so it stays part of the name", () => {
		expect(goTrimSpace("﻿FOO")).toBe("﻿FOO");
	});
});

describe("hardenEnvironment", () => {
	test("every .env name and pinned runner setting becomes present, keeping the user's own values", () => {
		const env = hardenEnvironment({ OPENAI_API_KEY: "sk-real", PS4: "+ " }, ["PS4", "SHELLOPTS", "DATABASE_URL"]);
		expect(env.OPENAI_API_KEY).toBe("sk-real");
		expect(env.PS4).toBe("+ ");
		expect(env.SHELLOPTS).toBe("");
		expect(env.DATABASE_URL).toBe("");
		for (const name of PINNED_ENV) expect(env[name]).toBeDefined();
	});

	test("ZDOTDIR is neutralized to its unset meaning ($HOME), not to an empty string", () => {
		expect(hardenEnvironment({ HOME: "/home/me" }, ["ZDOTDIR"]).ZDOTDIR).toBe("/home/me");
	});

	test("nothing outside the .env and the runner settings is touched (no empty GIT_SSH_COMMAND, ZDOTDIR, ...)", () => {
		const env = hardenEnvironment({ HOME: "/home/me" }, []);
		for (const name of ["GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "ZDOTDIR", "BASH_ENV"]) expect(env[name]).toBeUndefined();
	});
});

describe("refusals", () => {
	test("names an empty value cannot neutralize are refused (proxy, Bash functions, git's variables)", () => {
		expect(isUnpinnable("SANDBOX_EGRESS_PROXY")).toBe(true);
		expect(isUnpinnable("BASH_FUNC_ls%%")).toBe(true);
		expect(isUnpinnable("GIT_SSL_NO_VERIFY")).toBe(true); // disables TLS checks when merely present
		expect(isUnpinnable("GIT_CONFIG_GLOBAL")).toBe(true);
		expect(isUnpinnable("GIT_COMMIT_GRAPH_PARANOIA")).toBe(true);
		expect(isUnpinnable("PS4")).toBe(false);
	});

	test("the shells' own variables whose empty value breaks them are refused; ordinary names are not", () => {
		for (const name of ["BASH_SOURCE", "BASH_ARGV", "FUNCNAME", "DIRSTACK", "POSIXLY_CORRECT", "FPATH", "FUNCNEST", "TMPPREFIX", "commands", "options"]) {
			expect({ name, reason: unpinnableReason(name) }).toEqual({ name, reason: "it is one of the shell's own variables, which an empty value breaks" });
		}
		for (const name of ["BASH_ENV", "BASHFUL_API_KEY", "ZSH_VERSION", "HOST", "UID", "HISTORY_URL"]) expect({ name, refused: isUnpinnable(name) }).toEqual({ name, refused: false });
	});

	test("PI_UNREAL_TRUST_DOTENV is not suggested when SANDBOX_EGRESS_PROXY is among the refused (it refuses it too)", async () => {
		for (const text of ["SANDBOX_EGRESS_PROXY=http://evil:8080\n", "SANDBOX_EGRESS_PROXY=http://evil:8080\nGIT_DIR=/x\n"]) {
			const dir = tmpdir();
			fs.writeFileSync(path.join(dir, ".env"), text);
			const result = await runUnreal({ task: "t", cwd: dir, stateDir: tmpdir(), command: ["/nonexistent"] });
			expect(result.errorMessage).not.toContain("PI_UNREAL_TRUST_DOTENV");
		}
	});

	test("__proto__ is refused: Bun, Oh My Pi's runtime, drops it from a spawned process's environment", () => {
		expect(isUnpinnable("__proto__")).toBe(true);
	});

	test("names that exist on every JavaScript object (constructor, __proto__) are neutralized like any other", () => {
		const names = ["constructor", "toString", "__proto__"];
		const env = hardenEnvironment({ PATH: process.env.PATH }, names);
		for (const name of names) expect({ name, own: Object.hasOwn(env, name), value: env[name] }).toEqual({ name, own: true, value: "" });
		const printed = spawnSync("/usr/bin/env", { env: env as NodeJS.ProcessEnv, encoding: "utf8" }).stdout.split("\n");
		for (const name of names) expect(printed).toContain(`${name}=`);
	});

	test("build metadata under GIT_ names that git never reads is neutralized like any other name", () => {
		for (const name of ["GIT_SHA", "GIT_COMMIT_SHA", "GIT_BRANCH", "GIT_TAG"]) expect(isUnpinnable(name)).toBe(false);
	});

	test("each refusal says why", async () => {
		expect(unpinnableReason("GIT_SSL_NO_VERIFY")).toContain("git");
		expect(unpinnableReason("SANDBOX_EGRESS_PROXY")).toContain("proxy");
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, ".env"), "GIT_DIR=/elsewhere\nGIT_SHA=abc123\n");
		const result = await runUnreal({ task: "t", cwd: dir, stateDir: tmpdir(), command: ["/nonexistent"] });
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toContain("GIT_DIR (git acts on GIT_ settings even when they are empty)");
		expect(result.errorMessage).not.toContain("GIT_SHA");
		expect(formatSummary("t", result)).not.toContain("Log:"); // nothing ran, so there is no log to point at
	});

	test("inspectDotEnv reports names and refusals", () => {
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, ".env"), "FOO=1\nSANDBOX_EGRESS_PROXY=http://evil:8080\n");
		expect(inspectDotEnv(dir)).toEqual({ exists: true, names: ["FOO", "SANDBOX_EGRESS_PROXY"], unpinnable: ["SANDBOX_EGRESS_PROXY"] });
		expect(inspectDotEnv(tmpdir())).toEqual({ exists: false, names: [], unpinnable: [] });
	});

	test("runUnreal refuses before spawning, including the U+0085 disguise", async () => {
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, ".env"), "\u0085SANDBOX_EGRESS_PROXY=http://evil:8080\n");
		const result = await runUnreal({ task: "t", cwd: dir, stateDir: tmpdir(), command: ["/nonexistent"] });
		expect(result.status).toBe("failed");
		expect(result.exitCode).toBeNull();
		expect(result.errorMessage).toContain("SANDBOX_EGRESS_PROXY");
	});

	test("PI_UNREAL_TRUST_DOTENV=1 still refuses SANDBOX_EGRESS_PROXY", async () => {
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, ".env"), "SANDBOX_EGRESS_PROXY=http://evil:8080\n");
		const result = await runUnreal({ task: "t", cwd: dir, stateDir: tmpdir(), command: ["/nonexistent"], env: { PI_UNREAL_TRUST_DOTENV: "1" } });
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toContain("SANDBOX_EGRESS_PROXY");
	});

	test("PI_UNREAL_TRUST_DOTENV=1 lets a trusted .env through", async () => {
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, ".env"), "BASH_FUNC_x%%=() { :; }\n");
		const result = await runUnreal({ task: "t", cwd: dir, stateDir: tmpdir(), command: ["/nonexistent"], env: { PI_UNREAL_TRUST_DOTENV: "1" } });
		expect(result.errorMessage).toContain("failed to spawn"); // got past the refusal
	});
});

const shells = ["/bin/bash", "/bin/zsh"].filter(shell => fs.existsSync(shell));

describe("shellHook: Unreal's commands get your own environment back", () => {
	/** Runs `command` the way the runner does ($SHELL -c), with pi-unreal's hardened environment. */
	const runCommand = (original: Record<string, string | undefined>, neutralize: string[], command: string) => {
		const hardened = hardenEnvironment(original, neutralize);
		const hook = shellHook(original, hardened, path.join(tmpdir(), "shell"));
		expect(hook).toBeDefined();
		const shell = original.SHELL!;
		const result = spawnSync(shell, ["-c", command], { env: { ...hardened, ...hook } as NodeJS.ProcessEnv, encoding: "utf8" });
		expect(result.stderr).toBe("");
		return result.stdout;
	};
	const home = () => {
		const dir = tmpdir();
		return { HOME: dir, PATH: process.env.PATH };
	};

	for (const shell of shells) {
		test(`${path.basename(shell)}: placeholders are gone and your own values stay, so a project's tools can load its .env`, () => {
			const out = runCommand(
				{ ...home(), SHELL: shell, MINE: "mine" },
				["DATABASE_URL", "MINE", "GIT_SHA", "ZDOTDIR", "BASH_ENV", "PS4", "SHELLOPTS"],
				'printf "%s|" "${DATABASE_URL-unset}" "${MINE-unset}" "${GIT_SHA-unset}" "${OPENAI_API_KEY-unset}" "${BASH_ENV-unset}" "${ZDOTDIR-unset}"',
			);
			// PS4 and SHELLOPTS are shell variables: bash unsets PS4 (SHELLOPTS is read-only), zsh keeps its special
			// PS4 empty. Either way the command starts normally, which the empty stderr above checks.
			expect(out).toBe("unset|mine|unset|unset|unset|unset|");
		});

		test(`${path.basename(shell)}: nested shells start normally`, () => {
			const out = runCommand({ ...home(), SHELL: shell }, ["DATABASE_URL"], `${shell} -c 'printf "%s|%s" "\${BASH_ENV-unset}" "\${ZDOTDIR-unset}"'`);
			expect(out).toBe("unset|unset");
		});
	}

	test("bash: its special variables are left alone (RANDOM keeps working)", () => {
		const out = runCommand({ ...home(), SHELL: "/bin/bash" }, ["RANDOM", "DATABASE_URL"], 'a=$RANDOM; b=$RANDOM; [ "$a" != "$b" ] && echo random-ok');
		expect(out).toBe("random-ok\n");
	});

	test("bash: your own BASH_ENV is expanded the way bash expands it", () => {
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, "startup"), "export FROM_MY_STARTUP=yes\n");
		const out = runCommand(
			{ ...home(), SHELL: "/bin/bash", STARTUP_DIR: dir, BASH_ENV: "$STARTUP_DIR/startup" },
			["DATABASE_URL"],
			'printf "%s|%s" "${FROM_MY_STARTUP-no}" "$BASH_ENV"',
		);
		expect(out).toBe("yes|$STARTUP_DIR/startup");
	});

	test.skipIf(!shells.includes("/bin/zsh"))("zsh: a .env name zsh ties to another (path is PATH) is left alone", () => {
		const out = runCommand({ ...home(), SHELL: "/bin/zsh" }, ["path", "fpath", "DATABASE_URL"], 'uname -s >/dev/null && printf "%s" "${DATABASE_URL-unset}"');
		expect(out).toBe("unset");
	});

	test("bash: your own BASH_ENV still runs, and stays set", () => {
		const dir = tmpdir();
		const mine = path.join(dir, "my env's file");
		fs.writeFileSync(mine, "export FROM_MY_STARTUP=yes\n");
		const out = runCommand({ ...home(), SHELL: "/bin/bash", BASH_ENV: mine }, ["DATABASE_URL"], 'printf "%s|%s" "${FROM_MY_STARTUP-no}" "$BASH_ENV"');
		expect(out).toBe(`yes|${mine}`);
	});

	test.skipIf(!shells.includes("/bin/zsh"))("zsh: your own .zshenv still runs, from ZDOTDIR or HOME", () => {
		const env = home();
		fs.writeFileSync(path.join(env.HOME, ".zshenv"), "export FROM_MY_STARTUP=home\n");
		expect(runCommand({ ...env, SHELL: "/bin/zsh" }, ["DATABASE_URL"], 'printf "%s|%s" "${FROM_MY_STARTUP-no}" "${ZDOTDIR-unset}"')).toBe("home|unset");
		const zdotdir = tmpdir();
		fs.writeFileSync(path.join(zdotdir, ".zshenv"), "export FROM_MY_STARTUP=zdotdir\n");
		expect(runCommand({ ...env, SHELL: "/bin/zsh", ZDOTDIR: zdotdir }, ["DATABASE_URL"], 'printf "%s|%s" "${FROM_MY_STARTUP-no}" "$ZDOTDIR"')).toBe(
			`zdotdir|${zdotdir}`,
		);
	});

	test("other shells keep the empty placeholders, and the run says so", async () => {
		expect(shellHook({ SHELL: "/bin/sh" }, hardenEnvironment({ SHELL: "/bin/sh" }, ["FOO"]), tmpdir())).toBeUndefined();
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, ".env"), "FOO=1\nMINE=theirs\n");
		const result = await runUnreal({ task: "t", cwd: dir, stateDir: tmpdir(), command: ["/nonexistent"], env: { SHELL: "/bin/sh", MINE: "mine" } });
		expect(result.dotEnvEmpty).toEqual(["FOO"]);
		expect(formatSummary("t", result)).toContain(".env variables as empty (1;");
		const hooked = await runUnreal({ task: "t", cwd: dir, stateDir: tmpdir(), command: ["/nonexistent"], env: { SHELL: "/bin/bash" } });
		expect(hooked.dotEnvEmpty).toEqual([]);
	});

	test("zsh: when the system zshenv replaces ZDOTDIR, there is no hook (it would never run)", () => {
		const original = { SHELL: "/bin/zsh" };
		expect(shellHook(original, hardenEnvironment(original, ["FOO"]), tmpdir(), [], () => false)).toBeUndefined();
		expect(shellHook(original, hardenEnvironment(original, ["FOO"]), tmpdir(), [], () => true)).toBeDefined();
	});

	test.skipIf(!shells.includes("/bin/zsh"))("zsh: the probe asks zsh itself (this machine's system zshenv keeps ZDOTDIR)", () => {
		expect(zshHonorsZdotdir("/bin/zsh", { PATH: process.env.PATH, HOME: tmpdir() })).toBe(true);
		return zshHonorsZdotdirAsync("/bin/zsh", { PATH: process.env.PATH, HOME: tmpdir() }).then(honored => expect(honored).toBe(true));
	});

	test("bash: a BASH_ENV of yours built with command substitution still runs", () => {
		const env = home();
		fs.writeFileSync(path.join(env.HOME, "startup"), "export FROM_MY_STARTUP=substituted\n");
		const out = runCommand({ ...env, SHELL: "/bin/bash", BASH_ENV: '$(printf "%s" "$HOME")/startup' }, ["DATABASE_URL"], 'printf "%s|%s" "${FROM_MY_STARTUP-no}" "${DATABASE_URL-unset}"');
		expect(out).toBe("substituted|unset");
	});

	test.skipIf(!shells.includes("/bin/zsh"))("zsh: a variable zsh sets itself keeps its value (ZSH_VERSION), only placeholders go", () => {
		const out = runCommand({ ...home(), SHELL: "/bin/zsh" }, ["ZSH_VERSION", "DATABASE_URL"], 'printf "%s|%s" "${ZSH_VERSION:+kept}" "${DATABASE_URL-unset}"');
		expect(out).toBe("kept|unset");
	});

	test("bash: a BASH_ENV of yours with quotes in its file name still runs", () => {
		const env = home();
		fs.writeFileSync(path.join(env.HOME, 'start"up'), "export FROM_MY_STARTUP=quoted\n");
		const out = runCommand({ ...env, SHELL: "/bin/bash", BASH_ENV: '$HOME/start"up' }, ["DATABASE_URL"], 'printf "%s" "${FROM_MY_STARTUP-no}"');
		expect(out).toBe("quoted");
	});

	test("a trusted .env that sets the startup variable is left alone", () => {
		const original = { SHELL: "/bin/bash" };
		expect(shellHook(original, hardenEnvironment(original), tmpdir(), ["BASH_ENV"])).toBeUndefined();
	});
});

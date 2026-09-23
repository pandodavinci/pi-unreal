import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dotEnvNames, goTrimSpace, hardenEnvironment, inspectDotEnv, isUnpinnable, PINNED_ENV } from "../src/env";
import { runUnreal } from "../src/runner";

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

	test("tools that treat empty differently from unset get their unset behavior", () => {
		const home = tmpdir();
		const env = hardenEnvironment({ HOME: home }, ["GIT_CONFIG_GLOBAL", "GIT_SSH_COMMAND", "ZDOTDIR"]);
		expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null"); // no global config exists in this HOME
		expect(env.GIT_SSH_COMMAND).toBe("ssh");
		expect(env.ZDOTDIR).toBe(home);
		fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = me\n");
		expect(hardenEnvironment({ HOME: home }, ["GIT_CONFIG_GLOBAL"]).GIT_CONFIG_GLOBAL).toBe(path.join(home, ".gitconfig"));
		const git = Bun.spawnSync(["git", "config", "--global", "user.name"], {
			env: { ...hardenEnvironment({ HOME: home, PATH: process.env.PATH }, ["GIT_CONFIG_GLOBAL"]), DEVELOPER_DIR: process.env.DEVELOPER_DIR },
		});
		expect(git.stdout.toString().trim()).toBe("me");
	});

	test("nothing outside the .env and the runner settings is touched (no empty GIT_SSH_COMMAND, ZDOTDIR, ...)", () => {
		const env = hardenEnvironment({ HOME: "/home/me" }, []);
		for (const name of ["GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "ZDOTDIR", "BASH_ENV"]) expect(env[name]).toBeUndefined();
	});
});

describe("refusals", () => {
	test("SANDBOX_EGRESS_PROXY and BASH_FUNC_* cannot be neutralized with an empty value", () => {
		expect(isUnpinnable("SANDBOX_EGRESS_PROXY")).toBe(true);
		expect(isUnpinnable("BASH_FUNC_ls%%")).toBe(true);
		expect(isUnpinnable("PS4")).toBe(false);
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

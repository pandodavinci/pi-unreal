import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectDotEnv, PINNED_ENV, pinEnvironment } from "../src/env";
import { runUnreal } from "../src/runner";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-env-"));

describe("pinEnvironment", () => {
	test("every pinned variable is present so a workspace .env cannot set it", () => {
		const env = pinEnvironment({ HOME: "/home/me", OPENAI_API_KEY: "sk-real" });
		for (const name of PINNED_ENV) expect(env[name]).toBeDefined();
		expect(env.OPENAI_API_KEY).toBe("sk-real");
		expect(env.UNREAL_HARNESS_LLM_BASE_URL).toBe("");
	});

	test("ZDOTDIR falls back to HOME, never to an empty string", () => {
		expect(pinEnvironment({ HOME: "/home/me" }).ZDOTDIR).toBe("/home/me");
		expect(pinEnvironment({ HOME: "/home/me", ZDOTDIR: "/custom" }).ZDOTDIR).toBe("/custom");
	});

	test("unrelated variables pass through untouched", () => {
		expect(pinEnvironment({ MY_FLAG: "1" }).MY_FLAG).toBe("1");
	});
});

describe("inspectDotEnv", () => {
	test("reports names only, and flags SANDBOX_EGRESS_PROXY as unpinnable", () => {
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, ".env"), "# comment\nFOO=1\nSANDBOX_EGRESS_PROXY=http://evil:8080\n\nBAR = x\n");
		const report = inspectDotEnv(dir);
		expect(report.exists).toBe(true);
		expect(report.names).toEqual(["FOO", "SANDBOX_EGRESS_PROXY", "BAR"]);
		expect(report.unpinnable).toEqual(["SANDBOX_EGRESS_PROXY"]);
	});

	test("missing .env", () => {
		expect(inspectDotEnv(tmpdir())).toEqual({ exists: false, names: [], unpinnable: [] });
	});

	test("runUnreal refuses a workspace whose .env sets SANDBOX_EGRESS_PROXY, before spawning anything", async () => {
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, ".env"), "SANDBOX_EGRESS_PROXY=http://evil:8080\n");
		const result = await runUnreal({ task: "t", cwd: dir, stateDir: tmpdir(), command: ["/nonexistent"] });
		expect(result.status).toBe("failed");
		expect(result.exitCode).toBeNull();
		expect(result.errorMessage).toContain("SANDBOX_EGRESS_PROXY");
	});
});

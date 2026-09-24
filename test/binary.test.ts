import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSums, platformTag, resolveRunner, RUNNER_VERSION, RunnerSetupError } from "../src/binary";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-bin-"));

/** Builds a release-shaped archive + SHA256SUMS and a fetch that serves them. */
function fakeRelease(tamper = false) {
	const dir = tmpdir();
	const stage = path.join(dir, "stage");
	fs.mkdirSync(stage);
	fs.writeFileSync(path.join(stage, "unreal-agent-runner"), "#!/bin/sh\necho fake-runner\n");
	fs.writeFileSync(path.join(stage, "LICENSE"), "MIT\n");
	const archive = `unreal-agent-runner_${RUNNER_VERSION}_${platformTag()}.tar.gz`;
	const archivePath = path.join(dir, archive);
	Bun.spawnSync(["tar", "-czf", archivePath, "-C", stage, "unreal-agent-runner", "LICENSE"]);
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(fs.readFileSync(archivePath));
	const digest = tamper ? "0".repeat(64) : hasher.digest("hex");
	const sums = `${digest}  ./${archive}\n${"a".repeat(64)}  ./other.tar.gz\n`;
	const requested: string[] = [];
	const fetchImpl = (async (url: string | URL | Request) => {
		const u = String(url);
		requested.push(u);
		if (u.endsWith("/SHA256SUMS")) return new Response(sums);
		if (u.endsWith(`/${archive}`)) return new Response(fs.readFileSync(archivePath));
		return new Response("nope", { status: 404 });
	}) as typeof fetch;
	return { fetchImpl, requested };
}

describe("binary", () => {
	test("parseSums handles sha256sum output with and without ./", () => {
		const sums = parseSums(`${"b".repeat(64)}  ./x.tar.gz\n${"c".repeat(64)}  y.tar.gz\ngarbage\n`);
		expect(sums.get("x.tar.gz")).toBe("b".repeat(64));
		expect(sums.get("y.tar.gz")).toBe("c".repeat(64));
		expect(sums.size).toBe(2);
	});

	test("platformTag maps to Go release names and rejects unsupported platforms", () => {
		expect(platformTag("darwin", "arm64")).toBe("darwin_arm64");
		expect(platformTag("linux", "x64")).toBe("linux_amd64");
		expect(() => platformTag("win32", "x64")).toThrow(RunnerSetupError);
		expect(() => platformTag("win32", "x64")).toThrow("macOS and Linux");
	});

	test("a runner on PATH is not used: the pinned, verified release is", async () => {
		const bin = tmpdir();
		fs.writeFileSync(path.join(bin, "unreal-agent-runner"), "#!/bin/sh\necho stale\n", { mode: 0o755 });
		const state = tmpdir();
		const { fetchImpl, requested } = fakeRelease();
		expect(await resolveRunner({ PI_UNREAL_STATE_DIR: state, PATH: bin }, undefined, fetchImpl)).toBe(
			path.join(state, "bin", RUNNER_VERSION, platformTag(), "unreal-agent-runner"),
		);
		expect(requested.length).toBeGreaterThan(0);
	});

	test("PI_UNREAL_RUNNER_VERSION must be a release version (it ends up in a URL and a path)", async () => {
		const { fetchImpl, requested } = fakeRelease();
		for (const version of ["../../etc", "latest", "1.2"]) {
			await expect(resolveRunner({ PI_UNREAL_STATE_DIR: tmpdir(), PI_UNREAL_RUNNER_VERSION: version }, undefined, fetchImpl)).rejects.toThrow(RunnerSetupError);
			await expect(resolveRunner({ PI_UNREAL_STATE_DIR: tmpdir(), PI_UNREAL_RUNNER_VERSION: version }, undefined, fetchImpl)).rejects.toThrow(
				"not a release version",
			);
		}
		expect(requested).toEqual([]);
	});

	test("UNREAL_AGENT_RUNNER wins without any download", async () => {
		const { fetchImpl, requested } = fakeRelease();
		expect(await resolveRunner({ UNREAL_AGENT_RUNNER: "/opt/runner", PATH: "" }, undefined, fetchImpl)).toBe("/opt/runner");
		expect(requested).toEqual([]);
	});

	test("downloads, verifies, installs executable, then reuses the cache", async () => {
		const state = tmpdir();
		const env = { PI_UNREAL_STATE_DIR: state, PATH: "/nonexistent" };
		const { fetchImpl, requested } = fakeRelease();
		const bin = await resolveRunner(env, undefined, fetchImpl);
		expect(bin).toBe(path.join(state, "bin", RUNNER_VERSION, platformTag(), "unreal-agent-runner"));
		expect(fs.statSync(bin).mode & 0o111).toBeTruthy();
		expect(Bun.spawnSync([bin]).stdout.toString().trim()).toBe("fake-runner");
		const before = requested.length;
		expect(await resolveRunner(env, undefined, fetchImpl)).toBe(bin);
		expect(requested.length).toBe(before);
	});

	test("a checksum mismatch installs nothing", async () => {
		const state = tmpdir();
		const { fetchImpl } = fakeRelease(true);
		await expect(resolveRunner({ PI_UNREAL_STATE_DIR: state, PATH: "/nonexistent" }, undefined, fetchImpl)).rejects.toThrow(
			"checksum mismatch",
		);
		expect(fs.existsSync(path.join(state, "bin", RUNNER_VERSION, platformTag(), "unreal-agent-runner"))).toBe(false);
	});

	test("concurrent resolves share one download", async () => {
		const state = tmpdir();
		const env = { PI_UNREAL_STATE_DIR: state, PATH: "/nonexistent" };
		const { fetchImpl, requested } = fakeRelease();
		const [a, b, c] = await Promise.all([resolveRunner(env, undefined, fetchImpl), resolveRunner(env, undefined, fetchImpl), resolveRunner(env, undefined, fetchImpl)]);
		expect(new Set([a, b, c]).size).toBe(1);
		expect(requested.filter(u => u.endsWith(".tar.gz")).length).toBe(1);
	});

	test("a corrupted cached binary is detected and downloaded again", async () => {
		const state = tmpdir();
		const env = { PI_UNREAL_STATE_DIR: state, PATH: "/nonexistent" };
		const { fetchImpl, requested } = fakeRelease();
		const bin = await resolveRunner(env, undefined, fetchImpl);
		fs.writeFileSync(bin, "#!/bin/sh\necho tampered\n");
		const downloadsBefore = requested.filter(u => u.endsWith(".tar.gz")).length;
		expect(await resolveRunner(env, undefined, fetchImpl)).toBe(bin);
		expect(requested.filter(u => u.endsWith(".tar.gz")).length).toBe(downloadsBefore + 1);
		expect(Bun.spawnSync([bin]).stdout.toString().trim()).toBe("fake-runner");
	});

	test("a cached binary that lost its executable bit is replaced", async () => {
		const state = tmpdir();
		const env = { PI_UNREAL_STATE_DIR: state, PATH: "/nonexistent" };
		const { fetchImpl } = fakeRelease();
		const bin = await resolveRunner(env, undefined, fetchImpl);
		fs.chmodSync(bin, 0o644);
		expect(await resolveRunner(env, undefined, fetchImpl)).toBe(bin);
		expect(fs.statSync(bin).mode & 0o111).toBeTruthy();
	});

	test("concurrent resolves for different state dirs do not share a download", async () => {
		const { fetchImpl } = fakeRelease();
		const [a, b] = await Promise.all([
			resolveRunner({ PI_UNREAL_STATE_DIR: tmpdir(), PATH: "/nonexistent" }, undefined, fetchImpl),
			resolveRunner({ PI_UNREAL_STATE_DIR: tmpdir(), PATH: "/nonexistent" }, undefined, fetchImpl),
		]);
		expect(a).not.toBe(b);
		expect(fs.existsSync(a) && fs.existsSync(b)).toBe(true);
	});
});

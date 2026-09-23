import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSums, platformTag, resolveRunner, RUNNER_VERSION } from "../src/binary";

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
		expect(() => platformTag("win32", "x64")).toThrow("macOS and Linux");
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
		expect(bin).toBe(path.join(state, "bin", RUNNER_VERSION, "unreal-agent-runner"));
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
		expect(fs.existsSync(path.join(state, "bin", RUNNER_VERSION, "unreal-agent-runner"))).toBe(false);
	});
});

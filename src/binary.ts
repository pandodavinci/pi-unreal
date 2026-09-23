/**
 * Locates unreal-agent-runner, downloading the official release on first use.
 *
 * Order: UNREAL_AGENT_RUNNER → `unreal-agent-runner` on PATH → cached download → download.
 * Downloads come from github.com/unreallabsai/unreal-agent releases and are verified against the
 * release's SHA256SUMS before they are made executable.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RUNNER_VERSION = "0.1.1";
const RELEASES = "https://github.com/unreallabsai/unreal-agent/releases/download";
const BINARY = "unreal-agent-runner";

export function stateRoot(env: Record<string, string | undefined> = process.env): string {
	return env.PI_UNREAL_STATE_DIR ?? path.join(os.homedir(), ".cache", "pi-unreal");
}

export function platformTag(platform = process.platform, arch = process.arch): string {
	const goos = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
	const goarch = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : undefined;
	if (!goos || !goarch) {
		throw new Error(`Unreal Agent publishes binaries for macOS and Linux (x64/arm64) only, not ${platform}/${arch}.`);
	}
	return `${goos}_${goarch}`;
}

function sha256(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** `which`, using Node APIs only (Pi runs extensions on Node). */
export function which(name: string, envPath = process.env.PATH ?? ""): string | undefined {
	for (const dir of envPath.split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return undefined;
}

/** Parses a `sha256sum` file ("<hex>  ./name" or "<hex>  name"). */
export function parseSums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(?:\.\/)?(.+)$/);
		if (match) sums.set(match[2]!, match[1]!);
	}
	return sums;
}

let inflight: Promise<string> | undefined;

export async function resolveRunner(
	env: Record<string, string | undefined> = process.env,
	log: (msg: string) => void = () => {},
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	if (env.UNREAL_AGENT_RUNNER) return env.UNREAL_AGENT_RUNNER;
	const onPath = which(BINARY, env.PATH ?? "");
	if (onPath) return onPath;
	const version = env.PI_UNREAL_RUNNER_VERSION ?? RUNNER_VERSION;
	const target = path.join(stateRoot(env), "bin", version, BINARY);
	if (fs.existsSync(target)) return target;
	inflight ??= download(version, target, log, fetchImpl).finally(() => {
		inflight = undefined;
	});
	return inflight;
}

async function download(version: string, target: string, log: (msg: string) => void, fetchImpl: typeof fetch) {
	const archive = `${BINARY}_${version}_${platformTag()}.tar.gz`;
	const base = `${RELEASES}/v${version}`;
	log(`downloading ${base}/${archive}`);
	const dir = path.dirname(target);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-"));
	try {
		const [sumsRes, archiveRes] = await Promise.all([fetchImpl(`${base}/SHA256SUMS`), fetchImpl(`${base}/${archive}`)]);
		if (!sumsRes.ok) throw new Error(`fetch SHA256SUMS: HTTP ${sumsRes.status}`);
		if (!archiveRes.ok) throw new Error(`fetch ${archive}: HTTP ${archiveRes.status}`);
		const expected = parseSums(await sumsRes.text()).get(archive);
		if (!expected) throw new Error(`${archive} is not listed in SHA256SUMS`);
		const archivePath = path.join(tmp, archive);
		fs.writeFileSync(archivePath, Buffer.from(await archiveRes.arrayBuffer()));
		const actual = sha256(archivePath);
		if (actual !== expected) throw new Error(`checksum mismatch for ${archive}: expected ${expected}, got ${actual}`);
		try {
			execFileSync("tar", ["-xzf", archivePath, "-C", tmp, BINARY], { stdio: ["ignore", "ignore", "pipe"] });
		} catch (err) {
			throw new Error(`extract ${archive}: ${String((err as { stderr?: Buffer }).stderr ?? err).trim()}`);
		}
		fs.mkdirSync(dir, { recursive: true });
		fs.chmodSync(path.join(tmp, BINARY), 0o755);
		// Rename is atomic on the same filesystem; copy+rename handles tmp on another volume.
		const staged = `${target}.${process.pid}`;
		fs.copyFileSync(path.join(tmp, BINARY), staged);
		fs.chmodSync(staged, 0o755);
		fs.renameSync(staged, target);
		log(`installed ${target} (sha256 ${expected.slice(0, 12)}…)`);
		return target;
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

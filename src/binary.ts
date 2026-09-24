/**
 * Locates unreal-agent-runner, downloading the official release on first use.
 *
 * Order: UNREAL_AGENT_RUNNER → cached download → download. A runner on PATH is deliberately not used: the
 * plugin speaks the protocol of the release it pins, and a stale install there would be picked up silently.
 * Downloads come from github.com/unreallabsai/unreal-agent releases and are verified against the
 * release's SHA256SUMS before they are made executable. The cache is keyed by version and platform, and
 * a cached binary is re-hashed on every resolve; anything that does not match is downloaded again.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RUNNER_VERSION = "0.2.0";
const RELEASES = "https://github.com/unreallabsai/unreal-agent/releases/download";
const BINARY = "unreal-agent-runner";
const DOWNLOAD_TIMEOUT_MS = 120_000;

export function defaultStateRoot(): string {
	return path.join(os.homedir(), ".cache", "pi-unreal");
}

/** PI_UNREAL_STATE_DIR as an absolute path; unset or empty means the default. */
export function stateRoot(env: Record<string, string | undefined> = process.env): string {
	const configured = env.PI_UNREAL_STATE_DIR?.trim();
	return configured ? path.resolve(configured) : defaultStateRoot();
}

export class UnsupportedPlatformError extends Error {}

export function platformTag(platform = process.platform, arch = process.arch): string {
	const goos = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
	const goarch = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : undefined;
	if (!goos || !goarch) {
		throw new UnsupportedPlatformError(
			`Unreal Agent publishes runners for macOS and Linux (x64/arm64) only, and pi-unreal supports only those; this is ${platform}/${arch}.`,
		);
	}
	return `${goos}_${goarch}`;
}

function sha256(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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

const inflight = new Map<string, Promise<string>>();

export async function resolveRunner(
	env: Record<string, string | undefined> = process.env,
	log: (msg: string) => void = () => {},
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	if (env.UNREAL_AGENT_RUNNER) return env.UNREAL_AGENT_RUNNER;
	const version = env.PI_UNREAL_RUNNER_VERSION?.trim().replace(/^v/, "") || RUNNER_VERSION;
	// It becomes part of a URL and a cache path.
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`PI_UNREAL_RUNNER_VERSION is not a release version: ${version}`);
	const target = path.join(stateRoot(env), "bin", version, platformTag(), BINARY);
	if (cachedBinaryIsIntact(target)) return target;
	let pending = inflight.get(target);
	if (!pending) {
		pending = download(version, target, log, fetchImpl).finally(() => inflight.delete(target));
		inflight.set(target, pending);
	}
	return pending;
}

/** The installed binary must be executable and match the hash recorded when it was verified. */
function cachedBinaryIsIntact(target: string): boolean {
	try {
		fs.accessSync(target, fs.constants.X_OK);
		return fs.readFileSync(`${target}.sha256`, "utf8").trim() === sha256(target);
	} catch {
		return false;
	}
}

async function download(version: string, target: string, log: (msg: string) => void, fetchImpl: typeof fetch) {
	const archive = `${BINARY}_${version}_${platformTag()}.tar.gz`;
	const base = `${RELEASES}/v${version}`;
	log(`downloading ${base}/${archive}`);
	const dir = path.dirname(target);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-"));
	try {
		// Bounded, so a stalled connection fails (and the next attempt retries) instead of hanging forever.
		const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
		const [sumsRes, archiveRes] = await Promise.all([
			fetchImpl(`${base}/SHA256SUMS`, { signal }),
			fetchImpl(`${base}/${archive}`, { signal }),
		]);
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
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		// Rename is atomic on the same filesystem; copy+rename handles tmp on another volume.
		const staged = `${target}.${process.pid}.tmp`;
		fs.copyFileSync(path.join(tmp, BINARY), staged);
		fs.chmodSync(staged, 0o755);
		fs.writeFileSync(`${staged}.sha256`, `${sha256(staged)}\n`, { mode: 0o600 });
		fs.renameSync(`${staged}.sha256`, `${target}.sha256`);
		fs.renameSync(staged, target);
		log(`installed ${target} (sha256 ${expected.slice(0, 12)}…)`);
		return target;
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

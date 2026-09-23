/**
 * Small persistent records under ~/.cache/pi-unreal, and their housekeeping.
 *
 * Per-run logs and background job output are disposable after two weeks. Unreal sessions are its conversation
 * memory; they, their command output (sessions/operations/<id>) and ownership records, pasted images and
 * cancellation lists live as long as sessions (60 days since last use). A chat whose session was removed is
 * simply re-seeded from its visible history.
 */
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const DAY = 24 * 60 * 60 * 1000;
export const RETENTION = { runs: 14 * DAY, sessions: 60 * DAY, debugLogBytes: 10 * 1024 * 1024 };

async function removeOlderThan(dir: string, maxAgeMs: number, now: number): Promise<number> {
	let removed = 0;
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return 0;
	}
	for (const name of names) {
		const target = path.join(dir, name);
		try {
			const stat = await fs.lstat(target);
			if (now - stat.mtimeMs > maxAgeMs) {
				await fs.rm(target, { recursive: true, force: true });
				removed++;
			}
		} catch {}
	}
	return removed;
}

/** Remove expired files under the state root. Never throws. Returns how many entries were removed. */
export async function pruneState(root: string, now = Date.now()): Promise<number> {
	let removed = 0;
	for (const dir of ["jobs", "chat"]) removed += await removeOlderThan(path.join(root, dir), RETENTION.runs, now);
	for (const dir of ["images", "cancelled"]) removed += await removeOlderThan(path.join(root, dir), RETENTION.sessions, now);
	// Sessions, then everything that belongs to a session that is gone.
	const sessions = path.join(root, "sessions");
	const live = new Set<string>();
	try {
		for (const name of await fs.readdir(sessions)) {
			if (!name.endsWith(".session.jsonl")) continue;
			const id = name.slice(0, -".session.jsonl".length);
			const file = path.join(sessions, name);
			if (now - (await fs.lstat(file)).mtimeMs > RETENTION.sessions) {
				await fs.rm(file, { force: true });
				removed++;
			} else {
				live.add(id);
			}
		}
		for (const name of await fs.readdir(sessions)) {
			if (!name.endsWith(".owner.json")) continue;
			if (!live.has(name.slice(0, -".owner.json".length))) {
				await fs.rm(path.join(sessions, name), { force: true });
				removed++;
			}
		}
	} catch {}
	try {
		for (const id of await fs.readdir(path.join(sessions, "operations"))) {
			if (live.has(id)) continue;
			const dir = path.join(sessions, "operations", id);
			// A session that is starting has operations before its file settles: leave anything recent alone.
			if (now - (await fs.lstat(dir)).mtimeMs < RETENTION.runs) continue;
			await fs.rm(dir, { recursive: true, force: true });
			removed++;
		}
	} catch {}
	// Keep the debug log bounded: start over once it is too large.
	try {
		const log = path.join(root, "debug.log");
		if ((await fs.stat(log)).size > RETENTION.debugLogBytes) {
			await fs.rename(log, `${log}.old`);
			removed++;
		}
	} catch {}
	return removed;
}

/** Which host chat owns an Unreal session, and the turn it last answered (see context.ts unrealSessionFor). */
export interface SessionOwnership {
	hostSession: string;
	headTurn: string;
	inflightTurn?: string;
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fsSync.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(file: string, value: unknown) {
	fsSync.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const staged = `${file}.${process.pid}.tmp`;
	fsSync.writeFileSync(staged, JSON.stringify(value), { mode: 0o600 });
	fsSync.renameSync(staged, file);
}

export function readOwnership(root: string, unrealSession: string): SessionOwnership | undefined {
	return readJson<SessionOwnership>(path.join(root, "sessions", `${safeName(unrealSession)}.owner.json`));
}

export function writeOwnership(root: string, unrealSession: string, ownership: SessionOwnership | undefined) {
	const file = path.join(root, "sessions", `${safeName(unrealSession)}.owner.json`);
	if (ownership) writeJson(file, ownership);
	else fsSync.rmSync(file, { force: true });
}

/** Where a host chat's pasted images go (pruned together, by last use). */
export function imagesDir(root: string, hostSession: string): string {
	return path.join(root, "images", safeName(hostSession));
}

/** Mark a host chat's records as in use, so pruning (by last use) keeps them while the chat is active. */
export function touchChat(root: string, hostSession: string) {
	const now = new Date();
	for (const target of [path.join(root, "cancelled", `${safeName(hostSession)}.json`), imagesDir(root, hostSession)]) {
		try {
			fsSync.utimesSync(target, now, now);
		} catch {}
	}
}

/** Turns of a host chat that were canceled or dropped; they are never replayed to Unreal. */
export function readCancelled(root: string, hostSession: string): Set<string> {
	return new Set(readJson<string[]>(path.join(root, "cancelled", `${safeName(hostSession)}.json`)) ?? []);
}

export function addCancelled(root: string, hostSession: string, turnIds: readonly string[]) {
	if (turnIds.length === 0) return;
	const ids = readCancelled(root, hostSession);
	for (const id of turnIds) ids.add(id);
	writeJson(path.join(root, "cancelled", `${safeName(hostSession)}.json`), [...ids]);
}

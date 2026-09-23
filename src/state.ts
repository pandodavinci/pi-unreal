/**
 * Housekeeping for ~/.cache/pi-unreal. Per-run logs, background job output, pasted images and Unreal's
 * per-command output files are disposable after a while; Unreal sessions are its conversation memory and
 * are kept longer (a chat whose session was removed is simply re-seeded from its visible history).
 */
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
	for (const dir of ["jobs", "chat", "images"]) removed += await removeOlderThan(path.join(root, dir), RETENTION.runs, now);
	removed += await removeOlderThan(path.join(root, "sessions", "operations"), RETENTION.runs, now);
	try {
		for (const name of await fs.readdir(path.join(root, "sessions"))) {
			if (!name.endsWith(".session.jsonl")) continue;
			const file = path.join(root, "sessions", name);
			const stat = await fs.lstat(file);
			if (now - stat.mtimeMs > RETENTION.sessions) {
				await fs.rm(file, { force: true });
				removed++;
			}
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

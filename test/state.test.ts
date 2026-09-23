import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pruneState, RETENTION } from "../src/state";

test("runs expire after 14 days; sessions and what belongs to them after 60 days of disuse", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-prune-"));
	const day = 24 * 60 * 60 * 1000;
	const age = (target: string, ageMs: number) => {
		const when = new Date(Date.now() - ageMs);
		fs.utimesSync(target, when, when);
		return target;
	};
	const file = (rel: string, ageMs: number) => {
		const target = path.join(root, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "x");
		return age(target, ageMs);
	};
	const dir = (rel: string, ageMs: number) => {
		const target = path.join(root, rel);
		fs.mkdirSync(target, { recursive: true });
		return age(target, ageMs);
	};
	const oldRun = dir("jobs/2026-01-01-u1", 20 * day);
	const newRun = dir("chat/2026-09-20", 1 * day);
	const oldImage = file("images/old.png", 90 * day);
	const keptImage = file("images/kept.png", 20 * day); // may still be referenced by a live session
	const expiredSession = file("sessions/pi-a.session.jsonl", 90 * day);
	const expiredOwner = file("sessions/pi-a.owner.json", 90 * day);
	const expiredOps = dir("sessions/operations/pi-a", 90 * day);
	const liveSession = file("sessions/pi-b.session.jsonl", 20 * day);
	const liveOwner = file("sessions/pi-b.owner.json", 20 * day);
	const liveOps = dir("sessions/operations/pi-b", 20 * day);
	fs.writeFileSync(path.join(root, "debug.log"), Buffer.alloc(RETENTION.debugLogBytes + 1));

	await pruneState(root);
	for (const gone of [oldRun, oldImage, expiredSession, expiredOwner, expiredOps]) expect({ gone, exists: fs.existsSync(gone) }).toEqual({ gone, exists: false });
	for (const kept of [newRun, keptImage, liveSession, liveOwner, liveOps]) expect({ kept, exists: fs.existsSync(kept) }).toEqual({ kept, exists: true });
	expect(fs.existsSync(path.join(root, "debug.log.old"))).toBe(true);
});

test("a missing state directory is fine", async () => {
	expect(await pruneState(path.join(os.tmpdir(), "pi-unreal-does-not-exist"))).toBe(0);
});

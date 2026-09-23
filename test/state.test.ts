import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pruneState, RETENTION } from "../src/state";

test("expired runs, images and command output are removed; recent ones and live sessions are kept", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-prune-"));
	const make = (rel: string, ageMs: number) => {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "x");
		const when = new Date(Date.now() - ageMs);
		fs.utimesSync(file, when, when);
		return file;
	};
	const day = 24 * 60 * 60 * 1000;
	const oldImage = make("images/old.png", 20 * day);
	const newImage = make("images/new.png", 1 * day);
	const oldSession = make("sessions/pi-a.session.jsonl", 90 * day);
	const liveSession = make("sessions/pi-b.session.jsonl", 20 * day);
	fs.utimesSync(path.join(root, "images"), new Date(), new Date());
	const oldJob = path.join(root, "jobs", "2026-01-01-u1");
	fs.mkdirSync(oldJob, { recursive: true });
	fs.utimesSync(oldJob, new Date(Date.now() - 20 * day), new Date(Date.now() - 20 * day));
	fs.writeFileSync(path.join(root, "debug.log"), Buffer.alloc(RETENTION.debugLogBytes + 1));

	await pruneState(root);
	expect(fs.existsSync(oldImage)).toBe(false);
	expect(fs.existsSync(newImage)).toBe(true);
	expect(fs.existsSync(oldSession)).toBe(false);
	expect(fs.existsSync(liveSession)).toBe(true);
	expect(fs.existsSync(oldJob)).toBe(false);
	expect(fs.existsSync(path.join(root, "debug.log"))).toBe(false);
	expect(fs.existsSync(path.join(root, "debug.log.old"))).toBe(true);
});

test("a missing state directory is fine", async () => {
	expect(await pruneState(path.join(os.tmpdir(), "pi-unreal-does-not-exist"))).toBe(0);
});

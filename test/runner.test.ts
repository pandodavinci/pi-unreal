import { afterEach, describe as group, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BridgeEvent } from "../src/events";
import { runUnreal } from "../src/runner";

const FAKE = ["bun", path.join(import.meta.dir, "fake-runner.ts")];
const tmp = () => path.join(os.tmpdir(), `omp-unreal-test-${Math.random().toString(36).slice(2)}`);

function run(mode: string, extra: Partial<Parameters<typeof runUnreal>[0]> = {}, env: Record<string, string> = {}) {
	const events: BridgeEvent[] = [];
	const promise = runUnreal({
		task: "t",
		cwd: os.tmpdir(),
		stateDir: tmp(),
		command: FAKE,
		env: { FAKE_MODE: mode, ...env },
		onEvent: e => events.push(e),
		...extra,
	});
	return { promise, events };
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const leaked: number[] = [];
afterEach(() => {
	for (const pid of leaked.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
});

async function descendantPid(pidfile: string) {
	for (let i = 0; i < 50; i++) {
		const text = await Bun.file(pidfile).text().catch(() => "");
		if (text) {
			leaked.push(Number(text));
			return Number(text);
		}
		await Bun.sleep(50);
	}
	throw new Error("descendant never started");
}

group("runUnreal: outcomes", () => {
	test("streams events and summarizes a successful run", async () => {
		const { promise, events } = run("ok");
		const result = await promise;
		expect(result.status).toBe("completed");
		expect(result.exitCode).toBe(0);
		expect(result.finalText).toBe("All done.");
		expect(result.stats.modelCalls).toBe(2);
		expect(result.stats.toolCalls).toBe(2);
		expect(result.stats.operationsCompleted).toBe(2);
		expect(result.stats.maxConcurrentOperations).toBe(2);
		expect(result.stats.inputTokens).toBe(200);
		expect(result.stats.outputTokens).toBe(40);
		expect(events.map(e => e.kind)).toContain("tool_call");
	});

	test("truncated final response is incomplete, not completed", async () => {
		const result = await run("truncated").promise;
		expect(result.status).toBe("incomplete");
		expect(result.stopReason).toBe("max_output_tokens");
		expect(result.finalText).toBe("Partial answer");
	});

	test("operation failures, non-zero exits and rejections are counted separately", async () => {
		const { promise, events } = run("op-failures");
		const result = await promise;
		expect(result.stats.nonZeroExits).toBe(1);
		expect(result.stats.operationFailures).toBe(1);
		expect(result.stats.toolErrors).toBe(1);
		const image = events.find(e => e.kind === "operation_done" && e.type === "view_image");
		expect(image && image.kind === "operation_done" && image.error).toBe("unsupported image");
	});

	test("structured runner error is reported as failed", async () => {
		const result = await run("error").promise;
		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toBe("model must be set");
	});

	test("crash without error event surfaces exit code and stderr tail", async () => {
		const result = await run("crash").promise;
		expect(result.status).toBe("crashed");
		expect(result.exitCode).toBe(2);
		expect(result.errorMessage).toContain("panic: fake crash");
	});

	test("stderr keeps the tail, so the fatal line survives noisy output", async () => {
		const result = await run("big-stderr").promise;
		expect(result.errorMessage).toContain("FATAL: the real reason");
	});

	test("non-JSON and malformed lines become raw events without breaking the run", async () => {
		const garbage = run("garbage");
		expect((await garbage.promise).status).toBe("completed");
		expect(garbage.events.some(e => e.kind === "raw")).toBe(true);
		// Wrong-typed fields (reasoning Summary as an object) must not throw out of the stream reader.
		const badShape = await run("bad-shape").promise;
		expect(badShape.status).toBe("completed");
		expect(badShape.finalText).toBe("All done.");
	});

	test("streaming partials arrive as events and do not affect stats or the final answer", async () => {
		const { promise, events } = run("partials", { includePartials: true });
		const result = await promise;
		const text = events.flatMap(e => (e.kind === "partial" && e.partialKind === "text" ? [e.delta] : [])).join("");
		expect(text).toBe("All done.");
		expect(events.some(e => e.kind === "partial" && e.partialKind === "reset")).toBe(true);
		expect(result.stats.modelCalls).toBe(2);
		expect(result.finalText).toBe("All done.");
	});

	test("missing binary reports crashed instead of throwing", async () => {
		const result = await run("ok", { command: ["/nonexistent/unreal-agent-runner"] }).promise;
		expect(result.status).toBe("crashed");
		expect(result.errorMessage).toContain("failed to spawn");
	});
});

group("runUnreal: cancellation and cleanup", () => {
	test("events stream before the process exits, abort sends SIGINT → cancelled/130", async () => {
		const controller = new AbortController();
		let firstEventAt = 0;
		const { promise } = run("slow", {
			signal: controller.signal,
			onEvent: () => {
				if (!firstEventAt) {
					firstEventAt = performance.now();
					setTimeout(() => controller.abort(), 300);
				}
			},
		});
		const result = await promise;
		expect(firstEventAt).toBeGreaterThan(0);
		expect(result.status).toBe("cancelled");
		expect(result.exitCode).toBe(130);
		expect(result.stderr).toContain("interrupted");
	});

	test("already-aborted signal never spawns", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await run("ok", { signal: controller.signal }).promise;
		expect(result.status).toBe("cancelled");
		expect(result.exitCode).toBeNull();
	});

	test("runner that ignores SIGINT is SIGKILLed after the grace period", async () => {
		const controller = new AbortController();
		const { promise } = run("stubborn", { signal: controller.signal, killGraceMs: 300 });
		setTimeout(() => controller.abort(), 300);
		const t0 = performance.now();
		const result = await promise;
		expect(result.status).toBe("cancelled");
		expect(result.signalCode).toBe("SIGKILL");
		expect(performance.now() - t0).toBeLessThan(3000);
	});

	test("force signal kills immediately, no grace period", async () => {
		const controller = new AbortController();
		const force = new AbortController();
		const { promise } = run("stubborn", { signal: controller.signal, forceSignal: force.signal, killGraceMs: 60_000 });
		setTimeout(() => {
			controller.abort();
			force.abort();
		}, 300);
		const t0 = performance.now();
		const result = await promise;
		expect(result.status).toBe("cancelled");
		expect(performance.now() - t0).toBeLessThan(2000);
	});

	test("cancel kills descendants in their own process group that the runner leaves behind", async () => {
		const pidfile = tmp();
		const controller = new AbortController();
		const { promise } = run("orphan-slow", { signal: controller.signal }, { FAKE_PIDFILE: pidfile });
		const pid = await descendantPid(pidfile);
		await Bun.sleep(1200); // let the tree poll see it
		controller.abort();
		const result = await promise;
		expect(result.status).toBe("cancelled");
		await Bun.sleep(100);
		expect(alive(pid)).toBe(false);
		expect(result.killedDescendants).toBeGreaterThan(0);
	});

	test("runner crash kills descendants it had started", async () => {
		const pidfile = tmp();
		const { promise } = run("orphan-crash", {}, { FAKE_PIDFILE: pidfile });
		const [result, pid] = await Promise.all([promise, descendantPid(pidfile)]);
		expect(result.status).toBe("crashed");
		await Bun.sleep(100);
		// Guarantee holds for descendants the 1s tree poll observed before the crash.
		expect(alive(pid)).toBe(false);
		expect(result.killedDescendants).toBeGreaterThan(0);
	});
});

group("runUnreal: startup and defaults", () => {
	test("abort while the runner is being resolved still cancels, and nothing starts", async () => {
		const controller = new AbortController();
		const state = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-dl-"));
		// PATH has no runner, so a release download starts (for a version that does not exist).
		const promise = runUnreal({
			task: "t",
			cwd: os.tmpdir(),
			stateDir: tmp(),
			env: { PATH: "/nonexistent", PI_UNREAL_STATE_DIR: state, PI_UNREAL_RUNNER_VERSION: "0.0.0-never" },
			signal: controller.signal,
		});
		// runUnreal is now awaiting the (pending) runner download; abort must win without waiting for it.
		controller.abort();
		const result = await promise;
		expect(result.status).toBe("cancelled");
		expect(result.exitCode).toBeNull();
	});

	test("abort right after the call (before spawn completes) is honored", async () => {
		const controller = new AbortController();
		const { promise } = run("slow", { signal: controller.signal });
		controller.abort();
		const result = await promise;
		expect(result.status).toBe("cancelled");
	});
});

group("runUnreal: host responsiveness", () => {
	// Pi and Oh My Pi run extensions on their UI thread, so a run must not block the event loop.
	test("process-tree polling does not block the event loop", async () => {
		const began = performance.now();
		execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="]);
		const psMs = performance.now() - began;
		const controller = new AbortController();
		const { promise } = run("slow", { signal: controller.signal });
		await Bun.sleep(300);
		// A synchronous `ps` per poll stalls the loop for at least psMs at every poll; random CI noise causes
		// an occasional stall. Count stalls instead of trusting a single worst case.
		const stallMs = Math.max(8, psMs * 0.8);
		let last = performance.now();
		let stalls = 0;
		const timer = setInterval(() => {
			const now = performance.now();
			if (now - last - 2 >= stallMs) stalls++;
			last = now;
		}, 2);
		await Bun.sleep(1500); // six polls
		clearInterval(timer);
		controller.abort();
		await promise;
		expect(stalls).toBeLessThan(3);
	});
});

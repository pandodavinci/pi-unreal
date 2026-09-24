/**
 * Extension behavior against a fake host (both Pi and Oh My Pi shapes), with a fake runner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promptTakenByFlag } from "../src/chat-mode";
import piUnreal from "../src/index";
import { addCancelled, readCancelled } from "../src/state";
import { createFakeHost, fakeRunnerExecutable, waitFor } from "./fake-host";

const saved = { ...process.env };
const argv = process.argv;
beforeEach(() => {
	process.env.PI_UNREAL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-state-"));
	delete process.env.PI_UNREAL_MODE;
	delete process.env.PI_UNREAL_TRUST_DOTENV;
});
afterEach(() => {
	process.env = { ...saved };
	process.argv = argv;
});

async function setup(mode: string, opts: Parameters<typeof createFakeHost>[0] = {}) {
	process.env.UNREAL_AGENT_RUNNER = fakeRunnerExecutable(mode);
	const host = createFakeHost(opts);
	piUnreal(host.pi as never);
	await host.emit("session_start", { reason: "startup" });
	return host;
}

/**
 * Marks that Unreal already has a persisted session for this id, owned by host chat s1 and last answered at
 * `headTurn` (the fake runner writes neither).
 */
function unrealSessionExists(id: string, headTurn?: string) {
	const dir = path.join(process.env.PI_UNREAL_STATE_DIR!, "sessions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${id}.session.jsonl`), "");
	// Without headTurn, keep the ownership record the plugin wrote itself.
	if (headTurn) fs.writeFileSync(path.join(dir, `${id}.owner.json`), JSON.stringify({ hostSession: "s1", headTurn }));
}

const answers = (host: Awaited<ReturnType<typeof setup>>) => host.sent.filter(s => s.message.customType === "unreal-answer");

describe("--unreal mode", () => {
	test("plain input is handled in both hosts' result shapes; slash commands and !bash pass through", async () => {
		const host = await setup("echo", { flags: { unreal: true } });
		expect(await host.emit("input", { text: "hello", source: "interactive" })).toEqual({ action: "handled", handled: true });
		expect(await host.emit("input", { text: "/exit", source: "interactive" })).toBeUndefined();
		expect(await host.emit("input", { text: "!ls", source: "interactive" })).toBeUndefined();
	});

	test("the answer lands in the chat and the host model is never asked to run", async () => {
		const host = await setup("echo", { flags: { unreal: true } });
		await host.emit("input", { text: "hello", source: "interactive" });
		await waitFor(() => answers(host).length === 1);
		const answer = answers(host)[0]!.message;
		expect((answer.details as { body: string }).body).toBe("ECHO:hello");
		// The host model sees the reply labeled as Unreal's.
		expect(String(answer.content)).toBe("[Unreal Agent reply]\nECHO:hello");
		for (const { options } of host.sent) expect(options?.triggerTurn).toBeFalsy();
	});

	test("conversation Pi handled before the switch is given to Unreal, but only once", async () => {
		const host = await setup("echo");
		host.state.branch = [
			{ type: "message", message: { role: "user", content: "design a cache" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "use an LRU" }] } },
			{ type: "custom_message", customType: "unreal-result", content: "[unreal u1] migration failed: column missing" },
		];
		await host.command("harness", "unreal");
		await host.emit("input", { text: "implement that", source: "interactive" });
		await waitFor(() => answers(host).length === 1);
		const first = (answers(host)[0]!.message.details as { body: string }).body;
		expect(first).toContain("design a cache");
		expect(first).toContain("use an LRU");
		expect(first).toContain("migration failed: column missing"); // custom messages count too
		expect(first).toContain("implement that");

		// Unreal now has a session with that answer: the next turn carries nothing old.
		unrealSessionExists("pi-s1");
		await host.emit("input", { text: "next", source: "interactive" });
		await waitFor(() => answers(host).length === 2);
		expect((answers(host)[1]!.message.details as { body: string }).body).toBe("ECHO:next");
	});

	test("a forked chat seeds Unreal's new session with the whole visible history", async () => {
		const host = await setup("echo", { flags: { unreal: true } });
		host.state.sessionId = "fork-1"; // Unreal has no session for this id
		host.state.branch = [
			{ type: "custom_message", customType: "unreal-you", content: "x", details: { text: "we use Postgres", turnId: "old" } },
			{ type: "custom_message", customType: "unreal-answer", content: "x", details: { body: "noted, Postgres", delivered: true } },
		];
		await host.emit("input", { text: "write the schema", source: "interactive" });
		await waitFor(() => answers(host).length === 1);
		const body = (answers(host)[0]!.message.details as { body: string }).body;
		expect(body).toContain("we use Postgres");
		expect(body).toContain("noted, Postgres");
	});

	test("a message that never reached Unreal is passed along with the next one", async () => {
		const host = await setup("echo", { flags: { unreal: true } });
		unrealSessionExists("pi-s1", "t0");
		host.state.branch = [
			{ id: "a0", type: "custom_message", customType: "unreal-answer", content: "x", details: { body: "earlier", delivered: true, turnId: "t0", unrealSession: "pi-s1" } },
			{ id: "y1", type: "custom_message", customType: "unreal-you", content: "x", details: { text: "use port 8080", turnId: "lost" } },
			{ id: "a1", type: "custom_message", customType: "unreal-answer", content: "x", details: { body: "", delivered: false, turnId: "lost" } },
		];
		await host.emit("input", { text: "start the server", source: "interactive" });
		await waitFor(() => answers(host).length === 1);
		const body = (answers(host)[0]!.message.details as { body: string }).body;
		expect(body).toContain("use port 8080");
		expect(body).not.toContain("earlier");
	});

	test("a turn whose runner failed before saving the prompt is not treated as delivered", async () => {
		const host = await setup("error", { flags: { unreal: true } });
		unrealSessionExists("pi-s1", "t-head");
		await host.emit("input", { text: "use port 8080", source: "interactive" });
		await waitFor(() => answers(host).length === 1);
		expect((answers(host)[0]!.message.details as { delivered: boolean }).delivered).toBe(false);
	});

	test("a background result that arrived during a turn reaches Unreal with the next one", async () => {
		const host = await setup("echo", { flags: { unreal: true } });
		unrealSessionExists("pi-s1", "t1");
		host.state.branch = [
			{ id: "a1", type: "custom_message", customType: "unreal-answer", content: "x", details: { body: "prev", delivered: true, turnId: "t0", unrealSession: "pi-s1", contextIds: [] } },
			{ id: "y1", type: "custom_message", customType: "unreal-you", content: "x", details: { text: "current", turnId: "t1" } },
			// Arrived while turn t1 was running, after its context was captured:
			{ id: "r1", type: "custom_message", customType: "unreal-result", content: "[unreal u2] build failed" },
			{ id: "a2", type: "custom_message", customType: "unreal-answer", content: "x", details: { body: "ok", delivered: true, turnId: "t1", unrealSession: "pi-s1", contextIds: [] } },
		];
		await host.emit("input", { text: "fix it", source: "interactive" });
		await waitFor(() => answers(host).length === 1);
		const body = (answers(host)[0]!.message.details as { body: string }).body;
		expect(body).toContain("build failed");
		expect(body).not.toContain("current"); // delivered turn t1 is not repeated
	});

	test("a message sent while the host is still busy reaches neither agent", async () => {
		const host = await setup("echo", { flags: { unreal: true } });
		host.state.idle = false;
		expect(await host.emit("input", { text: "hi", source: "interactive" })).toEqual({ action: "handled", handled: true });
		expect(host.sent).toEqual([]);
		expect(host.notifications.join()).toContain("still finishing");
	});
});

describe("switching harness", () => {
	test("switching to Unreal is refused while Pi is working", async () => {
		const host = await setup("echo");
		host.state.idle = false;
		await host.command("harness", "unreal");
		expect(host.notifications.join()).toContain("Pi is still working");
		host.state.idle = true;
		expect(await host.emit("input", { text: "hi", source: "interactive" })).toBeUndefined();
	});

	test("switching to Pi is refused while Unreal works; Esc stops Unreal", async () => {
		const host = await setup("slow", { flags: { unreal: true } });
		await host.emit("input", { text: "long task", source: "interactive" });
		await Bun.sleep(300);
		await host.command("harness", "pi");
		expect(host.notifications.join()).toContain("Unreal is still working");
		expect(host.pressKey("\x1b")).toBe(true);
		await waitFor(() => answers(host).length === 1);
		expect((answers(host)[0]!.message.details as { status: string }).status).toBe("cancelled");
		// A stopped turn must not look like pending work to the host model after switching back.
		expect(String(answers(host)[0]!.message.content)).toContain("not pending work");
		await host.command("harness", "pi");
		expect(host.notifications.join()).toContain("Messages now go to the built-in harness");
	});

	test("unknown /harness arguments change nothing", async () => {
		const host = await setup("echo", { flags: { unreal: true } });
		await host.command("harness", "piReply with PONG");
		expect(host.notifications.join()).toContain("Unknown harness");
		expect(await host.emit("input", { text: "still unreal", source: "interactive" })).toEqual({ action: "handled", handled: true });
	});
});

describe("session changes", () => {
	test("Esc is re-registered after Oh My Pi drops terminal listeners on /new", async () => {
		const host = await setup("echo", { ohMyPi: true, flags: { unreal: true } });
		expect(host.terminalListeners.size).toBe(1);
		host.terminalListeners.clear(); // what Oh My Pi's prepareSessionSwitch does
		await host.emit("session_switch", {});
		expect(host.terminalListeners.size).toBe(1);
	});
});

describe("background delegation", () => {
	test("in Pi mode a background result wakes the model (aside on Oh My Pi, followUp on Pi)", async () => {
		for (const ohMyPi of [true, false]) {
			const host = await setup("echo", { ohMyPi });
			await host.tool("unreal_delegate").execute("id", { task: "t", background: true }, undefined, undefined, host.ctx);
			await waitFor(() => host.sent.some(s => s.message.customType === "unreal-result"));
			const result = host.sent.find(s => s.message.customType === "unreal-result")!;
			expect(result.options).toEqual(ohMyPi ? { deliverAs: "aside", triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true });
		}
	});

	test("after switching to Unreal mode, a pending background result is shown without waking the model", async () => {
		const host = await setup("echo");
		await host.tool("unreal_delegate").execute("id", { task: "t", background: true }, undefined, undefined, host.ctx);
		await host.command("harness", "unreal");
		await waitFor(() => host.sent.some(s => s.message.customType === "unreal-result"));
		expect(host.sent.find(s => s.message.customType === "unreal-result")!.options).toBeUndefined();
	});

	test("a failed foreground delegation throws, so Pi records a tool error", async () => {
		const host = await setup("error");
		await expect(host.tool("unreal_delegate").execute("id", { task: "t" }, undefined, undefined, host.ctx)).rejects.toThrow("model must be set");
	});
});

describe("host modes", () => {
	test("--unreal turns itself off where the host skips input hooks, and says so", async () => {
		const omp = await setup("echo", { ohMyPi: true, mode: "rpc", flags: { unreal: true } });
		expect(omp.notifications.join()).toContain("needs the interactive terminal");
		expect(await omp.emit("input", { text: "hi", source: "rpc" })).toBeUndefined();
		await omp.command("harness", "unreal");
		expect(await omp.emit("input", { text: "hi", source: "rpc" })).toBeUndefined();
	});

	test("in print mode, where there is no UI, the warning goes to stderr", async () => {
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => written.push(String(chunk)) > 0) as never;
		try {
			await setup("echo", { mode: "print", flags: { unreal: true } });
		} finally {
			process.stderr.write = original;
		}
		expect(written.join()).toContain("needs the interactive terminal");
	});

	test("Pi keeps --unreal in RPC mode; Oh My Pi keeps it in its TUI", async () => {
		const pi = await setup("echo", { mode: "rpc", flags: { unreal: true } });
		expect(await pi.emit("input", { text: "hi", source: "rpc" })).toEqual({ action: "handled", handled: true });
		const omp = await setup("echo", { ohMyPi: true, flags: { unreal: true } });
		expect(await omp.emit("input", { text: "hi", source: "interactive" })).toEqual({ action: "handled", handled: true });
	});

	test("Oh My Pi's command-line prompt (which skips the input hook) is stopped and handed to Unreal", async () => {
		process.argv = [...argv, "fix the tests"];
		const host = await setup("echo", { ohMyPi: true, flags: { unreal: true } });
		host.state.idle = false; // Oh My Pi is mid-setup of its own turn here
		await host.emit("before_agent_start", { prompt: "fix the tests" });
		expect(host.state.aborts).toBe(1);
		await waitFor(() => answers(host).length === 1);
		expect((answers(host)[0]!.message.details as { body: string }).body).toBe("ECHO:fix the tests");
		expect(host.sent.some(s => s.message.customType === "unreal-you")).toBe(true);
	});

	test("pi --unreal \"fix the tests\": the prompt Pi 0.87.1 reads as the flag's value still reaches Unreal, once", async () => {
		process.argv = [...argv.slice(0, 2), "--unreal", "fix the tests"];
		const host = await setup("echo", { flags: { unreal: true } });
		await waitFor(() => answers(host).length === 1);
		expect((answers(host)[0]!.message.details as { body: string }).body).toBe("ECHO:fix the tests");
		// The same text typed right away is a new message, never swallowed.
		await host.emit("input", { text: "fix the tests", source: "interactive" });
		await waitFor(() => answers(host).length === 2);
	});

	test("a command after --unreal is not sent to Unreal: Pi dropped it, so pi-unreal says how to run it", async () => {
		for (const command of ["/exit", "!uname -s"]) {
			process.argv = [...argv.slice(0, 2), "--unreal", command];
			const host = await setup("echo", { flags: { unreal: true } });
			await Bun.sleep(200);
			expect(host.sent.some(s => s.message.customType === "unreal-you")).toBe(false);
			expect(host.notifications.some(n => n.includes(`read "${command}"`) && n.includes("Type it in the chat"))).toBe(true);
		}
	});

	test("Oh My Pi: a command given on the command line is stopped, not sent to Unreal or to the host's model", async () => {
		for (const command of ["/exit", "!ls"]) {
			process.argv = [...argv, command];
			const host = await setup("echo", { ohMyPi: true, flags: { unreal: true } });
			await host.emit("before_agent_start", { prompt: command });
			expect(host.state.aborts).toBe(1);
			await Bun.sleep(200);
			expect(host.sent.some(s => s.message.customType === "unreal-you")).toBe(false);
			expect(host.notifications.some(n => n.includes("Type it in the chat"))).toBe(true);
		}
	});

	test("Oh My Pi reads --unreal as a switch, so nothing is recovered there", async () => {
		process.argv = [...argv.slice(0, 2), "--unreal", "fix the tests"];
		const host = await setup("echo", { ohMyPi: true, flags: { unreal: true } });
		await Bun.sleep(300);
		expect(host.sent.some(s => s.message.customType === "unreal-you")).toBe(false);
	});

	test("Pi's before_agent_start is left alone (its input hook already caught the prompt)", async () => {
		const host = await setup("echo", { flags: { unreal: true } });
		await host.emit("before_agent_start", { prompt: "anything" });
		expect(host.state.aborts).toBe(0);
	});
	// /unreal in print mode (waits for the job and prints the result) is covered end to end in test/e2e-host.mjs.
});

describe("cancellation and branches", () => {
	test("messages dropped with Esc are never replayed to Unreal later", async () => {
		const host = await setup("slow", { flags: { unreal: true } });
		await host.emit("input", { text: "long task", source: "interactive" });
		await host.emit("input", { text: "queued follow-up", source: "interactive" });
		await Bun.sleep(300);
		expect(host.pressKey("\x1b")).toBe(true);
		await waitFor(() => answers(host).length === 1);
		process.env.UNREAL_AGENT_RUNNER = fakeRunnerExecutable("echo");
		await host.emit("input", { text: "something else", source: "interactive" });
		await waitFor(() => answers(host).length === 2);
		const body = (answers(host)[1]!.message.details as { body: string }).body;
		expect(body).not.toContain("queued follow-up");
		expect(body).not.toContain("long task");
	});
});

describe("branches and handoffs", () => {
	test("an answer that finishes after /tree moved elsewhere is not added to the new branch", async () => {
		const host = await setup("slow", { flags: { unreal: true } });
		host.state.branch = [{ id: "root", type: "message", message: { role: "user", content: "start" } }];
		await host.emit("input", { text: "long task", source: "interactive" });
		await Bun.sleep(300);
		host.state.branch = [{ id: "other", type: "message", message: { role: "user", content: "another branch" } }]; // /tree
		expect(host.pressKey("\x1b")).toBe(true);
		await waitFor(() => host.notifications.some(n => n.includes("another chat or branch")));
		expect(answers(host)).toEqual([]);
	});

	test("a queued message typed on a branch the user left is dropped, not run against the new one", async () => {
		const host = await setup("delay", { flags: { unreal: true } });
		host.state.branch = [{ id: "root", type: "message", message: { role: "user", content: "start" } }];
		await host.emit("input", { text: "first", source: "interactive" });
		await host.emit("input", { text: "queued on the old branch", source: "interactive" });
		host.state.branch = [{ id: "other", type: "message", message: { role: "user", content: "another branch" } }]; // /tree
		await waitFor(() => host.notifications.some(n => n.includes("queued message for another branch was dropped")));
		expect(answers(host)).toEqual([]); // neither answer landed on the new branch
		const queued = host.sent.filter(s => s.message.customType === "unreal-you").map(s => (s.message.details as { turnId: string }).turnId)[1]!;
		const cancelled = JSON.parse(fs.readFileSync(path.join(process.env.PI_UNREAL_STATE_DIR!, "cancelled.json"), "utf8"));
		expect(Object.keys(cancelled)).toContain(queued); // never replayed if the user returns to that branch
	});

	test("Oh My Pi: only the command-line prompt is taken over, never other turns (skills, other extensions)", async () => {
		process.argv = [...argv, "startup prompt"];
		const host = await setup("echo", { ohMyPi: true, flags: { unreal: true } });
		await host.emit("input", { text: "/skill:review", source: "interactive" }); // typed: slash commands pass through
		await host.emit("before_agent_start", { prompt: "expanded skill instructions" });
		expect(host.state.aborts).toBe(0);
		const fresh = await setup("echo", { ohMyPi: true, flags: { unreal: true } });
		await fresh.emit("before_agent_start", { prompt: "startup prompt" });
		await fresh.emit("before_agent_start", { prompt: "a later turn" });
		expect(fresh.state.aborts).toBe(1);
		// An extension's own first prompt, not on the command line, is left to the host.
		const extension = await setup("echo", { ohMyPi: true, flags: { unreal: true } });
		await extension.emit("before_agent_start", { prompt: "an extension's workflow prompt" });
		expect(extension.state.aborts).toBe(0);
	});

	test("Oh My Pi: a startup handoff is not delivered into a chat the user switched to meanwhile", async () => {
		process.argv = [...argv, "startup prompt"];
		const host = await setup("echo", { ohMyPi: true, flags: { unreal: true } });
		host.state.idle = false;
		const abort = host.ctx.abort;
		host.ctx.abort = () => {
			host.state.aborts++; // Oh My Pi stays busy for a moment after the abort
		};
		await host.emit("before_agent_start", { prompt: "startup prompt" });
		host.state.sessionId = "s2";
		await host.emit("session_switch", {});
		host.state.idle = true;
		host.ctx.abort = abort;
		await Bun.sleep(300);
		expect(host.sent.filter(s => s.message.customType === "unreal-you")).toEqual([]);
		expect(host.notifications.join()).toContain("could not hand the command-line prompt");
	});

	test("background delegation in print mode runs in the foreground, since the host exits after its answer", async () => {
		const host = await setup("echo", { mode: "print" });
		const result = (await host.tool("unreal_delegate").execute("id", { task: "t", background: true }, undefined, undefined, host.ctx)) as {
			content: { text: string }[];
		};
		expect(result.content[0]!.text).toContain("ECHO:t");
	});
});

describe("review round 7 cases", () => {
	test("/tree back to the entry the message followed (dropping the message) keeps the answer out", async () => {
		const host = await setup("slow", { flags: { unreal: true } });
		host.state.branch = [{ id: "root", type: "message", message: { role: "user", content: "start" } }];
		await host.emit("input", { text: "long task", source: "interactive" });
		await Bun.sleep(300);
		host.state.branch = host.state.branch.slice(0, 1); // back to "root": the message itself is gone from this branch
		expect(host.pressKey("\x1b")).toBe(true);
		await waitFor(() => host.notifications.some(n => n.includes("another chat or branch")));
		expect(answers(host)).toEqual([]);
	});

	test("a fork copies the cancellation marker with the transcript, so a dropped message stays dropped there", async () => {
		const host = await setup("slow", { flags: { unreal: true } });
		await host.emit("input", { text: "long task", source: "interactive" });
		await host.emit("input", { text: "QUEUED-DROPPED", source: "interactive" });
		await Bun.sleep(300);
		expect(host.pressKey("\x1b")).toBe(true);
		await waitFor(() => answers(host).length === 1);
		host.state.sessionId = "fork-1"; // same visible history, new chat id: the per-chat file does not apply
		await host.emit("session_start", { reason: "fork" });
		process.env.UNREAL_AGENT_RUNNER = fakeRunnerExecutable("echo");
		await host.emit("input", { text: "continue", source: "interactive" });
		await waitFor(() => answers(host).length === 2);
		expect((answers(host)[1]!.message.details as { body: string }).body).not.toContain("QUEUED-DROPPED");
	});
});

describe("review round 8 cases", () => {
	const recorded = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

	test("a queued message removed by /tree never runs, even though its parent is still on the branch", async () => {
		const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-rec-")), "prompts");
		process.env.UNREAL_AGENT_RUNNER = fakeRunnerExecutable("delay", record);
		const host = createFakeHost({ flags: { unreal: true } });
		piUnreal(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await host.emit("input", { text: "first A", source: "interactive" });
		await host.emit("input", { text: "second B", source: "interactive" });
		// Back to A's bubble: B's bubble (after it) is no longer on the branch.
		const aBubble = host.state.branch.findIndex(entry => (entry as { details?: { text?: string } }).details?.text === "first A");
		host.state.branch = host.state.branch.slice(0, aBubble + 1);
		await waitFor(() => host.notifications.some(n => n.includes("queued message for another branch was dropped")));
		await Bun.sleep(200);
		expect(recorded(record)).toContain("first A");
		expect(recorded(record)).not.toContain("second B");
	});

	test("forking while a message is queued: the fork never replays the dropped message", async () => {
		process.env.UNREAL_AGENT_RUNNER = fakeRunnerExecutable("delay");
		const host = createFakeHost({ flags: { unreal: true } });
		piUnreal(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await host.emit("input", { text: "first A", source: "interactive" });
		await host.emit("input", { text: "QUEUED-B", source: "interactive" });
		host.state.sessionId = "fork-2"; // fork: same transcript copied, new chat id
		await host.emit("session_start", { reason: "fork" });
		await Bun.sleep(1_200); // A settles
		process.env.UNREAL_AGENT_RUNNER = fakeRunnerExecutable("echo");
		await host.emit("input", { text: "continue", source: "interactive" });
		await waitFor(() => answers(host).some(a => (a.message.details as { body: string }).body.includes("continue")));
		const body = answers(host).map(a => (a.message.details as { body: string }).body).find(b => b.includes("continue"))!;
		expect(body).not.toContain("QUEUED-B");
	});

	test("Oh My Pi: a command-line prompt with @file context (message at the end) is taken over", async () => {
		process.argv = [...argv, "@requirements.md", "implement this"];
		const host = await setup("echo", { ohMyPi: true, flags: { unreal: true } });
		await host.emit("before_agent_start", { prompt: '<file name="requirements.md">be fast</file>\nimplement this' });
		expect(host.state.aborts).toBe(1);
		await waitFor(() => answers(host).length === 1);
		expect((answers(host)[0]!.message.details as { body: string }).body).toContain("implement this");
	});

	test("Oh My Pi: Esc cancels a command-line prompt that is still waiting to be handed over", async () => {
		process.argv = [...argv, "startup prompt"];
		const host = await setup("echo", { ohMyPi: true, flags: { unreal: true } });
		host.state.idle = false;
		host.ctx.abort = () => {
			host.state.aborts++; // stays busy for a moment
		};
		await host.emit("before_agent_start", { prompt: "startup prompt" });
		expect(host.pressKey("\x1b")).toBe(true);
		host.state.idle = true;
		await Bun.sleep(300);
		expect(host.sent.filter(s => s.message.customType === "unreal-you")).toEqual([]);
	});
});

describe("review round 9 cases", () => {
	test("turns never overlap, even while a new message is still landing in the transcript", async () => {
		const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-rec-")), "prompts");
		process.env.UNREAL_AGENT_RUNNER = fakeRunnerExecutable("delay", record);
		const host = createFakeHost({ ohMyPi: true, asyncInsert: true, flags: { unreal: true } });
		piUnreal(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		for (const text of ["one", "two", "three"]) await host.emit("input", { text, source: "interactive" });
		await waitFor(() => answers(host).length === 3, 15_000);
		const bodies = answers(host).map(a => (a.message.details as { body: string }).body);
		expect(bodies.map(body => body.split("\n").at(-1))).toEqual(["one", "two", "three"].map((t, i) => (i === 0 ? `ECHO:${t}` : t)));
		// Strictly one run at a time: start, end, start, end, ...
		const log = fs.readFileSync(record, "utf8").trim().split("\n").map(line => (line.startsWith("start") ? "start" : line));
		expect(log).toEqual(["start", "end", "start", "end", "start", "end"]);
	}, 20_000);

	test("Esc reaches a turn that is still waiting for its message to land", async () => {
		process.env.UNREAL_AGENT_RUNNER = fakeRunnerExecutable("echo");
		const host = createFakeHost({ asyncInsert: true, flags: { unreal: true } });
		piUnreal(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await host.emit("input", { text: "hello", source: "interactive" });
		expect(host.pressKey("\x1b")).toBe(true);
		await waitFor(() => answers(host).length === 1);
		expect((answers(host)[0]!.message.details as { status: string }).status).toBe("cancelled");
	});

	test("cancellations do not expire, and older per-chat files are still honored", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-cancel-"));
		addCancelled(root, ["old"], Date.now() - 400 * 24 * 60 * 60 * 1000);
		fs.mkdirSync(path.join(root, "cancelled"));
		fs.writeFileSync(path.join(root, "cancelled", "s1.json"), JSON.stringify(["legacy"]));
		expect([...readCancelled(root)].sort()).toEqual(["legacy", "old"]);
	});
});

test("promptTakenByFlag: only the argument right after --unreal, and only a message", () => {
	expect(promptTakenByFlag(["--unreal", "fix the tests"])).toBe("fix the tests");
	expect(promptTakenByFlag(["--model", "x", "--unreal", "hi"])).toBe("hi");
	expect(promptTakenByFlag(["--unreal"])).toBeUndefined();
	expect(promptTakenByFlag(["--unreal", "--model", "x"])).toBeUndefined();
	expect(promptTakenByFlag(["--unreal", "@notes.md"])).toBeUndefined();
	expect(promptTakenByFlag(["fix the tests", "--unreal"])).toBeUndefined();
	expect(promptTakenByFlag(["--", "--unreal", "x"])).toBeUndefined();
	expect(promptTakenByFlag(["--unreal", "  "])).toBeUndefined();
});

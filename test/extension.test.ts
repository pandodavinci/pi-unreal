/**
 * Extension behavior against a fake host (both Pi and Oh My Pi shapes), with a fake runner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piUnreal from "../src/index";
import { createFakeHost, fakeRunnerExecutable, waitFor } from "./fake-host";

const saved = { ...process.env };
beforeEach(() => {
	process.env.PI_UNREAL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-state-"));
	delete process.env.PI_UNREAL_MODE;
	delete process.env.PI_UNREAL_TRUST_DOTENV;
});
afterEach(() => {
	process.env = { ...saved };
});

async function setup(mode: string, opts: Parameters<typeof createFakeHost>[0] = {}) {
	process.env.UNREAL_AGENT_RUNNER = fakeRunnerExecutable(mode);
	const host = createFakeHost(opts);
	piUnreal(host.pi as never);
	await host.emit("session_start", { reason: "startup" });
	return host;
}

/** Marks that Unreal already has a persisted session for this id (the fake runner does not write one). */
function unrealSessionExists(id: string) {
	const dir = path.join(process.env.PI_UNREAL_STATE_DIR!, "sessions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${id}.session.jsonl`), "");
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
		host.state.branch = [...host.state.branch, ...host.sent.map(s => ({ type: "custom_message", ...s.message }))];
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
		unrealSessionExists("pi-s1");
		host.state.branch = [
			{ type: "custom_message", customType: "unreal-answer", content: "x", details: { body: "earlier", delivered: true } },
			{ type: "custom_message", customType: "unreal-you", content: "x", details: { text: "use port 8080", turnId: "lost" } },
			{ type: "custom_message", customType: "unreal-answer", content: "x", details: { body: "", delivered: false } },
		];
		await host.emit("input", { text: "start the server", source: "interactive" });
		await waitFor(() => answers(host).length === 1);
		const body = (answers(host)[0]!.message.details as { body: string }).body;
		expect(body).toContain("use port 8080");
		expect(body).not.toContain("earlier");
	});

	test("a turn whose runner failed before saving the prompt is not treated as delivered", async () => {
		const host = await setup("error", { flags: { unreal: true } });
		unrealSessionExists("pi-s1");
		await host.emit("input", { text: "use port 8080", source: "interactive" });
		await waitFor(() => answers(host).length === 1);
		expect((answers(host)[0]!.message.details as { delivered: boolean }).delivered).toBe(false);
	});

	test("a background result that arrived during a turn reaches Unreal with the next one", async () => {
		const host = await setup("echo", { flags: { unreal: true } });
		unrealSessionExists("pi-s1");
		host.state.branch = [
			{ id: "a1", type: "custom_message", customType: "unreal-answer", content: "x", details: { body: "prev", delivered: true, turnId: "t0", contextIds: [] } },
			{ id: "y1", type: "custom_message", customType: "unreal-you", content: "x", details: { text: "current", turnId: "t1" } },
			// Arrived while turn t1 was running, after its context was captured:
			{ id: "r1", type: "custom_message", customType: "unreal-result", content: "[unreal u2] build failed" },
			{ id: "a2", type: "custom_message", customType: "unreal-answer", content: "x", details: { body: "ok", delivered: true, turnId: "t1", contextIds: [] } },
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

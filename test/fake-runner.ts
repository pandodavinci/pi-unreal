/**
 * Test double for unreal-agent-runner. Emits real-shaped JSONL items.
 * Mode comes from FAKE_MODE:
 *   ok | echo | delay (echo after 800ms) | slow | crash | error | garbage | truncated | op-failures | bad-shape | big-stderr | partials
 *   steer         prompt, a running command, then every stdin message (stream_input) for FAKE_STEER_MS
 *                 (default 1500), then answers ECHO:<all messages joined by " | ">. FAKE_IGNORE_STDIN=1: never
 *                 reads stdin, like a run that ends before a message arrives
 *   stubborn      ignores SIGINT (forces the bridge's SIGKILL path)
 *   orphan-crash  starts a descendant in its own process group (like Unreal's Bash), then crashes
 *   orphan-slow   starts such a descendant, then runs until interrupted and exits WITHOUT killing it
 * Descendant pid is written to FAKE_PIDFILE. Mirrors the real runner: SIGINT -> exit 130.
 * FAKE_STREAM_INPUT=1 makes it a runner build with stream_input (listed by -h); without it, a request with
 * stream_input is rejected as an unknown field, like released runners up to v0.2.0.
 */
export {};

const mode = process.env.FAKE_MODE ?? "ok";
const streamInput = process.env.FAKE_STREAM_INPUT === "1";
if (process.argv.includes("-h")) {
	process.stderr.write(`Usage: unreal-agent-runner [options] 'JSON request'\n  include_partial_messages: boolean\n${streamInput ? "  stream_input: boolean\n" : ""}`);
	process.exit(0);
}
type Request = { prompt?: string; messages?: { content: string; message_id?: string }[]; stream_input?: boolean };
const request = JSON.parse(process.argv.at(-1) ?? "{}") as Request;
const prompt = request.prompt ?? request.messages?.[0]?.content;
const promptId = request.messages?.[0]?.message_id ?? "in1";
// FAKE_RECORD: log "start <prompt>" when this runner starts and "end" when it exits (tests assert what ran,
// and that runs never overlap).
const recordLine = async (line: string) => {
	if (!process.env.FAKE_RECORD) return;
	const previous = await Bun.file(process.env.FAKE_RECORD).text().catch(() => "");
	await Bun.write(process.env.FAKE_RECORD, `${previous}${line}\n`);
};
await recordLine(`start ${JSON.stringify(prompt)}${request.messages?.[0]?.message_id ? ` id=${promptId}` : ""}`);
process.on("exit", () => {
	if (!process.env.FAKE_RECORD) return;
	require("node:fs").appendFileSync(process.env.FAKE_RECORD, "end\n");
});
const emit = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);
let seq = 0;
const item = (Kind: string, Data: unknown) => emit({ Sequence: ++seq, Kind, Data });
const usage = { InputTokens: 100, CachedInputTokens: 10, OutputTokens: 20, ReasoningTokens: 5 };

process.on("SIGINT", () => {
	if (mode === "stubborn") return;
	process.stderr.write("fake: interrupted\n");
	process.exit(130);
});

const spawnDescendant = async () => {
	// Own process group, ignores SIGTERM/SIGINT: the worst case the bridge must still clean up.
	const d = Bun.spawn(["/bin/sh", "-c", "trap '' TERM INT; while :; do sleep 1; done"], { detached: true, stdout: "ignore", stderr: "ignore" });
	await Bun.write(process.env.FAKE_PIDFILE!, String(d.pid));
	d.unref();
	await Bun.sleep(1300); // outlive one bridge tree poll (1s)
};

if (request.stream_input && !streamInput) {
	emit({ type: "error", message: 'invalid JSON: unknown object member name "stream_input"' });
	process.exit(1);
}

if (mode === "delay") await Bun.sleep(800); // then behaves like echo

if (mode === "steer") {
	const texts = [prompt];
	const seen = new Set([promptId]);
	item("input", { ID: promptId, Kind: "external", Payload: prompt });
	item("turn", { ID: "t1" });
	item("model_response", {
		Response: { Stop: "complete", Output: [{ Type: "tool_call", Data: { CallID: "c1", Name: "Bash", Arguments: '{"command":"sleep 1"}' } }], Usage: usage },
	});
	item("tool_call_status", { CallID: "c1", Status: { WaitingFor: ["op1"] }, Operations: [{ ID: "op1", Type: "shell", Status: "ready" }] });
	// FAKE_IGNORE_STDIN=1: the run ends without reading what was sent (a message that arrives too late).
	if (request.stream_input && process.env.FAKE_IGNORE_STDIN !== "1") {
		let buffered = "";
		process.stdin.on("data", chunk => {
			buffered += chunk.toString();
			let nl = buffered.indexOf("\n");
			while (nl !== -1) {
				const message = JSON.parse(buffered.slice(0, nl)) as { content: string; message_id: string };
				buffered = buffered.slice(nl + 1);
				nl = buffered.indexOf("\n");
				if (seen.has(message.message_id)) continue;
				seen.add(message.message_id);
				texts.push(message.content);
				item("input", { ID: message.message_id, Kind: "external", Payload: message.content });
			}
		});
	}
	await Bun.sleep(Number(process.env.FAKE_STEER_MS ?? 1500));
	process.stdin.pause();
	item("tool_call_status", {
		CallID: "c1",
		Status: {},
		Operations: [{ ID: "op1", Type: "shell", Status: "completed", State: { Result: { Out: "", ExitCode: 0 } } }],
	});
	item("turn", { ID: "t2" });
	item("model_response", {
		Response: {
			Stop: "complete",
			Output: [{ Type: "message", Data: { Role: "assistant", Text: `ECHO:${texts.join(" | ")}`, Phase: "final_answer" } }],
			Usage: usage,
		},
	});
	process.exit(0);
}

if (mode === "echo" || mode === "delay") {
	// Answers with the exact prompt it was given (the JSON request is the last argument).
	item("input", { ID: promptId, Kind: "external", Payload: prompt });
	item("turn", { ID: "t1" });
	item("model_response", {
		Response: {
			Stop: "complete",
			Output: [{ Type: "message", Data: { Role: "assistant", Text: `ECHO:${prompt}`, Phase: "final_answer" } }],
			Usage: usage,
		},
	});
	process.exit(0);
}

if (mode === "error") {
	process.stderr.write("fake: model must be set\n");
	emit({ type: "error", message: "model must be set" });
	process.exit(1);
}
if (mode === "big-stderr") {
	process.stderr.write(`${"noise line\n".repeat(7000)}FATAL: the real reason\n`);
	process.exit(3);
}

item("turn", { ID: "t1" });
item("model_response", {
	Response: {
		Stop: "complete",
		Output: [
			{ Type: "tool_call", Data: { CallID: "c1", Name: "Bash", Arguments: '{"command":"echo hi"}' } },
			{ Type: "tool_call", Data: { CallID: "c2", Name: "Bash", Arguments: '{"command":"echo yo"}' } },
		],
		Usage: usage,
	},
});
item("tool_call_status", { CallID: "c1", Status: { WaitingFor: ["op1"] }, Operations: [{ ID: "op1", Type: "shell", Status: "ready" }] });
item("tool_call_status", { CallID: "c2", Status: { WaitingFor: ["op2"] }, Operations: [{ ID: "op2", Type: "shell", Status: "ready" }] });

if (mode === "garbage") process.stdout.write("this is not json\n");
if (mode === "bad-shape") item("model_response", { Response: { Output: [{ Type: "reasoning", Data: { Summary: { not: "an array" } } }] } });

if (mode === "crash") {
	process.stderr.write("panic: fake crash\n");
	process.exit(2);
}
if (mode === "orphan-crash") {
	await spawnDescendant();
	process.stderr.write("panic: crashed with a child running\n");
	process.exit(2);
}
if (mode === "slow" || mode === "stubborn" || mode === "orphan-slow") {
	if (mode === "orphan-slow") await spawnDescendant();
	for (let i = 0; ; i++) {
		await Bun.sleep(100);
		item("turn", { ID: `slow-${i}` });
	}
}

if (mode === "op-failures") {
	item("tool_call_status", {
		CallID: "c1",
		Status: {},
		Operations: [{ ID: "op1", Type: "shell", Status: "completed", State: { Result: { Out: "1 fail\n", ExitCode: 1 } } }],
	});
	item("tool_call_status", {
		CallID: "c2",
		Status: {},
		Operations: [{ ID: "op2", Type: "view_image", Status: "completed", State: { Result: { Error: "unsupported image" } } }],
	});
	item("tool_call_status", { CallID: "c3", Status: { Error: "invalid arguments" }, Operations: [] });
} else {
	for (const id of ["op1", "op2"]) {
		item("tool_call_status", {
			CallID: id === "op1" ? "c1" : "c2",
			Status: {},
			Operations: [{ ID: id, Type: "shell", Status: "completed", State: { Result: { Out: "hi\n", ExitCode: 0 } } }],
		});
	}
}
item("turn", { ID: "t2" });
if (mode === "partials") {
	emit({ type: "partial", kind: "reset" });
	emit({ type: "partial", kind: "text", item_id: "m1", delta: "All " });
	emit({ type: "partial", kind: "text", item_id: "m1", delta: "done." });
}
item("model_response", {
	Response: {
		Stop: mode === "truncated" ? "max_output_tokens" : "complete",
		Output: [{ Type: "message", Data: { Role: "assistant", Text: mode === "truncated" ? "Partial answer" : "All done.", Phase: "final_answer" } }],
		Usage: usage,
	},
});

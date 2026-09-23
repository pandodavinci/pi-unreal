/**
 * Test double for unreal-agent-runner. Emits real-shaped JSONL items.
 * Mode comes from FAKE_MODE:
 *   ok | echo | delay (echo after 800ms) | slow | crash | error | garbage | truncated | op-failures | bad-shape | big-stderr | partials
 *   stubborn      ignores SIGINT (forces the bridge's SIGKILL path)
 *   orphan-crash  starts a descendant in its own process group (like Unreal's Bash), then crashes
 *   orphan-slow   starts such a descendant, then runs until interrupted and exits WITHOUT killing it
 * Descendant pid is written to FAKE_PIDFILE. Mirrors the real runner: SIGINT -> exit 130.
 */
export {};

const mode = process.env.FAKE_MODE ?? "ok";
// FAKE_RECORD: log "start <prompt>" when this runner starts and "end" when it exits (tests assert what ran,
// and that runs never overlap).
const recordLine = async (line: string) => {
	if (!process.env.FAKE_RECORD) return;
	const previous = await Bun.file(process.env.FAKE_RECORD).text().catch(() => "");
	await Bun.write(process.env.FAKE_RECORD, `${previous}${line}\n`);
};
await recordLine(`start ${JSON.stringify((JSON.parse(process.argv.at(-1) ?? "{}") as { prompt?: string }).prompt)}`);
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

if (mode === "delay") await Bun.sleep(800); // then behaves like echo

if (mode === "echo" || mode === "delay") {
	// Answers with the exact prompt it was given (the JSON request is the last argument).
	const request = JSON.parse(process.argv.at(-1) ?? "{}") as { prompt?: string; session_id?: string };
	item("input", { ID: "in1", Kind: "external", Payload: request.prompt });
	item("turn", { ID: "t1" });
	item("model_response", {
		Response: {
			Stop: "complete",
			Output: [{ Type: "message", Data: { Role: "assistant", Text: `ECHO:${request.prompt}`, Phase: "final_answer" } }],
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

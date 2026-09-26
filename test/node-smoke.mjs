// Loads the extension on Node through jiti, the loader Pi uses, and checks that it registers.
// Run with: node test/node-smoke.mjs   (CI runs it; bun test cannot catch Node-only failures).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: piUnreal } = await jiti.import("../src/index.ts");

const registered = { commands: [], tools: [], events: [], flags: [] };
piUnreal({
	on: event => registered.events.push(event),
	registerCommand: name => registered.commands.push(name),
	registerTool: tool => registered.tools.push(tool.name),
	registerFlag: name => registered.flags.push(name),
	getFlag: () => undefined,
	registerMessageRenderer: () => {},
	sendMessage: () => {},
});

assert.deepEqual(registered.commands.sort(), ["harness", "unreal", "unreal-cancel", "unreal-jobs", "unreal-say"]);
assert.deepEqual(registered.tools, ["unreal_delegate"]);
assert.deepEqual(registered.flags, ["unreal"]);
for (const event of ["input", "session_start", "session_shutdown"]) assert.ok(registered.events.includes(event), event);

const { runUnreal } = await jiti.import("../src/runner.ts");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-smoke-"));
try {
	const result = await runUnreal({ task: "t", cwd: process.cwd(), stateDir, command: ["/nonexistent/unreal-agent-runner"] });
	assert.equal(result.status, "crashed");
	assert.match(result.errorMessage, /failed to spawn/);
	// A message sent while the runner works goes through Node's child stdin (Pi runs extensions on Node).
	// The runner's -h check and the run itself both read these from the environment.
	Object.assign(process.env, { FAKE_MODE: "steer", FAKE_STREAM_INPUT: "1", FAKE_STEER_MS: "600" });
	const noteId = "8d7c6b5a-4f3e-4d2c-8b1a-0f9e8d7c6b5a";
	const steered = await runUnreal({
		task: "run the tests",
		cwd: process.cwd(),
		stateDir,
		command: ["bun", path.join(import.meta.dirname, "fake-runner.ts")],
		onSteer: send => assert.equal(send?.("skip e2e", noteId), true),
	});
	assert.equal(steered.finalText, "ECHO:run the tests | skip e2e");
	assert.ok(steered.deliveredIds.includes(noteId));
} finally {
	fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log(`node ${process.version}: extension loads and runs on Node`);

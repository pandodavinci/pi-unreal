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

assert.deepEqual(registered.commands.sort(), ["harness", "unreal", "unreal-cancel", "unreal-jobs"]);
assert.deepEqual(registered.tools, ["unreal_delegate"]);
assert.deepEqual(registered.flags, ["unreal"]);
for (const event of ["input", "session_start", "session_shutdown"]) assert.ok(registered.events.includes(event), event);

const { runUnreal } = await jiti.import("../src/runner.ts");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-smoke-"));
try {
	const result = await runUnreal({ task: "t", cwd: process.cwd(), stateDir, command: ["/nonexistent/unreal-agent-runner"] });
	assert.equal(result.status, "crashed");
	assert.match(result.errorMessage, /failed to spawn/);
} finally {
	fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log(`node ${process.version}: extension loads and runs on Node`);

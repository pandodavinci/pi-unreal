// End-to-end: the real Pi (or Oh My Pi) binary in RPC mode, with this plugin loaded in --unreal mode and a
// fake Unreal runner that answers with the prompt it received. No model or network is used.
//
//   node test/e2e-host.mjs            # Pi from devDependencies
//   node test/e2e-host.mjs omp        # Oh My Pi, if `omp` is on PATH (needs Bun >= 1.3.14)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = process.argv[2] ?? "pi";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-e2e-"));

// Fake runner as an executable (UNREAL_AGENT_RUNNER must be a single path).
const runner = path.join(tmp, "unreal-agent-runner");
fs.writeFileSync(runner, `#!/bin/sh\nFAKE_MODE=echo exec bun ${JSON.stringify(path.join(root, "test", "fake-runner.ts"))} "$@"\n`, { mode: 0o755 });
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace);

const command =
	host === "omp"
		? ["omp", "--mode", "rpc", "--no-session", "-e", root, "--unreal"]
		: [path.join(root, "node_modules", ".bin", "pi"), "--mode", "rpc", "--no-session", "-e", root, "--unreal"];

const child = spawn(command[0], command.slice(1), {
	cwd: workspace,
	stdio: ["pipe", "pipe", "pipe"],
	env: {
		...process.env,
		PI_CODING_AGENT_DIR: path.join(tmp, "pi-agent"), // throwaway Pi config, same as a fresh CI machine
		PI_UNREAL_STATE_DIR: path.join(tmp, "state"),
		UNREAL_AGENT_RUNNER: runner,
		// Oh My Pi refuses to start without any model configured. The test never calls one.
		...(host === "omp" && !process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: "sk-e2e-never-used" } : {}),
	},
});

let stderr = "";
child.stderr.on("data", chunk => (stderr += chunk));
const records = [];
const waiters = [];
let buffer = "";
child.stdout.on("data", chunk => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (!line.trim()) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		records.push(record);
		for (const waiter of [...waiters]) waiter();
	}
});

function waitFor(predicate, what, ms = 60_000) {
	return new Promise((resolve, reject) => {
		const check = () => {
			const found = records.find(predicate);
			if (!found) return false;
			clearTimeout(timer);
			waiters.splice(waiters.indexOf(check), 1);
			resolve(found);
			return true;
		};
		const timer = setTimeout(() => {
			waiters.splice(waiters.indexOf(check), 1);
			reject(new Error(`timed out waiting for ${what}\nstderr:\n${stderr}\nrecords:\n${records.map(r => JSON.stringify(r)).join("\n")}`));
		}, ms);
		waiters.push(check);
		check();
	});
}

const send = record => child.stdin.write(`${JSON.stringify(record)}\n`);
const customEnd = type => r => r.type === "message_end" && r.message?.role === "custom" && r.message.customType === type;
const text = message => (typeof message.content === "string" ? message.content : JSON.stringify(message.content));

try {
	await waitFor(r => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "unreal-harness", "the plugin to load");

	if (host === "omp") {
		// Oh My Pi skips extension input hooks outside its terminal UI: the plugin must say so, not pretend.
		await waitFor(
			r => r.type === "extension_ui_request" && r.method === "notify" && /does not pass messages/.test(r.message ?? ""),
			"the RPC-mode warning",
		);
	} else {
		send({ id: "p1", type: "prompt", message: "hello from e2e" });
		await waitFor(r => r.type === "response" && r.id === "p1", "prompt response");
		const you = await waitFor(customEnd("unreal-you"), "the user's message in the transcript");
		assert.match(text(you.message), /hello from e2e/);
		const answer = await waitFor(customEnd("unreal-answer"), "Unreal's answer");
		assert.equal(answer.message.details?.body, "ECHO:hello from e2e");
		assert.equal(answer.message.details?.status, "completed");
		assert.equal(answer.message.details?.delivered, true);
	}

	// Background job through the /unreal command (works in every mode of both hosts).
	send({ id: "p2", type: "prompt", message: "/unreal background task" });
	if (host === "omp") {
		// Oh My Pi does not emit idle extension messages to RPC clients; the plugin notifies instead.
		await waitFor(
			r => r.type === "extension_ui_request" && r.method === "notify" && /ECHO:background task/.test(r.message ?? ""),
			"the background job's result notification",
		);
	} else {
		const result = await waitFor(customEnd("unreal-result"), "the background job's result");
		assert.match(text(result.message), /ECHO:background task/);
		assert.equal(result.message.details?.status, "completed");
	}

	// The host's own agent loop never ran: no model turn was started.
	assert.equal(records.filter(r => r.type === "agent_start").length, 0, "host agent loop started");
	console.log(
		host === "omp"
			? "e2e omp: RPC-mode warning shown, Unreal handled the background job, host agent loop idle"
			: "e2e pi: Unreal handled the chat and the background job, host agent loop idle",
	);
} finally {
	child.kill("SIGTERM");
	fs.rmSync(tmp, { recursive: true, force: true });
}

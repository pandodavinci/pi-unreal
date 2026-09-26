/**
 * Steering against the REAL unreal-agent-runner: a message sent while a command runs must reach the model
 * before that command ends.
 *
 * A local fake Responses API plays the model. Its first answer starts a Bash command that only ends when the
 * model is asked about the steering message, so without steering the run can never finish.
 *
 * Needs a runner with stream_input (UNREAL_AGENT_RUNNER, for example a build of our fork); skipped otherwise,
 * and with PI_UNREAL_SKIP_LIVE=1.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRunner, supportsStreamInput } from "../src/binary";
import { runUnreal } from "../src/runner";

const live = process.env.PI_UNREAL_SKIP_LIVE !== "1";
const runner = live ? await resolveRunner().catch(() => "") : "";
const steerable = runner !== "" && (await supportsStreamInput([runner]));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-steer-"));

const PROMPT_ID = "5b0f4d6e-1c2a-4e8b-9f3d-7a6c5e4b3a21";
const NOTE_ID = "8d7c6b5a-4f3e-4d2c-8b1a-0f9e8d7c6b5a";
const NOTE = "skip the e2e suite";

const sse = (response: object) =>
	new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
const message = (id: string, text: string) =>
	sse({
		id,
		status: "completed",
		output: [{ id: `msg-${id}`, type: "message", status: "completed", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] }],
	});

const workspace = tmpdir();
/** What the model saw of the Bash call when it first saw the steering message. */
let bashWhenSteered: "running" | "finished" | undefined;
let requests = 0;
const model = Bun.serve({
	port: 0,
	async fetch(req) {
		const body = await req.text();
		requests++;
		if (requests === 1) {
			return sse({
				id: "resp-1",
				status: "completed",
				output: [
					{
						id: "fc-1",
						type: "function_call",
						call_id: "call-1",
						name: "Bash",
						arguments: JSON.stringify({ command: "touch started; while [ ! -f release ]; do sleep 0.05; done; echo RELEASED-$((40+2))" }),
						status: "completed",
					},
				],
			});
		}
		// Only the command's output has "RELEASED-42"; its text does not.
		const finished = body.includes("RELEASED-42");
		if (body.includes(NOTE) && bashWhenSteered === undefined) {
			bashWhenSteered = finished ? "finished" : "running";
			fs.writeFileSync(path.join(workspace, "release"), "");
			return message(`resp-${requests}`, "noted");
		}
		return message(`resp-${requests}`, finished ? "done" : "waiting");
	},
});
afterAll(() => model.stop(true));

test.skipIf(!steerable)("real runner: a message sent mid-command reaches the model before the command ends", async () => {
	const force = new AbortController();
	const timeout = setTimeout(() => force.abort(), 20_000);
	const result = await runUnreal({
		task: "run the tests",
		messageId: PROMPT_ID,
		cwd: workspace,
		stateDir: tmpdir(),
		command: [runner],
		forceSignal: force.signal,
		env: {
			UNREAL_HARNESS_LLM_PROVIDER: "openai",
			UNREAL_HARNESS_LLM_MODEL: "fake",
			UNREAL_HARNESS_LLM_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
			UNREAL_HARNESS_LLM_MAX_ATTEMPTS: "1",
			OPENAI_API_KEY: "sk-fake",
			SHELL: "/bin/bash",
		},
		onSteer: send => {
			// Send once the command is running.
			const poll = setInterval(() => {
				if (!fs.existsSync(path.join(workspace, "started"))) return;
				clearInterval(poll);
				expect(send!(NOTE, NOTE_ID)).toBe(true);
			}, 20);
		},
	});
	clearTimeout(timeout);
	expect(result.status).toBe("completed");
	expect(bashWhenSteered).toBe("running");
	expect(result.deliveredIds).toEqual([PROMPT_ID, NOTE_ID]);
	expect(result.finalText).toBe("done");
}, 30_000);

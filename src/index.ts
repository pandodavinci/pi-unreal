/**
 * pi-unreal: Unreal Agent inside Pi and Oh My Pi.
 *
 *   pi --unreal             every message goes to Unreal Agent (chat-mode.ts); /harness unreal|pi toggles
 *   /unreal <task>          run a task in Unreal in the background while you keep chatting
 *   /unreal-jobs            list background jobs and their latest steps
 *   /unreal-cancel [id|all] cancel a background job (SIGINT, then SIGKILL of the whole process tree)
 *   unreal_delegate tool    lets the host's model hand a task to Unreal (foreground or background)
 *
 * Env: UNREAL_HARNESS_LLM_PROVIDER / UNREAL_HARNESS_LLM_MODEL (default openai-codex / gpt-6-astra),
 *      UNREAL_AGENT_RUNNER, PI_UNREAL_STATE_DIR, PI_UNREAL_THINKING, PI_UNREAL_MODE=1, PI_UNREAL_DEBUG=1.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stateRoot as resolveStateRoot } from "./binary";
import { registerChatMode } from "./chat-mode";
import { pruneState } from "./state";
import { type BridgeEvent, describe, emptyStats } from "./events";
import { hostMode, idleMessagesReachClient, safeTimers, tell, wakeModelDelivery, withDeadline } from "./host";
import { formatSummary, runUnreal, type UnrealRunResult } from "./runner";

type Origin = "command" | "tool";

interface Job {
	id: string;
	task: string;
	origin: Origin;
	/** Host session that started the job; results are only delivered back into it. */
	sessionId: string;
	startedAt: number;
	controller: AbortController;
	force: AbortController;
	lines: string[];
	result?: UnrealRunResult;
	done: Promise<UnrealRunResult>;
}

const WIDGET_KEY = "unreal";
const MAX_LINES_PER_JOB = 200;
const MAX_FINISHED_JOBS = 50;
/** Oh My Pi caps session_shutdown handlers at 2s; stay well inside it. */
const SHUTDOWN_GRACE_MS = 900;
const SHUTDOWN_FORCE_WAIT_MS = 500;


export default function piUnreal(pi: ExtensionAPI) {
	const stateRoot = resolveStateRoot();
	const debugEnabled = process.env.PI_UNREAL_DEBUG === "1";
	const debugFile = path.join(stateRoot, "debug.log");
	const jobs = new Map<string, Job>();
	/** Finished command jobs waiting for the host to be idle, so the result shows immediately. */
	const pendingDelivery: Job[] = [];
	let nextId = 1;
	let liveCtx: ExtensionContext | undefined;
	let ticking = false;

	let debugFileReady = false;
	const debug = (scope: string, msg: string) => {
		if (!debugEnabled) return;
		try {
			if (!debugFileReady) {
				// Also tighten a state dir / log created by an older version with default permissions.
				fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
				fs.chmodSync(stateRoot, 0o700);
				fs.appendFileSync(debugFile, "", { mode: 0o600 });
				fs.chmodSync(debugFile, 0o600);
				debugFileReady = true;
			}
			fs.appendFileSync(debugFile, `${new Date().toISOString()} [${scope}] ${msg}\n`);
		} catch {}
	};
	const timers = safeTimers(err => debug("timer", String(err)));

	const chat = registerChatMode(pi, debug);

	const currentSessionId = () => liveCtx?.sessionManager.getSessionId() ?? "";
	const running = () => [...jobs.values()].filter(j => !j.result);
	const elapsed = (j: Job) => `${Math.round((Date.now() - j.startedAt) / 1000)}s`;
	const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

	const refreshUi = () => {
		const ui = liveCtx?.ui;
		if (!ui) return;
		const active = running().filter(j => j.sessionId === currentSessionId());
		if (active.length === 0) {
			ui.setWidget(WIDGET_KEY, undefined);
			ui.setStatus(WIDGET_KEY, undefined);
			return;
		}
		ui.setStatus(WIDGET_KEY, `unreal: ${active.length} running`);
		const perJob = Math.max(1, Math.floor(10 / active.length) - 1);
		const lines: string[] = [];
		for (const job of active) {
			lines.push(`⟳ unreal ${job.id} ${elapsed(job)}  ${clip(job.task, 70)}`);
			for (const line of job.lines.slice(-perJob)) lines.push(`   ${clip(line, 110)}`);
		}
		ui.setWidget(WIDGET_KEY, lines.slice(0, 10));
	};

	const sendResult = (job: Job, result: UnrealRunResult) => {
		const message = {
			customType: "unreal-result",
			content: `[unreal ${job.id}] ${formatSummary(job.task, result)}`,
			display: true,
			details: { jobId: job.id, task: job.task, ...result, stderr: result.stderr.slice(-4000) },
			attribution: "agent",
		} as never;
		// Command jobs: append to the conversation (and model context) without starting a turn; the host is
		// idle here (see deliver), where plain delivery displays immediately in both hosts.
		// Tool jobs: wake the model so it can act on the result, except in Unreal mode, where the host's model
		// must stay idle; there the result is only shown.
		if (job.origin === "tool" && !chat.isUnrealMode()) pi.sendMessage(message, wakeModelDelivery(pi));
		else pi.sendMessage(message);
		// Outside its TUI, Oh My Pi appends such a message without emitting it to the client (oh-my-pi#13014),
		// so show the result as a notification there too.
		if (job.origin === "command" && liveCtx && !idleMessagesReachClient(pi, hostMode(liveCtx))) {
			tell(liveCtx, `[unreal ${job.id}] ${formatSummary(job.task, result)}`, result.status === "completed" ? "info" : "error");
		}
	};

	const flushPending = () => {
		if (!liveCtx?.isIdle()) return;
		while (pendingDelivery.length) {
			const job = pendingDelivery.shift()!;
			if (job.sessionId === currentSessionId()) sendResult(job, job.result!);
		}
	};

	const deliver = (job: Job, result: UnrealRunResult) => {
		const level = result.status === "completed" ? "info" : result.status === "cancelled" ? "warning" : "error";
		liveCtx?.ui.notify(`unreal ${job.id} ${result.status} (${(result.durationMs / 1000).toFixed(0)}s)`, level);
		if (job.sessionId !== currentSessionId()) {
			liveCtx?.ui.notify(`unreal ${job.id} belongs to another session; result kept in /unreal-jobs`, "info");
			return;
		}
		if ((job.origin === "command" || chat.isUnrealMode()) && !liveCtx?.isIdle()) {
			pendingDelivery.push(job);
			return;
		}
		sendResult(job, result);
	};

	/** Keep the most recent finished jobs only. */
	const pruneFinishedJobs = () => {
		const finished = [...jobs.values()].filter(j => j.result);
		for (const j of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) jobs.delete(j.id);
	};

	const startJob = (task: string, origin: Origin, ctx: ExtensionContext, signal?: AbortSignal, onEvent?: (line: string) => void) => {
		liveCtx = ctx;
		const id = `u${nextId++}`;
		const controller = new AbortController();
		const force = new AbortController();
		const forward = () => controller.abort();
		if (signal?.aborted) controller.abort();
		else signal?.addEventListener("abort", forward, { once: true });
		const job: Job = {
			id,
			task,
			origin,
			sessionId: ctx.sessionManager.getSessionId(),
			startedAt: Date.now(),
			controller,
			force,
			lines: [],
			done: undefined as never,
		};
		jobs.set(id, job);
		debug(id, `start origin=${origin} session=${job.sessionId} cwd=${ctx.cwd} task=${JSON.stringify(task)}`);

		job.done = runUnreal({
			task,
			cwd: ctx.cwd,
			stateDir: path.join(stateRoot, "jobs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}`),
			signal: controller.signal,
			forceSignal: force.signal,
			debugLog: msg => debug(id, msg),
			onStatus: message => {
				job.lines.push(`· ${message}`);
				onEvent?.(`· ${message}`);
				refreshUi();
			},
			onEvent: (event: BridgeEvent) => {
				if (event.kind === "partial") return;
				const line = describe(event);
				job.lines.push(line);
				if (job.lines.length > MAX_LINES_PER_JOB) job.lines.shift();
				onEvent?.(line);
				refreshUi();
			},
		})
			.catch(
				(err): UnrealRunResult => ({
					status: "crashed",
					exitCode: null,
					signalCode: null,
					stopReason: "",
					promptPersisted: false,
					finalText: "",
					stats: emptyStats(),
					durationMs: Date.now() - job.startedAt,
					stderr: "",
					errorMessage: err instanceof Error ? err.message : String(err),
					logDir: "",
					killedDescendants: 0,
				}),
			)
			.then(result => {
				job.result = result;
				pruneFinishedJobs();
				signal?.removeEventListener("abort", forward);
				debug(id, `done status=${result.status} exit=${result.exitCode} ${JSON.stringify(result.stats)}`);
				refreshUi();
				return result;
			});

		if (!ticking) {
			ticking = true;
			timers.every(1000, () => {
				flushPending();
				if (running().length) refreshUi();
			});
		}
		refreshUi();
		return job;
	};

	let pruned = false;
	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		if (!pruned) {
			pruned = true;
			// In the background: never delays startup.
			void pruneState(stateRoot).then(removed => removed && debug("state", `pruned ${removed} expired entries`));
		}
	});
	pi.on("agent_end", async (_event, ctx) => {
		liveCtx = ctx;
		flushPending();
	});

	pi.registerCommand("unreal", {
		description: "Run a task in Unreal Agent in the background: /unreal <task>",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /unreal <task>", "warning");
				return;
			}
			const job = startJob(task, "command", ctx);
			const mode = hostMode(ctx);
			if (mode === "print" || mode === "json") {
				// The host exits once this command returns, which would cancel the job: wait for it and print the
				// result. In print mode it is the command's output, so it goes to stdout (fd 1 directly: Pi reroutes
				// extension writes to process.stdout onto stderr there). In JSON mode stdout is the event stream, so
				// it goes to stderr.
				const result = await job.done;
				fs.writeSync(mode === "print" ? 1 : 2, `${formatSummary(job.task, result)}\n`);
				if (result.status !== "completed") process.exitCode = 1;
				return;
			}
			ctx.ui.notify(`unreal ${job.id} started. /unreal-jobs to inspect, /unreal-cancel ${job.id} to stop.`, "info");
			void job.done.then(result => deliver(job, result));
		},
	});

	pi.registerCommand("unreal-jobs", {
		description: "List Unreal Agent background jobs",
		handler: async (_args, ctx) => {
			liveCtx = ctx;
			if (jobs.size === 0) {
				ctx.ui.notify("No unreal jobs yet.", "info");
				return;
			}
			const here = ctx.sessionManager.getSessionId();
			const rows = [...jobs.values()].reverse().map(j => {
				const state = j.result ? `${j.result.status} in ${(j.result.durationMs / 1000).toFixed(1)}s` : `running ${elapsed(j)}`;
				const other = j.sessionId === here ? "" : " (other session)";
				return `${j.id} [${state}]${other} ${clip(j.task, 80)}`;
			});
			const picked = await ctx.ui.select("Unreal jobs: pick one to show it here (Esc to close)", rows);
			const job = picked ? jobs.get(picked.split(" ")[0]!) : undefined;
			if (!job) return;
			if (!job.result) {
				ctx.ui.notify([`unreal ${job.id} is still running:`, ...job.lines.slice(-8)].join("\n"), "info");
				return;
			}
			// Show the full result in this chat, as information only (it does not start a turn).
			pi.sendMessage({
				customType: "unreal-result",
				content: `[unreal ${job.id}] ${formatSummary(job.task, job.result)}${job.result.stderr.trim() ? `\n\nstderr (last lines):\n${job.result.stderr.trim().split("\n").slice(-20).join("\n")}` : ""}`,
				display: true,
				details: { jobId: job.id, task: job.task, ...job.result, stderr: job.result.stderr.slice(-4000) },
				attribution: "agent",
			} as never);
		},
	});

	pi.registerCommand("unreal-cancel", {
		description: "Cancel a running Unreal job: /unreal-cancel [id|all] (default: most recent)",
		handler: async (args, ctx) => {
			liveCtx = ctx;
			const target = args.trim();
			const active = running();
			const victims = target === "all" ? active : target ? active.filter(j => j.id === target) : active.slice(-1);
			if (victims.length === 0) {
				ctx.ui.notify(target ? `No running job ${target}` : "No running unreal jobs.", "warning");
				return;
			}
			for (const j of victims) j.controller.abort();
			ctx.ui.notify(`Cancelling ${victims.map(j => j.id).join(", ")}…`, "info");
		},
	});

	pi.registerTool({
		name: "unreal_delegate",
		label: "Unreal Agent",
		description:
			"Delegate a self-contained coding task to Unreal Agent, a separate async agent harness that works in the current directory with its own Bash tool. " +
			"Use for long multi-step tasks (e.g. run tests, investigate failures, fix them). " +
			"With background=true it returns a job id immediately and the result is delivered later as a message.",
		parameters: Type.Object({
			task: Type.String({ description: "Complete, self-contained instructions for the Unreal agent" }),
			background: Type.Optional(Type.Boolean({ description: "Return immediately and deliver the result later (default false)" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// In print and JSON modes the host exits after its answer and would cancel a background job.
			const mode = hostMode(ctx);
			if (params.background && mode !== "print" && mode !== "json") {
				const job = startJob(params.task, "tool", ctx);
				void job.done.then(result => deliver(job, result));
				return {
					content: [
						{
							type: "text",
							text: `Started unreal job ${job.id} in the background. Its result will arrive as a message. Do not poll or wait for it.`,
						},
					],
					details: { jobId: job.id, background: true },
				};
			}
			const recent: string[] = [];
			const job = startJob(params.task, "tool", ctx, signal, line => {
				recent.push(line);
				if (recent.length > 12) recent.shift();
				onUpdate?.({ content: [{ type: "text", text: recent.join("\n") }], details: { jobId: job.id } });
			});
			const result = await job.done;
			const summary = formatSummary(params.task, result);
			// Pi marks a tool result as failed only when execute throws.
			if (result.status !== "completed") throw new Error(summary);
			return {
				content: [{ type: "text", text: summary }],
				details: { jobId: job.id, ...result, stderr: result.stderr.slice(-4000) },
			};
		},
	});

	pi.on("session_shutdown", async () => {
		timers.clearAll();
		ticking = false;
		const active = running();
		if (active.length === 0) return;
		for (const j of active) j.controller.abort();
		await withDeadline(Promise.all(active.map(j => j.done)), SHUTDOWN_GRACE_MS);
		for (const j of active) if (!j.result) j.force.abort();
		await withDeadline(Promise.all(active.map(j => j.done)), SHUTDOWN_FORCE_WAIT_MS);
	});
}

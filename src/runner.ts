/**
 * Spawns unreal-agent-runner, streams its JSONL stdout as BridgeEvents, captures stderr,
 * and handles cancellation, crashes and process-tree cleanup.
 * No OMP dependencies, so it can be tested and benchmarked standalone.
 *
 * Process model: the runner is spawned detached (own process group). Unreal starts each Bash
 * command in yet another process group, so on cancel/crash we also kill every descendant group
 * we have observed (snapshotted periodically, since orphans lose their parent link once the runner dies).
 */
import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { resolveRunner } from "./binary";
import { inspectDotEnv, pinEnvironment } from "./env";
import { type BridgeEvent, EventMapper, type RunStats } from "./events";

export interface UnrealRunOptions {
	task: string;
	/** Workspace the Unreal agent works in (Bash cwd). */
	cwd: string;
	/** Directory for this run's JSONL log (and session store unless sessionDir is set). */
	stateDir: string;
	/** Resume/create this Unreal session (conversation memory across runs). */
	sessionId?: string;
	/** Shared Unreal session store; required for sessionId to resume across runs. Default <stateDir>/sessions. */
	sessionDir?: string;
	/** Graceful cancel: SIGINT, then SIGKILL of the whole tree after killGraceMs. */
	signal?: AbortSignal;
	/** Immediate hard kill of the whole tree (used for shutdown deadlines). */
	forceSignal?: AbortSignal;
	onEvent?: (event: BridgeEvent, raw: string) => void;
	/** Override argv[0..n] used to launch the runner (tests use a fake runner). */
	command?: string[];
	env?: Record<string, string | undefined>;
	thinkingLevel?: string;
	model?: string;
	/** Ask the runner for streaming {"type":"partial"} previews (needs the partial-messages runner build). */
	includePartials?: boolean;
	killGraceMs?: number;
	debugLog?: (msg: string) => void;
}

/**
 * completed  runner exited 0 and the last model response stopped normally
 * incomplete runner exited 0 but the last response was truncated/refused/failed (see stopReason)
 * failed     runner reported a structured {"type":"error"}
 * cancelled  aborted by the caller
 * crashed    anything else (spawn failure, non-zero exit without error event, stream failure)
 */
export type UnrealRunStatus = "completed" | "incomplete" | "failed" | "cancelled" | "crashed";

export interface UnrealRunResult {
	status: UnrealRunStatus;
	exitCode: number | null;
	signalCode: string | null;
	stopReason: string;
	finalText: string;
	stats: RunStats;
	durationMs: number;
	/** Last STDERR_TAIL bytes of stderr. */
	stderr: string;
	errorMessage?: string;
	/** Session JSONL for this run. Full command output lives under the session store's operations/ dir. */
	logDir: string;
	/** Descendant process groups/pids the bridge had to kill during cleanup. */
	killedDescendants: number;
}

const STDERR_TAIL = 64 * 1024;
const TREE_POLL_MS = 1_000;

interface Proc {
	pid: number;
	pgid: number;
}

/** All live descendants of rootPid (pid + process group). */
export function descendantsOf(rootPid: number): Proc[] {
	const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
	const children = new Map<number, Proc[]>();
	for (const line of out.split("\n")) {
		const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
		if (!pid || ppid === undefined || pgid === undefined) continue;
		const list = children.get(ppid) ?? [];
		list.push({ pid, pgid });
		children.set(ppid, list);
	}
	const result: Proc[] = [];
	const stack = [rootPid];
	while (stack.length) {
		for (const child of children.get(stack.pop()!) ?? []) {
			result.push(child);
			stack.push(child.pid);
		}
	}
	return result;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function runUnreal(opts: UnrealRunOptions): Promise<UnrealRunResult> {
	const started = performance.now();
	const baseEnv = { ...process.env, ...opts.env };
	const debug = opts.debugLog ?? (() => {});
	const logDir = path.join(opts.stateDir, "logs");
	const mapper = new EventMapper();
	const base = { signalCode: null, stopReason: "", finalText: "", stats: mapper.stats, stderr: "", logDir, killedDescendants: 0 };

	if (opts.signal?.aborted || opts.forceSignal?.aborted) {
		return { ...base, status: "cancelled", exitCode: null, durationMs: 0 };
	}

	const dotEnv = inspectDotEnv(opts.cwd);
	if (dotEnv.unpinnable.length) {
		return {
			...base,
			status: "failed",
			exitCode: null,
			durationMs: 0,
			errorMessage: `Refusing to run: ${path.join(opts.cwd, ".env")} sets ${dotEnv.unpinnable.join(", ")}, which Unreal Agent would apply even over your own settings (it reroutes model traffic). Remove it or run from another directory.`,
		};
	}

	const request: Record<string, unknown> = { prompt: opts.task };
	const thinking = opts.thinkingLevel ?? baseEnv.PI_UNREAL_THINKING;
	if (thinking) request.thinking_level = thinking;
	if (opts.model) request.model = opts.model;
	if (opts.sessionId) request.session_id = opts.sessionId;
	if (opts.includePartials) request.include_partial_messages = true;

	let argv: string[];
	try {
		argv = [
			...(opts.command ?? [await resolveRunner(baseEnv, debug)]),
			"-workspace",
			opts.cwd,
			"-session-directory",
			opts.sessionDir ?? path.join(opts.stateDir, "sessions"),
			"-log-directory",
			logDir,
			JSON.stringify(request),
		];
	} catch (err) {
		return {
			...base,
			status: "crashed",
			exitCode: null,
			durationMs: performance.now() - started,
			errorMessage: `unreal-agent-runner unavailable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	// Default to the Codex login (~/.codex/auth.json) unless the caller configured a provider.
	const configured: Record<string, string | undefined> = { ...baseEnv };
	if (!configured.UNREAL_HARNESS_LLM_PROVIDER) {
		configured.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
		configured.UNREAL_HARNESS_LLM_MODEL ??= "gpt-6-astra";
	}
	// Pin credentials, endpoints and shell hooks so the workspace .env cannot override them.
	const env = pinEnvironment(configured);
	debug(`spawn ${JSON.stringify(argv)} provider=${env.UNREAL_HARNESS_LLM_PROVIDER} model=${env.UNREAL_HARNESS_LLM_MODEL}`);

	// Node APIs only: Pi runs extensions on Node, Oh My Pi on the Bun runtime.
	// detached: own process group, so terminal Ctrl-C does not hit it directly and we can signal the group.
	let child: ChildProcessByStdio<null, Readable, Readable>;
	let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	try {
		child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		exited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
		const spawnError = await new Promise<Error | undefined>(resolve => {
			child.once("spawn", () => resolve(undefined));
			child.once("error", resolve);
		});
		if (spawnError) throw spawnError;
	} catch (err) {
		return {
			...base,
			status: "crashed",
			exitCode: null,
			durationMs: performance.now() - started,
			errorMessage: `failed to spawn runner: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const pid = child.pid!;
	debug(`pid=${pid}`);

	// Track descendants while the runner lives; they get reparented (and invisible) once it dies.
	const known = new Map<number, Proc>();
	const snapshot = () => {
		try {
			for (const p of descendantsOf(pid)) known.set(p.pid, p);
		} catch (err) {
			debug(`descendant snapshot failed: ${String(err)}`);
		}
	};
	const treePoll = setInterval(snapshot, TREE_POLL_MS);

	const signalGroup = (sig: NodeJS.Signals) => {
		try {
			process.kill(-pid, sig);
		} catch {
			try {
				child.kill(sig);
			} catch {}
		}
	};
	let killedDescendants = 0;
	const killDescendants = () => {
		snapshot();
		const groups = new Set<number>();
		for (const p of known.values()) {
			if (p.pgid !== pid && p.pgid !== process.pid) groups.add(p.pgid);
		}
		for (const pgid of groups) {
			try {
				process.kill(-pgid, "SIGKILL");
				killedDescendants++;
				debug(`SIGKILL group ${pgid}`);
			} catch {}
		}
		for (const p of known.values()) {
			if (alive(p.pid)) {
				try {
					process.kill(p.pid, "SIGKILL");
					killedDescendants++;
				} catch {}
			}
		}
	};

	let cancelled = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const hardKill = (why: string) => {
		debug(`${why}: SIGKILL tree pid=${pid}`);
		snapshot();
		signalGroup("SIGKILL");
		killDescendants();
	};
	const onAbort = () => {
		if (cancelled) return;
		cancelled = true;
		snapshot();
		debug(`abort: SIGINT pid=${pid}`);
		signalGroup("SIGINT");
		killTimer = setTimeout(() => hardKill("grace elapsed"), opts.killGraceMs ?? 5_000);
	};
	const onForce = () => {
		cancelled = true;
		hardKill("force");
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	opts.forceSignal?.addEventListener("abort", onForce, { once: true });

	let runnerError: string | undefined;
	let streamError: string | undefined;

	const readStdout = async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		const handle = (line: string) => {
			if (!line.trim()) return;
			if (!line.startsWith('{"type":"partial"')) debug(`stdout ${line}`);
			for (const event of mapper.map(line)) {
				if (event.kind === "runner_error") runnerError = event.message;
				if (event.kind === "tool_call") snapshot();
				try {
					opts.onEvent?.(event, line);
				} catch (err) {
					debug(`onEvent threw: ${String(err)}`);
				}
			}
		};
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				handle(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
			}
		}
		buffer += decoder.decode();
		handle(buffer);
	};

	let stderrTail = "";
	const readStderr = async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr) {
			const piece = decoder.decode(chunk, { stream: true });
			debug(`stderr ${piece.trimEnd()}`);
			stderrTail = (stderrTail + piece).slice(-STDERR_TAIL);
		}
	};

	let exitCode: number | null = null;
	let signalCode: string | null = null;
	try {
		const results = await Promise.allSettled([readStdout(), readStderr()]);
		for (const r of results) {
			if (r.status === "rejected") streamError ??= `stream read failed: ${String(r.reason)}`;
		}
		if (streamError) {
			debug(streamError);
			hardKill("stream error");
		}
		const exit = await exited;
		exitCode = exit.code;
		signalCode = exit.signal;
	} finally {
		clearInterval(treePoll);
		clearTimeout(killTimer);
		opts.signal?.removeEventListener("abort", onAbort);
		opts.forceSignal?.removeEventListener("abort", onForce);
	}

	let status: UnrealRunStatus;
	let errorMessage: string | undefined;
	if (cancelled) {
		status = "cancelled";
	} else if (streamError) {
		status = "crashed";
		errorMessage = streamError;
	} else if (exitCode === 0) {
		const stop = mapper.lastStop;
		if (stop === "" || stop === "complete") {
			status = "completed";
		} else {
			status = "incomplete";
			errorMessage = `last model response stopped: ${stop}`;
		}
	} else if (runnerError !== undefined) {
		status = "failed";
		errorMessage = runnerError;
	} else {
		status = "crashed";
		const tail = stderrTail.trim().split("\n").slice(-5).join("\n");
		errorMessage = `runner exited with code ${exitCode}${signalCode ? ` (${signalCode})` : ""}${tail ? `: ${tail}` : ""}`;
	}
	// Unreal's own cleanup of Bash groups is asynchronous and can race its exit; make sure nothing survives.
	if (status !== "completed" && status !== "incomplete") killDescendants();
	debug(`exit code=${exitCode} signal=${signalCode} status=${status} killedDescendants=${killedDescendants}`);

	return {
		status,
		exitCode,
		signalCode,
		stopReason: mapper.lastStop,
		finalText: mapper.finalText,
		stats: mapper.stats,
		durationMs: performance.now() - started,
		stderr: stderrTail,
		errorMessage,
		logDir,
		killedDescendants,
	};
}

export function formatSummary(task: string, result: UnrealRunResult): string {
	const s = result.stats;
	const lines = [
		`Unreal Agent ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s`,
		`Task: ${task}`,
		`model calls=${s.modelCalls} tool calls=${s.toolCalls} ops=${s.operationsCompleted} (peak in flight ${s.maxConcurrentOperations})`,
		`tokens in=${s.inputTokens} (cached ${s.cachedInputTokens}) out=${s.outputTokens} (reasoning ${s.reasoningTokens})`,
	];
	if (s.toolErrors || s.operationFailures || s.nonZeroExits || s.modelFailures) {
		lines.push(
			`tool rejections=${s.toolErrors} op failures=${s.operationFailures} non-zero exits=${s.nonZeroExits} model failures=${s.modelFailures}`,
		);
	}
	if (result.errorMessage) lines.push(`Error: ${result.errorMessage}`);
	lines.push(`Log: ${result.logDir}`);
	if (result.finalText) lines.push("", result.finalText);
	return lines.join("\n");
}

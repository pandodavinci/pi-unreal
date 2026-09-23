/**
 * Minimal stand-in for the Pi / Oh My Pi extension host: records registrations, sent messages and UI calls,
 * and lets tests drive events, commands, tools and terminal input.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Handler = (event: unknown, ctx: FakeContext) => unknown;

export interface Sent {
	message: { customType?: string; content?: unknown; details?: unknown };
	options?: { deliverAs?: string; triggerTurn?: boolean };
}

export interface FakeContext {
	cwd: string;
	mode: "tui" | "rpc" | "json" | "print";
	hasUI: boolean;
	abort(): void;
	isIdle(): boolean;
	sessionManager: { getSessionId(): string; getBranch(): unknown[]; getLeafId(): string | null };
	ui: Record<string, (...args: never[]) => unknown>;
}

export function createFakeHost(
	opts: { ohMyPi?: boolean; flags?: Record<string, boolean>; cwd?: string; mode?: FakeContext["mode"] } = {},
) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const sent: Sent[] = [];
	const notifications: string[] = [];
	const terminalListeners = new Set<(data: string) => unknown>();
	const state = { idle: true, sessionId: "s1", branch: [] as unknown[], aborts: 0 };

	const ctx: FakeContext = {
		cwd: opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-host-")),
		mode: opts.mode ?? "tui",
		hasUI: opts.mode !== "print" && opts.mode !== "json",
		abort: () => {
			state.aborts++;
			state.idle = true;
		},
		isIdle: () => state.idle,
		sessionManager: {
			getSessionId: () => state.sessionId,
			getBranch: () => state.branch,
			getLeafId: () => ((state.branch.at(-1) as { id?: string } | undefined)?.id ?? null),
		},
		ui: {
			notify: ((message: string) => notifications.push(message)) as never,
			setStatus: (() => {}) as never,
			setWidget: (() => {}) as never,
			select: (async () => undefined) as never,
			onTerminalInput: ((listener: (data: string) => unknown) => {
				terminalListeners.add(listener);
				return () => terminalListeners.delete(listener);
			}) as never,
		},
	};

	const pi: Record<string, unknown> = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: FakeContext) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
		registerFlag: () => {},
		getFlag: (name: string) => opts.flags?.[name],
		registerMessageRenderer: () => {},
		// Like both hosts when idle: the message is recorded and appended to the current branch.
		sendMessage: (message: Sent["message"], options?: Sent["options"]) => {
			sent.push({ message, options });
			state.branch.push({ id: `msg-${sent.length}`, type: "custom_message", ...message });
		},
		// Like the hosts: a custom entry on the current branch, never sent to a model.
		appendEntry: (customType: string, data: unknown) => state.branch.push({ id: `entry-${state.branch.length}`, type: "custom", customType, data }),
	};
	if (opts.ohMyPi) pi.zod = {};

	const emit = async (event: string, payload: unknown = {}) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
		return result;
	};

	return {
		pi,
		ctx,
		state,
		sent,
		notifications,
		terminalListeners,
		emit,
		command: (name: string, args = "") => commands.get(name)!.handler(args, ctx),
		tool: (name: string) => tools.get(name)!,
		pressKey: (data: string) => [...terminalListeners].some(listener => (listener(data) as { consume?: boolean } | undefined)?.consume),
	};
}

/** A runner executable (shell wrapper around fake-runner.ts) for UNREAL_AGENT_RUNNER. */
export function fakeRunnerExecutable(mode: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-bin-"));
	const file = path.join(dir, "unreal-agent-runner");
	fs.writeFileSync(file, `#!/bin/sh\nFAKE_MODE=${mode} exec bun ${JSON.stringify(path.join(import.meta.dir, "fake-runner.ts"))} "$@"\n`, { mode: 0o755 });
	return file;
}

export async function waitFor(check: () => boolean, ms = 10_000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await Bun.sleep(20);
	}
}

/**
 * The few places where Pi (@earendil-works/pi-coding-agent) and Oh My Pi differ.
 * Everything else uses the shared extension API; both hosts resolve the
 * `@earendil-works/*` and `typebox` imports for extensions.
 */
import type { ExtensionAPI, InputEventResult } from "@earendil-works/pi-coding-agent";

/** Oh My Pi injects extra helpers (`pi.zod`, `pi.pi`) that upstream Pi does not have. */
export function isOhMyPi(pi: ExtensionAPI): boolean {
	return typeof (pi as unknown as { zod?: unknown }).zod !== "undefined";
}

/** Pi reads `{ action: "handled" }`; Oh My Pi reads `{ handled: true }`. Returning both works in each. */
export function handledInput(): InputEventResult {
	return { action: "handled", handled: true } as InputEventResult;
}

/**
 * Delivery for a background result that should wake the model.
 * Oh My Pi: `aside` (injected at the next step boundary without interrupting a tool batch).
 * Pi: `followUp` (queued after the current run) plus `triggerTurn` when idle.
 */
export function wakeModelDelivery(pi: ExtensionAPI): { deliverAs: "followUp"; triggerTurn: true } {
	return (isOhMyPi(pi) ? { deliverAs: "aside", triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true }) as {
		deliverAs: "followUp";
		triggerTurn: true;
	};
}

/**
 * Timers that never take down the host: a throwing callback is logged instead of becoming an
 * uncaughtException. Cleared by `clearAll()` on session_shutdown.
 */
export function safeTimers(onError: (err: unknown) => void) {
	const timers = new Set<ReturnType<typeof setInterval>>();
	return {
		every(ms: number, fn: () => void) {
			const timer = setInterval(() => {
				try {
					fn();
				} catch (err) {
					onError(err);
				}
			}, ms);
			(timer as { unref?: () => void }).unref?.();
			timers.add(timer);
			return timer;
		},
		clearAll() {
			for (const timer of timers) clearInterval(timer);
			timers.clear();
		},
	};
}

/** Resolves after ms without keeping the process alive. */
export function sleep(ms: number): Promise<undefined> {
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(undefined), ms);
		(timer as { unref?: () => void }).unref?.();
	});
}

export const withDeadline = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, sleep(ms)]);

export type HostMode = "tui" | "rpc" | "json" | "print";

/** The host's run mode. Both hosts expose ctx.mode; older builds without it are interactive. */
export function hostMode(ctx: unknown): HostMode {
	return ((ctx as { mode?: HostMode }).mode ?? "tui") as HostMode;
}

/**
 * Where --unreal can take over typed messages. Pi runs extension input hooks for every prompt, so its TUI and
 * RPC modes work. Oh My Pi runs them only in its TUI (can1357/oh-my-pi#13013). Print and JSON modes exit
 * after one prompt, before an Unreal turn could finish.
 */
export function chatModeSupported(pi: ExtensionAPI, mode: HostMode): boolean {
	return isOhMyPi(pi) ? mode === "tui" : mode === "tui" || mode === "rpc";
}

/** Oh My Pi appends idle extension messages without emitting them outside its TUI (can1357/oh-my-pi#13014). */
export function idleMessagesReachClient(pi: ExtensionAPI, mode: HostMode): boolean {
	return !isOhMyPi(pi) || mode === "tui";
}

/** A warning the user sees in every mode: print and JSON modes have no UI, so it goes to stderr there. */
export function warn(ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }, message: string) {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
	else process.stderr.write(`${message}\n`);
}

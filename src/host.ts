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

/**
 * Oh My Pi only runs extension `input` handlers in its interactive terminal UI; in print, JSON, RPC and ACP
 * modes a prompt goes straight to its agent loop, so --unreal cannot intercept it. Pi runs them in RPC too.
 */
export function ohMyPiSkipsInputHooks(pi: ExtensionAPI, argv: readonly string[] = process.argv): boolean {
	if (!isOhMyPi(pi)) return false;
	const args = argv.slice(2);
	if (args[0] === "acp") return true;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "-p" || arg === "--print") return true;
		const mode = arg === "--mode" ? args[i + 1] : arg.startsWith("--mode=") ? arg.slice("--mode=".length) : undefined;
		if (mode !== undefined && mode !== "text") return true;
	}
	return false;
}

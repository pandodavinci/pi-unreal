/**
 * Unreal chat mode: every message you type goes to Unreal Agent instead of the host's own agent loop.
 * Pi / Oh My Pi is only the terminal UI while this mode is on.
 *
 * - Plain messages are intercepted in the `input` hook (handled), so the host's harness never runs. Oh My Pi
 *   skips that hook for a prompt given on its command line, so its turn is stopped in `before_agent_start`
 *   and the prompt goes to Unreal instead.
 * - Slash commands (/exit, /new, /harness, ...) and !bash still go to the host.
 * - Unreal keeps a persisted session per conversation branch, so it remembers the conversation; /new, a fork
 *   or going back with /tree starts a fresh one, seeded with the visible history.
 * - Esc cancels the running Unreal turn and the queued ones. Messages sent while it runs are queued.
 * - Replies stream live (runner include_partial_messages) in a widget, then land in the transcript.
 * - Pasted images are saved to files and handed to Unreal's ViewImage tool by absolute path.
 *
 * Start with `pi --unreal` (or PI_UNREAL_MODE=1). Toggle any time: /harness unreal | pi
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { stateRoot as resolveStateRoot } from "./binary";
import {
	ANSWER_TYPE,
	type AnswerDetails,
	CANCELLED_TYPE,
	type Entry,
	USER_TYPE,
	type UserDetails,
	unrealSessionFor,
	unseenContext,
} from "./context";
import { inspectDotEnv } from "./env";
import { describe } from "./events";
import { chatModeSupported, handledInput, hostMode, isOhMyPi, safeTimers, warn, SHUTDOWN_FORCE_WAIT_MS, SHUTDOWN_GRACE_MS, withDeadline } from "./host";
import { runnerModel, runUnreal } from "./runner";
import { addCancelled, imagesDir, readCancelled, readOwnership, touchChat, writeOwnership } from "./state";

const WIDGET_KEY = "unreal-chat";
const STATUS_KEY = "unreal-harness";
const ESC_SEQUENCES = new Set(["\x1b", "\x1b[27u", "\x1b[27;1u"]);
/** Cap on conversation carried over to Unreal as context. */
const MAX_CONTEXT_CHARS = 12_000;
const UNSUPPORTED_MODE =
	"pi-unreal: --unreal needs the interactive terminal (or Pi's RPC mode); in this mode messages go to the built-in model. /unreal <task> and the unreal_delegate tool still work.";

type ImageContent = NonNullable<InputEvent["images"]>[number];

interface Turn {
	id: string;
	text: string;
	images: string[];
	/** Host session the message was typed in; the answer is only posted there. */
	hostSession: string;
	/** Host entry the message followed. If the user moves to a branch without it (/tree), the turn is dropped. */
	parentEntry: string | null;
}

interface LiveView {
	requestRender(): void;
	setHeader(text: string): void;
	setSteps(text: string): void;
	setBody(text: string): void;
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * The command-line argument this prompt came from, if any. Oh My Pi builds its startup prompt as
 * [piped stdin + "\n"] + [@file contents] + first message, so the message argument is the prompt or ends it.
 * Flags ("-...") and file references ("@...") are not messages; each argument is taken over once. A one-word
 * message after @file context is not recognized (it could be a flag's value); type such prompts in the chat.
 */
export function commandLinePromptArg(prompt: string, args: readonly string[], taken: ReadonlySet<string>): string | undefined {
	if (!prompt) return undefined;
	return args
		.map(arg => arg.trim())
		.find(
			arg =>
				arg &&
				!arg.startsWith("-") &&
				!arg.startsWith("@") &&
				!taken.has(arg) &&
				// A one-word argument could be a flag's value ("--thinking high"): only an exact match counts then.
				(prompt === arg || (/\s/.test(arg) && prompt.endsWith(arg))),
		);
}

/**
 * The prompt Pi dropped from `pi --unreal "fix the tests"`: Pi 0.87.1 parses extension flags before any
 * extension has registered them, so it reads the argument after an unknown flag as that flag's value.
 * Oh My Pi knows its extensions' flags when it parses, so this applies to Pi only.
 */
export function promptTakenByFlag(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--") return undefined;
		if (args[i] !== "--unreal") continue;
		const next = args[i + 1];
		return next !== undefined && next.trim() && !next.startsWith("-") && !next.startsWith("@") ? next.trim() : undefined;
	}
	return undefined;
}

export function registerChatMode(pi: ExtensionAPI, debug: (scope: string, msg: string) => void): { isUnrealMode(): boolean } {
	const stateRoot = resolveStateRoot();
	const { provider, model } = runnerModel();

	pi.registerFlag("unreal", { description: "Send every message to Unreal Agent (pi-unreal)", type: "boolean", default: false });
	let enabled = process.env.PI_UNREAL_MODE === "1";
	let flagApplied = false;
	const dotEnvNoticeShown = new Set<string>();
	const timers = safeTimers(err => debug("chat", `timer error: ${String(err)}`));
	let liveCtx: ExtensionContext | undefined;
	let unsubscribeKeys: (() => void) | undefined;
	const queue: Turn[] = [];
	let shuttingDown = false;
	/** Oh My Pi's command-line prompt skips the input hook; only that first prompt is taken over (see below). */
	let sawTypedInput = false;
	/** Command-line arguments already taken over as prompts. */
	const takenOverArgs = new Set<string>();
	let pendingHandoff: { cancelled: boolean } | undefined;
	/** The turn being processed, from the moment the pump takes it (so Esc and shutdown can always reach it). */
	let active:
		| {
				turn: Turn;
				controller: AbortController;
				force: AbortController;
				/** Set once the runner starts. */
				done?: Promise<unknown>;
				startedAt: number;
				steps: string[];
				/** Streaming preview of the message currently being written. */
				liveText: string;
				liveItem: string;
				thinking: string;
		  }
		| undefined;
	let ticker = false;
	let view: LiveView | undefined;
	let renderQueued = false;

	const showStatus = () => {
		liveCtx?.ui.setStatus(
			STATUS_KEY,
			enabled ? `harness: unreal (${model || provider})${active ? " · working, Esc to stop" : ""}${queue.length ? ` · ${queue.length} queued` : ""}` : "harness: pi",
		);
	};

	const clip = (text: string, n: number) => {
		const flat = text.replace(/\s+/g, " ").trim();
		return flat.length > n ? `…${flat.slice(-n)}` : flat;
	};

	/** Live widget: header, recent steps, and the reply streaming in as Markdown. */
	const mountView = () => {
		liveCtx?.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			const box = new Container();
			const header = new Text("", 1, 0);
			const steps = new Text("", 3, 0);
			const body = new Markdown("", 1, 0, getMarkdownTheme());
			box.addChild(header);
			box.addChild(steps);
			box.addChild(body);
			view = {
				requestRender: () => tui.requestRender(),
				setHeader: t => header.setText(theme.fg("accent", t)),
				setSteps: t => steps.setText(theme.fg("dim", t)),
				setBody: t => body.setText(t),
			};
			return Object.assign(box, { dispose: () => (view = undefined) });
		});
	};

	const renderView = () => {
		if (!active || !view) return;
		const secs = Math.round((Date.now() - active.startedAt) / 1000);
		const thinking = active.thinking ? `  ${clip(active.thinking, 80)}` : "";
		view.setHeader(`⟳ unreal ${secs}s  (Esc to stop)${thinking}`);
		view.setSteps(active.steps.slice(-4).map(s => (s.length > 120 ? `${s.slice(0, 119)}…` : s)).join("\n"));
		view.setBody(active.liveText);
		view.requestRender();
	};

	/** Coalesce bursts of token deltas into at most one repaint per 50ms. */
	const showProgress = () => {
		if (!active) {
			liveCtx?.ui.setWidget(WIDGET_KEY, undefined);
			view = undefined;
			return;
		}
		if (!view) mountView();
		if (renderQueued) return;
		renderQueued = true;
		setTimeout(() => {
			renderQueued = false;
			renderView();
		}, 50);
	};

	pi.registerMessageRenderer<UserDetails>(USER_TYPE, (message, _opts, theme) => {
		const box = new Container();
		const text = message.details?.text ?? String(message.content);
		box.addChild(new Spacer(1));
		box.addChild(new Text(`${theme.fg("accent", theme.bold("you ›"))} ${text}`, 1, 0));
		return box;
	});

	pi.registerMessageRenderer<AnswerDetails>(ANSWER_TYPE, (message, opts, theme) => {
		const d = message.details;
		const box = new Container();
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("accent", theme.bold("unreal ›")), 1, 0));
		const body = d?.body ?? (typeof message.content === "string" ? message.content : "");
		if (body) box.addChild(new Markdown(body, 1, 0, getMarkdownTheme()));
		if (d?.error) box.addChild(new Text(theme.fg("error", d.error), 1, 0));
		if (d?.footer) box.addChild(new Text(theme.fg("dim", d.footer + (opts.expanded ? "" : "  (Ctrl+O: steps)")), 1, 0));
		if (opts.expanded && d?.steps.length) box.addChild(new Text(theme.fg("dim", d.steps.join("\n")), 3, 0));
		return box;
	});

	const post = (customType: string, content: string, details?: unknown) =>
		// The host is idle in this mode; with no delivery options both Pi and Oh My Pi append the message to the
		// transcript immediately without starting a turn. (Pi's `nextTurn` would hide it until the next prompt.)
		pi.sendMessage({ customType, content, display: true, details, attribution: "agent" } as never);

	const branchOf = (ctx: ExtensionContext): Entry[] => {
		try {
			return ctx.sessionManager.getBranch() as Entry[];
		} catch {
			return [];
		}
	};

	/**
	 * Persist that these turns were canceled or dropped, so they are never replayed to Unreal as context: in a
	 * per-chat file (any branch, survives restarts) and, for the current chat, in the transcript itself, which
	 * the host copies when the chat is forked.
	 */
	const markCancelled = (turns: readonly Turn[]) => {
		if (turns.length === 0) return;
		try {
			addCancelled(stateRoot, turns.map(turn => turn.id));
		} catch (err) {
			debug("chat", `recording canceled turns failed: ${String(err)}`);
		}
		// Also in the transcript shown now, if it contains any of those messages (for instance a fork that just
		// copied them): the marker travels with the transcript even without this machine's state.
		const ctx = liveCtx;
		const onBranch = ctx && !shuttingDown ? turns.filter(turn => bubbleOnBranch(ctx, turn)) : [];
		if (onBranch.length === 0) return;
		try {
			pi.appendEntry(CANCELLED_TYPE, { turnIds: onBranch.map(turn => turn.id) });
		} catch (err) {
			debug("chat", `recording canceled turns failed: ${String(err)}`);
		}
	};

	/** The transcript bubble of a turn, if it is on the current branch. */
	const bubbleOnBranch = (ctx: ExtensionContext, turn: Turn) =>
		branchOf(ctx).some(entry => entry.customType === USER_TYPE && (entry.details as Partial<UserDetails> | undefined)?.turnId === turn.id);

	/** Whether the entry the turn followed is still on the current branch (false after /tree elsewhere). */
	const onCurrentBranch = (ctx: ExtensionContext, turn: Turn) =>
		turn.parentEntry === null || branchOf(ctx).some(entry => entry.id === turn.parentEntry);

	const runTurn = async (turn: Turn) => {
		const ctx = liveCtx!;
		const controller = new AbortController();
		const force = new AbortController();
		const steps: string[] = [];
		const startedAt = Date.now();
		active = { turn, controller, force, startedAt, steps, liveText: "", liveItem: "", thinking: "" };
		try {
			await processTurn(ctx, turn, active);
		} finally {
			active = undefined;
			showProgress();
			showStatus();
		}
	};

	const processTurn = async (ctx: ExtensionContext, turn: Turn, current: NonNullable<typeof active>) => {
		const { controller, force, steps, startedAt } = current;
		if (process.env.PI_UNREAL_TRUST_DOTENV === "1" && !dotEnvNoticeShown.has(ctx.cwd)) {
			dotEnvNoticeShown.add(ctx.cwd);
			const dotEnv = inspectDotEnv(ctx.cwd);
			if (dotEnv.exists && dotEnv.names.length > 0) {
				ctx.ui.notify(
					`This folder has a .env (${dotEnv.names.length} vars). PI_UNREAL_TRUST_DOTENV=1: Unreal Agent will load it; model credentials and endpoints stay pinned.`,
					"info",
				);
			}
		}
		// Only run a message that is still in the conversation shown (a brand-new one may take a moment to land).
		if (turn.hostSession === ctx.sessionManager.getSessionId() && onCurrentBranch(ctx, turn)) {
			const deadline = Date.now() + 1_000;
			while (!bubbleOnBranch(ctx, turn) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
		}
		if (turn.hostSession !== ctx.sessionManager.getSessionId() || !bubbleOnBranch(ctx, turn)) {
			// Typed on a branch the user has since left: never run it against another conversation.
			markCancelled([turn]);
			ctx.ui.notify("A queued message for another branch was dropped.", "info");
			return;
		}
		const branch = branchOf(ctx);
		const hostSession = ctx.sessionManager.getSessionId();
		const unrealSession = unrealSessionFor(
			branch,
			hostSession,
			id => readOwnership(stateRoot, id),
			() => `pi-${hostSession}-${randomUUID().slice(0, 8)}`,
		);
		touchChat(stateRoot, hostSession);
		const previousOwner = readOwnership(stateRoot, unrealSession);
		const recordOwner = (owner: Parameters<typeof writeOwnership>[2]) => {
			try {
				writeOwnership(stateRoot, unrealSession, owner);
			} catch (err) {
				debug("chat", `writing session ownership failed: ${String(err)}`);
			}
		};
		// Recorded before the run: if the host dies mid-turn, the next turn will not trust this session.
		recordOwner({ hostSession, headTurn: previousOwner?.headTurn ?? "", inflightTurn: turn.id });
		const context = unseenContext(branch, {
			unrealSession,
			unrealHasSession: fs.existsSync(path.join(stateRoot, "sessions", `${unrealSession}.session.jsonl`)),
			pendingTurns: new Set([turn.id, ...queue.map(queued => queued.id)]),
			cancelledTurns: readCancelled(stateRoot),
			maxChars: MAX_CONTEXT_CHARS,
		});
		const done = runUnreal({
			task: withContext(context.text, withImages(turn.text, turn.images)),
			cwd: ctx.cwd,
			stateDir: path.join(stateRoot, "chat", `${new Date().toISOString().replace(/[:.]/g, "-")}`),
			sessionId: unrealSession,
			sessionDir: path.join(stateRoot, "sessions"),
			includePartials: true,
			signal: controller.signal,
			forceSignal: force.signal,
			debugLog: msg => debug("chat", msg),
			onStatus: message => {
				steps.push(`· ${message}`);
				showProgress();
			},
			onEvent: event => {
				const live = current;
				if (event.kind === "partial") {
					if (event.partialKind === "reset") {
						live.liveText = "";
						live.liveItem = "";
						live.thinking = "";
					} else if (event.partialKind === "reasoning") {
						live.thinking += event.delta;
					} else {
						if (event.itemId !== live.liveItem) {
							live.liveItem = event.itemId;
							live.liveText = "";
						}
						live.liveText += event.delta;
					}
				} else {
					// A completed response replaces the preview; its text shows up as a step (or the final answer).
					if (event.kind === "text" || event.kind === "tool_call") {
						live.liveText = "";
						live.thinking = "";
					}
					steps.push(describe(event));
				}
				showProgress();
			},
		});
		current.done = done;
		showStatus();
		showProgress();
		const result = await done;
		showProgress();
		if (result.dotEnvEmpty?.length && !dotEnvNoticeShown.has(ctx.cwd)) {
			dotEnvNoticeShown.add(ctx.cwd);
			ctx.ui.notify(
				`Unreal's commands see this folder's .env variables as empty (${result.dotEnvEmpty.length}): pi-unreal gives them back only for bash and zsh. Set PI_UNREAL_TRUST_DOTENV=1 if you trust this repo.`,
				"info",
			);
		}

		// A turn that never reached Unreal's session leaves it where it was.
		recordOwner(result.promptPersisted ? { hostSession, headTurn: turn.id } : previousOwner);
		// Record a cancellation before anything else, even if the answer is not added to this chat below.
		if (result.status === "cancelled") markCancelled([turn]);
		const s = result.stats;
		const footer = [
			result.status === "completed" ? null : result.status,
			`${(result.durationMs / 1000).toFixed(1)}s`,
			`${s.modelCalls} model calls`,
			`${s.toolCalls} tool calls`,
			`${k(s.inputTokens)} in / ${k(s.outputTokens)} out`,
		]
			.filter(Boolean)
			.join(" · ");
		const error = result.status === "completed" || result.status === "cancelled" ? undefined : result.errorMessage;
		const body = result.finalText || (result.status === "cancelled" ? "_stopped_" : "");
		// Different chat or branch now (/new, /resume, /tree while running): only add the answer where its
		// question is.
		if (!liveCtx || turn.hostSession !== liveCtx.sessionManager.getSessionId() || !bubbleOnBranch(liveCtx, turn)) {
			liveCtx?.ui.notify(`Unreal's answer belongs to another chat or branch and was not added here (${result.status}).`, "info");
			return;
		}
		// These messages are also in the host model's context (e.g. after /harness pi). Label them so it knows
		// Unreal already handled them and does not pick up a stopped request as unfinished work.
		const forModel =
			result.status === "cancelled"
				? "[Unreal Agent: the user stopped this turn. It is not pending work.]"
				: `[Unreal Agent reply${result.status === "completed" ? "" : `, ${result.status}`}]\n${body || error || ""}`;
		post(ANSWER_TYPE, forModel, {
			body,
			delivered: result.promptPersisted,
			turnId: turn.id,
			unrealSession,
			contextIds: result.promptPersisted ? context.ids : [],
			status: result.status,
			footer,
			steps,
			error,
		} satisfies AnswerDetails);
	};

	/** One pump at a time: turns never overlap, including a turn's wait for its message to land. */
	let pumping = false;
	const pump = async () => {
		if (pumping) return;
		pumping = true;
		try {
			while (queue.length && enabled) {
				const turn = queue.shift()!;
				showStatus();
				try {
					await runTurn(turn);
				} catch (err) {
					liveCtx?.ui.notify(`unreal turn failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			}
		} finally {
			pumping = false;
			showStatus();
		}
	};

	/** Unreal's request only takes text; its ViewImage tool reads files by absolute path. */
	const saveImages = async (images: ImageContent[], hostSession: string) => {
		const dir = imagesDir(stateRoot, hostSession);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const paths: string[] = [];
		for (const [i, image] of images.entries()) {
			const file = path.join(dir, `${stamp}-${i + 1}.${IMAGE_EXT[image.mimeType] ?? "png"}`);
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fs.chmodSync(dir, 0o700);
			fs.writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
			paths.push(file);
		}
		return paths;
	};
	const withImages = (text: string, paths: string[]) =>
		paths.length
			? `${text}\n\nThe user attached ${paths.length} image(s). Look at them with the ViewImage tool before answering:\n${paths.map(p => `- ${p}`).join("\n")}`
			: text;
	const withContext = (context: string, text: string) =>
		context
			? `Earlier in this chat, not yet in your session (some of it handled by another agent, Pi). Use it as context:\n\n${context}\n\n---\n\n${text}`
			: text;

	const untilIdle = async (ctx: ExtensionContext, timeoutMs = 10_000): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		while (!ctx.isIdle()) {
			if (Date.now() > deadline) return false;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		return true;
	};

	/** Show the message in the transcript and queue it for Unreal. */
	const route = async (ctx: ExtensionContext, text: string, images: ImageContent[] | undefined) => {
		const parentEntry = ctx.sessionManager.getLeafId();
		const saved = images?.length ? await saveImages(images, ctx.sessionManager.getSessionId()) : [];
		const shown = saved.length ? `${text}  [${saved.length} image${saved.length > 1 ? "s" : ""}]` : text;
		const turnId = randomUUID();
		post(USER_TYPE, `[User message sent to Unreal Agent, which handles it]\n${shown}`, { text: shown, turnId } satisfies UserDetails);
		queue.push({ id: turnId, text, images: saved, hostSession: ctx.sessionManager.getSessionId(), parentEntry });
		void pump();
	};

	const stopActive = (ctx: ExtensionContext) => {
		if (!active) return false;
		active.controller.abort();
		markCancelled(queue);
		queue.length = 0;
		ctx.ui.notify("Stopping unreal…", "info");
		return true;
	};

	const bind = (ctx: ExtensionContext) => {
		liveCtx = ctx;
		if (!flagApplied) {
			flagApplied = true;
			if (pi.getFlag("unreal") === true) enabled = true;
			if (enabled && !chatModeSupported(pi, hostMode(ctx))) {
				// Say so instead of letting the host's own model answer while the status claims Unreal.
				enabled = false;
				warn(ctx, UNSUPPORTED_MODE);
			}
			const swallowed = enabled && !isOhMyPi(pi) && hostMode(ctx) === "tui" ? promptTakenByFlag(process.argv.slice(2)) : undefined;
			if (swallowed && (swallowed.startsWith("/") || swallowed.startsWith("!"))) {
				// A command is Pi's to run, which only happens when typed in the chat.
				warn(ctx, `Pi read "${swallowed}" as the value of --unreal and dropped it. Type it in the chat instead.`);
			} else if (swallowed) {
				void route(ctx, swallowed, undefined);
			}
		}
		if (!unsubscribeKeys && ctx.hasUI) {
			// Re-registered after every session change: Oh My Pi drops terminal listeners on /new and /resume.
			unsubscribeKeys = ctx.ui.onTerminalInput(data => {
				if (!ESC_SEQUENCES.has(data)) return undefined;
				if (pendingHandoff && !pendingHandoff.cancelled) {
					pendingHandoff.cancelled = true;
					ctx.ui.notify("Command-line prompt canceled.", "info");
					return { consume: true };
				}
				return stopActive(ctx) ? { consume: true } : undefined;
			});
		}
		if (!ticker) {
			ticker = true;
			timers.every(1000, () => active && showProgress());
		}
		showStatus();
	};

	const onSessionChange = async (_e: unknown, ctx: ExtensionContext) => {
		unsubscribeKeys?.();
		unsubscribeKeys = undefined;
		markCancelled(queue);
		queue.length = 0;
		bind(ctx);
	};
	// Pi reports /new, /resume and /fork as session_start; Oh My Pi as session_switch.
	pi.on("session_start", onSessionChange);
	(pi.on as (event: string, handler: (e: unknown, ctx: ExtensionContext) => Promise<void>) => void)(
		"session_switch",
		onSessionChange,
	);

	pi.on("input", async (event, ctx) => {
		bind(ctx);
		if (event.source !== "extension") sawTypedInput = true;
		if (!enabled || event.source === "extension") return undefined;
		const text = event.text.trim();
		if ((!text && !event.images?.length) || text.startsWith("/") || text.startsWith("!")) return undefined;
		if (!ctx.isIdle()) {
			// Posting now would steer the host's running turn. Keep the message out of both agents.
			ctx.ui.notify("Pi is still finishing a turn. Send your message again in a moment.", "warning");
			return handledInput();
		}
		await route(ctx, text, event.images);
		return handledInput();
	});

	// Oh My Pi sends a prompt given on its command line straight to its agent loop, skipping the input hook.
	// That first turn is stopped here, before any model call, and the prompt handed to Unreal instead. Only that
	// startup prompt: later turns that reach this hook (skills, other extensions) are left to the host. Pi runs
	// the input hook for every prompt, and aborting here would not stop its turn anyway.
	pi.on("before_agent_start", async (event, ctx) => {
		bind(ctx);
		if (!enabled || !isOhMyPi(pi) || hostMode(ctx) !== "tui" || sawTypedInput) return undefined;
		const text = (event.prompt ?? "").trim();
		// Only a prompt the user gave on the command line; an extension's own prompt is left alone.
		const arg = commandLinePromptArg(text, process.argv.slice(2), takenOverArgs);
		if (arg === undefined) return undefined;
		takenOverArgs.add(arg);
		if (text.startsWith("/") || text.startsWith("!")) {
			// Oh My Pi would send it to its model as plain text; commands only run when typed in the chat.
			ctx.abort();
			warn(ctx, `"${text}" on the command line is not run as a command. Type it in the chat instead.`);
			return undefined;
		}
		const hostSession = ctx.sessionManager.getSessionId();
		const leaf = ctx.sessionManager.getLeafId();
		ctx.abort();
		// Oh My Pi is still "busy" here; a message posted now would steer the aborted turn. Wait until it settles,
		// and give up rather than post into another chat or a busy host.
		const handoff = { cancelled: false };
		pendingHandoff = handoff;
		void untilIdle(ctx).then(idle => {
			if (pendingHandoff === handoff) pendingHandoff = undefined;
			if (handoff.cancelled) return;
			// Still the same conversation point: the captured entry is on the branch and nothing the user said
			// follows it (another branch that merely shares that ancestor has its own messages after it).
			const branch = branchOf(ctx);
			const at = leaf === null ? -1 : branch.findIndex(entry => entry.id === leaf);
			const moved =
				(leaf !== null && at < 0) ||
				branch.slice(at + 1).some(entry => entry.customType === USER_TYPE || (entry.type === "message" && entry.message?.role === "user"));
			if (!idle || shuttingDown || moved || hostSession !== liveCtx?.sessionManager.getSessionId()) {
				if (!shuttingDown) warn(ctx, "pi-unreal could not hand the command-line prompt to Unreal. Type it again.");
				return;
			}
			// Oh My Pi restores an interrupted prompt into the editor; it has been handed to Unreal, so clear it.
			if (ctx.hasUI && ctx.ui.getEditorText?.().trim() === text) ctx.ui.setEditorText?.("");
			return route(ctx, text, event.images as ImageContent[] | undefined);
		});
		return undefined;
	});

	pi.registerCommand("harness", {
		description: "Choose who answers your messages: /harness unreal | pi",
		// No argument autocomplete on purpose: an open completion menu makes Enter accept the completion instead of
		// submitting, so the next message typed would be glued onto "/harness ...".
		handler: async (args, ctx) => {
			bind(ctx);
			const choice = args.trim().toLowerCase();
			let next: boolean;
			if (choice === "unreal") next = true;
			else if (choice === "pi") next = false;
			else if (choice === "") next = !enabled;
			else {
				ctx.ui.notify(`Unknown harness "${args.trim()}". Use /harness unreal or /harness pi.`, "warning");
				return;
			}
			if (next && !chatModeSupported(pi, hostMode(ctx))) {
				warn(ctx, UNSUPPORTED_MODE);
				return;
			}
			// Never let both agents work on the same chat at once.
			if (next && !enabled && !ctx.isIdle()) {
				ctx.ui.notify("Pi is still working. Wait for it to finish or press Esc, then switch.", "warning");
				return;
			}
			if (!next && enabled && (active || queue.length)) {
				ctx.ui.notify("Unreal is still working. Press Esc to stop it, then switch.", "warning");
				return;
			}
			enabled = next;
			ctx.ui.notify(enabled ? "Messages now go to Unreal Agent" : "Messages now go to the built-in harness", "info");
			showStatus();
			if (enabled) void pump();
		},
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		timers.clearAll();
		ticker = false;
		unsubscribeKeys?.();
		unsubscribeKeys = undefined;
		markCancelled(active ? [active.turn, ...queue] : queue);
		queue.length = 0;
		if (!active) return;
		const current = active;
		current.controller.abort();
		await withDeadline(current.done ?? Promise.resolve(), SHUTDOWN_GRACE_MS);
		current.force.abort();
		await withDeadline(current.done ?? Promise.resolve(), SHUTDOWN_FORCE_WAIT_MS);
	});

	return { isUnrealMode: () => enabled };
}

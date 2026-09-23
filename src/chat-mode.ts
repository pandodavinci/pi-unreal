/**
 * Unreal chat mode: every message you type goes to Unreal Agent instead of the host's own agent loop.
 * Pi / Oh My Pi is only the terminal UI: it makes zero model calls while this mode is on.
 *
 * - Plain messages are intercepted in the `input` hook (handled), so the host's harness never runs.
 * - Slash commands (/exit, /new, /harness, ...) and !bash still go to the host.
 * - One Unreal session per host session (session_id = pi-<id>), so Unreal remembers the conversation.
 *   /new starts a fresh Unreal session.
 * - Esc cancels the running Unreal turn. Messages sent while it runs are queued.
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
import { inspectDotEnv } from "./env";
import { describe } from "./events";
import { handledInput, ohMyPiSkipsInputHooks, safeTimers, withDeadline } from "./host";
import { runUnreal, type UnrealRunResult } from "./runner";

const USER_TYPE = "unreal-you";
const ANSWER_TYPE = "unreal-answer";
const WIDGET_KEY = "unreal-chat";
const STATUS_KEY = "unreal-harness";
const ESC_SEQUENCES = new Set(["\x1b", "\x1b[27u", "\x1b[27;1u"]);
const SHUTDOWN_GRACE_MS = 900;
const SHUTDOWN_FORCE_WAIT_MS = 500;

interface AnswerDetails {
	/** What the user sees; `content` is the model-facing version, labeled for the host's model. */
	body: string;
	/** True when the runner persisted the prompt (so Unreal's session contains this turn). */
	delivered: boolean;
	turnId: string;
	/** Host entries whose content was sent to Unreal as context with this turn. */
	contextIds: string[];
	status: UnrealRunResult["status"];
	footer: string;
	steps: string[];
	error?: string;
}

type ImageContent = NonNullable<InputEvent["images"]>[number];

interface Turn {
	id: string;
	text: string;
	images: string[];
	sessionId: string;
}

interface LiveView {
	requestRender(): void;
	setHeader(text: string): void;
	setSteps(text: string): void;
	setBody(text: string): void;
}

/** Session entry shapes shared by Pi and Oh My Pi (`message` and `custom_message`). */
interface Entry {
	id?: string;
	type?: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
	message?: { role?: string; content?: unknown };
}

/** Cap on conversation carried over from the host when switching to Unreal. */
const MAX_CONTEXT_CHARS = 12_000;

function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map(block => ((block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
		.join("")
		.trim();
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function registerChatMode(pi: ExtensionAPI, debug: (scope: string, msg: string) => void): { isUnrealMode(): boolean } {
	const stateRoot = resolveStateRoot();
	const provider = process.env.UNREAL_HARNESS_LLM_PROVIDER ?? "openai-codex";
	const model = process.env.UNREAL_HARNESS_LLM_MODEL ?? (process.env.UNREAL_HARNESS_LLM_PROVIDER ? "" : "gpt-6-astra");

	pi.registerFlag("unreal", { description: "Send every message to Unreal Agent (pi-unreal)", type: "boolean", default: false });
	let enabled = process.env.PI_UNREAL_MODE === "1";
	let flagApplied = false;
	const dotEnvNoticeShown = new Set<string>();
	const timers = safeTimers(err => debug("chat", `timer error: ${String(err)}`));
	let liveCtx: ExtensionContext | undefined;
	let unsubscribeKeys: (() => void) | undefined;
	const queue: Turn[] = [];
	let active:
		| {
				controller: AbortController;
				force: AbortController;
				done: Promise<unknown>;
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

	pi.registerMessageRenderer<{ text: string }>(USER_TYPE, (message, _opts, theme) => {
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

	const runTurn = async (turn: Turn) => {
		const ctx = liveCtx!;
		if (!dotEnvNoticeShown.has(ctx.cwd)) {
			dotEnvNoticeShown.add(ctx.cwd);
			const dotEnv = inspectDotEnv(ctx.cwd);
			if (dotEnv.exists && dotEnv.names.length > 0) {
				ctx.ui.notify(
					process.env.PI_UNREAL_TRUST_DOTENV === "1"
						? `This folder has a .env (${dotEnv.names.length} vars). PI_UNREAL_TRUST_DOTENV=1: Unreal Agent will load it; model credentials and endpoints stay pinned.`
						: `This folder has a .env (${dotEnv.names.length} vars). pi-unreal keeps it away from Unreal Agent. Set PI_UNREAL_TRUST_DOTENV=1 if you trust this repo.`,
					"info",
				);
			}
		}
		const controller = new AbortController();
		const force = new AbortController();
		const steps: string[] = [];
		const startedAt = Date.now();
		const turnState = { liveText: "", liveItem: "", thinking: "" };
		const context = conversationContext(ctx, turn);
		const task = withContext(context.text, withImages(turn.text, turn.images));
		const done = runUnreal({
			task,
			cwd: ctx.cwd,
			stateDir: path.join(stateRoot, "chat", `${new Date().toISOString().replace(/[:.]/g, "-")}`),
			sessionId: turn.sessionId,
			sessionDir: path.join(stateRoot, "sessions"),
			includePartials: true,
			signal: controller.signal,
			forceSignal: force.signal,
			debugLog: msg => debug("chat", msg),
			onEvent: event => {
				const live = active ?? turnState;
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
		active = { controller, force, done, startedAt, steps, ...turnState };
		showStatus();
		showProgress();
		const result = await done;
		active = undefined;
		showProgress();
		showStatus();

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
		// Different session now (/new while running): keep the transcript clean, just notify.
		if (turn.sessionId !== `pi-${liveCtx?.sessionManager.getSessionId()}`) {
			liveCtx?.ui.notify(`unreal answer for a previous session dropped (${result.status})`, "info");
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
			contextIds: result.promptPersisted ? context.ids : [],
			status: result.status,
			footer,
			steps,
			error,
		} satisfies AnswerDetails);
	};

	const pump = async () => {
		if (active) return;
		while (queue.length && enabled) {
			const turn = queue.shift()!;
			showStatus();
			try {
				await runTurn(turn);
			} catch (err) {
				active = undefined;
				liveCtx?.ui.notify(`unreal turn failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		}
		showStatus();
	};

	/** Unreal's request only takes text; its ViewImage tool reads files by absolute path. */
	const saveImages = async (images: ImageContent[]) => {
		const dir = path.join(stateRoot, "images");
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

	/**
	 * What Unreal has not seen yet. If Unreal has no session for this chat (new, forked or resumed chat), that
	 * is the whole visible history. Otherwise it is every entry that no delivered turn recorded as seen:
	 * messages the host's model handled, other extensions' messages (e.g. background results, including ones
	 * that arrived during an earlier turn) and messages of ours that never reached Unreal. Turns still queued
	 * are excluded. Keeps the last MAX_CONTEXT_CHARS characters.
	 */
	const conversationContext = (ctx: ExtensionContext, turn: Turn): { text: string; ids: string[] } => {
		let branch: Entry[];
		try {
			branch = ctx.sessionManager.getBranch() as Entry[];
		} catch {
			return { text: "", ids: [] };
		}
		const key = (entry: Entry, index: number) => entry.id ?? `index:${index}`;
		const unrealHasSession = fs.existsSync(path.join(stateRoot, "sessions", `${turn.sessionId}.session.jsonl`));
		const seen = new Set<string>();
		const deliveredTurns = new Set<string>();
		if (unrealHasSession) {
			branch.forEach((entry, index) => {
				const details = entry.details as Partial<AnswerDetails> | undefined;
				if (entry.customType !== ANSWER_TYPE || !details?.delivered) return;
				seen.add(key(entry, index));
				if (details.turnId) deliveredTurns.add(details.turnId);
				for (const id of details.contextIds ?? []) seen.add(id);
			});
		}
		const pending = new Set([turn.id, ...queue.map(queued => queued.id)]);
		const lines: string[] = [];
		const ids: string[] = [];
		branch.forEach((entry, index) => {
			const id = key(entry, index);
			if (seen.has(id)) return;
			let line: string | undefined;
			if (entry.type === "message" && entry.message) {
				const { role, content } = entry.message;
				const text = textOf(content);
				if (text && (role === "user" || role === "assistant")) line = `${role === "user" ? "User" : "Pi"}: ${text}`;
			} else if (entry.customType === USER_TYPE) {
				const details = entry.details as { text?: string; turnId?: string } | undefined;
				if (details?.turnId && (pending.has(details.turnId) || deliveredTurns.has(details.turnId))) return;
				const label = unrealHasSession ? "User (a message that did not reach you)" : "User (to you, Unreal)";
				line = `${label}: ${details?.text ?? textOf(entry.content)}`;
			} else if (entry.customType === ANSWER_TYPE) {
				const details = entry.details as Partial<AnswerDetails> | undefined;
				if (details?.delivered && details.body) line = `You (Unreal): ${details.body}`;
			} else {
				const text = textOf(entry.content);
				if (entry.customType && text) line = `[${entry.customType}] ${text}`;
			}
			if (line) {
				lines.push(line);
				ids.push(id);
			}
		});
		const joined = lines.join("\n\n");
		return { text: joined.length > MAX_CONTEXT_CHARS ? `…${joined.slice(-MAX_CONTEXT_CHARS)}` : joined, ids };
	};
	const withContext = (context: string, text: string) =>
		context
			? `Earlier in this chat, not yet in your session (some of it handled by another agent, Pi). Use it as context:\n\n${context}\n\n---\n\n${text}`
			: text;

	const bind = (ctx: ExtensionContext) => {
		liveCtx = ctx;
		if (!flagApplied) {
			flagApplied = true;
			if (pi.getFlag("unreal") === true) enabled = true;
			if (enabled && ohMyPiSkipsInputHooks(pi)) {
				// Say so instead of letting Oh My Pi's own model answer while the status claims Unreal.
				enabled = false;
				ctx.ui.notify(
					"pi-unreal: Oh My Pi does not pass messages to extensions in this mode (print/JSON/RPC/ACP), so --unreal is off and messages go to Oh My Pi's model. /unreal <task> works here; --unreal works in the interactive terminal.",
					"warning",
				);
			}
		}
		if (!unsubscribeKeys && ctx.hasUI) {
			// Re-registered after every session change: Oh My Pi drops terminal listeners on /new and /resume.
			unsubscribeKeys = ctx.ui.onTerminalInput(data => {
				if (!active || !ESC_SEQUENCES.has(data)) return undefined;
				active.controller.abort();
				queue.length = 0;
				ctx.ui.notify("Stopping unreal…", "info");
				return { consume: true };
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
		if (!enabled || event.source === "extension") return undefined;
		const text = event.text.trim();
		if ((!text && !event.images?.length) || text.startsWith("/") || text.startsWith("!")) return undefined;
		if (!ctx.isIdle()) {
			// Posting now would steer the host's running turn. Keep the message out of both agents.
			ctx.ui.notify("Pi is still finishing a turn. Send your message again in a moment.", "warning");
			return handledInput();
		}
		const images = event.images?.length ? await saveImages(event.images) : [];
		const shown = images.length ? `${text}  [${images.length} image${images.length > 1 ? "s" : ""}]` : text;
		const turnId = randomUUID();
		post(USER_TYPE, `[User message sent to Unreal Agent, which handles it]\n${shown}`, { text: shown, turnId });
		queue.push({ id: turnId, text, images, sessionId: `pi-${ctx.sessionManager.getSessionId()}` });
		void pump();
		return handledInput();
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
			if (next && ohMyPiSkipsInputHooks(pi)) {
				ctx.ui.notify("Oh My Pi does not pass messages to extensions in this mode. Use /unreal <task>, or the interactive terminal.", "warning");
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
		timers.clearAll();
		ticker = false;
		unsubscribeKeys?.();
		unsubscribeKeys = undefined;
		queue.length = 0;
		if (!active) return;
		const current = active;
		current.controller.abort();
		await withDeadline(current.done, SHUTDOWN_GRACE_MS);
		current.force.abort();
		await withDeadline(current.done, SHUTDOWN_FORCE_WAIT_MS);
	});

	return { isUnrealMode: () => enabled };
}

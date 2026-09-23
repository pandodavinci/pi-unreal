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
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { stateRoot as resolveStateRoot } from "./binary";
import { inspectDotEnv } from "./env";
import { describe } from "./events";
import { handledInput, safeTimers, withDeadline } from "./host";
import { runUnreal, type UnrealRunResult } from "./runner";

const USER_TYPE = "unreal-you";
const ANSWER_TYPE = "unreal-answer";
const WIDGET_KEY = "unreal-chat";
const STATUS_KEY = "unreal-harness";
const ESC_SEQUENCES = new Set(["\x1b", "\x1b[27u", "\x1b[27;1u"]);
const SHUTDOWN_GRACE_MS = 900;
const SHUTDOWN_FORCE_WAIT_MS = 500;

interface AnswerDetails {
	status: UnrealRunResult["status"];
	footer: string;
	steps: string[];
	error?: string;
}

type ImageContent = NonNullable<InputEvent["images"]>[number];

interface Turn {
	text: string;
	sessionId: string;
}

interface LiveView {
	requestRender(): void;
	setHeader(text: string): void;
	setSteps(text: string): void;
	setBody(text: string): void;
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function registerChatMode(pi: ExtensionAPI, debug: (scope: string, msg: string) => void) {
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

	pi.registerMessageRenderer<string>(USER_TYPE, (message, _opts, theme) => {
		const box = new Container();
		box.addChild(new Spacer(1));
		box.addChild(new Text(`${theme.fg("accent", theme.bold("you ›"))} ${String(message.content)}`, 1, 0));
		return box;
	});

	pi.registerMessageRenderer<AnswerDetails>(ANSWER_TYPE, (message, opts, theme) => {
		const d = message.details;
		const box = new Container();
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("accent", theme.bold("unreal ›")), 1, 0));
		const body = typeof message.content === "string" ? message.content : "";
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
			if (dotEnv.exists && dotEnv.unpinnable.length === 0) {
				ctx.ui.notify(
					`This folder has a .env (${dotEnv.names.length} vars). Unreal Agent loads it; pi-unreal pins your credentials, endpoints and shell hooks so it cannot override them.`,
					"info",
				);
			}
		}
		const controller = new AbortController();
		const force = new AbortController();
		const steps: string[] = [];
		const startedAt = Date.now();
		const turnState = { liveText: "", liveItem: "", thinking: "" };
		const done = runUnreal({
			task: turn.text,
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
		post(ANSWER_TYPE, body, { status: result.status, footer, steps, error } satisfies AnswerDetails);
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
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, Buffer.from(image.data, "base64"));
			paths.push(file);
		}
		return paths;
	};
	const withImages = (text: string, paths: string[]) =>
		paths.length
			? `${text}\n\nThe user attached ${paths.length} image(s). Look at them with the ViewImage tool before answering:\n${paths.map(p => `- ${p}`).join("\n")}`
			: text;

	const bind = (ctx: ExtensionContext) => {
		liveCtx = ctx;
		if (!flagApplied) {
			flagApplied = true;
			if (pi.getFlag("unreal") === true) enabled = true;
		}
		if (!unsubscribeKeys && ctx.hasUI) {
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

	// Pi reports /new, /resume and /fork as session_start; Oh My Pi as session_switch.
	pi.on("session_start", async (_e, ctx) => {
		bind(ctx);
		queue.length = 0;
	});
	(pi.on as (event: string, handler: (e: unknown, ctx: ExtensionContext) => Promise<void>) => void)(
		"session_switch",
		async (_e, ctx) => {
			bind(ctx);
			queue.length = 0;
		},
	);

	pi.on("input", async (event, ctx) => {
		bind(ctx);
		if (!enabled || event.source === "extension") return undefined;
		const text = event.text.trim();
		if ((!text && !event.images?.length) || text.startsWith("/") || text.startsWith("!")) return undefined;
		const images = event.images?.length ? await saveImages(event.images) : [];
		post(USER_TYPE, images.length ? `${text}  [${images.length} image${images.length > 1 ? "s" : ""}]` : text);
		queue.push({ text: withImages(text, images), sessionId: `pi-${ctx.sessionManager.getSessionId()}` });
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
			if (choice === "unreal") enabled = true;
			else if (choice === "pi") enabled = false;
			else if (choice === "") enabled = !enabled;
			else {
				ctx.ui.notify(`Unknown harness "${args.trim()}". Use /harness unreal or /harness pi.`, "warning");
				return;
			}
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
}

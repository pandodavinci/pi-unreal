/**
 * Pure transcript logic for Unreal chat mode: which host session entries Unreal has already seen, what to
 * send it as context, and which Unreal session continues the current branch. No I/O.
 *
 * Entry shapes are shared by Pi and Oh My Pi: `message` entries carry `message.role/content`,
 * `custom_message` entries carry `customType/content/details`, and `custom` entries (pi.appendEntry) carry
 * `customType/data`. Every entry has a stable `id`.
 */

export const USER_TYPE = "unreal-you";
export const ANSWER_TYPE = "unreal-answer";
/** pi.appendEntry marker: turns the user canceled before Unreal answered them. Not sent to any model. */
export const CANCELLED_TYPE = "pi-unreal-cancelled";

export interface Entry {
	id?: string;
	type?: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
	data?: unknown;
	message?: { role?: string; content?: unknown };
}

export interface UserDetails {
	/** What the user sees. */
	text: string;
	turnId: string;
}

export interface AnswerDetails {
	/** What the user sees; `content` is the model-facing version, labeled for the host's model. */
	body: string;
	/** True when the runner persisted the prompt, so Unreal's session contains this turn. */
	delivered: boolean;
	turnId: string;
	/** The Unreal session that answered. */
	unrealSession: string;
	/** Host entries whose content was sent to Unreal as context with this turn. */
	contextIds: string[];
	status: string;
	footer: string;
	steps: string[];
	error?: string;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map(block => ((block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
		.join("")
		.trim();
}

const keyOf = (entry: Entry, index: number) => entry.id ?? `index:${index}`;

function answerDetails(entry: Entry): Partial<AnswerDetails> | undefined {
	return entry.customType === ANSWER_TYPE ? (entry.details as Partial<AnswerDetails> | undefined) : undefined;
}

/** Turn ids the user canceled (Esc, or queued messages dropped with it). */
export function cancelledTurns(branch: readonly Entry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of branch) {
		if (entry.customType !== CANCELLED_TYPE) continue;
		for (const id of (entry.data as { turnIds?: string[] } | undefined)?.turnIds ?? []) ids.add(id);
	}
	return ids;
}

/** Persisted next to an Unreal session: which host chat owns it and the turn it last answered. */
export interface SessionOwnership {
	hostSession: string;
	headTurn: string;
}

/**
 * The Unreal session that continues this branch. Unreal's memory is linear, so a session is reused only when
 * it belongs to this host chat and its latest answer is the latest answer on this branch. Otherwise (a fork,
 * or the user went back with /tree and continued elsewhere) a fresh session is used, seeded from the branch.
 */
export function unrealSessionFor(
	branch: readonly Entry[],
	hostSessionId: string,
	ownership: (unrealSession: string) => SessionOwnership | undefined,
	fresh: () => string,
): string {
	let last: Partial<AnswerDetails> | undefined;
	for (const entry of branch) {
		const details = answerDetails(entry);
		if (details?.delivered) last = details;
	}
	const base = `pi-${hostSessionId}`;
	const candidate = last?.unrealSession ?? base;
	const owner = ownership(candidate);
	if (!owner) return last ? fresh() : candidate; // no record: only a brand-new chat may start the base session
	return owner.hostSession === hostSessionId && owner.headTurn === last?.turnId ? candidate : fresh();
}

/**
 * What Unreal has not seen yet, as text. With no Unreal session yet (new chat, fork, other branch), that is
 * the whole visible branch. Otherwise it is every entry that no delivered turn of `unrealSession` recorded as
 * seen: messages the host's model handled, other extensions' messages (background results, even ones that
 * arrived mid-turn) and messages of ours that never reached Unreal. Queued and canceled turns are skipped.
 * Keeps the last `maxChars` characters.
 */
export function unseenContext(
	branch: readonly Entry[],
	opts: {
		unrealSession: string;
		unrealHasSession: boolean;
		pendingTurns: ReadonlySet<string>;
		/** Turns the user canceled or that were dropped (Esc, /new, /tree, exit). */
		cancelledTurns?: ReadonlySet<string>;
		maxChars: number;
	},
): { text: string; ids: string[] } {
	const seen = new Set<string>();
	const deliveredTurns = new Set<string>();
	if (opts.unrealHasSession) {
		branch.forEach((entry, index) => {
			const details = answerDetails(entry);
			if (!details?.delivered || (details.unrealSession ?? opts.unrealSession) !== opts.unrealSession) return;
			seen.add(keyOf(entry, index));
			if (details.turnId) deliveredTurns.add(details.turnId);
			for (const id of details.contextIds ?? []) seen.add(id);
		});
	}
	const cancelled = new Set([...cancelledTurns(branch), ...(opts.cancelledTurns ?? [])]);
	const lines: string[] = [];
	const ids: string[] = [];
	branch.forEach((entry, index) => {
		const id = keyOf(entry, index);
		if (seen.has(id)) return;
		let line: string | undefined;
		if (entry.type === "message" && entry.message) {
			const { role, content } = entry.message;
			const text = textOf(content);
			if (text && (role === "user" || role === "assistant")) line = `${role === "user" ? "User" : "Pi"}: ${text}`;
		} else if (entry.customType === USER_TYPE) {
			const details = entry.details as Partial<UserDetails> | undefined;
			const turnId = details?.turnId;
			if (turnId && (opts.pendingTurns.has(turnId) || deliveredTurns.has(turnId) || cancelled.has(turnId))) return;
			const label = opts.unrealHasSession ? "User (a message that did not reach you)" : "User (to you, Unreal)";
			line = `${label}: ${details?.text ?? textOf(entry.content)}`;
		} else if (entry.customType === ANSWER_TYPE) {
			const details = answerDetails(entry);
			if (details?.delivered && details.body) line = `You (Unreal): ${details.body}`;
		} else if (entry.customType && entry.customType !== CANCELLED_TYPE) {
			const text = textOf(entry.content);
			if (text) line = `[${entry.customType}] ${text}`;
		}
		if (line) {
			lines.push(line);
			ids.push(id);
		}
	});
	const joined = lines.join("\n\n");
	return { text: joined.length > opts.maxChars ? `…${joined.slice(-opts.maxChars)}` : joined, ids };
}

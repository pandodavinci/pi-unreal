import { describe, expect, test } from "bun:test";
import { commandLinePromptArg } from "../src/chat-mode";
import { ANSWER_TYPE, CANCELLED_TYPE, type Entry, USER_TYPE, unrealSessionFor, unseenContext } from "../src/context";

const you = (id: string, turnId: string, text: string): Entry => ({ id, type: "custom_message", customType: USER_TYPE, content: "x", details: { text, turnId } });
const answer = (id: string, turnId: string, body: string, extra: Record<string, unknown> = {}): Entry => ({
	id,
	type: "custom_message",
	customType: ANSWER_TYPE,
	content: "x",
	details: { body, turnId, delivered: true, unrealSession: "pi-s", contextIds: [], ...extra },
});
const piUser = (id: string, text: string): Entry => ({ id, type: "message", message: { role: "user", content: text } });
const opts = (over: Partial<Parameters<typeof unseenContext>[1]> = {}) => ({
	unrealSession: "pi-s",
	unrealHasSession: true,
	pendingTurns: new Set<string>(),
	maxChars: 12_000,
	...over,
});

describe("unseenContext", () => {
	test("delivered turns and what they carried are not repeated", () => {
		const branch = [piUser("p1", "design a cache"), you("y1", "t1", "go"), answer("a1", "t1", "done", { contextIds: ["p1"] }), piUser("p2", "now add tests")];
		expect(unseenContext(branch, opts()).text).toBe("User: now add tests");
	});

	test("without an Unreal session, the whole visible branch is carried, including earlier Unreal turns", () => {
		const branch = [you("y1", "t1", "we use Postgres"), answer("a1", "t1", "noted")];
		const text = unseenContext(branch, opts({ unrealHasSession: false })).text;
		expect(text).toContain("User (to you, Unreal): we use Postgres");
		expect(text).toContain("You (Unreal): noted");
	});

	test("canceled turns are never replayed", () => {
		const branch = [you("y1", "t1", "delete everything"), { id: "c1", type: "custom", customType: CANCELLED_TYPE, data: { turnIds: ["t1"] } }];
		expect(unseenContext(branch, opts()).text).toBe("");
	});

	test("answers from another Unreal session do not count as seen by this one", () => {
		const branch = [you("y1", "t1", "old branch work"), answer("a1", "t1", "old answer", { unrealSession: "pi-s-other" })];
		expect(unseenContext(branch, opts()).text).toContain("old answer");
	});

	test("queued turns are left out, and only the last maxChars characters are kept", () => {
		expect(unseenContext([you("y1", "t9", "queued")], opts({ pendingTurns: new Set(["t9"]) })).text).toBe("");
		const long = unseenContext([piUser("p1", "x".repeat(100))], opts({ maxChars: 10 })).text;
		expect(long).toBe(`…${"x".repeat(10)}`);
	});
});

describe("unrealSessionFor", () => {
	const fresh = () => "pi-s1-fresh";
	const owners = (records: Record<string, { hostSession: string; headTurn: string }>) => (id: string) => records[id];
	const branch = [answer("a1", "t1", "x", { unrealSession: "pi-s1" })];

	test("a new chat uses the host session id", () => {
		expect(unrealSessionFor([], "s1", owners({}), fresh)).toBe("pi-s1");
	});

	test("the branch that ends where its Unreal session last answered keeps that session, across restarts", () => {
		// Ownership is persisted next to the session, so a restart sees the same record.
		expect(unrealSessionFor(branch, "s1", owners({ "pi-s1": { hostSession: "s1", headTurn: "t1" } }), fresh)).toBe("pi-s1");
	});

	test("after going back (/tree) past a later answer, a fresh session is used", () => {
		expect(unrealSessionFor(branch, "s1", owners({ "pi-s1": { hostSession: "s1", headTurn: "t2" } }), fresh)).toBe("pi-s1-fresh");
		expect(unrealSessionFor([], "s1", owners({ "pi-s1": { hostSession: "s1", headTurn: "t2" } }), fresh)).toBe("pi-s1-fresh");
	});

	test("a fork never shares its parent's Unreal session, even when forked at the latest answer", () => {
		expect(unrealSessionFor(branch, "fork", owners({ "pi-s1": { hostSession: "s1", headTurn: "t1" } }), () => "pi-fork-fresh")).toBe(
			"pi-fork-fresh",
		);
	});

	test("a session left mid-turn by a crash is not trusted: its memory may be ahead of the transcript", () => {
		expect(
			unrealSessionFor(branch, "s1", owners({ "pi-s1": { hostSession: "s1", headTurn: "t1", inflightTurn: "t2" } as never }), fresh),
		).toBe("pi-s1-fresh");
	});

	test("an answer whose session has no ownership record (older version) is re-seeded in a fresh session", () => {
		expect(unrealSessionFor(branch, "s1", owners({}), fresh)).toBe("pi-s1-fresh");
	});
});

describe("unseenContext: persistent cancellations", () => {
	test("turns canceled in another branch or before a restart are skipped", () => {
		const branch = [you("y1", "t1", "delete everything")];
		expect(unseenContext(branch, opts({ cancelledTurns: new Set(["t1"]) })).text).toBe("");
	});
});

describe("commandLinePromptArg", () => {
	const none = new Set<string>();
	test("matches the message argument, alone or after @file / stdin context", () => {
		expect(commandLinePromptArg("fix the tests", ["--unreal", "fix the tests"], none)).toBe("fix the tests");
		expect(commandLinePromptArg("<file>x</file>\nfix it", ["@a.md", "fix it"], none)).toBe("fix it");
	});
	test("ignores flags, file references, other prompts and already-taken arguments", () => {
		expect(commandLinePromptArg("an extension prompt", ["--model", "gpt"], none)).toBeUndefined();
		expect(commandLinePromptArg("@a.md", ["@a.md"], none)).toBeUndefined();
		expect(commandLinePromptArg("fix", ["fix"], new Set(["fix"]))).toBeUndefined();
	});
});

import { describe, expect, test } from "bun:test";
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

	test("a new chat uses the host session id", () => {
		expect(unrealSessionFor([], "s1", new Map(), fresh)).toBe("pi-s1");
	});

	test("the branch that ends where Unreal last answered keeps its session", () => {
		const branch = [answer("a1", "t1", "x", { unrealSession: "pi-s1" })];
		expect(unrealSessionFor(branch, "s1", new Map([["pi-s1", "t1"]]), fresh)).toBe("pi-s1");
	});

	test("after going back to an earlier point (/tree), a fresh session is used", () => {
		const branch = [answer("a1", "t1", "x", { unrealSession: "pi-s1" })];
		// Unreal's session has since answered t2 on another branch.
		expect(unrealSessionFor(branch, "s1", new Map([["pi-s1", "t2"]]), fresh)).toBe("pi-s1-fresh");
		// Going back before the first answer while that session exists elsewhere.
		expect(unrealSessionFor([], "s1", new Map([["pi-s1", "t2"]]), fresh)).toBe("pi-s1-fresh");
	});

	test("after a restart (no known heads) the branch is trusted", () => {
		const branch = [answer("a1", "t1", "x", { unrealSession: "pi-s1" })];
		expect(unrealSessionFor(branch, "s1", new Map(), fresh)).toBe("pi-s1");
	});
});

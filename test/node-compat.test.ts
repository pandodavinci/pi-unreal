import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Pi loads extensions on Node (Oh My Pi on Bun): src/ must not use Bun-only globals.
test("src/ uses no Bun-only APIs", () => {
	const dir = path.join(import.meta.dir, "..", "src");
	for (const file of fs.readdirSync(dir)) {
		const text = fs.readFileSync(path.join(dir, file), "utf8");
		expect({ file, usesBun: /\bBun\./.test(text) }).toEqual({ file, usesBun: false });
	}
});

// Every temp directory the tests (and the processes they spawn) create goes under one root, removed at the end.
import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unreal-test-"));
process.env.TMPDIR = root;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

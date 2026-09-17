import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { subagentTimeout } from "../extensions/zense-harness/index.ts";

// B: per-role timeout — regression-guards the "code=143 signal=null" bug (a timeout reported as a crash)
test("subagentTimeout: per-role map + default fallback (no more env override)", () => {
	assert.equal(subagentTimeout("requirements"), 600_000);
	assert.equal(subagentTimeout("grader"), 600_000);
	assert.equal(subagentTimeout("reviewer"), 480_000);
	assert.equal(subagentTimeout("unknown-role"), 300_000); // unknown role → default
});

// s2: the agent-visible knob is .zense/config.json (key subagentTimeoutMs) — read live on every call, no cache
test("subagentTimeout: .zense/config.json overrides built-in map, read fresh per call", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-cfg-"));
	try {
		// no config yet → built-in map
		assert.equal(subagentTimeout("requirements", dir), 600_000);
		mkdirSync(join(dir, ".zense"), { recursive: true });
		// a role entry overrides the map
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: 900_000 } }));
		assert.equal(subagentTimeout("requirements", dir), 900_000);
		assert.equal(subagentTimeout("grader", dir), 600_000); // other roles unaffected
		// a default entry covers unspecified roles
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { default: 45_000 } }));
		assert.equal(subagentTimeout("grader", dir), 45_000);
		assert.equal(subagentTimeout("requirements", dir), 45_000);
		// a role entry beats default
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { default: 45_000, reviewer: 120_000 } }));
		assert.equal(subagentTimeout("reviewer", dir), 120_000);
		// invalid values (0/negative/non-number) → skipped, fall back to the map
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: 0, default: -5 } }));
		assert.equal(subagentTimeout("requirements", dir), 600_000);
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: "60k" } }));
		assert.equal(subagentTimeout("requirements", dir), 600_000);
		// corrupt JSON → the map (never throws)
		writeFileSync(join(dir, ".zense", "config.json"), "{oops");
		assert.equal(subagentTimeout("requirements", dir), 600_000);
		// live read: rewritten at runtime → the very next call sees it
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: 777_000 } }));
		assert.equal(subagentTimeout("requirements", dir), 777_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// s2: a worktree has no .zense (gitignored) → falls back to the main repo
test("subagentTimeout: cwd without config → falls back to the next dir (worktree → main repo)", () => {
	const wt = mkdtempSync(join(tmpdir(), "zense-wt-"));
	const main = mkdtempSync(join(tmpdir(), "zense-main-"));
	try {
		mkdirSync(join(main, ".zense"), { recursive: true });
		writeFileSync(join(main, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: 800_000 } }));
		assert.equal(subagentTimeout("requirements", wt, main), 800_000); // wt lacks it → main wins
		mkdirSync(join(wt, ".zense"), { recursive: true });
		writeFileSync(join(wt, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: 111_000 } }));
		assert.equal(subagentTimeout("requirements", wt, main), 111_000); // wt has its own → it wins
		assert.equal(subagentTimeout("reviewer", wt, main), 480_000); // absent in both configs → the map
	} finally {
		rmSync(wt, { recursive: true, force: true });
		rmSync(main, { recursive: true, force: true });
	}
});

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSubagent } from "../extensions/zense-harness/index.ts";

// Esc-cancel: runSubagent's AbortSignal wiring — the "can't cancel zense_spec mid-run" bug.
// A fake `pi` on PATH (exec sleep = the spawned process itself, so SIGTERM kills it directly
// and no orphaned grandchild holds the stdio pipes open → 'close' fires immediately).

const withFakePi = () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-cancel-"));
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	const fake = join(bin, "pi");
	writeFileSync(fake, "#!/bin/sh\nexec sleep 60\n");
	chmodSync(fake, 0o755);
	const oldPath = process.env.PATH ?? "";
	process.env.PATH = `${bin}:${oldPath}`;
	return {
		dir,
		restore: () => {
			process.env.PATH = oldPath;
			rmSync(dir, { recursive: true, force: true });
		},
	};
};

test("runSubagent: abort mid-run kills the child (SIGTERM) and resolves quickly with a cancelled result", async () => {
	const { dir, restore } = withFakePi();
	try {
		const logPath = join(dir, "cancel.log");
		const ctrl = new AbortController();
		const t0 = Date.now();
		// 300s timeout must never be the thing that resolves this run
		const p = runSubagent("requirements", "task", dir, 300_000, undefined, logPath, undefined, undefined, undefined, ctrl.signal);
		setTimeout(() => ctrl.abort(), 400);
		const r = await p;
		const elapsed = Date.now() - t0;
		assert.equal(r.ok, false);
		assert.match(r.output, /cancelled by user \(Esc\)/);
		assert.match(r.output, /killed mid-run/);
		assert.equal(r.logPath, logPath);
		assert.ok(elapsed < 10_000, `cancel should resolve fast, took ${elapsed}ms`);
		const log = readFileSync(logPath, "utf8");
		assert.match(log, /cancelled by user \(Esc\) — SIGTERM/);
		assert.match(log, /\(cancelled SIGTERM\)/); // exit line distinguishes cancel from timeout/crash
	} finally {
		restore();
	}
});

test("runSubagent: pre-aborted signal resolves without spawning (no log file written)", async () => {
	const { dir, restore } = withFakePi();
	try {
		const logPath = join(dir, "never-started.log");
		const ctrl = new AbortController();
		ctrl.abort(); // Esc arrived before the launch (e.g. during a clarify dialog)
		const t0 = Date.now();
		const r = await runSubagent("requirements", "task", dir, 300_000, undefined, logPath, undefined, undefined, undefined, ctrl.signal);
		assert.ok(Date.now() - t0 < 5_000);
		assert.equal(r.ok, false);
		assert.match(r.output, /cancelled by user \(Esc\)/);
		assert.match(r.output, /never started/);
		assert.equal(existsSync(logPath), false); // proves the child/log header were never created
	} finally {
		restore();
	}
});

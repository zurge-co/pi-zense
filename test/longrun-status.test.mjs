import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { longrunStatusText, saveTracker } from "../extensions/zense-harness/index.ts";

// longrun status bar (2026-09-24): compact footer line for the active long-run tracker —
// `zense · <slug> <done>/<total> · <id> <title> | (between phases) · <cycle phase>`.
// longrunStatusText is pure (fs read only: loads the tracker from cwd); index.ts wires it
// into updateWidget with a string-level dedupe.

const tracker = (over = {}) => ({
	version: 1,
	slug: "add-auth",
	title: "Add auth",
	intent: "",
	worktreeBranch: "zense/longrun/add-auth",
	status: "active",
	phases: [
		{ id: "p1", title: "Schema", intent: "", scope: ["src/schema"], constraints: [], criteria: [], status: "done" },
		{ id: "p2", title: "Wire up login", intent: "", scope: ["src/login"], constraints: [], criteria: [], status: "active" },
		{ id: "p3", title: "Guards", intent: "", scope: ["src/guards"], constraints: [], criteria: [], status: "pending" },
	],
	updatedAt: 0,
	...over,
});

const withTracker = (t, fn) => {
	const cwd = mkdtempSync(join(tmpdir(), "zense-lrstatus-"));
	try {
		saveTracker(cwd, t);
		return fn(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
};

test("longrunStatusText: nothing to show when no longrun / tracker gone / not active", () => {
	withTracker(tracker(), (cwd) => {
		assert.equal(longrunStatusText(cwd, undefined, "implementation"), undefined);
		assert.equal(longrunStatusText(cwd, { slug: "nope", trackerVersion: 1 }, "implementation"), undefined); // not on disk
		assert.equal(longrunStatusText(cwd, { slug: "add-auth", trackerVersion: 1 }, "implementation").includes("add-auth"), true);
	});
	withTracker(tracker({ status: "done" }), (cwd) => {
		assert.equal(longrunStatusText(cwd, { slug: "add-auth", trackerVersion: 1 }, "review"), undefined);
	});
	withTracker(tracker({ status: "abandoned" }), (cwd) => {
		assert.equal(longrunStatusText(cwd, { slug: "add-auth", trackerVersion: 1 }, "review"), undefined);
	});
});

test("longrunStatusText: active phase — slug, progress, phase id + title, cycle phase", () => {
	withTracker(tracker(), (cwd) => {
		const line = longrunStatusText(cwd, { slug: "add-auth", trackerVersion: 1, activePhase: "p2" }, "implementation");
		assert.equal(line, "zense · add-auth 1/3 · p2 Wire up login · implementation");
	});
});

test("longrunStatusText: between phases (no activePhase) shows the boundary marker", () => {
	withTracker(tracker(), (cwd) => {
		const line = longrunStatusText(cwd, { slug: "add-auth", trackerVersion: 1 }, "requirements");
		assert.equal(line, "zense · add-auth 1/3 · (between phases) · requirements");
	});
});

test("longrunStatusText: activePhase pointing at a missing phase falls back to the boundary marker", () => {
	withTracker(tracker(), (cwd) => {
		const line = longrunStatusText(cwd, { slug: "add-auth", trackerVersion: 1, activePhase: "pX" }, "eval");
		assert.equal(line, "zense · add-auth 1/3 · (between phases) · eval");
	});
});

test("longrunStatusText: progress reflects done count only", () => {
	const t = tracker();
	t.phases[2].status = "done"; // p3 done, p2 still active → 2 done
	withTracker(t, (cwd) => {
		const line = longrunStatusText(cwd, { slug: "add-auth", trackerVersion: 1, activePhase: "p2" }, "review");
		assert.equal(line, "zense · add-auth 2/3 · p2 Wire up login · review");
	});
});

// regression guards: the footer entry must be wired into the existing updateWidget closure
// (string-level dedupe), re-exported for tests, and cleared by pi's session reset
test("index.ts wires the longrun status bar via updateWidget with dedupe", () => {
	const src = readFileSync(new URL("../extensions/zense-harness/index.ts", import.meta.url), "utf8");
	assert.ok(src.includes('export * from "./src/longrun-status.ts"'), "module re-exported from the entry point");
	assert.ok(src.includes('setStatus("zense-longrun", status)'), "footer entry set under the zense-longrun key");
	assert.ok(/const updateWidget[\s\S]{0,1600}?setStatus\("zense-longrun"/.test(src), "setStatus lives inside updateWidget");
	assert.ok(src.includes("lastLongrunStatus"), "string-level dedupe exists");
	// zense_longrun's say closure refreshes (via updateWidget) → all actions covered
	assert.ok(/const say = .*?\{\s*updateWidget\(ctx\);/s.test(src), "zense_longrun say closure refreshes");
});

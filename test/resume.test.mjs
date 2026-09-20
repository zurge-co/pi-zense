import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadSpecFromDisk,
	findSpecArchivePaths,
	findSessionWorktree,
	restorePendingApply,
	discoverResumeState,
	createWorktree,
} from "../extensions/zense-harness/index.ts";

// /zense resume helpers — explicit adoption of an on-disk cycle into a fresh session.
// Git-dependent cases use real temp repos (mirrors test/worktree.test.mjs).

const SPEC = (version) => ({
	version,
	title: `spec v${version}`,
	intent: "intent",
	scope: [],
	constraints: [],
	criteria: [],
	specDebt: [],
	approved: true,
});

/** create a temp git repo with an initial commit */
const makeRepo = () => {
	const base = mkdtempSync(join(tmpdir(), "zense-resume-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, "README.md"), "# init\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	return { cwd, base, git };
};

// ----- loadSpecFromDisk -----

test("loadSpecFromDisk: no spec.json → null", () => {
	const { cwd, base } = makeRepo();
	try {
		assert.equal(loadSpecFromDisk(cwd), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("loadSpecFromDisk: corrupt JSON → null", () => {
	const { cwd, base } = makeRepo();
	try {
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		writeFileSync(join(cwd, ".zense", "spec.json"), "{ not json");
		assert.equal(loadSpecFromDisk(cwd), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("loadSpecFromDisk: invalid shape (non-array criteria / missing title) → null", () => {
	const { cwd, base } = makeRepo();
	try {
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		const p = join(cwd, ".zense", "spec.json");
		writeFileSync(p, JSON.stringify({ version: 1, title: "x", scope: [], criteria: "nope" }));
		assert.equal(loadSpecFromDisk(cwd), null);
		writeFileSync(p, JSON.stringify({ version: 1, scope: [], criteria: [] })); // no title
		assert.equal(loadSpecFromDisk(cwd), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("loadSpecFromDisk: valid signed spec → adopted with defaults for missing optionals", () => {
	const { cwd, base } = makeRepo();
	try {
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		writeFileSync(
			join(cwd, ".zense", "spec.json"),
			JSON.stringify({ version: 3, title: "t", intent: "i", scope: ["src/"], criteria: [{ id: "C1", text: "x", check: "true" }], approved: true }),
		);
		const s = loadSpecFromDisk(cwd);
		assert.ok(s, "expected a spec");
		assert.equal(s.version, 3);
		assert.equal(s.approved, true);
		assert.deepEqual(s.constraints, []);
		assert.deepEqual(s.specDebt, []);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

// ----- findSpecArchivePaths -----

test("findSpecArchivePaths: picks the newest archive pair of the requested version only", () => {
	const { cwd, base } = makeRepo();
	try {
		const specs = join(cwd, ".zense", "specs");
		mkdirSync(specs, { recursive: true });
		for (const f of [
			"2026-09-01-00-00-00-v1-a.json",
			"2026-09-01-00-00-00-v1-a.md",
			"2026-09-02-00-00-00-v2-b.json",
			"2026-09-02-00-00-00-v2-b.md",
			"2026-09-03-00-00-00-v2-c.json", // newer v2 → preferred
		])
			writeFileSync(join(specs, f), "x");
		const r = findSpecArchivePaths(cwd, 2);
		assert.equal(r.json, join(specs, "2026-09-03-00-00-00-v2-c.json"));
		assert.equal(r.md, join(specs, "2026-09-02-00-00-00-v2-b.md"));
		assert.deepEqual(findSpecArchivePaths(cwd, 9), {});
		assert.deepEqual(findSpecArchivePaths(join(base, "nope"), 1), {});
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

// ----- findSessionWorktree -----

test("findSessionWorktree: no worktree dir / stray non-git dir → null", () => {
	const { cwd, base } = makeRepo();
	try {
		assert.equal(findSessionWorktree(cwd, 1), null);
		mkdirSync(join(cwd, ".zense", "worktree", "stray"), { recursive: true });
		assert.equal(findSessionWorktree(cwd, 1), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("findSessionWorktree: real zense worktree found; exact version match preferred", () => {
	const { cwd, base } = makeRepo();
	try {
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		const wt = createWorktree(cwd, SPEC(4));
		assert.ok(wt, "worktree created");
		const found = findSessionWorktree(cwd, 4);
		assert.ok(found, "worktree rediscovered");
		assert.equal(found.wt.root, wt.root);
		assert.equal(found.wt.branch, wt.branch);
		assert.equal(found.exactVersion, true);
		// a single leftover with a stale version-prefixed branch (version bumped mid-impl) is
		// still adopted — flagged as inexact so the caller can warn
		const inexact = findSessionWorktree(cwd, 5);
		assert.ok(inexact, "single leftover adopted despite version mismatch");
		assert.equal(inexact.exactVersion, false);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("findSessionWorktree: multiple candidates with no exact version match → null (never guess)", () => {
	const { cwd, base } = makeRepo();
	try {
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		assert.ok(createWorktree(cwd, SPEC(1)));
		// createWorktree names dir+branch from a second-resolution stamp — two creates inside
		// the same second would collide; wait out the boundary (sync sleep, test-only)
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
		assert.ok(createWorktree(cwd, SPEC(2)));
		assert.equal(findSessionWorktree(cwd, 7), null);
		const exact = findSessionWorktree(cwd, 2);
		assert.ok(exact && exact.exactVersion, "exact match wins among several");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

// ----- discoverResumeState (the one-shot /zense resume discovery) -----

test("discoverResumeState: no spec on disk → null", () => {
	const { cwd, base } = makeRepo();
	try {
		assert.equal(discoverResumeState(cwd), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("discoverResumeState: spec only (no worktree/apply) → spec + archive paths, rest absent", () => {
	const { cwd, base } = makeRepo();
	try {
		const specs = join(cwd, ".zense", "specs");
		mkdirSync(specs, { recursive: true });
		writeFileSync(join(specs, "2026-09-20-00-00-00-v3-t.json"), "{}");
		writeFileSync(join(specs, "2026-09-20-00-00-00-v3-t.md"), "# s");
		writeFileSync(
			join(cwd, ".zense", "spec.json"),
			JSON.stringify({ version: 3, title: "t", intent: "i", scope: [], criteria: [], approved: true }),
		);
		const d = discoverResumeState(cwd);
		assert.ok(d, "discovery returned");
		assert.equal(d.spec.version, 3);
		assert.equal(d.specJsonPath, join(specs, "2026-09-20-00-00-00-v3-t.json"));
		assert.equal(d.specMdPath, join(specs, "2026-09-20-00-00-00-v3-t.md"));
		assert.equal(d.worktree, undefined);
		assert.equal(d.pendingApply, undefined);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("discoverResumeState: signed spec + worktree + staged apply → everything wired at once", () => {
	const { cwd, base, git } = makeRepo();
	try {
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		writeFileSync(
			join(cwd, ".zense", "spec.json"),
			JSON.stringify({ version: 5, title: "t", intent: "i", scope: [], criteria: [], approved: true }),
		);
		const wt = createWorktree(cwd, SPEC(5));
		assert.ok(wt, "worktree created");
		// eval-PASS aftermath in main: staged change + the reverse patch helper
		writeFileSync(join(cwd, ".zense", "pending-apply.patch"), "fake patch");
		writeFileSync(join(cwd, "applied.txt"), "x\n");
		git(["add", "applied.txt"]);
		const d = discoverResumeState(cwd);
		assert.ok(d, "discovery returned");
		assert.equal(d.worktree?.root, wt.root);
		assert.equal(d.worktreeExactVersion, true);
		assert.deepEqual(d.pendingApply?.paths, ["applied.txt"]);
		assert.equal(d.pendingApply?.specVersion, 5);
		// unsigned spec → pendingApply is never probed (no apply can exist before approval)
		writeFileSync(
			join(cwd, ".zense", "spec.json"),
			JSON.stringify({ version: 5, title: "t", intent: "i", scope: [], criteria: [], approved: false }),
		);
		assert.equal(discoverResumeState(cwd)?.pendingApply, undefined);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

// ----- restorePendingApply -----

test("restorePendingApply: no patch file → null; patch + empty index → null", () => {
	const { cwd, base } = makeRepo();
	try {
		assert.equal(restorePendingApply(cwd, 1), null);
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		writeFileSync(join(cwd, ".zense", "pending-apply.patch"), "fake patch");
		assert.equal(restorePendingApply(cwd, 1), null); // index clean = human closed it outside the flow
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("restorePendingApply: patch + staged change → restored, .zense paths excluded", () => {
	const { cwd, base, git } = makeRepo();
	try {
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		writeFileSync(join(cwd, ".zense", "pending-apply.patch"), "fake patch");
		writeFileSync(join(cwd, "new-file.txt"), "hello\n");
		git(["add", "new-file.txt", ".zense/pending-apply.patch"]);
		const pa = restorePendingApply(cwd, 2);
		assert.ok(pa, "pending apply restored");
		assert.equal(pa.specVersion, 2);
		assert.deepEqual(pa.paths, ["new-file.txt"]);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

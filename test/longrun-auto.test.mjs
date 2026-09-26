import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AUTO_FIX_MAX_ROUNDS,
	autoLoopEnabled,
	buildAutoFixPrompt,
	buildCompactionCapsule,
	buildLongrunDigest,
	digestPath,
	longrunBranch,
	nextPendingPhase,
	renderDigestMd,
	saveTracker,
	writePhaseSummary,
} from "../extensions/zense-harness/index.ts";

// longrun v2 (auto loop): auto gating, bounded auto-fix prompt, next-phase kickoff,
// one-line compaction summary (disk is the source of truth), digest.md — the single review
// artifact. The reset itself rides turn_end boundary compaction drafts in index.ts (runtime
// pi wiring, not unit-testable here) — never ctx.compact() (aborts the run mid-turn)

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const mkRepo = () => {
	const root = mkdtempSync(join(tmpdir(), "zense-longrun-auto-"));
	git(["init", "-q", "-b", "main"], root);
	git(["config", "user.email", "t@t"], root);
	git(["config", "user.name", "t"], root);
	writeFileSync(join(root, "a.txt"), "a\n");
	git(["add", "-A"], root);
	git(["commit", "-q", "-m", "init", "--no-verify"], root);
	return root;
};

const mkTracker = (over = {}) => ({
	version: 1,
	slug: "ship-oauth",
	title: "Ship oauth",
	intent: "Move auth to oauth",
	worktreeBranch: longrunBranch("ship-oauth"),
	status: "active",
	auto: true,
	approvedAt: Date.now(),
	updatedAt: Date.now(),
	phases: [
		{
			id: "p1", title: "store", intent: "token store", scope: ["src/store"], constraints: [],
			criteria: [
				{ id: "S1", text: "store module exists", check: "true" },
				{ id: "S2", text: "token roundtrip test passes", check: "true" },
			],
			status: "done", checkpoint: "aaaaaaaabbbb", specVersion: 1,
			verdict: "PASS", criteriaVerdicts: { S1: "PASS", S2: "PASS" },
			filesChanged: ["src/store/index.ts", "test/store.test.mjs"],
			summaryPath: "phases/p1.md",
		},
		{
			id: "p2", title: "login flow", intent: "oauth login", scope: ["src/login"], constraints: ["no breaking"],
			criteria: [{ id: "L1", text: "login page renders", check: "true" }],
			status: "pending",
		},
	],
	...over,
});

// ---------- gating

test("autoLoopEnabled: ONLY explicit true — undefined/false keep the v1 manual gates", () => {
	assert.equal(autoLoopEnabled(mkTracker()), true);
	assert.equal(autoLoopEnabled(mkTracker({ auto: false })), false);
	const noAuto = mkTracker();
	delete noAuto.auto;
	assert.equal(autoLoopEnabled(noAuto), false);
});

// ---------- auto-fix prompt (bounded re-drive, no human until the bound)

test("buildAutoFixPrompt: nails the failed signed criteria + scope + re-eval directive, rounds left", () => {
	const t = mkTracker();
	const prompt = buildAutoFixPrompt(t.phases[1], [{ id: "L1", text: "login page renders" }], 2);
	assert.match(prompt, /2 round\(s\) left/);
	assert.match(prompt, /p2 "login flow"/);
	assert.match(prompt, /L1: login page renders/);
	assert.match(prompt, /src\/login/);
	assert.match(prompt, /zense_eval/);
});

test("AUTO_FIX_MAX_ROUNDS is a small integer bound (not an unbounded furnace)", () => {
	assert.ok(AUTO_FIX_MAX_ROUNDS >= 1 && AUTO_FIX_MAX_ROUNDS <= 3);
});

// ---------- compaction summary: the one-line reset directive the boundary draft carries

test("buildCompactionCapsule: ONE self-sufficient line pointing at zense_longrun next — no stale prior-phase capsule", () => {
	const root = mkRepo();
	const t = mkTracker();
	saveTracker(root, t);
	const line = buildCompactionCapsule(t);
	assert.match(line, /\[zense longrun\] ship-oauth/);
	assert.match(line, /call zense_longrun next now/);
	assert.match(line, /never reconstruct state from memory/);
	assert.equal(line.includes("\n"), false, "the summary is ONE line — the fresh context re-derives state from disk, not from a snapshot");
	assert.ok(!/p2/.test(line) && !/seed criteria/.test(line), "no next-phase detail embedded — next re-reads the tracker");
	// set complete → no 'next', points at the single review
	t.phases[1].status = "done";
	saveTracker(root, t);
	assert.match(buildCompactionCapsule(t), /awaits the single final human review/);
	rmSync(root, { recursive: true, force: true });
});

// ---------- digest.md — per-phase intent, criteria+verdict, files, why

test("renderDigestMd: every phase gets intent, criteria verdicts, files, rationale, checkpoint", () => {
	const t = mkTracker();
	const md = renderDigestMd(t, (p) => (p.id === "p1" ? "token store landed with atomic save; test covers roundtrip" : ""));
	assert.match(md, /# Ship oauth — longrun digest \(the single review\)/);
	assert.match(md, /## ✅ p1 — store/);
	assert.match(md, /\*\*Intent\/goal:\*\* token store/);
	assert.match(md, /✓ S1 \(PASS\) — store module exists/);
	assert.match(md, /✓ S2 \(PASS\) — token roundtrip test passes/);
	assert.match(md, /- src\/store\/index\.ts/);
	assert.match(md, /\*\*Why \/ what was done:\*\* token store landed with atomic save/);
	assert.match(md, /checkpoint: `aaaaaaaabbbb`/);
	assert.match(md, /## ⏳ p2 — login flow/, "pending phase still listed");
	assert.match(md, /· L1 \(—\) — login page renders/, "unjudged criteria marked, never faked as PASS");
});

test("buildLongrunDigest: writes digest.md into the longrun directory with the phases/ rationale", () => {
	const root = mkRepo();
	const t = mkTracker();
	saveTracker(root, t);
	writePhaseSummary(root, t, t.phases[0], "token store landed with atomic save", t.phases[0].filesChanged);
	const p = buildLongrunDigest(root, t);
	assert.equal(p, digestPath(root, t.slug));
	assert.equal(existsSync(p), true);
	const md = readFileSync(p, "utf8");
	assert.match(md, /✓ S1 \(PASS\)/);
	assert.match(md, /token store landed with atomic save/);
	rmSync(root, { recursive: true, force: true });
});

// ---------- kickoff: the ONLY instruction surviving a retain-none reset

test("buildNextPhaseKickoff: self-sufficient — tells the fresh context to re-read from disk and call next", async () => {
	const { buildNextPhaseKickoff } = await import("../extensions/zense-harness/index.ts");
	const t = mkTracker();
	const kick = buildNextPhaseKickoff("/tmp/any", t, nextPendingPhase(t));
	assert.match(kick, /AUTO-CONTINUE longrun "ship-oauth"/);
	assert.match(kick, /hard-reset/);
	assert.match(kick, /zense_longrun next/);
	assert.match(kick, /never reconstruct state from memory/);
	// a wrong-arity call must fail loudly, not silently — assert the throw so future refactors keep the (cwd, tracker, phase) shape
	assert.throws(() => buildNextPhaseKickoff(t, nextPendingPhase(t)));
});

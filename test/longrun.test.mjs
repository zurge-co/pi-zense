import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	abandonLongrunWorktree,
	allPhasesDone,
	appendSpecsLog,
	buildContextCapsule,
	buildLongrunPlannerPrompt,
	checkpointCommit,
	compilePhaseSpec,
	discoverLongrunTrackers,
	droppedSeedIds,
	ensureLongrunWorktree,
	findPhase,
	healToBranch,
	parseLongrunPlan,
	loadTracker,
	longrunBranch,
	mergePhaseCriteria,
	nextPendingPhase,
	reconcileLongrunWorktree,
	renderTrackerMd,
	resetToCheckpoint,
	saveTracker,
	slugifyTitle,
	trackerPath,
	validateTracker,
	writePhaseSummary,
} from "../extensions/zense-harness/index.ts";

// long-running mode (ADR-004): tracker persistence/validation, criteria carry + provenance,
// capsule, checkpoint/reset git semantics, ambient-state-distrust reconcile, worktree reuse

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** temp repo with one commit on main (+ .zense ignored state) */
const mkRepo = () => {
	const root = mkdtempSync(join(tmpdir(), "zense-longrun-"));
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
	slug: "migrate-auth",
	title: "Migrate auth",
	intent: "Move auth to oauth",
	worktreeBranch: longrunBranch("migrate-auth"),
	status: "active",
	approvedAt: Date.now(),
	updatedAt: Date.now(),
	phases: [
		{ id: "p1", title: "store", intent: "token store", scope: ["src/store"], constraints: [], criteria: [{ id: "S1", text: "t", check: "true" }], status: "done", checkpoint: "abc123", summaryPath: "phases/p1.md" },
		{ id: "p2", title: "login flow", intent: "oauth login", scope: ["src/login"], constraints: ["no breaking"], criteria: [{ id: "S2", text: "t2", check: "true" }], status: "pending" },
	],
	...over,
});

// ---------- identity / persistence

test("slugifyTitle: letters kept, separators collapsed, capped (same regex as commitSpec's archive slugger)", () => {
	assert.equal(slugifyTitle("Migrate Auth to OAuth!"), "migrate-auth-to-oauth");
	assert.equal(slugifyTitle("ย้ายระบบ auth"), "ย-ายระบบ-auth"); // combining marks (\p{M}) collapse like commitSpec's slugger — same regex on purpose
	assert.equal(slugifyTitle("!!!"), "untitled");
	assert.ok(slugifyTitle("x".repeat(100)).length <= 40);
});

test("longrunBranch: deterministic per slug", () => {
	assert.equal(longrunBranch("migrate-auth"), "zense/longrun/migrate-auth");
});

test("tracker save→load roundtrip; atomic write leaves no tmp behind", () => {
	const root = mkRepo();
	const t = mkTracker();
	saveTracker(root, t);
	const loaded = loadTracker(root, t.slug);
	assert.equal(loaded.slug, "migrate-auth");
	assert.equal(loaded.phases.length, 2);
	assert.ok(existsSync(join(root, ".zense", "long-running", "migrate-auth", "tracker.md")), "md render written");
	assert.ok(existsSync(join(root, ".zense", "long-running", "migrate-auth", "phases")), "phases/ dir created");
	assert.ok(!readdirHasTmp(join(root, ".zense", "long-running", "migrate-auth")), "no tmp file left");
	rmSync(root, { recursive: true, force: true });
});

const readdirHasTmp = (dir) => readdirSync(dir).some((f) => f.includes(".tmp-"));

test("loadTracker: missing/corrupt → null (never throws into resume)", () => {
	const root = mkRepo();
	assert.equal(loadTracker(root, "nope"), null);
	const p = trackerPath(root, "broken");
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, "{not json");
	assert.equal(loadTracker(root, "broken"), null);
	rmSync(root, { recursive: true, force: true });
});

// ---------- validation / selection

test("validateTracker: catches dupes, empty scope, broken criteria", () => {
	const t = mkTracker();
	assert.deepEqual(validateTracker(t), []);
	const bad = mkTracker({
		slug: "",
		phases: [
			{ id: "p1", title: "", intent: "", scope: [], constraints: [], criteria: [{ id: "", text: "x", check: "" }], status: "pending" },
			{ id: "p1", title: "y", intent: "", scope: ["s"], constraints: [], criteria: [], status: "pending" },
		],
	});
	const errs = validateTracker(bad);
	assert.ok(errs.some((e) => e.includes("slug")));
	assert.ok(errs.some((e) => e.includes("duplicate phase id: p1")));
	assert.ok(errs.some((e) => e.includes("empty title")));
	assert.ok(errs.some((e) => e.includes("empty scope")));
	assert.ok(errs.some((e) => e.includes("empty id/check")));
});

test("phase selection: nextPendingPhase/allPhasesDone/findPhase", () => {
	const t = mkTracker();
	assert.equal(nextPendingPhase(t).id, "p2");
	assert.equal(allPhasesDone(t), false);
	assert.equal(findPhase(t, "p1").status, "done");
	t.phases[1].status = "done";
	assert.equal(nextPendingPhase(t), undefined);
	assert.equal(allPhasesDone(t), true);
});

// ---------- criteria carry + provenance (the tracker signature must survive compilation)

test("mergePhaseCriteria: seeds keep identity, extras marked compiled, id clash loses", () => {
	const seed = [{ id: "S1", text: "seed one", check: "a" }, { id: "S2", text: "seed two", check: "b" }];
	const merged = mergePhaseCriteria(seed, [{ id: "S2", text: "hijack", check: "x" }, { id: "E1", text: "extra", check: "c" }]);
	assert.equal(merged.length, 3);
	assert.deepEqual(merged.map((c) => c.id), ["S1", "S2", "E1"]);
	assert.equal(merged[1].text, "seed two", "clashing extra may not overwrite a seed");
	assert.deepEqual(merged.map((c) => c.origin), ["tracker", "tracker", "compiled"]);
});

test("droppedSeedIds: flags every seed the compiled spec lost", () => {
	const seed = [{ id: "S1", text: "", check: "" }, { id: "S2", text: "", check: "" }, { id: "S3", text: "", check: "" }];
	assert.deepEqual(droppedSeedIds(seed, [{ id: "S2", text: "", check: "" }]), ["S1", "S3"]);
	assert.deepEqual(droppedSeedIds(seed, seed), []);
});

// ---------- capsule: context discipline — done collapses to one line, active spelled out

test("buildContextCapsule: carries progress, one-line done summaries, active phase detail, worktree", () => {
	const root = mkRepo();
	const t = mkTracker();
	saveTracker(root, t);
	writeFileSync(join(root, ".zense", "long-running", t.slug, "phases", "p1.md"), "# p1 — store\n\ntoken store landed in src/store\n");
	t.phases[1].status = "active";
	const capsule = buildContextCapsule(root, t, t.phases[1]);
	assert.match(capsule, /\[zense longrun\] migrate-auth/);
	assert.match(capsule, /p1✓/);
	assert.match(capsule, /token store landed in src\/store/, "done phase collapses to its summary line");
	assert.match(capsule, /Active phase p2 "login flow": oauth login/);
	assert.match(capsule, /seed criteria .*: S2/);
	assert.match(capsule, /branch zense\/longrun\/migrate-auth/);
	assert.ok(!capsule.includes("token store intent body"), "done phase intent is NOT carried in full");
	rmSync(root, { recursive: true, force: true });
});

// ---------- git semantics: checkpoint / reset / reconcile (real temp repos)

test("checkpointCommit: commits phase work, never .zense", () => {
	const root = mkRepo();
	const { wt } = ensureLongrunWorktree(root, "migrate-auth", longrunBranch("migrate-auth"));
	writeFileSync(join(wt.root, "src.ts"), "export {}\n");
	mkdirSync(join(wt.root, ".zense"), { recursive: true });
	writeFileSync(join(wt.root, ".zense", "scratch.txt"), "state\n");
	const r = checkpointCommit(wt.root, "longrun(migrate-auth): p1 store");
	assert.equal(r.ok, true);
	assert.match(git(["log", "-1", "--format=%s"], wt.root), /longrun\(migrate-auth\): p1 store/);
	assert.equal(git(["status", "--porcelain"], wt.root).includes("src.ts"), false, "src committed");
	assert.equal(existsSync(join(wt.root, ".zense", "scratch.txt")), true, ".zense left on disk");
	assert.match(git(["show", "--name-only", "--format=", "HEAD"], wt.root).trim(), /src\.ts/);
	rmSync(root, { recursive: true, force: true });
});

test("resetToCheckpoint: phase discard = exact rewind incl. untracked leftovers (ADR-004 DENY: no reverse patch)", () => {
	const root = mkRepo();
	const { wt } = ensureLongrunWorktree(root, "migrate-auth", longrunBranch("migrate-auth"));
	const base = git(["rev-parse", "HEAD"], wt.root);
	writeFileSync(join(wt.root, "phase.ts"), "work\n");
	writeFileSync(join(wt.root, "a.txt"), "modified\n");
	const r = resetToCheckpoint(wt.root, base);
	assert.equal(r.ok, true);
	assert.equal(readFileSync(join(wt.root, "a.txt"), "utf8"), "a\n", "tracked rewound");
	assert.equal(existsSync(join(wt.root, "phase.ts")), false, "untracked cleaned");
	rmSync(root, { recursive: true, force: true });
});

test("ensureLongrunWorktree: create once, reattach by slug across 'sessions', never duplicate", () => {
	const root = mkRepo();
	const a = ensureLongrunWorktree(root, "migrate-auth", longrunBranch("migrate-auth"));
	assert.equal(a.created, true);
	assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], a.wt.root), "zense/longrun/migrate-auth");
	const b = ensureLongrunWorktree(root, "migrate-auth", longrunBranch("migrate-auth"));
	assert.equal(b.created, false, "second call reuses");
	assert.equal(b.wt.root, a.wt.root);
	// orphaned branch (dir gone, branch kept) → re-checkout, not a second branch
	rmSync(a.wt.root, { recursive: true, force: true });
	git(["worktree", "prune"], root);
	const c = ensureLongrunWorktree(root, "migrate-auth", longrunBranch("migrate-auth"));
	assert.equal(c.created, true);
	assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], c.wt.root), "zense/longrun/migrate-auth");
	rmSync(root, { recursive: true, force: true });
});

test("reconcileLongrunWorktree: ambient-state distrust — ok/wrong-branch/detached/dirty/missing/diverged", () => {
	const root = mkRepo();
	const { wt } = ensureLongrunWorktree(root, "migrate-auth", longrunBranch("migrate-auth"));
	const branch = longrunBranch("migrate-auth");
	// missing
	assert.equal(reconcileLongrunWorktree(join(root, "gone"), branch).status, "missing-worktree");
	// clean ok
	let r = reconcileLongrunWorktree(wt.root, branch);
	assert.equal(r.status, "ok");
	assert.equal(r.dirty.length, 0);
	// dirty (does not flip status, but blocks auto-heal on mismatch)
	writeFileSync(join(wt.root, "dirty.ts"), "x\n");
	r = reconcileLongrunWorktree(wt.root, branch);
	assert.equal(r.status, "ok");
	assert.equal(r.healable, false);
	assert.ok(r.dirty.some((l) => l.includes("dirty.ts")));
	// wrong branch + dirty → not healable (never auto-switch away from human work)
	git(["switch", "-q", "-c", "user-topic"], wt.root);
	r = reconcileLongrunWorktree(wt.root, branch);
	assert.equal(r.status, "wrong-branch");
	assert.equal(r.actualBranch, "user-topic");
	assert.equal(r.healable, false);
	// clean now → healable, and healToBranch actually returns
	rmSync(join(wt.root, "dirty.ts"));
	r = reconcileLongrunWorktree(wt.root, branch);
	assert.equal(r.healable, true);
	assert.equal(healToBranch(wt.root, branch).ok, true);
	assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], wt.root), branch);
	// detached
	const head = git(["rev-parse", "HEAD"], wt.root);
	git(["checkout", "-q", head], wt.root);
	r = reconcileLongrunWorktree(wt.root, branch);
	assert.equal(r.status, "detached");
	assert.equal(healToBranch(wt.root, branch).ok, true);
	// checkpoint diverged (branch rewound behind our back) → human, never auto-heal
	git(["commit", "-q", "--allow-empty", "-m", "cp", "--no-verify"], wt.root);
	const ckpt = git(["rev-parse", "HEAD"], wt.root);
	git(["reset", "-q", "--hard", "HEAD~1"], wt.root);
	r = reconcileLongrunWorktree(wt.root, branch, ckpt);
	assert.equal(r.status, "checkpoint-diverged");
	assert.equal(r.healable, false);
	rmSync(root, { recursive: true, force: true });
});

test("reconcile: user commits ahead of checkpoint are visible (amendment reconciliation)", () => {
	const root = mkRepo();
	const { wt } = ensureLongrunWorktree(root, "migrate-auth", longrunBranch("migrate-auth"));
	const ckpt = git(["rev-parse", "HEAD"], wt.root);
	git(["commit", "-q", "--allow-empty", "-m", "human edit", "--no-verify"], wt.root);
	const r = reconcileLongrunWorktree(wt.root, longrunBranch("migrate-auth"), ckpt);
	assert.equal(r.status, "ok");
	assert.equal(r.commitsSinceCheckpoint, 1);
	rmSync(root, { recursive: true, force: true });
});

// ---------- closure summary / rendering / discovery

test("writePhaseSummary + renderTrackerMd reflect the closure", () => {
	const root = mkRepo();
	const t = mkTracker();
	saveTracker(root, t);
	const rel = writePhaseSummary(root, t, t.phases[1], "oauth login landed", ["src/login.ts"]);
	assert.equal(rel, "phases/p2.md");
	assert.match(readFileSync(join(root, ".zense", "long-running", t.slug, rel), "utf8"), /oauth login landed/);
	t.phases[1].status = "done";
	t.phases[1].checkpoint = "def456";
	t.phases[1].summaryPath = rel; // writePhaseSummary returns the path; the tracker stores it (close does this in index.ts)
	const md = renderTrackerMd(t);
	assert.match(md, /# Migrate auth — long-running tracker v1/);
	assert.match(md, /✅ p1 — store/);
	assert.match(md, /✅ p2 — login flow/);
	assert.match(md, /checkpoint: def456/);
	assert.match(md, /summary: phases\/p2\.md/);
	rmSync(root, { recursive: true, force: true });
});

// ---------- planner / phase-spec compilation (drafted by the model, signed by the human)

test("parseLongrunPlan: bare JSON, fenced JSON, and pointed errors on bad shape", () => {
	const good = { phases: [{ id: "p1", title: "store", intent: "token store", scope: ["src/store"], criteria: [{ id: "P1C1", text: "exists", check: "test -d src/store" }] }] };
	const bare = parseLongrunPlan(JSON.stringify(good));
	assert.equal(bare.ok, true);
	assert.equal(bare.phases[0].id, "p1");
	const fenced = parseLongrunPlan("Here is the plan:\n```json\n" + JSON.stringify(good) + "\n```\nhope that helps");
	assert.equal(fenced.ok, true, "prose + fences tolerated");
	assert.equal(parseLongrunPlan("no json here").ok, false);
	assert.match(parseLongrunPlan("{bad json}").error ?? "", /JSON\.parse failed/);
	assert.match(parseLongrunPlan("{").error ?? "", /no JSON object/, "brace without close is not a parse attempt");
	const noPhases = parseLongrunPlan(JSON.stringify({ phases: [] }));
	assert.equal(noPhases.ok, false);
	const badCrit = parseLongrunPlan(JSON.stringify({ phases: [{ ...good.phases[0], criteria: [{ id: "X", text: "t" }] }] }));
	assert.equal(badCrit.ok, false);
	assert.match(badCrit.error ?? "", /id\/text\/check/);
	const badScope = parseLongrunPlan(JSON.stringify({ phases: [{ ...good.phases[0], scope: [] }] }));
	assert.equal(badScope.ok, false);
	assert.match(badScope.error ?? "", /scope/);
});

test("buildLongrunPlannerPrompt: demands ordered phases + runnable checks, embeds the requirement doc", () => {
	const prompt = buildLongrunPlannerPrompt("Migrate auth", "Move to oauth", "# Spec\nbody");
	assert.match(prompt, /Migrate auth/);
	assert.match(prompt, /Move to oauth/);
	assert.match(prompt, /# Spec\nbody/);
	assert.match(prompt, /"phases"/);
	assert.match(prompt, /runnable command/);
});

test("compilePhaseSpec: title/intent/provenance derive from the tracker; seeds keep origin", () => {
	const t = mkTracker();
	const draft = compilePhaseSpec(t, t.phases[1], [{ id: "E1", text: "extra", check: "true" }]);
	assert.equal(draft.title, "longrun(migrate-auth) p2 – login flow");
	assert.equal(draft.provenance, "tracker:migrate-auth@v1");
	assert.match(draft.intent, /oauth login/);
	assert.match(draft.intent, /tracker v1/);
	assert.deepEqual(draft.scope, ["src/login"]);
	assert.deepEqual(draft.criteria.map((c) => [c.id, c.origin]), [["S2", "tracker"], ["E1", "compiled"]]);
});

test("abandonLongrunWorktree: destroys worktree+branch; main untouched (ADR-004 upside)", () => {
	const root = mkRepo();
	const t = mkTracker();
	const { wt } = ensureLongrunWorktree(root, t.slug, t.worktreeBranch);
	writeFileSync(join(wt.root, "phase.ts"), "work\n");
	assert.equal(checkpointCommit(wt.root, "longrun(migrate-auth): p1 store").ok, true);
	const mainHead = git(["rev-parse", "HEAD"], root);
	const r = abandonLongrunWorktree(root, t);
	assert.equal(r.ok, true);
	assert.equal(existsSync(wt.root), false, "worktree removed");
	assert.equal(git(["branch", "--list", t.worktreeBranch], root), "", "branch deleted");
	assert.equal(git(["rev-parse", "HEAD"], root), mainHead, "main HEAD never moved");
	assert.equal(git(["status", "--porcelain"], root), "", "main tree clean — nothing was ever staged");
	// idempotent against an already-pruned worktree
	assert.equal(abandonLongrunWorktree(root, t).ok, true);
	rmSync(root, { recursive: true, force: true });
});

test("appendSpecsLog: the requirement doc accumulates history lines", () => {
	const root = mkRepo();
	const t = mkTracker();
	saveTracker(root, t);
	appendSpecsLog(root, t.slug, "tracker v1 signed (2 phases: p1, p2)");
	const specs = readFileSync(join(root, ".zense", "long-running", t.slug, "specs.md"), "utf8");
	assert.match(specs, /tracker v1 signed \(2 phases: p1, p2\)/);
	rmSync(root, { recursive: true, force: true });
});

test("discoverLongrunTrackers: finds active trackers sorted by recency, skips done/corrupt", () => {
	const root = mkRepo();
	const a = mkTracker({ slug: "a-req", title: "A", updatedAt: 1000 });
	const b = mkTracker({ slug: "b-req", title: "B", status: "done", updatedAt: 3000, worktreeBranch: longrunBranch("b-req") });
	saveTracker(root, a);
	saveTracker(root, b);
	// saveTracker bumps updatedAt on every write — pin deterministic values post-save to test the sort
	writeFileSync(trackerPath(root, "a-req"), JSON.stringify({ ...a, updatedAt: 1000 }));
	writeFileSync(trackerPath(root, "b-req"), JSON.stringify({ ...b, updatedAt: 3000 }));
	mkdirSync(join(root, ".zense", "long-running", "corrupt"), { recursive: true });
	writeFileSync(join(root, ".zense", "long-running", "corrupt", "tracker.json"), "{bad");
	const found = discoverLongrunTrackers(root);
	assert.deepEqual(found.map((t) => t.slug), ["b-req", "a-req"], "updatedAt desc, corrupt skipped");
	assert.equal(found.filter((t) => t.status === "active").length, 1);
	rmSync(root, { recursive: true, force: true });
});

import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, appendFileSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	rewritePathForWorktree,
	buildWorktreeCommand,
	createWorktree,
	applyWorktreeBack,
	discardPendingApply,
	acceptPendingApply,
	composeCommitMessage,
	sanitizeSubject,
	gitOk,
} from "../extensions/zense-harness/index.ts";

// ----- pure helpers (path/command rewrite) -----

test("rewritePathForWorktree: relative path under the repo → remapped under wtRoot", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "extensions/x.ts"), "/r-wt/extensions/x.ts");
});

test("rewritePathForWorktree: absolute path under cwd → remapped under wtRoot", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "/r/a/b.ts"), "/r-wt/a/b.ts");
});

test("rewritePathForWorktree: path outside the repo (absolute, not under cwd) → unchanged", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "/Users/elsewhere/doc.md"), "/Users/elsewhere/doc.md");
});

test("rewritePathForWorktree: relative escape (../) → not under wtRoot", () => {
	const out = rewritePathForWorktree("/r/sub", "/r/sub-wt", "../outside.txt");
	assert.ok(!out.startsWith("/r/sub-wt"), `expected not under wtRoot, got ${out}`);
});

test("rewritePathForWorktree: path under .zense/ → unchanged (harness state lives in main)", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", ".zense/spec.md"), ".zense/spec.md");
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "/r/.zense/memory.jsonl"), "/r/.zense/memory.jsonl");
});

test("buildWorktreeCommand: prefixed with cd <wtRoot> && (spacey paths single-quoted)", () => {
	assert.equal(buildWorktreeCommand("npm test", "/r-wt"), "cd '/r-wt' && npm test");
	assert.equal(buildWorktreeCommand("ls", "/path with space/wt"), "cd '/path with space/wt' && ls");
});

// ----- git integration (temp repo) -----

const SPEC = {
	version: 1,
	title: "Add src module",
	intent: "Implement the src module for testing apply-back.",
	scope: [],
	constraints: [],
	criteria: [],
	specDebt: [],
	approved: true,
};

/** git runner bound to a dir (for committing inside a worktree) */
const gitIn = (dir) => (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** create a temp git repo with an initial commit */
const makeRepo = () => {
	const base = mkdtempSync(join(tmpdir(), "zense-wt-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, "README.md"), "# init\n");
	mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "x"), "x"); // placeholder
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	return { cwd, base, git };
};

/** staged paths in main (excluding .zense) — assertion helper */
const stagedIn = (git) => git(["diff", "--cached", "--name-only", "--", ".", ":!.zense"]).split("\n").map((s) => s.trim()).filter(Boolean);

test("gitOk: returns ok=false in a non-git dir", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-nogit-"));
	const r = gitOk(["status"], base);
	assert.equal(r.ok, false);
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: creates the worktree + a zense/impl/* branch + copies spec.json in", () => {
	const { cwd, base, git } = makeRepo();
	writeFileSync(join(cwd, ".zense", "spec.json"), '{"version":1}');
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt, "worktree should be created");
	assert.ok(wt.branch.startsWith("zense/impl/v1-"), `branch=${wt.branch}`);
	// the worktree must nest under <repo>/.zense/worktree/ (not a sibling of the repo)
	assert.equal(
		join(cwd, ".zense", "worktree"),
		dirname(wt.root),
		`worktree parent should be .zense/worktree, got ${wt.root}`,
	);
	assert.ok(basename(wt.root).startsWith("repo-wt-"), `wt name keeps repo basename: ${wt.root}`);
	assert.ok(existsSync(join(wt.root, "README.md")), "worktree has checked-out file");
	assert.ok(existsSync(join(wt.root, ".zense", "spec.json")), "spec.json copied into worktree");
	const list = git(["worktree", "list"]);
	assert.ok(list.includes(wt.root), "worktree listed by git");
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: main repo git status stays clean (nested worktree excluded via .git/info/exclude)", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	assert.equal(git(["status", "--porcelain"]).trim(), "", "main git status should be clean");
	// the exclusion lives in local .git/info/exclude, never in tracked files
	const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
	assert.ok(exclude.includes("/.zense/worktree/"), `exclude has worktree path: ${exclude}`);
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: captures baseline ref (main HEAD before branch)", () => {
	const { cwd, base, git } = makeRepo();
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt, "worktree should be created");
	assert.equal(wt.baseline, headBefore, "baseline = main HEAD right before branching");
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: in a non-git dir → null, no throw", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-nogit2-"));
	const wt = createWorktree(base, SPEC);
	assert.equal(wt, null);
	rmSync(base, { recursive: true, force: true });
});

// ----- applyWorktreeBack (ADR-003: staged-only, never commits) -----

test("applyWorktreeBack: eval PASS → change staged in main, HEAD unmoved (no new commit) + worktree/branch cleaned + reverse patch stored", () => {
	const { cwd, base, git } = makeRepo();
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	// simulate an agent edit inside the worktree
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply should succeed: ${ar.msg}`);
	// ADR-003 core: main HEAD unmoved — apply created no commit
	assert.equal(git(["rev-parse", "HEAD"]).trim(), headBefore, "HEAD must not move (no auto-commit)");
	assert.deepEqual(git(["log", "--format=%s"]).trim().split("\n"), ["init"], "main log unchanged");
	// the change sits staged in the index, awaiting a human commit
	assert.deepEqual(stagedIn(git), ["src.txt"], "src.txt staged in main");
	assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "impl\n");
	assert.deepEqual(ar.paths, ["src.txt"]);
	// ready-made commit message from the squashed commit (subject = spec title)
	assert.ok(ar.commitMsg.includes("Add src module"), `commitMsg has spec title: ${ar.commitMsg}`);
	// reverse patch stored for discard
	assert.ok(readFileSync(join(cwd, ".zense", "pending-apply.patch"), "utf8").includes("src.txt"), "reverse patch stored");
	// worktree + branch cleaned up
	assert.ok(!existsSync(wt.root), "worktree dir removed");
	assert.equal(git(["branch", "--list", wt.branch]).trim(), "", "branch deleted");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: several interim commits + an uncommitted file → squashed and fully staged in main (log unmoved)", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	const gwt = gitIn(wt.root);
	writeFileSync(join(wt.root, "a.txt"), "a\n");
	gwt(["add", "a.txt"]);
	gwt(["commit", "-q", "-m", "wip: add a"]);
	writeFileSync(join(wt.root, "b.txt"), "b\n");
	gwt(["add", "b.txt"]);
	gwt(["commit", "-q", "-m", "wip: add b"]);
	writeFileSync(join(wt.root, "c.txt"), "c\n"); // last file, uncommitted
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply should succeed: ${ar.msg}`);
	// no interim commits ever reach main — the log is untouched
	assert.deepEqual(git(["log", "--format=%s"]).trim().split("\n"), ["init"], "main log unchanged (no interim, no merge commit)");
	// every file (incl. uncommitted) fully staged
	assert.deepEqual(stagedIn(git).sort(), ["a.txt", "b.txt", "c.txt"], "all files staged");
	// the ready-made message must list the interims (traceability)
	assert.ok(ar.commitMsg.includes("wip: add a") && ar.commitMsg.includes("wip: add b"), `commitMsg lists interims: ${ar.commitMsg}`);
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: unchanged worktree → ok=true with empty paths, main clean, fully cleaned up", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply should succeed: ${ar.msg}`);
	assert.deepEqual(ar.paths, [], "no paths staged");
	assert.deepEqual(stagedIn(git), [], "nothing staged in main");
	assert.deepEqual(git(["log", "--format=%s"]).trim().split("\n"), ["init"], "main log unchanged");
	assert.ok(!existsSync(wt.root), "worktree cleaned up");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: repo gitignoring .zense/ — worktree staging must not fail (git ≥2.55 exclude-pathspec regression) + .zense never follows into main", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-wt-ignored-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = gitIn(cwd);
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, ".gitignore"), ".zense/\n"); // ← the case where git add with ':!.zense' used to fatal exit 1
	writeFileSync(join(cwd, "README.md"), "# init\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	writeFileSync(join(wt.root, ".zense", "spec.json"), "{}\n"); // harness state is ignored in the worktree too (via .gitignore)
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply must succeed despite .zense being gitignored: ${ar.msg}`);
	assert.deepEqual(stagedIn(git), ["src.txt"], "only sources staged — harness state stays behind");
	assert.ok(!existsSync(wt.root), "worktree cleaned up");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: dirty-main guard — uncommitted changes outside .zense → refuse (ok=false dirtyMain), branch/worktree untouched", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	// a human edit is left uncommitted in main
	writeFileSync(join(cwd, "README.md"), "# human change\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, false, `apply should be refused: ${ar.msg}`);
	assert.equal(ar.dirtyMain, true, "flagged as dirtyMain");
	// worktree + branch must survive (retry-safe, no work lost)
	assert.ok(existsSync(wt.root), "worktree kept");
	assert.ok(git(["branch", "--list", wt.branch]).trim(), "branch kept");
	// the human's file is untouched
	assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "# human change\n");
	assert.deepEqual(stagedIn(git), [], "nothing staged by failed apply");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: the guard ignores .zense — dirty .zense in main doesn't block apply (policy)", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	// .zense/ (harness state) dirty in main — must not trip the guard
	appendFileSync(join(cwd, ".zense", "x"), "state-dirty");
	writeFileSync(join(cwd, ".zense", "memory.jsonl"), "{}\n"); // untracked inside .zense too
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply should succeed despite dirty .zense: ${ar.msg}`);
	assert.deepEqual(stagedIn(git), ["src.txt"]);
	// main's .zense must be untouched by apply
	assert.equal(readFileSync(join(cwd, ".zense", "memory.jsonl"), "utf8"), "{}\n");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: conflict (another session edited the same file in main) → ok=false conflict=true, main rolled back clean, worktree kept", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	// the other session edits + commits the same file in main first
	writeFileSync(join(cwd, "src.txt"), "main-change\n");
	git(["add", "src.txt"]);
	git(["commit", "-q", "-m", "other session"]);
	// this session edits the same file in the worktree
	writeFileSync(join(wt.root, "src.txt"), "wt-change\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, false);
	assert.equal(ar.conflict, true);
	// main must be rolled back clean (no conflict markers / staged junk)
	assert.equal(git(["status", "--porcelain", "--", ".", ":!.zense"]).trim(), "", "main clean after abort");
	assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "main-change\n");
	// the worktree survives (for human resolution)
	assert.ok(existsSync(wt.root), "worktree kept for manual resolve");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: no .zense changes in the staged result (harness state never follows into main) — via both staging and interim commits in the worktree", () => {
	const { cwd, base, git } = makeRepo();
	// make .zense/spec.md tracked in main first
	mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "spec.md"), "# old\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "add spec"]);
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	const gwt = gitIn(wt.root);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	gwt(["add", "src.txt"]);
	gwt(["commit", "-q", "-m", "wip: src"]);
	writeFileSync(join(wt.root, ".zense", "spec.md"), "# new\n");
	gwt(["add", ".zense/spec.md"]);
	gwt(["commit", "-q", "-m", "wip: zense state"]);
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true);
	// nothing .zense/spec.md may be staged in main
	const staged = stagedIn(git);
	assert.ok(!staged.some((p) => p.startsWith(".zense")), `no .zense in staged: ${staged}`);
	assert.deepEqual(staged, ["src.txt"]);
	// main's spec.md still has the old content (untouched)
	assert.equal(readFileSync(join(cwd, ".zense", "spec.md"), "utf8"), "# old\n");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: multi-session — A's apply sits staged, B applies after → the guard must refuse (mixing is the only alternative)", () => {
	const { cwd, base, git } = makeRepo();
	// session A: applied successfully (staged in main)
	const wtA = createWorktree(cwd, SPEC);
	assert.ok(wtA);
	writeFileSync(join(wtA.root, "a.txt"), "a\n");
	const arA = applyWorktreeBack(cwd, SPEC, wtA);
	assert.equal(arA.ok, true);
	// session B: a new worktree (branched from the same HEAD — A hasn't committed) tries to apply
	const specB = { ...SPEC, version: 2, title: "Add b module" };
	const wtB = createWorktree(cwd, specB);
	assert.ok(wtB);
	writeFileSync(join(wtB.root, "b.txt"), "b\n");
	const arB = applyWorktreeBack(cwd, specB, wtB);
	assert.equal(arB.ok, false, "B must be refused while A's staged changes pending");
	assert.equal(arB.dirtyMain, true);
	assert.ok(existsSync(wtB.root), "B worktree kept");
	// A's staged files must be intact, untouched
	assert.deepEqual(stagedIn(git), ["a.txt"]);
	rmSync(base, { recursive: true, force: true });
});

// ----- discardPendingApply (the post-review undo path) -----

test("discardPendingApply: rolls back the applied change → new files removed, main exactly back to its pre-apply state", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	appendFileSync(join(wt.root, "README.md"), "added-line\n"); // also touch a tracked file
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true);
	// human review → unhappy → discard
	const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, true, `discard should succeed: ${dr.msg}`);
	// the apply-created file must be gone / the tracked file restored
	assert.ok(!existsSync(join(cwd, "src.txt")), "new file removed by reverse patch");
	assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "# init\n", "tracked file restored");
	assert.equal(git(["status", "--porcelain", "--", ".", ":!.zense"]).trim(), "", "main clean as before apply");
	// patch/msg swept
	assert.ok(!existsSync(join(cwd, ".zense", "pending-apply.patch")), "patch cleaned");
	rmSync(base, { recursive: true, force: true });
});

test("discardPendingApply: human edited the applied files → reverse fails loudly and never deletes human work", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true);
	// the human overwrites the applied file afterwards
	writeFileSync(join(cwd, "src.txt"), "human edit\n");
	const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, false, "reverse must fail when human edited applied files");
	// the human's content fully survives — never silently deleted
	assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "human edit\n");
	// the patch stays around for the human to decide
	assert.ok(existsSync(join(cwd, ".zense", "pending-apply.patch")), "patch kept on failure");
	rmSync(base, { recursive: true, force: true });
});

test("discardPendingApply: no pending patch → ok=false without breaking anything", () => {
	const { cwd, base } = makeRepo();
	const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, false);
	assert.ok(dr.msg.includes("not found"), `msg explains: ${dr.msg}`);
	rmSync(base, { recursive: true, force: true });
});

test("discardPendingApply: empty patch (apply had no source change) → ok=true, unstage only, no breakage", () => {
	const { cwd, base, git } = makeRepo();
	mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "pending-apply.patch"), ""); // apply whose interim commits touched only .zense → empty patch
	// stage something first (simulating leftover index)
	writeFileSync(join(cwd, "leftover.txt"), "x\n");
	git(["add", "leftover.txt"]);
	const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, true, `discard should succeed: ${dr.msg}`);
	// the index is unstaged (the file remains untracked — an empty patch can't force-delete it)
	assert.equal(git(["diff", "--cached", "--name-only"]).trim(), "", "index unstaged");
	assert.ok(!existsSync(join(cwd, ".zense", "pending-apply.patch")), "patch cleaned");
	rmSync(base, { recursive: true, force: true });
});

test("composeCommitMessage: single-line subject ≤72 chars + interim list + footer", () => {
	assert.equal(sanitizeSubject("hello   world\nsecond line"), "hello world second line");
	const long = "x".repeat(100);
	const s = sanitizeSubject(long);
	assert.ok(s.length <= 72, `subject ≤72: ${s.length}`);
	assert.ok(s.endsWith("…"), "long subject truncated with ellipsis");
	assert.equal(sanitizeSubject(""), "zense impl");
	const msg = composeCommitMessage(SPEC, ["wip: one", "wip: two"]);
	assert.ok(msg.startsWith("Add src module\n\n"), `subject first: ${msg}`);
	assert.ok(msg.includes("- wip: one") && msg.includes("- wip: two"), `lists interims: ${msg}`);
	assert.ok(msg.includes("zense spec v1"), `footer: ${msg}`);
	const bare = composeCommitMessage({ ...SPEC, intent: "" }, []);
	assert.ok(!bare.includes("Squashed"), "no interim section when empty");
});

// ----- acceptPendingApply (pendingApply's accept side — counterpart of the discard tests above) -----

/** Simulate the state after applyWorktreeBack: patch+msg pending in .zense + the worktree's change staged in the index */
const seedPending = ({ cwd, git }) => {
	writeFileSync(join(cwd, ".zense", "pending-apply.patch"), "dummy reverse patch\n");
	writeFileSync(join(cwd, ".zense", "pending-apply.msg"), "Add src module\n\nbody from composeCommitMessage\n");
	writeFileSync(join(cwd, "src.txt"), "from worktree\n");
	git(["add", "src.txt"]);
};

const pendingFiles = (cwd) => ({
	patch: existsSync(join(cwd, ".zense", "pending-apply.patch")),
	msg: existsSync(join(cwd, ".zense", "pending-apply.msg")),
});

test("acceptPendingApply: no pending patch → clear ok=false, repo untouched", () => {
	const { cwd, base, git } = makeRepo();
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const r = acceptPendingApply(cwd);
	assert.equal(r.ok, false);
	assert.match(r.msg, /no pending apply/);
	assert.equal(git(["rev-parse", "HEAD"]).trim(), headBefore);
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: the human committed themselves (empty index, HEAD moved) → ok, patch+msg removed, no warnings", () => {
	const { cwd, base, git } = makeRepo();
	const preApplyHead = git(["rev-parse", "HEAD"]).trim();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]); // the human's own commit
	const r = acceptPendingApply(cwd, { preApplyHead });
	assert.equal(r.ok, true, r.msg);
	assert.equal(r.committedOnBehalf, false);
	assert.deepEqual(r.warnings, []);
	assert.deepEqual(pendingFiles(cwd), { patch: false, msg: false });
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: soft mode — empty index but HEAD unmoved (change vanished?) → still ok, warning attached, never refuses", () => {
	const { cwd, base, git } = makeRepo();
	const preApplyHead = git(["rev-parse", "HEAD"]).trim();
	seedPending({ cwd, git });
	git(["reset", "-q", "--hard", "HEAD"]); // simulate the change being reset away outside the flow (empty index, no new commit)
	const r = acceptPendingApply(cwd, { preApplyHead });
	assert.equal(r.ok, true, "soft mode accepts even when suspect");
	assert.equal(r.warnings.length, 1);
	assert.match(r.warnings[0], /HEAD/);
	assert.deepEqual(pendingFiles(cwd), { patch: false, msg: false });
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: still staged + no commit-on-behalf requested → ok=false explaining both ways out", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const r = acceptPendingApply(cwd);
	assert.equal(r.ok, false);
	assert.match(r.msg, /commitIfStaged=true \/ \/zense accept commit/);
	assert.equal(git(["rev-parse", "HEAD"]).trim(), headBefore, "must never commit unprompted");
	assert.deepEqual(pendingFiles(cwd), { patch: true, msg: true }, "not yet accepted → patch+msg must remain");
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: commitIfStaged=true ('commit it for me') → commits with the prepared message, then clears patch+msg", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	const r = acceptPendingApply(cwd, { commitIfStaged: true });
	assert.equal(r.ok, true, r.msg);
	assert.equal(r.committedOnBehalf, true);
	assert.equal(git(["log", "-1", "--format=%s"]).trim(), "Add src module", "subject comes from pending-apply.msg");
	// the commit must contain src.txt (staged at seed time) but no .zense/
	assert.deepEqual(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").filter(Boolean), ["src.txt"]);
	assert.deepEqual(pendingFiles(cwd), { patch: false, msg: false });
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: human amendments — evalTree differs from HEAD^{tree} → returns only the human-edited files", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]);
	const evalTree = git(["rev-parse", "HEAD^{tree}"]).trim(); // the tree at apply time (repinned like lastEval.head)
	writeFileSync(join(cwd, "src.txt"), "human tweak\n"); // human edit after the grader passed
	writeFileSync(join(cwd, "extra.md"), "human notes\n");
	git(["add", "src.txt", "extra.md"]);
	git(["commit", "-q", "-m", "human adjustments after review"]);
	const r = acceptPendingApply(cwd, { evalTree });
	assert.equal(r.ok, true, r.msg);
	assert.deepEqual(r.amendedFiles.sort(), ["extra.md", "src.txt"]);
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: evalTree equals HEAD^{tree} (no human edits) → amendedFiles empty", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]);
	const evalTree = git(["rev-parse", "HEAD^{tree}"]).trim();
	const r = acceptPendingApply(cwd, { evalTree });
	assert.equal(r.ok, true, r.msg);
	assert.deepEqual(r.amendedFiles, []);
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: no evalTree → the delta is skipped quietly (amendedFiles empty)", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]);
	const r = acceptPendingApply(cwd, {});
	assert.equal(r.ok, true, r.msg);
	assert.deepEqual(r.amendedFiles, []);
	rmSync(base, { recursive: true, force: true });
});

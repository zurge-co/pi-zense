import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uncommittedChanges, snapshotUncommitted, composeSnapshotMessage, isGitRepo, gitAddButZense } from "../extensions/zense-harness/index.ts";

/** temp git repo with an initial commit (tracked: README.md + .zense/x) */
const makeRepo = () => {
	const base = mkdtempSync(join(tmpdir(), "zense-dirty-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, "README.md"), "# init\n");
	mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "x"), "x");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	return { cwd, base, git };
};

test("uncommittedChanges: clean repo → [] (incl. modified .zense — harness state doesn't count)", () => {
	const { cwd, base } = makeRepo();
	assert.deepEqual(uncommittedChanges(cwd), []);
	appendFileSync(join(cwd, ".zense", "x"), "dirty"); // touch only .zense
	writeFileSync(join(cwd, ".zense", "memory.jsonl"), "{}\n"); // untracked inside .zense
	assert.deepEqual(uncommittedChanges(cwd), []);
	rmSync(base, { recursive: true, force: true });
});

test("uncommittedChanges: modified tracked + new untracked files → both listed", () => {
	const { cwd, base } = makeRepo();
	appendFileSync(join(cwd, "README.md"), "more\n");
	writeFileSync(join(cwd, "new.ts"), "export {};\n");
	const out = uncommittedChanges(cwd);
	assert.equal(out.length, 2, `expected 2 entries, got ${JSON.stringify(out)}`);
	assert.ok(out.some((l) => l.includes("README.md")), out.join(","));
	assert.ok(out.some((l) => l.includes("new.ts")), out.join(","));
	rmSync(base, { recursive: true, force: true });
});

test("uncommittedChanges: non-git dir → [] (degrades silently, never blocks compile)", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-dirty-nogit-"));
	assert.deepEqual(uncommittedChanges(base), []);
	rmSync(base, { recursive: true, force: true });
});

test("snapshotUncommitted: commits pending changes outside .zense → repo clean, no .zense in the commit", () => {
	const { cwd, base, git } = makeRepo();
	writeFileSync(join(cwd, "wip.ts"), "// wip\n");
	writeFileSync(join(cwd, ".zense", "memory.jsonl"), "{}\n"); // must not be committed
	const r = snapshotUncommitted(cwd, composeSnapshotMessage(uncommittedChanges(cwd)));
	assert.equal(r.ok, true, r.msg);
	assert.notEqual(r.msg, "nothing to commit");
	assert.deepEqual(uncommittedChanges(cwd), []); // everything outside .zense is clean now
	const files = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").map((s) => s.trim()).filter(Boolean);
	assert.deepEqual(files, ["wip.ts"], `committed files: ${files}`);
	const subject = git(["log", "-1", "--format=%s"]).trim();
	assert.ok(subject.startsWith("chore: snapshot pre-spec"), subject);
	assert.ok(subject.includes("wip.ts"), `subject must name the actual pending file, not fixed text: ${subject}`);
	rmSync(base, { recursive: true, force: true });
});

test("composeSnapshotMessage: subject built from real files (≤72 chars) + body lists every file", () => {
	const m = composeSnapshotMessage([" M src/a.ts", "?? new.ts", "R  old.ts -> renamed.ts"]);
	const [subject, , ...body] = m.split("\n");
	assert.ok(subject.length <= 72, `subject too long: ${subject.length}`);
	assert.ok(subject.includes("src/a.ts, new.ts"), subject);
	assert.ok(subject.includes("old.ts -> renamed.ts"), `3 short files should all fit in the subject: ${subject}`);
	assert.ok(body.join("\n").includes("- old.ts -> renamed.ts"));
	// many files → subject truncated with (+N) but the body is complete
	const many = Array.from({ length: 30 }, (_, i) => `?? file-${i}.ts`);
	const m2 = composeSnapshotMessage(many);
	const subject2 = m2.split("\n")[0];
	assert.ok(subject2.length <= 72, `subject too long: ${subject2.length}`);
	assert.ok(subject2.includes("(+27)"), subject2);
	assert.equal(m2.split("\n").filter((l) => l.startsWith("- ")).length, 30);
});

test("isGitRepo: detects both cases — feature guards must switch off entirely outside git repos", () => {
	const { cwd, base } = makeRepo();
	assert.equal(isGitRepo(cwd), true);
	rmSync(base, { recursive: true, force: true });
	const nogit = mkdtempSync(join(tmpdir(), "zense-dirty-nogit-"));
	assert.equal(isGitRepo(nogit), false);
	rmSync(nogit, { recursive: true, force: true });
});

test("snapshotUncommitted: .zense/ in .gitignore → add must not fail (git ≥2.55 exclude-pathspec regression) + no .zense in the commit", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-dirty-ignored-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, ".gitignore"), ".zense/\n");
	writeFileSync(join(cwd, "README.md"), "# init\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	writeFileSync(join(cwd, "wip.ts"), "// wip\n");
	mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "spec.json"), "{}\n"); // ignored — the old add died right here
	const r = snapshotUncommitted(cwd, "chore: snapshot");
	assert.equal(r.ok, true, `snapshot must succeed despite .zense being ignored: ${r.msg}`);
	assert.match(r.msg, /^[0-9a-f]{7,}$/, `msg must be the snapshot commit's short hash: ${r.msg}`);
	const files = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").map((s) => s.trim()).filter(Boolean);
	assert.deepEqual(files, ["wip.ts"], `the commit must not drag .zense/.gitignore along: ${files}`);
	assert.deepEqual(uncommittedChanges(cwd), []); // everything outside .zense is clean now
	rmSync(base, { recursive: true, force: true });
});

test("gitAddButZense: repo without a first commit (no HEAD) + .zense not ignored → sources only staged, .zense never enters the index", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-dirty-nohead-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, "src.ts"), "export {};\n");
	mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "spec.json"), "{}\n");
	const add = gitAddButZense(cwd);
	assert.equal(add.ok, true, add.err);
	const staged = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
	assert.deepEqual(staged, ["src.ts"], `staged must contain no .zense (no-HEAD fallback): ${staged}`);
	rmSync(base, { recursive: true, force: true });
});

test("snapshotUncommitted: nothing pending → ok but 'nothing to commit' (no empty commit)", () => {
	const { cwd, base, git } = makeRepo();
	const before = git(["rev-parse", "HEAD"]);
	const r = snapshotUncommitted(cwd, "chore: snapshot");
	assert.equal(r.ok, true);
	assert.equal(r.msg, "nothing to commit");
	assert.equal(git(["rev-parse", "HEAD"]), before, "HEAD must not move");
	rmSync(base, { recursive: true, force: true });
});

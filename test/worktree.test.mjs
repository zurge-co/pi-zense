import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	rewritePathForWorktree,
	buildWorktreeCommand,
	createWorktree,
	mergeWorktreeBack,
	gitOk,
} from "../extensions/zense-harness/index.ts";

// ----- pure helpers (path/command rewrite) -----

test("rewritePathForWorktree: relative path ใต้ repo → remap ใต้ wtRoot", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "extensions/x.ts"), "/r-wt/extensions/x.ts");
});

test("rewritePathForWorktree: absolute path ใต้ cwd → remap ใต้ wtRoot", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "/r/a/b.ts"), "/r-wt/a/b.ts");
});

test("rewritePathForWorktree: path นอก repo (absolute ไม่ใต้ cwd) → คืนเดิม", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "/Users/elsewhere/doc.md"), "/Users/elsewhere/doc.md");
});

test("rewritePathForWorktree: relative ออกนอก repo (../) → ไม่อยู่ใต้ wtRoot", () => {
	const out = rewritePathForWorktree("/r/sub", "/r/sub-wt", "../outside.txt");
	assert.ok(!out.startsWith("/r/sub-wt"), `expected not under wtRoot, got ${out}`);
});

test("rewritePathForWorktree: path ใต้ .pi/zense/ → คืนเดิม (harness state อยู่ main)", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", ".pi/zense/spec.md"), ".pi/zense/spec.md");
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "/r/.pi/zense/memory.jsonl"), "/r/.pi/zense/memory.jsonl");
});

test("buildWorktreeCommand: นำหน้าด้วย cd <wtRoot> && (path มี space ก็ quote ด้วย single-quote)", () => {
	assert.equal(buildWorktreeCommand("npm test", "/r-wt"), "cd '/r-wt' && npm test");
	assert.equal(buildWorktreeCommand("ls", "/path with space/wt"), "cd '/path with space/wt' && ls");
});

// ----- git integration (temp repo) -----

const SPEC = { version: 1, title: "t", intent: "t", scope: [], constraints: [], criteria: [], specDebt: [], approved: true };

/** สร้าง temp git repo พร้อม initial commit; คืน {cwd, cleanup} */
const makeRepo = () => {
	const base = mkdtempSync(join(tmpdir(), "zense-wt-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, "README.md"), "# init\n");
	mkdirSync(join(cwd, ".pi", "zense"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "zense", "x"), "x"); // placeholder
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	return { cwd, base, git };
};

test("gitOk: returns ok=false ใน dir ที่ไม่ใช่ git repo", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-nogit-"));
	const r = gitOk(["status"], base);
	assert.equal(r.ok, false);
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: สร้าง worktree + branch zense/impl/* + copy spec.json เข้าไป", () => {
	const { cwd, base, git } = makeRepo();
	writeFileSync(join(cwd, ".pi", "zense", "spec.json"), '{"version":1}');
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt, "worktree should be created");
	assert.ok(wt.branch.startsWith("zense/impl/v1-"), `branch=${wt.branch}`);
	assert.ok(existsSync(join(wt.root, "README.md")), "worktree has checked-out file");
	assert.ok(existsSync(join(wt.root, ".pi", "zense", "spec.json")), "spec.json copied into worktree");
	const list = git(["worktree", "list"]);
	assert.ok(list.includes(wt.root), "worktree listed by git");
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: ใน dir ที่ไม่ใช่ git repo → คืน null ไม่ throw", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-nogit2-"));
	const wt = createWorktree(base, SPEC);
	assert.equal(wt, null);
	rmSync(base, { recursive: true, force: true });
});

test("mergeWorktreeBack: eval PASS → auto-commit + merge เข้า main + cleanup worktree/branch", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	// จำลองการแก้ไฟล์ใน worktree (เหมือน agent เขียน)
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	// merge กลับ
	const mr = mergeWorktreeBack(cwd, SPEC, wt);
	assert.equal(mr.ok, true, `merge should succeed: ${mr.msg}`);
	// main มี merge commit
	const log = git(["log", "--oneline"]);
	assert.ok(/merge impl/.test(log), `main log has merge commit: ${log}`);
	// ไฟล์จาก worktree อยู่ใน main แล้ว
	assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "impl\n");
	// worktree ถูก remove แล้ว
	assert.ok(!existsSync(wt.root), "worktree dir removed");
	const branches = git(["branch", "--list", wt.branch]);
	assert.equal(branches.trim(), "", "branch deleted");
	rmSync(base, { recursive: true, force: true });
});

test("mergeWorktreeBack: conflict (อีก session แก้ไฟล์เดียวกันใน main) → ok=false conflict=true + เก็บ worktree", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	// อีก session แก้ same file ใน main และ commit ก่อน
	writeFileSync(join(cwd, "src.txt"), "main-change\n");
	git(["add", "src.txt"]);
	git(["commit", "-q", "-m", "other session"]);
	// session นี้แก้ same file ใน worktree
	writeFileSync(join(wt.root, "src.txt"), "wt-change\n");
	const mr = mergeWorktreeBack(cwd, SPEC, wt);
	assert.equal(mr.ok, false);
	assert.equal(mr.conflict, true);
	// worktree ยังอยู่ (ให้มนุษย์ resolve)
	assert.ok(existsSync(wt.root), "worktree kept for manual resolve");
	rmSync(base, { recursive: true, force: true });
});

test("mergeWorktreeBack: ไม่มี .pi/zense changes ใน merge (harness state ไม่ตามเข้า main)", () => {
	const { cwd, base, git } = makeRepo();
	// สร้าง .pi/zense/spec.md tracked ใน main ก่อน (commit)
	mkdirSync(join(cwd, ".pi", "zense"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "zense", "spec.md"), "# old\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "add spec"]);
	const wt = createWorktree(cwd, SPEC);
	// แก้ source ใน worktree + แก้ .pi/zense ใน worktree (จะถูก exclude จาก commit)
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	writeFileSync(join(wt.root, ".pi", "zense", "spec.md"), "# new\n");
	const mr = mergeWorktreeBack(cwd, SPEC, wt);
	assert.equal(mr.ok, true);
	// main spec.md ยังเป็นของเดิม (ไม่ถูกลาก)
	assert.equal(readFileSync(join(cwd, ".pi", "zense", "spec.md"), "utf8"), "# old\n");
	rmSync(base, { recursive: true, force: true });
});

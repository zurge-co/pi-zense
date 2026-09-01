import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	rewritePathForWorktree,
	buildWorktreeCommand,
	createWorktree,
	mergeWorktreeBack,
	composeCommitMessage,
	sanitizeSubject,
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

test("rewritePathForWorktree: path ใต้ .zense/ → คืนเดิม (harness state อยู่ main)", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", ".zense/spec.md"), ".zense/spec.md");
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "/r/.zense/memory.jsonl"), "/r/.zense/memory.jsonl");
});

test("buildWorktreeCommand: นำหน้าด้วย cd <wtRoot> && (path มี space ก็ quote ด้วย single-quote)", () => {
	assert.equal(buildWorktreeCommand("npm test", "/r-wt"), "cd '/r-wt' && npm test");
	assert.equal(buildWorktreeCommand("ls", "/path with space/wt"), "cd '/path with space/wt' && ls");
});

// ----- git integration (temp repo) -----

const SPEC = {
	version: 1,
	title: "Add src module",
	intent: "Implement the src module for testing merge-back.",
	scope: [],
	constraints: [],
	criteria: [],
	specDebt: [],
	approved: true,
};

/** git runner แบบระบุ dir (ไว้ commit ใน worktree) */
const gitIn = (dir) => (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

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
	mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "x"), "x"); // placeholder
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
	writeFileSync(join(cwd, ".zense", "spec.json"), '{"version":1}');
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt, "worktree should be created");
	assert.ok(wt.branch.startsWith("zense/impl/v1-"), `branch=${wt.branch}`);
	// worktree ต้องอยู่ nested ใต้ <repo>/.zense/worktree/ (ไม่ใช่ sibling dir ข้าง repo)
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

test("createWorktree: main repo git status สะอาดหลังสร้าง (nested worktree ถูก exclude ใน .git/info/exclude)", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	assert.equal(git(["status", "--porcelain"]).trim(), "", "main git status should be clean");
	// exclude ไปอยู่ใน local .git/info/exclude ไม่แตะไฟล์ tracked
	const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
	assert.ok(exclude.includes("/.zense/worktree/"), `exclude has worktree path: ${exclude}`);
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: captures baseline ref (main HEAD before branch)", () => {
	const { cwd, base, git } = makeRepo();
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt, "worktree should be created");
	assert.equal(wt.baseline, headBefore, "baseline = main HEAD ณ ตอนก่อนสร้าง branch");
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: ใน dir ที่ไม่ใช่ git repo → คืน null ไม่ throw", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-nogit2-"));
	const wt = createWorktree(base, SPEC);
	assert.equal(wt, null);
	rmSync(base, { recursive: true, force: true });
});

test("mergeWorktreeBack: eval PASS → squash เป็น commit เดียว subject=spec title + ff merge + cleanup worktree/branch", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	// จำลองการแก้ไฟล์ใน worktree (เหมือน agent เขียน)
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	// merge กลับ
	const mr = mergeWorktreeBack(cwd, SPEC, wt);
	assert.equal(mr.ok, true, `merge should succeed: ${mr.msg}`);
	// main ได้ commit เดียว subject = spec title (ไม่ใช่ "zense: impl v... (eval PASS)")
	const subjects = git(["log", "--format=%s"]).trim().split("\n");
	assert.deepEqual(subjects, ["Add src module", "init"], `main log subjects: ${subjects.join(" | ")}`);
	// body มี intent + footer spec version
	const body = git(["log", "-1", "--format=%B"]);
	assert.ok(body.includes("Implement the src module for testing merge-back."), `body has intent: ${body}`);
	assert.ok(body.includes("zense spec v1"), `body has spec footer: ${body}`);
	// ไฟล์จาก worktree อยู่ใน main แล้ว
	assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "impl\n");
	// worktree ถูก remove แล้ว
	assert.ok(!existsSync(wt.root), "worktree dir removed");
	const branches = git(["branch", "--list", wt.branch]);
	assert.equal(branches.trim(), "", "branch deleted");
	rmSync(base, { recursive: true, force: true });
});

test("mergeWorktreeBack: interim commits หลายอันใน branch → squash เป็น commit เดียว body มีรายชื่อ interim", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	const gwt = gitIn(wt.root);
	// agent commit ย่อย 2 ครั้ง + ทิ้งไฟล์ uncommitted อีก 1
	writeFileSync(join(wt.root, "a.txt"), "a\n");
	gwt(["add", "a.txt"]);
	gwt(["commit", "-q", "-m", "wip: add a"]);
	writeFileSync(join(wt.root, "b.txt"), "b\n");
	gwt(["add", "b.txt"]);
	gwt(["commit", "-q", "-m", "wip: add b"]);
	writeFileSync(join(wt.root, "c.txt"), "c\n");
	const mr = mergeWorktreeBack(cwd, SPEC, wt);
	assert.equal(mr.ok, true, `merge should succeed: ${mr.msg}`);
	// main ได้ commit ใหม่ตัวเดียว (squash) — interim commits ไม่ตามเข้า main
	const subjects = git(["log", "--format=%s"]).trim().split("\n");
	assert.deepEqual(subjects, ["Add src module", "init"], `main log subjects: ${subjects.join(" | ")}`);
	// แต่รายชื่อ interim commits ถูกเก็บไว้ใน body เพื่อ traceability
	const body = git(["log", "-1", "--format=%B"]);
	assert.ok(body.includes("wip: add a"), `body lists interim a: ${body}`);
	assert.ok(body.includes("wip: add b"), `body lists interim b: ${body}`);
	// ไฟล์ทั้งหมด (รวม uncommitted ตัวสุดท้าย) อยู่ใน main ครบ
	for (const f of ["a.txt", "b.txt", "c.txt"]) assert.ok(existsSync(join(cwd, f)), `${f} merged to main`);
	rmSync(base, { recursive: true, force: true });
});

test("mergeWorktreeBack: worktree ไม่มีการเปลี่ยนแปลง → ok แต่ไม่สร้าง commit ว่างบน main", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	const mr = mergeWorktreeBack(cwd, SPEC, wt);
	assert.equal(mr.ok, true, `merge should succeed: ${mr.msg}`);
	assert.equal(git(["log", "--format=%s"]).trim(), "init", "main log unchanged (no empty merge commit)");
	assert.ok(!existsSync(wt.root), "worktree cleaned up");
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

test("mergeWorktreeBack: ไม่มี .zense changes ใน merge (harness state ไม่ตามเข้า main) — ทั้งกรณี staged และ commit ย่อย", () => {
	const { cwd, base, git } = makeRepo();
	// สร้าง .zense/spec.md tracked ใน main ก่อน (commit)
	mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "spec.md"), "# old\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "add spec"]);
	const wt = createWorktree(cwd, SPEC);
	const gwt = gitIn(wt.root);
	// แก้ source ใน worktree + commit ย่อยที่แตะ .zense (interim commit มี .zense → ตอน squash ต้องหลุดออก)
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	gwt(["add", "src.txt"]);
	gwt(["commit", "-q", "-m", "wip: src"]);
	writeFileSync(join(wt.root, ".zense", "spec.md"), "# new\n");
	gwt(["add", ".zense/spec.md"]);
	gwt(["commit", "-q", "-m", "wip: zense state"]);
	const mr = mergeWorktreeBack(cwd, SPEC, wt);
	assert.equal(mr.ok, true);
	// main spec.md ยังเป็นของเดิม (ไม่ถูกลาก)
	assert.equal(readFileSync(join(cwd, ".zense", "spec.md"), "utf8"), "# old\n");
	// แต่ source ยังเข้า main ปกติ
	assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "impl\n");
	rmSync(base, { recursive: true, force: true });
});

test("composeCommitMessage: subject เป็นบรรทัดเดียว ≤72 chars + list interim + footer", () => {
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

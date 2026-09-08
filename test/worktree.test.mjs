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
	intent: "Implement the src module for testing apply-back.",
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

/** staged paths ใน main (ยกเว้น .zense) — helper ของ assertion */
const stagedIn = (git) => git(["diff", "--cached", "--name-only", "--", ".", ":!.zense"]).split("\n").map((s) => s.trim()).filter(Boolean);

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

// ----- applyWorktreeBack (ADR-003: staged-only, ไม่ commit) -----

test("applyWorktreeBack: eval PASS → change staged ใน main แต่ HEAD ไม่ขยับ (ไม่มี commit ใหม่) + cleanup worktree/branch + เก็บ reverse patch", () => {
	const { cwd, base, git } = makeRepo();
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	// จำลองการแก้ไฟล์ใน worktree (เหมือน agent เขียน)
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply should succeed: ${ar.msg}`);
	// ADR-003 core: main HEAD ไม่ขยับ — ไม่มี commit ใหม่จาก apply
	assert.equal(git(["rev-parse", "HEAD"]).trim(), headBefore, "HEAD must not move (no auto-commit)");
	assert.deepEqual(git(["log", "--format=%s"]).trim().split("\n"), ["init"], "main log unchanged");
	// change ถูก stage ไว้ใน index (รอมนุษย์ commit)
	assert.deepEqual(stagedIn(git), ["src.txt"], "src.txt staged in main");
	assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "impl\n");
	assert.deepEqual(ar.paths, ["src.txt"]);
	// commit message สำเร็จรูปจาก squashed commit (subject = spec title)
	assert.ok(ar.commitMsg.includes("Add src module"), `commitMsg has spec title: ${ar.commitMsg}`);
	// reverse patch ถูกเก็บไว้สำหรับ discard
	assert.ok(readFileSync(join(cwd, ".zense", "pending-apply.patch"), "utf8").includes("src.txt"), "reverse patch stored");
	// worktree + branch ถูก cleanup แล้ว
	assert.ok(!existsSync(wt.root), "worktree dir removed");
	assert.equal(git(["branch", "--list", wt.branch]).trim(), "", "branch deleted");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: interim commits หลายอัน + ไฟล์ uncommitted → squash แล้ว stage ครบใน main (log ไม่ขยับ)", () => {
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
	writeFileSync(join(wt.root, "c.txt"), "c\n"); // uncommitted ตัวสุดท้าย
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply should succeed: ${ar.msg}`);
	// interim commits ไม่ตามเข้า main เลย — log ยังเหมือนเดิม
	assert.deepEqual(git(["log", "--format=%s"]).trim().split("\n"), ["init"], "main log unchanged (no interim, no merge commit)");
	// ทุกไฟล์ (รวม uncommitted) staged ครบ
	assert.deepEqual(stagedIn(git).sort(), ["a.txt", "b.txt", "c.txt"], "all files staged");
	// commit message สำเร็จรูปต้องเก็บรายชื่อ interim (traceability)
	assert.ok(ar.commitMsg.includes("wip: add a") && ar.commitMsg.includes("wip: add b"), `commitMsg lists interims: ${ar.commitMsg}`);
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: worktree ไม่มีการเปลี่ยนแปลง → ok=true paths ว่าง, main สะอาด, cleanup ครบ", () => {
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

test("applyWorktreeBack: guard dirty main — main มี uncommitted change นอก .zense → refuse (ok=false dirtyMain) ไม่แตะ branch/worktree", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	// human แก้ไฟล์ใน main ค้างไว้ (ไม่ commit)
	writeFileSync(join(cwd, "README.md"), "# human change\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, false, `apply should be refused: ${ar.msg}`);
	assert.equal(ar.dirtyMain, true, "flagged as dirtyMain");
	// worktree + branch ต้องยังอยู่ (retry ได้ ไม่สูญงาน)
	assert.ok(existsSync(wt.root), "worktree kept");
	assert.ok(git(["branch", "--list", wt.branch]).trim(), "branch kept");
	// ของ human ไม่โดนแตะ
	assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "# human change\n");
	assert.deepEqual(stagedIn(git), [], "nothing staged by failed apply");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: guard ไม่เล็ง .zense — มีเฉพาะ .zense change ใน main ก็ apply ได้ตาม policy", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	// .zense/ (harness state) dirty ใน main — ต้องไม่ trip guard
	appendFileSync(join(cwd, ".zense", "x"), "state-dirty");
	writeFileSync(join(cwd, ".zense", "memory.jsonl"), "{}\n"); // untracked ใน .zense ด้วย
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply should succeed despite dirty .zense: ${ar.msg}`);
	assert.deepEqual(stagedIn(git), ["src.txt"]);
	// .zense ใน main ต้องไม่โดนแตะตอน apply
	assert.equal(readFileSync(join(cwd, ".zense", "memory.jsonl"), "utf8"), "{}\n");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: conflict (อีก session แก้ไฟล์เดียวกันใน main) → ok=false conflict=true, main ถูกย้อนสะอาด, เก็บ worktree", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	// อีก session แก้ same file ใน main และ commit ก่อน
	writeFileSync(join(cwd, "src.txt"), "main-change\n");
	git(["add", "src.txt"]);
	git(["commit", "-q", "-m", "other session"]);
	// session นี้แก้ same file ใน worktree
	writeFileSync(join(wt.root, "src.txt"), "wt-change\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, false);
	assert.equal(ar.conflict, true);
	// main ต้องถูกย้อนกลับสะอาด (ไม่ค้าง conflict markers / staged junk)
	assert.equal(git(["status", "--porcelain", "--", ".", ":!.zense"]).trim(), "", "main clean after abort");
	assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "main-change\n");
	// worktree ยังอยู่ (ให้มนุษย์ resolve)
	assert.ok(existsSync(wt.root), "worktree kept for manual resolve");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: ไม่มี .zense changes ใน staged result (harness state ไม่ตามเข้า main) — ทั้งกรณี staged และ commit ย่อยใน worktree", () => {
	const { cwd, base, git } = makeRepo();
	// สร้าง .zense/spec.md tracked ใน main ก่อน
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
	// staged ใน main ต้องไม่มี .zense/spec.md
	const staged = stagedIn(git);
	assert.ok(!staged.some((p) => p.startsWith(".zense")), `no .zense in staged: ${staged}`);
	assert.deepEqual(staged, ["src.txt"]);
	// main spec.md ยังเป็นของเดิม (ไม่ถูกลาก)
	assert.equal(readFileSync(join(cwd, ".zense", "spec.md"), "utf8"), "# old\n");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: multi-session — A apply ค้าง staged อยู่, B apply ตามหลัง → guard เด้ง refuse (อีกทางเลือกคือปนของ)", () => {
	const { cwd, base, git } = makeRepo();
	// session A: apply สำเร็จ (staged ค้างใน main)
	const wtA = createWorktree(cwd, SPEC);
	assert.ok(wtA);
	writeFileSync(join(wtA.root, "a.txt"), "a\n");
	const arA = applyWorktreeBack(cwd, SPEC, wtA);
	assert.equal(arA.ok, true);
	// session B: worktree ใหม่ (branch จาก HEAD เดิม — A ยังไม่ commit) แล้วพยายาม apply
	const specB = { ...SPEC, version: 2, title: "Add b module" };
	const wtB = createWorktree(cwd, specB);
	assert.ok(wtB);
	writeFileSync(join(wtB.root, "b.txt"), "b\n");
	const arB = applyWorktreeBack(cwd, specB, wtB);
	assert.equal(arB.ok, false, "B must be refused while A's staged changes pending");
	assert.equal(arB.dirtyMain, true);
	assert.ok(existsSync(wtB.root), "B worktree kept");
	// staged ของ A ยังอยู่ครบ ไม่ถูกแตะ
	assert.deepEqual(stagedIn(git), ["a.txt"]);
	rmSync(base, { recursive: true, force: true });
});

// ----- discardPendingApply (undo path หลัง review) -----

test("discardPendingApply: ย้อน change ที่ apply ไว้ → ไฟล์ใหม่ถูกลบ, main กลับสะอาดเหมือนก่อน apply เป๊ะ", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	appendFileSync(join(wt.root, "README.md"), "added-line\n"); // แก้ไฟล์ tracked เดิมด้วย
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true);
	// human review → ไม่พอใจ → discard
	const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, true, `discard should succeed: ${dr.msg}`);
	// ไฟล์ใหม่ที่ apply สร้างต้องหาย / ไฟล์เดิมต้องกลับเนื้อเดิม
	assert.ok(!existsSync(join(cwd, "src.txt")), "new file removed by reverse patch");
	assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "# init\n", "tracked file restored");
	assert.equal(git(["status", "--porcelain", "--", ".", ":!.zense"]).trim(), "", "main clean as before apply");
	// patch/msg ถูกเก็บกวาด
	assert.ok(!existsSync(join(cwd, ".zense", "pending-apply.patch")), "patch cleaned");
	rmSync(base, { recursive: true, force: true });
});

test("discardPendingApply: human แก้ไฟล์ที่ apply ไว้ → reverse fail ชัดๆ และไม่ลบของ human", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true);
	// human แก้ไฟล์ที่ apply มาหลังจากนั้น (ทับเนื้อทั้งก้อน)
	writeFileSync(join(cwd, "src.txt"), "human edit\n");
	const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, false, "reverse must fail when human edited applied files");
	// ของ human ต้องเหลือครบ — ห้ามลบเงียบๆ
	assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "human edit\n");
	// patch ยังอยู่ให้มนุษย์ตัดสินใจต่อ
	assert.ok(existsSync(join(cwd, ".zense", "pending-apply.patch")), "patch kept on failure");
	rmSync(base, { recursive: true, force: true });
});

test("discardPendingApply: ไม่มี pending patch → ok=false ไม่พัง", () => {
	const { cwd, base } = makeRepo();
	const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, false);
	assert.ok(dr.msg.includes("ไม่พบ"), `msg explains: ${dr.msg}`);
	rmSync(base, { recursive: true, force: true });
});

test("discardPendingApply: patch ว่าง (apply ไม่มี source change) → ok=true unstage-only ไม่พัง", () => {
	const { cwd, base, git } = makeRepo();
	mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "pending-apply.patch"), ""); // apply ที่ interim แตะเฉพาะ .zense → patch ว่าง
	// stage อะไรสักอย่างไว้ก่อน (จำลอง index ค้าง)
	writeFileSync(join(cwd, "leftover.txt"), "x\n");
	git(["add", "leftover.txt"]);
	const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, true, `discard should succeed: ${dr.msg}`);
	// index ถูก unstage (ของยังอยู่เป็น untracked — patch ว่างไม่ได้บังคับลบ)
	assert.equal(git(["diff", "--cached", "--name-only"]).trim(), "", "index unstaged");
	assert.ok(!existsSync(join(cwd, ".zense", "pending-apply.patch")), "patch cleaned");
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

// ----- acceptPendingApply (ทางออกฝั่ง "รับงาน" ของ pendingApply — คู่กับ discard tests ด้านบน) -----

/** จำลองสถานะหลัง applyWorktreeBack: patch+msg ค้างใน .zense + change จาก worktree staged อยู่ใน index */
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

test("acceptPendingApply: ไม่มี pending patch → ok=false ชัดๆ ไม่แตะ repo", () => {
	const { cwd, base, git } = makeRepo();
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const r = acceptPendingApply(cwd);
	assert.equal(r.ok, false);
	assert.match(r.msg, /ไม่มี pending apply/);
	assert.equal(git(["rev-parse", "HEAD"]).trim(), headBefore);
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: มนุษย์ commit เองแล้ว (index ว่าง, HEAD ขยับ) → ok, patch+msg ถูกลบ, ไม่มี warning", () => {
	const { cwd, base, git } = makeRepo();
	const preApplyHead = git(["rev-parse", "HEAD"]).trim();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]); // มนุษย์ commit เอง
	const r = acceptPendingApply(cwd, { preApplyHead });
	assert.equal(r.ok, true, r.msg);
	assert.equal(r.committedOnBehalf, false);
	assert.deepEqual(r.warnings, []);
	assert.deepEqual(pendingFiles(cwd), { patch: false, msg: false });
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: soft-mode — index ว่างแต่ HEAD ไม่ขยับ (change หาย?) → ok แต่แนบ warning ไม่ refuse", () => {
	const { cwd, base, git } = makeRepo();
	const preApplyHead = git(["rev-parse", "HEAD"]).trim();
	seedPending({ cwd, git });
	git(["reset", "-q", "--hard", "HEAD"]); // จำลอง change โดน reset ทิ้งนอก flow (index ว่าง ไม่มี commit ใหม่)
	const r = acceptPendingApply(cwd, { preApplyHead });
	assert.equal(r.ok, true, "soft-mode ต้อง accept ต่อแม้อันตราย");
	assert.equal(r.warnings.length, 1);
	assert.match(r.warnings[0], /HEAD/);
	assert.deepEqual(pendingFiles(cwd), { patch: false, msg: false });
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: ยัง staged ค้าง + ไม่ได้ขอ commit แทน → ok=false พร้อมบอกวิธี commit เอง/ขอแทน", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const r = acceptPendingApply(cwd);
	assert.equal(r.ok, false);
	assert.match(r.msg, /commitIfStaged=true \/ \/zense accept commit/);
	assert.equal(git(["rev-parse", "HEAD"]).trim(), headBefore, "ห้าม commit เองโดยไม่ได้ขอ");
	assert.deepEqual(pendingFiles(cwd), { patch: true, msg: true }, "ยังไม่ accept → patch+msg ต้องอยู่");
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: commitIfStaged=true (เคสสั่ง agent commit ให้หน่อย) → commit แทนด้วย message ที่เตรียมไว้ แล้วล้าง patch+msg", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	const r = acceptPendingApply(cwd, { commitIfStaged: true });
	assert.equal(r.ok, true, r.msg);
	assert.equal(r.committedOnBehalf, true);
	assert.equal(git(["log", "-1", "--format=%s"]).trim(), "Add src module", "subject มาจาก pending-apply.msg");
	// commit ต้องมี src.txt (staged ตอน seed) แต่ห้ามมี .zense/
	assert.deepEqual(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").filter(Boolean), ["src.txt"]);
	assert.deepEqual(pendingFiles(cwd), { patch: false, msg: false });
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: human amendments — evalTree ต่างจาก HEAD^{tree} → คืนเฉพาะชื่อไฟล์ที่มนุษย์แก้", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]);
	const evalTree = git(["rev-parse", "HEAD^{tree}"]).trim(); // tree ตอน apply (repin เหมือน lastEval.head)
	writeFileSync(join(cwd, "src.txt"), "human tweak\n"); // มนุษย์แก้เพิ่มหลัง grader ผ่าน
	writeFileSync(join(cwd, "extra.md"), "human notes\n");
	git(["add", "src.txt", "extra.md"]);
	git(["commit", "-q", "-m", "human adjustments after review"]);
	const r = acceptPendingApply(cwd, { evalTree });
	assert.equal(r.ok, true, r.msg);
	assert.deepEqual(r.amendedFiles.sort(), ["extra.md", "src.txt"]);
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: evalTree เท่ากับ HEAD^{tree} (มนุษย์ไม่แก้อะไรเลย) → amendedFiles ว่าง", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]);
	const evalTree = git(["rev-parse", "HEAD^{tree}"]).trim();
	const r = acceptPendingApply(cwd, { evalTree });
	assert.equal(r.ok, true, r.msg);
	assert.deepEqual(r.amendedFiles, []);
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: ไม่ส่ง evalTree → ข้าม delta เงียบๆ (amendedFiles ว่าง)", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]);
	const r = acceptPendingApply(cwd, {});
	assert.equal(r.ok, true, r.msg);
	assert.deepEqual(r.amendedFiles, []);
	rmSync(base, { recursive: true, force: true });
});

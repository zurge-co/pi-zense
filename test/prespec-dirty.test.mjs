import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uncommittedChanges, snapshotUncommitted, composeSnapshotMessage, isGitRepo, gitAddButZense } from "../extensions/zense-harness/index.ts";

/** สร้าง temp git repo พร้อม initial commit (tracked: README.md + .zense/x) */
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

test("uncommittedChanges: repo สะอาด → [] (รวมถึง .zense ที่ถูกแก้ — harness state ไม่นับ)", () => {
	const { cwd, base } = makeRepo();
	assert.deepEqual(uncommittedChanges(cwd), []);
	appendFileSync(join(cwd, ".zense", "x"), "dirty"); // แตะเฉพาะ .zense
	writeFileSync(join(cwd, ".zense", "memory.jsonl"), "{}\n"); // untracked ใน .zense
	assert.deepEqual(uncommittedChanges(cwd), []);
	rmSync(base, { recursive: true, force: true });
});

test("uncommittedChanges: tracked ที่แก้ + untracked ใหม่ → ถูก list ทั้งคู่", () => {
	const { cwd, base } = makeRepo();
	appendFileSync(join(cwd, "README.md"), "more\n");
	writeFileSync(join(cwd, "new.ts"), "export {};\n");
	const out = uncommittedChanges(cwd);
	assert.equal(out.length, 2, `expected 2 entries, got ${JSON.stringify(out)}`);
	assert.ok(out.some((l) => l.includes("README.md")), out.join(","));
	assert.ok(out.some((l) => l.includes("new.ts")), out.join(","));
	rmSync(base, { recursive: true, force: true });
});

test("uncommittedChanges: dir ที่ไม่ใช่ git repo → [] (degrade เงียบ ไม่บล็อก compile)", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-dirty-nogit-"));
	assert.deepEqual(uncommittedChanges(base), []);
	rmSync(base, { recursive: true, force: true });
});

test("snapshotUncommitted: commit ของที่ค้างนอก .zense → repo สะอาด, .zense ไม่ตามเข้า commit", () => {
	const { cwd, base, git } = makeRepo();
	writeFileSync(join(cwd, "wip.ts"), "// wip\n");
	writeFileSync(join(cwd, ".zense", "memory.jsonl"), "{}\n"); // ต้องไม่โดน commit
	const r = snapshotUncommitted(cwd, composeSnapshotMessage(uncommittedChanges(cwd)));
	assert.equal(r.ok, true, r.msg);
	assert.notEqual(r.msg, "nothing to commit");
	assert.deepEqual(uncommittedChanges(cwd), []); // นอก .zense สะอาดแล้ว
	const files = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").map((s) => s.trim()).filter(Boolean);
	assert.deepEqual(files, ["wip.ts"], `committed files: ${files}`);
	const subject = git(["log", "-1", "--format=%s"]).trim();
	assert.ok(subject.startsWith("chore: snapshot pre-spec"), subject);
	assert.ok(subject.includes("wip.ts"), `subject ต้องตั้งชื่อไฟล์ที่ค้างจริง ไม่ใช่ fixed: ${subject}`);
	rmSync(base, { recursive: true, force: true });
});

test("composeSnapshotMessage: subject สร้างจากไฟล์จริง (≤72 chars) + body list ครบทุกไฟล์", () => {
	const m = composeSnapshotMessage([" M src/a.ts", "?? new.ts", "R  old.ts -> renamed.ts"]);
	const [subject, , ...body] = m.split("\n");
	assert.ok(subject.length <= 72, `subject too long: ${subject.length}`);
	assert.ok(subject.includes("src/a.ts, new.ts"), subject);
	assert.ok(subject.includes("old.ts -> renamed.ts"), `3 ไฟล์สั้นควรอยู่ครบใน subject: ${subject}`);
	assert.ok(body.join("\n").includes("- old.ts -> renamed.ts"));
	// ไฟล์เยอะ → subject ตัดด้วย (+N) แต่ body ครบ
	const many = Array.from({ length: 30 }, (_, i) => `?? file-${i}.ts`);
	const m2 = composeSnapshotMessage(many);
	const subject2 = m2.split("\n")[0];
	assert.ok(subject2.length <= 72, `subject too long: ${subject2.length}`);
	assert.ok(subject2.includes("(+27)"), subject2);
	assert.equal(m2.split("\n").filter((l) => l.startsWith("- ")).length, 30);
});

test("isGitRepo: ตรวจถูกทั้งสองกรณี — feature guard ต้องปิดสนิทเมื่อไม่ใช่ git repo", () => {
	const { cwd, base } = makeRepo();
	assert.equal(isGitRepo(cwd), true);
	rmSync(base, { recursive: true, force: true });
	const nogit = mkdtempSync(join(tmpdir(), "zense-dirty-nogit-"));
	assert.equal(isGitRepo(nogit), false);
	rmSync(nogit, { recursive: true, force: true });
});

test("snapshotUncommitted: .zense/ อยู่ใน .gitignore → add ห้ามล้ม (git ≥2.55 exclude-pathspec regression) + commit ไม่มี .zense ตาม", () => {
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
	writeFileSync(join(cwd, ".zense", "spec.json"), "{}\n"); // ถูก ignore — สมัยก่อน add ตายตรงนี้
	const r = snapshotUncommitted(cwd, "chore: snapshot");
	assert.equal(r.ok, true, `snapshot ต้องสำเร็จแม้ .zense ถูก ignore: ${r.msg}`);
	assert.match(r.msg, /^[0-9a-f]{7,}$/, `msg ต้องเป็น short hash ของ snapshot commit: ${r.msg}`);
	const files = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").map((s) => s.trim()).filter(Boolean);
	assert.deepEqual(files, ["wip.ts"], `commit ห้ามมี .zense/.gitignore ที่ไม่เกี่ยวตาม: ${files}`);
	assert.deepEqual(uncommittedChanges(cwd), []); // นอก .zense สะอาดแล้ว
	rmSync(base, { recursive: true, force: true });
});

test("gitAddButZense: repo ไม่มี commit แรก (no HEAD) + ไม่ ignore .zense → stage เฉพาะ source, .zense ไม่ติด index", () => {
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
	assert.deepEqual(staged, ["src.ts"], `staged ต้องไม่มี .zense (no-HEAD fallback): ${staged}`);
	rmSync(base, { recursive: true, force: true });
});

test("snapshotUncommitted: ไม่มีอะไรค้าง → ok แต่ 'nothing to commit' (ไม่สร้าง commit ว่าง)", () => {
	const { cwd, base, git } = makeRepo();
	const before = git(["rev-parse", "HEAD"]);
	const r = snapshotUncommitted(cwd, "chore: snapshot");
	assert.equal(r.ok, true);
	assert.equal(r.msg, "nothing to commit");
	assert.equal(git(["rev-parse", "HEAD"]), before, "HEAD ต้องไม่ขยับ");
	rmSync(base, { recursive: true, force: true });
});

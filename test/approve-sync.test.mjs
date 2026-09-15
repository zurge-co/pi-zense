import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { syncApprovedSpecFiles, renderSpecMd } from "../extensions/zense-harness/index.ts";

const baseSpec = (over = {}) => ({
	version: 2,
	title: "Fix approve sync",
	intent: "spec.json on disk must reflect the human signature",
	approach: ["sync on approve"],
	scope: ["extensions"],
	constraints: [],
	criteria: [{ id: "c1", text: "synced", check: "npm test" }],
	specDebt: [],
	approved: false,
	...over,
});

const setupZenseDir = () => {
	const cwd = mkdtempSync(join(tmpdir(), "zense-approve-sync-"));
	mkdirSync(join(cwd, ".zense", "specs"), { recursive: true });
	return cwd;
};

test("syncApprovedSpecFiles: เขียน approved:true กลับลง spec.json + spec.md (latest copies)", () => {
	const cwd = setupZenseDir();
	const unsigned = baseSpec();
	// จำลอง commitSpec: เขียนไฟล์ตอนยังไม่ได้เซ็น
	writeFileSync(join(cwd, ".zense", "spec.json"), JSON.stringify(unsigned, null, 2));
	writeFileSync(join(cwd, ".zense", "spec.md"), renderSpecMd(unsigned));

	const signed = { ...unsigned, approved: true, approvedAt: 12345 };
	assert.equal(syncApprovedSpecFiles(cwd, signed), true);

	const json = JSON.parse(readFileSync(join(cwd, ".zense", "spec.json"), "utf8"));
	assert.equal(json.approved, true);
	assert.equal(json.approvedAt, 12345);
	assert.match(readFileSync(join(cwd, ".zense", "spec.md"), "utf8"), /^approved: true$/m);
});

test("syncApprovedSpecFiles: sync archive copies ที่ paths ชี้อยู่ด้วย", () => {
	const cwd = setupZenseDir();
	const unsigned = baseSpec();
	const archJson = join(cwd, ".zense", "specs", "a.json");
	const archMd = join(cwd, ".zense", "specs", "a.md");
	writeFileSync(archJson, JSON.stringify(unsigned, null, 2));
	writeFileSync(archMd, renderSpecMd(unsigned));

	assert.equal(syncApprovedSpecFiles(cwd, { ...unsigned, approved: true }, { json: archJson, md: archMd }), true);
	assert.equal(JSON.parse(readFileSync(archJson, "utf8")).approved, true);
	assert.match(readFileSync(archMd, "utf8"), /^approved: true$/m);
});

test("syncApprovedSpecFiles: ไฟล์ไม่มี/paths ไม่ส่ง → best-effort ไม่พัง", () => {
	const cwd = setupZenseDir(); // ยังไม่เคย commit spec — ไม่มี spec.json
	assert.equal(syncApprovedSpecFiles(cwd, { ...baseSpec(), approved: true }), false);
	assert.equal(existsSync(join(cwd, ".zense", "spec.json")), false); // ห้ามสร้างไฟล์มั่วที่ยังไม่เคย commit
	assert.equal(syncApprovedSpecFiles(cwd, { ...baseSpec(), approved: true }, { json: join(cwd, "nope.json") }), false);
});

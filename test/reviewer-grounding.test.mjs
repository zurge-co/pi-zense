import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildReviewerPrompt, findUngroundedTokens } from "../extensions/zense-harness/index.ts";

const LASTEVAL = {
	verdict: "PASS",
	perCriteria: { c1: "PASS", c2: "PASS" },
	failedIds: [],
	probes: [
		{ id: "c1", status: "pass", exitCode: 0, detail: "npm test → PASS (exit 0, 71 tests)" },
		{ id: "c2", status: "pass", exitCode: 0, detail: "path exists: src/a.ts" },
	],
};
const CRITERIA = [
	{ id: "c1", text: "tests pass", check: "npm test" },
	{ id: "c2", text: "guard exists", check: "path exists: src/a.ts" },
];

// r2: evidence ต้องถึงมือ reviewer แบบ verbatim — probe detail + criteria text (เดิมย่อเหลือ id:status)
test("buildReviewerPrompt: probes + criteria fed verbatim", () => {
	const p = buildReviewerPrompt("do x", LASTEVAL, [], [], [], "git log ...", "", undefined, CRITERIA);
	assert.match(p, /npm test → PASS \(exit 0, 71 tests\)/); // probe detail เต็ม
	assert.match(p, /tests pass \[check: npm test\]/); // criteria text + check
	assert.match(p, /c1: PASS/);
	assert.match(p, /VERBATIM|verbatim/); // r3: grounding contract
	assert.match(p, /Human actions/);
	assert.match(p, /zense_eval/); // r3: pipeline tools ground ชื่อ tool
	assert.match(p, /must not contradict/); // r3: TL;DR ห้ามขัด verdict
});

// r4: จับ token ที่แต่งขึ้น (เคสจริง: ENTROPY_TIMEOUT_MINS / SUB_AGENT_KILLED / hash ปลอม)
test("findUngroundedTokens: จับ identifier/hash/backtick นอก evidence", () => {
	const packet = [
		"env `ENTROPY_TIMEOUT_MINS` และ flag `SUB_AGENT_KILLED` ที่ index.ts:289",
		"commit `8f8b1f2` ยังไม่ merge",
		"ส่วน `npm test` ผ่าน",
	].join("\n");
	const evidence = "constants: subagentTimeout, timedOut / commit 3879624 / npm test";
	const bad = findUngroundedTokens(packet, evidence, () => false);
	assert.ok(bad.includes("ENTROPY_TIMEOUT_MINS"));
	assert.ok(bad.includes("SUB_AGENT_KILLED"));
	assert.ok(bad.includes("8f8b1f2"));
	assert.ok(!bad.includes("npm test")); // backtick หลายคำ = การเน้นประโยค → ข้าม (กัน noise)
});

// r4: ไม่จับคำ section ปกติ + token ที่ evidence มี + path ที่มีไฟล์จริง (pathExists injectable)
test("findUngroundedTokens: ไม่จับ PASS/OVERALL, token ใน evidence และ path จริง", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-ground-"));
	try {
		writeFileSync(join(dir, "real.ts"), "x");
		const packet = "ดู `real.ts:12` กับ `ghost.ts` แล้วสรุป PASS ตาม OVERALL";
		const evidence = "verdict PASS จาก OVERALL line";
		const bad = findUngroundedTokens(packet, evidence, (p) => p === "real.ts");
		assert.ok(!bad.includes("real.ts:12")); // path มีจริง (ตัด :line ก่อนเช็ค)
		assert.ok(bad.includes("ghost.ts")); // path ไม่มีจริง → จับ
		assert.ok(!bad.includes("PASS") && !bad.includes("OVERALL")); // ไม่มี _ → ไม่จับ
		// default pathExists = existsSync (relative กับ cwd) — ไฟล์ใน tmp มองไม่เห็น → จับ
		assert.ok(findUngroundedTokens(packet, evidence).includes("real.ts:12"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

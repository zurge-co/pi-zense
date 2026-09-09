import { strict as assert } from "node:assert";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	aggregateMemory,
	buildDistilledMemory,
	clearDirFiles,
	distillImpact,
	distillTaskPrompt,
	fmtBytes,
	MAX_DISTILL_MEMORY_BYTES,
	memorySummaryLines,
	parseDistilledLessons,
	replaceFileAtomic,
} from "../extensions/zense-harness/index.ts";

/** สร้าง repo ปลอมพร้อม .zense fixture ใน tmp — คืน cleanup */
const makeRepo = () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-distill-"));
	mkdirSync(join(dir, ".zense", "specs"), { recursive: true });
	mkdirSync(join(dir, ".zense", "subagents"), { recursive: true });
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("distillImpact: นับ memory บรรทัด + ไฟล์/ขนาดของ specs และ subagents", () => {
	const { dir, cleanup } = makeRepo();
	try {
		writeFileSync(join(dir, ".zense", "memory.jsonl"), '{"at":1,"phase":"x","note":"a"}\n{"at":2,"phase":"y","note":"b"}\n\n');
		writeFileSync(join(dir, ".zense", "specs", "s1.json"), "{}");
		writeFileSync(join(dir, ".zense", "specs", "s1.md"), "hello");
		writeFileSync(join(dir, ".zense", "subagents", "g.log"), "x".repeat(100));
		const imp = distillImpact(dir);
		assert.equal(imp.memoryLines, 2); // บรรทัดว่างไม่นับ
		assert.ok(imp.memoryBytes > 0);
		assert.equal(imp.specFiles, 2);
		assert.equal(imp.specBytes, 7);
		assert.equal(imp.logFiles, 1);
		assert.equal(imp.logBytes, 100);
	} finally {
		cleanup();
	}
});

test("distillImpact: ไม่มี .zense เลย → ศูนย์ทุกช่อง (guard memory ว่างใช้ค่านี้)", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-distill-"));
	try {
		const imp = distillImpact(dir);
		assert.deepEqual(imp, { memoryLines: 0, memoryBytes: 0, specFiles: 0, specBytes: 0, logFiles: 0, logBytes: 0 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseDistilledLessons: รับ JSON ดิบ, fence และ prose คั่น (extractJsonObject เดิม)", () => {
	for (const text of [
		'{"lessons": ["a", "b"]}',
		'```json\n{"lessons": ["a"]}\n```',
		'นี่คือผลลัพธ์ครับ {"lessons": ["x"]} จบ',
	]) {
		const r = parseDistilledLessons(text);
		assert.equal(r.ok, true, text);
	}
});

test("parseDistilledLessons: normalize whitespace รวม newline เป็นบรรทัดเดียว (กัน JSONL พัง)", () => {
	const r = parseDistilledLessons('{"lessons": ["  a\\n b  c "]}');
	assert.equal(r.ok, true);
	assert.deepEqual(r.lessons, ["a b c"]);
});

test("parseDistilledLessons: reject output เสียทุกรูปแบบ → caller abort", () => {
	for (const text of [
		"ไม่มี JSON เลย",
		'[1,2,3]',
		'{"lessons": []}',
		'{"lessons": "not-array"}',
		'{"lessons": [42]}',
		'{"lessons": ["ok", "  "]}',
		`{"lessons": [${Array.from({ length: 51 }, () => '"x"').join(",")}]}`,
		`{"lessons": ["${"y".repeat(401)}"]}`,
	]) {
		assert.equal(parseDistilledLessons(text).ok, false, text.slice(0, 40));
	}
});

test("buildDistilledMemory: ทุกบรรทัด parse ได้ด้วย aggregateMemory เดิม และเนื้อบทเรียนไหลเข้า eval channel", () => {
	const { dir, cleanup } = makeRepo();
	try {
		writeFileSync(join(dir, ".zense", "memory.jsonl"), buildDistilledMemory(["gate ต้อง block write ก่อนเซ็น", "grader ชอบ timeout ที่ 240s"]));
		const agg = aggregateMemory(dir);
		assert.equal(agg.total, 2);
		assert.deepEqual(agg.evals, ["distilled · gate ต้อง block write ก่อนเซ็น", "distilled · grader ชอบ timeout ที่ 240s"]);
		assert.equal(agg.misc, 0);
	} finally {
		cleanup();
	}
});

test("distilled memory + บทเรียนใหม่ที่ตามมา (prefix เดิมทุกแบบ) ไหลผ่าน aggregateMemory/memorySummaryLines เดิมโดยไม่แก้ parser", () => {
	const { dir, cleanup } = makeRepo();
	try {
		const mem = join(dir, ".zense", "memory.jsonl");
		writeFileSync(mem, buildDistilledMemory(["gate ต้อง block ก่อนเซ็น"]));
		// บทเรียนที่สะสม *หลัง* distill — reuse prefix เดิมของระบบทุกชนิด ต้อง parse ร่วมกันได้
		appendFileSync(mem, JSON.stringify({ at: 1, phase: "maintenance", note: "flag: unsigned override: edit" }) + "\n");
		appendFileSync(mem, JSON.stringify({ at: 2, phase: "requirements", note: "escalation: need-permission: write blocked: spec unsigned" }) + "\n");
		appendFileSync(mem, JSON.stringify({ at: 3, phase: "evaluation", note: "sub-agent failed: grader" }) + "\n");
		appendFileSync(mem, JSON.stringify({ at: 4, phase: "maintenance", note: "distilled: บทเรียนอิสระที่ไม่มี prefix" }) + "\n");
		const agg = aggregateMemory(dir);
		assert.equal(agg.total, 5);
		assert.equal(agg.flags.get("unsigned override: edit"), 1); // flag: เดิมยังนับซ้ำได้
		assert.equal(agg.esc.get("need-permission"), 1); // escalation: เดิม
		assert.equal(agg.subFails.get("grader"), 1); // sub-agent failed: เดิม
		assert.equal(agg.misc, 1); // distilled: อิสระ → misc (โชว์เป็นจำนวนใน summary)
		// memorySummaryLines เดิมต้อง render ได้ และบทเรียนที่กลั่น (eval channel) ต้องโผล่ในสรุปที่ feed compile_spec
		const lines = memorySummaryLines(dir).join("\n");
		assert.match(lines, /5 lessons/);
		assert.match(lines, /eval history.*distilled · gate ต้อง block ก่อนเซ็น/);
		assert.match(lines, /unsigned override: edit ×1/);
	} finally {
		cleanup();
	}
});

test("บทเรียนยาวเกิน 60 ตัวอักษรต้องรอดจาก aggregateMemory/memorySummaryLines ครบ (regression: eval channel เคยตัด 60)", () => {
	const { dir, cleanup } = makeRepo();
	try {
		// บทเรียนยาว 160 ตัวอักษร — เกินเพดาน truncate ของ eval channel เดิมชัดเจน
		const longLesson = "gate ต้อง block write ทุกครั้งก่อนเซ็น spec ไม่เช่นนั้น agent จะแก้โค้ดล่วงหน้าโดยไม่มีลายเซ็นมนุษย์กำกับ ทำลายสัญญาของ harness--1234567890" ;
		assert.ok(longLesson.length > 60);
		writeFileSync(join(dir, ".zense", "memory.jsonl"), buildDistilledMemory([longLesson]));
		const agg = aggregateMemory(dir);
		assert.equal(agg.evals[0], `distilled · ${longLesson}`); // ครบ ไม่ถูก slice(0, 60)
		// ส่วน eval entry ปกติ (ไม่ใช่ distilled) ยังโดนตัด 60 เหมือนเดิม — ไม่กระทบ behavior เดิม
		appendFileSync(join(dir, ".zense", "memory.jsonl"), JSON.stringify({ at: 9, phase: "evaluation", note: `eval: ${"x".repeat(120)}` }) + "\n");
		const agg2 = aggregateMemory(dir);
		assert.equal(agg2.evals[1].length, 60);
		assert.ok(memorySummaryLines(dir).join("\n").includes(longLesson)); // feed ครบเข้า compile_spec
	} finally {
		cleanup();
	}
});

test("replaceFileAtomic: เขียนผ่าน tmp แล้ว rename — เนื้อใหม่ถูกต้อง ไม่เหลือไฟล์ tmp ค้าง", () => {
	const { dir, cleanup } = makeRepo();
	try {
		const p = join(dir, ".zense", "memory.jsonl");
		writeFileSync(p, "old");
		replaceFileAtomic(p, "new");
		assert.equal(readFileSync(p, "utf8"), "new");
		assert.ok(!readdirSync(join(dir, ".zense")).some((f) => f.endsWith(".tmp")));
	} finally {
		cleanup();
	}
});

test("distillTaskPrompt: ฝังเนื้อ memory inline ครบ (ไม่พึ่ง read tool ที่ truncate ไฟล์ยาว) + เพดานไซซ์เป็น constant เดียว", () => {
	const prompt = distillTaskPrompt('{"note":"a"}\n{"note":"b"}', 2);
	assert.ok(prompt.includes('{"note":"a"}') && prompt.includes('{"note":"b"}'));
	assert.match(prompt, /MEMORY JSONL START \(2 entries\)/);
	assert.match(prompt, /do not try to read any file/);
	assert.ok(MAX_DISTILL_MEMORY_BYTES > 0);
});

test("ขอบเขตการลบของ distill: specs/ + subagents/ เท่านั้น — protected set (adr/, config.json, models.json, spec.json, spec.md, worktree/) ต้องเหลือครบ", () => {
	const { dir, cleanup } = makeRepo();
	try {
		// protected set ตามสัญญา — สร้างครบทุกชิ้นรอบ memory
		mkdirSync(join(dir, ".zense", "adr"), { recursive: true });
		mkdirSync(join(dir, ".zense", "worktree"), { recursive: true });
		writeFileSync(join(dir, ".zense", "adr", "001-x.md"), "DENY: node_modules/");
		writeFileSync(join(dir, ".zense", "config.json"), "{}");
		writeFileSync(join(dir, ".zense", "models.json"), "{}");
		writeFileSync(join(dir, ".zense", "spec.json"), "{}");
		writeFileSync(join(dir, ".zense", "spec.md"), "# spec");
		writeFileSync(join(dir, ".zense", "memory.jsonl"), buildDistilledMemory(["a"]));
		// deletion step ของ runDistill: clearDirFiles ถูกเรียกเฉพาะ 2 dir นี้เท่านั้น (specs keep ไม่มี, subagents keep distiller log)
		writeFileSync(join(dir, ".zense", "specs", "old.json"), "{}");
		writeFileSync(join(dir, ".zense", "subagents", "old.log"), "x");
		writeFileSync(join(dir, ".zense", "subagents", "latest-distiller.log"), "y");
		clearDirFiles(join(dir, ".zense", "specs"));
		clearDirFiles(join(dir, ".zense", "subagents"), new Set(["latest-distiller.log"]));
		// protected เหลือครบ ไม่มีไฟล์ไหนถูกแตะ
		for (const p of ["adr/001-x.md", "config.json", "models.json", "spec.json", "spec.md", "memory.jsonl"])
			assert.ok(readFileSync(join(dir, ".zense", p), "utf8").length > 0, p);
		assert.equal(readdirSync(join(dir, ".zense", "worktree")).filter((f) => !f.startsWith(".")).length, 0); // worktree/ ไม่โดนลบ (เดิมว่างอยู่แล้ว)
		assert.deepEqual(readdirSync(join(dir, ".zense", "adr")), ["001-x.md"]); // adr/ อยู่ครบ
		assert.deepEqual(readdirSync(join(dir, ".zense", "specs")), []); // specs ถูกล้าง
		assert.deepEqual(readdirSync(join(dir, ".zense", "subagents")), ["latest-distiller.log"]); // logs ถูกล้าง ยกเว้น keep
	} finally {
		cleanup();
	}
});

test("clearDirFiles: ลบเฉพาะไฟล์ เคารพ keep set — dir ยังอยู่", () => {
	const { dir, cleanup } = makeRepo();
	try {
		const d = join(dir, ".zense", "subagents");
		writeFileSync(join(d, "a.log"), "1");
		writeFileSync(join(d, "b.log"), "2");
		writeFileSync(join(d, "keep.log"), "3");
		const n = clearDirFiles(d, new Set(["keep.log"]));
		assert.equal(n, 2);
		assert.equal(readFileSync(join(d, "keep.log"), "utf8"), "3");
		assert.equal(clearDirFiles(join(dir, ".zense", "nope")), 0); // dir ไม่มี → 0 ไม่ throw
	} finally {
		cleanup();
	}
});

test("fmtBytes: หน่วยอ่านง่ายสำหรับ confirm dialog", () => {
	assert.equal(fmtBytes(512), "512B");
	assert.equal(fmtBytes(2048), "2.0KB");
	assert.equal(fmtBytes(2 * 1_048_576), "2.0MB");
});

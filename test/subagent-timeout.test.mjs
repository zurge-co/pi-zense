import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { subagentTimeout } from "../extensions/zense-harness/index.ts";

// B: timeout ต่อ role — ป้องกัน regression ของ bug "code=143 signal=null" (timeout ถูกรายงานเป็น crash)
test("subagentTimeout: per-role map + default fallback (ไม่มี env override แล้ว)", () => {
	assert.equal(subagentTimeout("requirements"), 600_000);
	assert.equal(subagentTimeout("grader"), 600_000);
	assert.equal(subagentTimeout("reviewer"), 480_000);
	assert.equal(subagentTimeout("unknown-role"), 300_000); // role แปลก → default
});

// s2: ช่องปรับของ agent = .zense/config.json (key subagentTimeoutMs) — อ่านสดทุก call ไม่ cache
test("subagentTimeout: .zense/config.json overrides built-in map, read fresh per call", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-cfg-"));
	try {
		// ยังไม่มี config → built-in map
		assert.equal(subagentTimeout("requirements", dir), 600_000);
		mkdirSync(join(dir, ".zense"), { recursive: true });
		// role entry → ทับ map
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: 900_000 } }));
		assert.equal(subagentTimeout("requirements", dir), 900_000);
		assert.equal(subagentTimeout("grader", dir), 600_000); // role อื่นไม่โดน
		// default entry ครอบ role ที่ไม่ระบุ
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { default: 45_000 } }));
		assert.equal(subagentTimeout("grader", dir), 45_000);
		assert.equal(subagentTimeout("requirements", dir), 45_000);
		// role entry ชนะ default
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { default: 45_000, reviewer: 120_000 } }));
		assert.equal(subagentTimeout("reviewer", dir), 120_000);
		// ค่า invalid (0/ติดลบ/ไม่ใช่ตัวเลข) → ข้าม ไปใช้ map
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: 0, default: -5 } }));
		assert.equal(subagentTimeout("requirements", dir), 600_000);
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: "60k" } }));
		assert.equal(subagentTimeout("requirements", dir), 600_000);
		// JSON พัง → map (ไม่ throw)
		writeFileSync(join(dir, ".zense", "config.json"), "{oops");
		assert.equal(subagentTimeout("requirements", dir), 600_000);
		// อ่านสด: เขียนใหม่ตอน runtime → call ถัดไปเห็นทันที
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: 777_000 } }));
		assert.equal(subagentTimeout("requirements", dir), 777_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// s2: worktree ไม่มี .zense (gitignored) → fallback ไป main repo
test("subagentTimeout: cwd ไม่มี config → fallback dir ถัดไป (worktree → main repo)", () => {
	const wt = mkdtempSync(join(tmpdir(), "zense-wt-"));
	const main = mkdtempSync(join(tmpdir(), "zense-main-"));
	try {
		mkdirSync(join(main, ".zense"), { recursive: true });
		writeFileSync(join(main, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: 800_000 } }));
		assert.equal(subagentTimeout("requirements", wt, main), 800_000); // wt ไม่มี → main
		mkdirSync(join(wt, ".zense"), { recursive: true });
		writeFileSync(join(wt, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { requirements: 111_000 } }));
		assert.equal(subagentTimeout("requirements", wt, main), 111_000); // wt มีของตัวเอง → ชนะ
		assert.equal(subagentTimeout("reviewer", wt, main), 480_000); // ไม่มีใน config ทั้งคู่ → map
	} finally {
		rmSync(wt, { recursive: true, force: true });
		rmSync(main, { recursive: true, force: true });
	}
});

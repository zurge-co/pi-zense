import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	SUBAGENT_STRIP_FLAGS,
	buildRequirementsPrompt,
	buildSubagentArgv,
	listInstalledExtensions,
	subagentExtIncludes,
	subagentStripFlagsAsync,
	writeSubagentExtIncludes,
} from "../extensions/zense-harness/index.ts";

// ext-config (spec v7, 2026-09-08): sub-agent extension loading ต่อ role —
// DEFAULT = UNLOAD ทั้งหมด (uniform bare boot กัน extension ที่มี gate/ค้างบล็อก sub-process)
// แล้ว user tick โหลดเพิ่ม (opt-in). persist local .zense + seed-once global.
const mkTmp = () => mkdtempSync(join(tmpdir(), "zense-extcfg-"));
const writeCfg = (dir, obj) => {
	mkdirSync(join(dir, ".zense"), { recursive: true });
	writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify(obj));
};

test("default (ไม่มี config): role ที่ base มี --no-extensions → flags เดิมเป๊ะ (bare boot)", async () => {
	const dir = mkTmp();
	const globalDir = mkTmp();
	try {
		const flags = await subagentStripFlagsAsync("grader", dir, undefined, mkTmp(), globalDir);
		assert.deepEqual(flags, SUBAGENT_STRIP_FLAGS.grader);
		assert.deepEqual(subagentExtIncludes("grader", dir, undefined, globalDir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("default: role ที่ base ไม่มี --no-extensions (requirements) → ได้ --no-extensions เพิ่ม (uniform bare)", async () => {
	const dir = mkTmp();
	const globalDir = mkTmp();
	try {
		assert.ok(!SUBAGENT_STRIP_FLAGS.requirements.includes("--no-extensions"));
		const flags = await subagentStripFlagsAsync("requirements", dir, undefined, mkTmp(), globalDir);
		assert.ok(flags.includes("--no-extensions"));
		assert.ok(flags.includes("--no-themes") && flags.includes("--no-prompt-templates"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("include list: -e เฉพาะ path ที่ installed+enabled จริง; uninstalled/ไม่รู้จัก ทิ้งเงียบๆ", async () => {
	const dir = mkTmp();
	const agentDir = mkTmp();
	const globalDir = mkTmp();
	try {
		// extension ปลอมในโปรเจกต์ tmp — DefaultPackageManager ต้องมองเห็น (origin top-level, project scope)
		mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
		const fakePath = join(dir, ".pi", "extensions", "fake-ext.ts");
		writeFileSync(fakePath, "export default function (pi) {}\n");
		const installed = await listInstalledExtensions(dir, agentDir);
		assert.ok(
			installed.some((e) => e.path === fakePath),
			`fake extension ต้องถูก enumerate เจอ (ได้: ${installed.map((e) => e.path).join(", ") || "none"})`,
		);
		writeCfg(dir, { subagentExtInclude: { grader: [fakePath, "/nonexistent/gone.ts"] } });
		const flags = await subagentStripFlagsAsync("grader", dir, undefined, agentDir, globalDir);
		assert.ok(flags.includes("--no-extensions"));
		const eIdx = flags.indexOf("-e");
		assert.ok(eIdx >= 0 && flags[eIdx + 1] === fakePath, "-e ต้องชี้ fake-ext.ts");
		assert.ok(!flags.includes("/nonexistent/gone.ts"), "path ที่ uninstall แล้วต้องถูกทิ้ง");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("config พัง/ผิดประเภท → built-in [] (ไม่ throw)", () => {
	const dir = mkTmp();
	try {
		writeCfg(dir, "{oops");
		assert.deepEqual(subagentExtIncludes("grader", dir, undefined, mkTmp()), []);
		writeCfg(dir, { subagentExtInclude: { grader: 42 } });
		assert.deepEqual(subagentExtIncludes("grader", dir, undefined, mkTmp()), []);
		writeCfg(dir, { subagentTimeoutMs: { grader: 1 } });
		assert.deepEqual(subagentExtIncludes("grader", dir, undefined, mkTmp()), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("chain: local(cwd) ไม่มี → fallbackCwd; ไม่มีทั้งคู่ → global; local ชนะ global", () => {
	const cwd = mkTmp();
	const fallback = mkTmp();
	const globalDir = mkTmp();
	try {
		mkdirSync(join(globalDir), { recursive: true });
		writeFileSync(join(globalDir, "config.json"), JSON.stringify({ subagentExtInclude: { grader: ["/g.ts"] } }));
		assert.deepEqual(subagentExtIncludes("grader", cwd, fallback, globalDir), ["/g.ts"]); // global fallback
		writeCfg(fallback, { subagentExtInclude: { grader: ["/f.ts"] } });
		assert.deepEqual(subagentExtIncludes("grader", cwd, fallback, globalDir), ["/f.ts"]); // fallbackCwd ชนะ global
		writeCfg(cwd, { subagentExtInclude: { grader: ["/l.ts", "/l2.ts"] } });
		assert.deepEqual(subagentExtIncludes("grader", cwd, fallback, globalDir), ["/l.ts", "/l2.ts"]); // local ชนะทุกอย่าง
	} finally {
		for (const d of [cwd, fallback, globalDir]) rmSync(d, { recursive: true, force: true });
	}
});

test("writer: persist LOCAL .zense/config.json เสมอ คง key อื่นครบ; GLOBAL seed ครั้งแรกครั้งเดียว มีแล้วไม่ overwrite", () => {
	const dir = mkTmp();
	const globalDir = mkTmp();
	try {
		const cfgPath = join(dir, ".zense", "config.json");
		writeCfg(dir, { subagentTimeoutMs: { grader: 999 } });
		// ครั้งแรก: seed global
		let r = writeSubagentExtIncludes(dir, "grader", ["/a.ts"], globalDir);
		assert.equal(r.globalSeeded, true);
		assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).subagentExtInclude.grader, ["/a.ts"]);
		assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).subagentTimeoutMs.grader, 999); // key อื่นอยู่ครบ
		assert.deepEqual(JSON.parse(readFileSync(join(globalDir, "config.json"), "utf8")).subagentExtInclude.grader, ["/a.ts"]);
		// ครั้งที่สอง: local เปลี่ยน แต่ global ไม่ overwrite (กติกา user: มีแล้วข้าม)
		r = writeSubagentExtIncludes(dir, "grader", ["/b.ts"], globalDir);
		assert.equal(r.globalSeeded, false);
		assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).subagentExtInclude.grader, ["/b.ts"]);
		assert.deepEqual(JSON.parse(readFileSync(join(globalDir, "config.json"), "utf8")).subagentExtInclude.grader, ["/a.ts"]);
		// ไฟล์ global อยู่ใต้ globalDir ที่ inject เท่านั้น (ไม่แตะ ~/.pi จริง)
		// value=null: ลบ local เท่านั้น ไม่ seed/แตะ global
		r = writeSubagentExtIncludes(dir, "grader", null, globalDir);
		assert.equal(r.globalSeeded, false);
		assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).subagentExtInclude, undefined); // ว่างหมด → ลบก้อน
		assert.deepEqual(JSON.parse(readFileSync(join(globalDir, "config.json"), "utf8")).subagentExtInclude.grader, ["/a.ts"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("buildSubagentArgv: stripFlags override เข้า argv (c3); ไม่ส่ง → built-in map ไม่พัง", () => {
	const custom = buildSubagentArgv("task", undefined, ["write"], "grader", ["--no-skills", "--no-extensions", "-e", "/tmp/x.ts"]);
	assert.ok(custom.includes("/tmp/x.ts"));
	assert.ok(custom.includes("--no-extensions"));
	const dflt = buildSubagentArgv("task", undefined, ["write"], "grader");
	assert.ok(dflt.includes("--no-extensions"));
});

// anti-hang: budget นาทีจริงใน requirements prompt (spec v2 — ค้างจากเดิม ย้ายมารวมไฟล์นี้)
test("buildRequirementsPrompt: ใส่ timeout เป็นตัวเลขนาทีจริง + clause กันคำสั่งนาน → specDebt", () => {
	const p = buildRequirementsPrompt("intent", [], [], null, 600_000);
	assert.match(p, /about 10 minutes/);
	assert.match(p, /specDebt instead of burning your budget/);
	assert.match(buildRequirementsPrompt("intent", []), /about 5 minutes/); // backward-compat default
});

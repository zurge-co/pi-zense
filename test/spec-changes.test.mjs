import { strict as assert } from "node:assert";
import test from "node:test";
import { buildSpecChanges, renderSpecMd } from "../extensions/zense-harness/index.ts";

const baseSpec = (over = {}) => ({
	version: 1,
	title: "Fix login redirect",
	intent: "users hit /login twice",
	approach: ["read auth code", "patch guard"],
	scope: ["src/auth"],
	constraints: ["no new deps"],
	criteria: [
		{ id: "c1", text: "login test passes", check: "npm test" },
		{ id: "c2", text: "guard exists", check: "path exists: src/auth/guard.ts" },
	],
	specDebt: ["verify UX by eye"],
	approved: false,
	...over,
});

test("buildSpecChanges: identical spec → บรรทัดเตือนบรรทัดเดียว (ห้ามนำเสนอซ้ำเงียบๆ)", () => {
	const prev = baseSpec({ version: 3 });
	const next = baseSpec({ version: 4 });
	const lines = buildSpecChanges(prev, next);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /ไม่มีการเปลี่ยนแปลงจาก v3/);
	assert.ok(lines[0].startsWith("⚠️"));
});

test("buildSpecChanges: title / intent changes", () => {
	const prev = baseSpec({ version: 1 });
	const next = baseSpec({ version: 2, title: "New title", intent: "different intent" });
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.some((l) => l.includes('title: "Fix login redirect" → "New title"')));
	assert.ok(lines.some((l) => l.startsWith("intent:")));
});

test("buildSpecChanges: criteria added / removed / changed (text และ check)", () => {
	const prev = baseSpec({ version: 1 });
	const next = baseSpec({
		version: 2,
		criteria: [
			{ id: "c1", text: "login test passes", check: "npm test" }, // unchanged
			{ id: "c2", text: "guard renders", check: "path exists: src/auth/guard.tsx" }, // text+check changed
			{ id: "c3", text: "session persists", check: "npx vitest run" }, // added
		],
	});
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.some((l) => l.startsWith("criteria +: c3: session persists")));
	assert.ok(!lines.some((l) => l.includes("c1"))); // unchanged → ไม่รายงาน
	const c2 = lines.find((l) => l.startsWith("criteria ~: c2"));
	assert.ok(c2, "ต้องมี criteria ~: c2");
	assert.ok(c2.includes('text: "guard exists" → "guard renders"'));
	assert.ok(c2.includes('check: "path exists: src/auth/guard.ts" → "path exists: src/auth/guard.tsx"'));

	// removed
	const removed = buildSpecChanges(next, prev).find((l) => l.startsWith("criteria −:"));
	assert.equal(removed, "criteria −: c3: session persists");
});

test("buildSpecChanges: scope / constraints / approach / specDebt list diffs (+/−)", () => {
	const prev = baseSpec({ version: 1 });
	const next = baseSpec({
		version: 2,
		approach: ["read auth code", "patch guard", "add regression test"],
		scope: ["src/auth", "src/session"],
		constraints: [],
		specDebt: [],
	});
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.includes("approach +: add regression test"));
	assert.ok(lines.includes("scope +: src/session"));
	assert.ok(lines.includes("constraints −: no new deps"));
	assert.ok(lines.includes("specDebt −: verify UX by eye"));
});

test("buildSpecChanges: ทน field optional หาย (persisted spec เก่าไม่มี approach)", () => {
	const prev = baseSpec({ version: 1 });
	delete prev.approach; // persisted spec เก่าก่อน field approach
	const next = baseSpec({ version: 2 });
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.includes("approach +: read auth code"));
	assert.ok(!lines.some((l) => l.startsWith("approach −:")));
});

test("renderSpecMd: มี Changes section ก็ต่อเมื่อ spec มี changesFrom — v2 โชว์, spec เก่าเรนเดอร์เหมือนเดิมไม่ crash", () => {
	const changes = ['scope +: src/session', '⚠️ ไม่มีการเปลี่ยนแปลงจาก v9'];
	const withChanges = baseSpec({ version: 10, changesFrom: changes });
	const md = renderSpecMd(withChanges);
	assert.ok(md.includes("## Changes in v10 (vs v9)"));
	assert.ok(md.includes("- scope +: src/session"));
	// section changes ต้องอยู่ก่อน Intent — ผู้เซ็นเห็น change ก่อนอ่านเนื้อเต็ม
	assert.ok(md.indexOf("## Changes in v10") < md.indexOf("## Intent"));

	// backward compat: ไม่มี field / field ว่าง → ไม่มี section
	const old = baseSpec({ version: 10 });
	assert.ok(!renderSpecMd(old).includes("## Changes"));
	const empty = baseSpec({ version: 10, changesFrom: [] });
	assert.ok(!renderSpecMd(empty).includes("## Changes"));
});

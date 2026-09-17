import { strict as assert } from "node:assert";
import test from "node:test";
import {
	buildAcceptBulletin,
	buildDiscardBulletin,
	buildReconcileBulletin,
	resetCycleState,
	takeContextBulletin,
} from "../extensions/zense-harness/index.ts";

// cycle closure (spec v3, 2026-09-17): งานปิด 2 อาการ — (1) agent ไม่รู้ว่ามนุษย์ accept/discard/
// commit แล้ว (command/reconcile ปิดเงียบๆ เห็นแค่ tool results) → contextBulletin one-shot ติด
// system prompt ของ turn ถัดไปครั้งเดียว; (2) state.spec ค้างทำ commitSpec นับ version ต่อ → reset
// cycle state ให้งานใหม่เริ่ม v1. reset ต้องเคลียร์ cycle-scope แต่คง session-scope observability

test("buildAcceptBulletin: ครบ version/title/amended + ระบุ cycle reset + spec v1 | ≤2 บรรทัด", () => {
	const plain = buildAcceptBulletin(2, "Cycle closure", 0);
	assert.ok(plain.startsWith("[zense]"));
	assert.ok(plain.includes("v2") && plain.includes("Cycle closure"));
	assert.ok(plain.includes("cycle reset") && plain.includes("spec v1"));
	assert.ok(!plain.includes("แก้เพิ่ม"), "ไม่มี amended ไม่ควรพูดถึง");
	const amended = buildAcceptBulletin(1, "T", 3);
	assert.ok(amended.includes("3 ไฟล์"), "มี amended ต้องบอกจำนวนไฟล์");
	for (const b of [plain, amended]) assert.ok(b.split("\n").length <= 2, "bulletin ติด system prompt — ห้ามยาว");
});

test("buildReconcileBulletin / buildDiscardBulletin: keyword ครบ + สั้น", () => {
	const rec = buildReconcileBulletin(5);
	assert.ok(rec.includes("v5") && rec.includes("นอก flow") && rec.includes("spec v1"));
	const dis = buildDiscardBulletin(3);
	assert.ok(dis.includes("v3") && dis.includes("discard") && dis.includes("reverse patch") && dis.includes("spec v1"));
	for (const b of [rec, dis]) assert.ok(b.split("\n").length <= 2);
});

test("takeContextBulletin: one-shot เด็ดขาด — ครั้งแรกคืนค่า+เคลียร์, ครั้งสอง undefined; ไม่มีก็ไม่แตะ state", () => {
	const s = { contextBulletin: "hello", other: 1 };
	assert.equal(takeContextBulletin(s), "hello");
	assert.equal(s.contextBulletin, undefined);
	assert.equal(takeContextBulletin(s), undefined);
	const empty = { other: 2 };
	assert.equal(takeContextBulletin(empty), undefined);
	assert.deepEqual(empty, { other: 2 });
});

test("resetCycleState: เคลียร์ cycle fields ครบ (spec/phase/eval/head/override/source/paths) — งานใหม่เริ่ม v1", () => {
	const s = {
		spec: { version: 2, title: "old", approved: true },
		phase: "maintenance",
		lastEval: { verdict: "PASS" },
		baselineHead: "abc",
		evalOverrideFails: { specVersion: 2, ids: ["C1"], count: 1 },
		specSource: "set",
		specMdPath: "/x/spec.md",
		specJsonPath: "/x/spec.json",
		lastCompileLessons: 3,
		worktreeLeaveNotified: true,
		// session-scope observability — ต้องอยู่ครบ
		turnsUsed: 9,
		tokensUsed: 12345,
		subagentRuns: [{ role: "grader", ok: true, summary: "", at: 1 }],
		trajectoryFlags: ["f"],
		escalations: [{ kind: "accepted", detail: "d", at: 1 }],
		pendingApply: undefined,
	};
	resetCycleState(s);
	assert.equal(s.spec, undefined);
	assert.equal(s.phase, "requirements");
	for (const k of ["lastEval", "baselineHead", "evalOverrideFails", "specSource", "specMdPath", "specJsonPath", "lastCompileLessons", "worktreeLeaveNotified"])
		assert.equal(s[k], undefined, `${k} ต้องถูกเคลียร์ (cycle-scope)`);
	assert.equal(s.turnsUsed, 9);
	assert.equal(s.tokensUsed, 12345);
	assert.equal(s.subagentRuns.length, 1);
	assert.equal(s.trajectoryFlags.length, 1);
	assert.equal(s.escalations.length, 1);
});

test("resetCycleState: idempotent — state ว่างอยู่แล้วเรียกซ้ำไม่พัง", () => {
	const s = { phase: "maintenance", turnsUsed: 0, tokensUsed: 0, subagentRuns: [], trajectoryFlags: [], escalations: [] };
	resetCycleState(s);
	resetCycleState(s);
	assert.equal(s.phase, "requirements");
	assert.equal(s.spec, undefined);
	// ควบคู่ bulletin: reset ไม่แตะ contextBulletin (caller set หลัง reset ได้)
	s.contextBulletin = buildReconcileBulletin(1);
	assert.equal(takeContextBulletin(s), buildReconcileBulletin(1));
});

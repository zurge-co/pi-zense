import { strict as assert } from "node:assert";
import test from "node:test";
import {
	buildAcceptBulletin,
	buildDiscardBulletin,
	buildReconcileBulletin,
	resetCycleState,
	takeContextBulletin,
} from "../extensions/zense-harness/index.ts";

// cycle closure (spec v3, 2026-09-17): two symptoms of sloppy closure — (1) the agent doesn't
// know the human accepted/discarded/committed (command/reconcile paths close silently; the
// agent only ever sees tool results) → a one-shot contextBulletin rides the next turn's
// system prompt once; (2) a leftover state.spec would make commitSpec continue the version
// counter → reset cycle state so new work starts at v1. The reset must clear cycle scope
// while keeping session-scope observability.

test("buildAcceptBulletin: version/title/amended complete + mentions cycle reset + spec v1 | ≤2 lines", () => {
	const plain = buildAcceptBulletin(2, "Cycle closure", 0);
	assert.ok(plain.startsWith("[zense]"));
	assert.ok(plain.includes("v2") && plain.includes("Cycle closure"));
	assert.ok(plain.includes("cycle reset") && plain.includes("spec v1"));
	assert.ok(!plain.includes("amended"), "no amendments → must not mention them");
	const amended = buildAcceptBulletin(1, "T", 3);
	assert.ok(amended.includes("amended 3 file(s)"), "amendments must state the file count");
	for (const b of [plain, amended]) assert.ok(b.split("\n").length <= 2, "bulletins ride the system prompt — must stay short");
});

test("buildReconcileBulletin / buildDiscardBulletin: keywords complete + short", () => {
	const rec = buildReconcileBulletin(5);
	assert.ok(rec.includes("v5") && rec.includes("outside the flow") && rec.includes("spec v1"));
	const dis = buildDiscardBulletin(3);
	assert.ok(dis.includes("v3") && dis.includes("discard") && dis.includes("reverse patch") && dis.includes("spec v1"));
	for (const b of [rec, dis]) assert.ok(b.split("\n").length <= 2);
});

test("takeContextBulletin: strictly one-shot — first call returns+clears, second is undefined; absent leaves state alone", () => {
	const s = { contextBulletin: "hello", other: 1 };
	assert.equal(takeContextBulletin(s), "hello");
	assert.equal(s.contextBulletin, undefined);
	assert.equal(takeContextBulletin(s), undefined);
	const empty = { other: 2 };
	assert.equal(takeContextBulletin(empty), undefined);
	assert.deepEqual(empty, { other: 2 });
});

test("resetCycleState: clears all cycle fields (spec/phase/eval/head/override/source/paths) — new work starts at v1", () => {
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
		// session-scope observability — must survive
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
		assert.equal(s[k], undefined, `${k} must be cleared (cycle scope)`);
	assert.equal(s.turnsUsed, 9);
	assert.equal(s.tokensUsed, 12345);
	assert.equal(s.subagentRuns.length, 1);
	assert.equal(s.trajectoryFlags.length, 1);
	assert.equal(s.escalations.length, 1);
});

test("resetCycleState: idempotent — repeated calls on an already-empty state do not break", () => {
	const s = { phase: "maintenance", turnsUsed: 0, tokensUsed: 0, subagentRuns: [], trajectoryFlags: [], escalations: [] };
	resetCycleState(s);
	resetCycleState(s);
	assert.equal(s.phase, "requirements");
	assert.equal(s.spec, undefined);
	// alongside the bulletin: reset never touches contextBulletin (callers may set it after)
	s.contextBulletin = buildReconcileBulletin(1);
	assert.equal(takeContextBulletin(s), buildReconcileBulletin(1));
});

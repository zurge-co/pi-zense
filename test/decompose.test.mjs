import { strict as assert } from "node:assert";
import test from "node:test";
import {
	buildPlannerPrompt,
	compileDecomposed,
	DECOMPOSE_MAX_CHARS,
	DECOMPOSE_MAX_WORDS,
	mergeSubtaskDrafts,
	needsDecompose,
	parsePlannerSubtasks,
	SUBAGENT_EXCLUDE_TOOLS,
	SUBAGENT_STRIP_FLAGS,
	SUBAGENT_TIMEOUT_MS,
} from "../extensions/zense-harness/index.ts";

// decompose-then-compile: planner role + needsDecompose + planner parser + merge + orchestration (pure —
// runTask เป็น injected fake ไม่ spawn pi จริง)

const planJson = (subs) => JSON.stringify({ subtasks: subs });
const twoSubs = () => [
	{ id: "t1", title: "core", intent: "implement the core logic" },
	{ id: "t2", title: "tests", intent: "cover it with tests", scope: "test/" },
];
const specJson = (marker) =>
	JSON.stringify({
		title: `draft-${marker}`,
		intent: `intent-${marker}`,
		approach: [`step-${marker}`],
		scope: [`scope-${marker}/`],
		constraints: ["shared-constraint", `c-${marker}`],
		criteria: [
			{ text: `crit-${marker}-1`, check: "npm test" },
			{ id: "same-id", text: `crit-${marker}-2`, check: "npm run typecheck" },
		],
		specDebt: [marker === "t1" ? "debt-a" : "debt-a"],
	});

// ---------- needsDecompose (threshold ต้อง deterministic — test assert boundary เป็นตัวเลข)

test("needsDecompose: intent เล็ก/สั้นจริง → false (flow เดิมไม่แตะ)", () => {
	assert.equal(needsDecompose(""), false);
	assert.equal(needsDecompose("fix the typo in README"), false);
	assert.equal(needsDecompose("กำ".repeat(100)), false);
});

test("needsDecompose: เกิน threshold คำ → true; พอดี threshold → false (boundary เด็ดขาด)", () => {
	assert.equal(needsDecompose(Array(DECOMPOSE_MAX_WORDS).fill("w").join(" ")), false);
	assert.equal(needsDecompose(Array(DECOMPOSE_MAX_WORDS + 1).fill("w").join(" ")), true);
});

test("needsDecompose: ภาษาไม่เว้นวรรค (ไทย) วัดด้วยความยาวตัวอักษรแทน → ยาวเกิน threshold ก็ true", () => {
	assert.equal(needsDecompose("ง".repeat(DECOMPOSE_MAX_CHARS)), false);
	assert.equal(needsDecompose("ง".repeat(DECOMPOSE_MAX_CHARS + 1)), true);
});

// ---------- parsePlannerSubtasks (validate shape + จำนวน 2–8 + id unique — throw ข้อความเจาะจง)

test("parsePlannerSubtasks: JSON ตรงๆ และ ```json fence ใช้ได้เหมือนกัน", () => {
	const plain = parsePlannerSubtasks(planJson(twoSubs()));
	assert.equal(plain.length, 2);
	assert.deepEqual(plain[0], { id: "t1", title: "core", intent: "implement the core logic" });
	assert.deepEqual(plain[1], { id: "t2", title: "tests", intent: "cover it with tests", scope: "test/" });
	const fenced = parsePlannerSubtasks(`โอเคครับ\n\`\`\`json\n${planJson(twoSubs())}\n\`\`\`\nเสร็จแล้ว`);
	assert.equal(fenced.length, 2);
});

test("parsePlannerSubtasks: output ผิดรูป → throw (น้อยกว่า 2 / เกิน 8 / ไม่ใช่ JSON / subtasks ไม่ใช่ array)", () => {
	assert.throws(() => parsePlannerSubtasks(planJson(twoSubs().slice(0, 1))), /2–8/);
	assert.throws(() => parsePlannerSubtasks(planJson(Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, title: "x", intent: "y" })))), /2–8/);
	assert.throws(() => parsePlannerSubtasks("no json here at all"), /JSON/);
	assert.throws(() => parsePlannerSubtasks(JSON.stringify({ subtasks: "nope" })), /2–8/);
});

test("parsePlannerSubtasks: id ซ้ำ / field ว่าง → throw เจาะจงตำแหน่ง", () => {
	assert.throws(() => parsePlannerSubtasks(planJson([{ id: "t1", title: "a", intent: "x" }, { id: "t1", title: "b", intent: "y" }])), /ซ้ำ/);
	assert.throws(() => parsePlannerSubtasks(planJson([{ id: "t1", title: "a", intent: "" }, { id: "t2", title: "b", intent: "y" }])), /intent ว่าง/);
	assert.throws(() => parsePlannerSubtasks(planJson([{ id: "", title: "a", intent: "x" }, { id: "t2", title: "b", intent: "y" }])), /id ว่าง/);
});

test("buildPlannerPrompt: ฝัง intent + กติกา 2–8 subtasks และระบุ sequential ไว้ใน prompt", () => {
	const p = buildPlannerPrompt("MY BIG TASK", 120_000);
	assert.match(p, /MY BIG TASK/);
	assert.match(p, /2 to 8 subtasks/);
	assert.match(p, /SEQUENTIAL/);
});

// ---------- mergeSubtaskDrafts (criteria รวมต้อง unique id, scope/constraints dedupe)

test("mergeSubtaskDrafts: รวม 2 drafts — criteria ต่อกัน re-id c1..cN (id ชนเดิมถูกแก้), ค่าซ้ำ dedupe, approach ติด prefix", () => {
	const d1 = { subtask: "t1", draft: parseDraftForMerge("t1") };
	const d2 = { subtask: "t2", draft: parseDraftForMerge("t2") };
	const m = mergeSubtaskDrafts("BIG", "the whole intent", [d1, d2]);
	assert.equal(m.title, "BIG");
	assert.equal(m.intent, "the whole intent");
	assert.deepEqual(m.criteria.map((c) => c.id), ["c1", "c2", "c3", "c4"]); // "same-id" สองตัวไม่ชนแล้ว
	assert.equal(m.criteria.length, 4);
	assert.deepEqual(m.scope, ["scope-t1/", "scope-t2/"]);
	assert.deepEqual(m.constraints, ["shared-constraint", "c-t1", "c-t2"]);
	assert.deepEqual(m.specDebt, ["debt-a"]); // dedupe
	assert.ok(m.approach.every((a, i) => a.startsWith(i === 0 ? "[t1] " : "[t2] ")));
});

function parseDraftForMerge(marker) {
	// draft ผ่าน shape เดียวกับ parseSpecDraft ออกมา (สร้างเองตรงๆ เพื่อเลี่ยง dependency ลูป)
	return JSON.parse(specJson(marker));
}

// ---------- compileDecomposed (orchestration — fake runTask, assert sequential + fail-fast)

const fakePlanner = (output, ok = true) => ({ ok, output });
const runFor = (calls, handlers) => async (role, task) => {
	calls.push([role, task]);
	return handlers[role](task);
};

test("compileDecomposed: happy path — planner ก่อน แล้ว requirements ทีละ subtask ตามลำดับ (sequential-only)", async () => {
	const calls = [];
	const runTask = runFor(calls, {
		planner: () => Promise.resolve(fakePlanner(planJson(twoSubs()))),
		requirements: (task) => Promise.resolve(fakePlanner(specJson(task.includes("t1") ? "t1" : "t2"))),
	});
	const r = await compileDecomposed("BIG INTENT", runTask, (st) => `PROMPT[${st.id}]`);
	assert.deepEqual(calls.map(([role]) => role), ["planner", "requirements", "requirements"]);
	assert.deepEqual(calls[1][1], "PROMPT[t1]");
	assert.deepEqual(calls[2][1], "PROMPT[t2]");
	assert.equal(r.subtasks.length, 2);
	assert.deepEqual(r.drafts.map((d) => d.subtask), ["t1", "t2"]);
});

test("compileDecomposed: planner ล้ม (ok=false หรือ output ผิดรูป) → throw ทันที ไม่ยิง requirements เลย", async () => {
	const calls = [];
	await assert.rejects(
		compileDecomposed("X", runFor(calls, { planner: () => Promise.resolve({ ok: false, output: "boom\nmore" }), requirements: () => Promise.reject(new Error("must not be called")) }), (st) => st.id),
		/planner sub-agent failed/,
	);
	assert.equal(calls.length, 1);
	await assert.rejects(
		compileDecomposed("X", runFor(calls, { planner: () => Promise.resolve(fakePlanner("not json")), requirements: () => Promise.reject(new Error("must not be called")) }), (st) => st.id),
		/JSON/,
	);
	assert.equal(calls.length, 2); // planner รอบที่สองเท่านั้น — requirements ยังไม่ถูกเรียก
});

test("compileDecomposed: subtask ล้มกลางทาง → หยุดทันที (subtask ถัดไปไม่ถูกยิง), ไม่เสนอ spec ครึ่งๆ", async () => {
	const calls = [];
	const threeSubs = [...twoSubs(), { id: "t3", title: "docs", intent: "write docs" }];
	const runTask = runFor(calls, {
		planner: () => Promise.resolve(fakePlanner(planJson(threeSubs))),
		requirements: (task) =>
			task.includes("t2") ? Promise.resolve({ ok: false, output: "timeout" }) : Promise.resolve(fakePlanner(specJson("t1"))),
	});
	await assert.rejects(compileDecomposed("X", runTask, (st) => `PROMPT[${st.id}]`), /subtask t2/);
	assert.deepEqual(calls.map(([role, task]) => [role, String(task)]),
		[["planner", calls[0][1]], ["requirements", "PROMPT[t1]"], ["requirements", "PROMPT[t2]"]]); // t3 ไม่ถูกยิง
});

test("compileDecomposed: subtask ดันถาม clarify → throw (decompose path ไม่รองรับ clarify — caller fallback)", async () => {
	const runTask = runFor([], {
		planner: () => Promise.resolve(fakePlanner(planJson(twoSubs()))),
		requirements: () => Promise.resolve(fakePlanner(JSON.stringify({ questions: ["which db?"] }))),
	});
	await assert.rejects(compileDecomposed("X", runTask, (st) => st.id), /clarify/);
});

// ---------- planner เป็น first-class role: wire ครบทุก per-role registry เหมือน role อื่น

test("planner role: อยู่ใน SUBAGENT_EXCLUDE_TOOLS (read-only), STRIP_FLAGS และ TIMEOUT_MS ครบ", () => {
	assert.deepEqual(SUBAGENT_EXCLUDE_TOOLS.planner, ["write", "edit"]);
	assert.ok(Array.isArray(SUBAGENT_STRIP_FLAGS.planner) && SUBAGENT_STRIP_FLAGS.planner.length > 0);
	assert.ok(SUBAGENT_TIMEOUT_MS.planner > 0);
});

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

// decompose-then-compile: planner role + needsDecompose + planner parser + merge +
// orchestration (pure — runTask is an injected fake; no real pi spawn)

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

// ---------- needsDecompose (deterministic thresholds — the tests assert numeric boundaries)

test("needsDecompose: genuinely small/short intent → false (normal flow untouched)", () => {
	assert.equal(needsDecompose(""), false);
	assert.equal(needsDecompose("fix the typo in README"), false);
	assert.equal(needsDecompose("fix".repeat(100)), false);
});

test("needsDecompose: over the word threshold → true; exactly at it → false (hard boundary)", () => {
	assert.equal(needsDecompose(Array(DECOMPOSE_MAX_WORDS).fill("w").join(" ")), false);
	assert.equal(needsDecompose(Array(DECOMPOSE_MAX_WORDS + 1).fill("w").join(" ")), true);
});

test("needsDecompose: whitespace-free languages measured by character length instead → over the threshold is true too", () => {
	assert.equal(needsDecompose("中".repeat(DECOMPOSE_MAX_CHARS)), false);
	assert.equal(needsDecompose("中".repeat(DECOMPOSE_MAX_CHARS + 1)), true);
});

// ---------- parsePlannerSubtasks (shape validation + 2–8 count + unique ids — specific throw messages)

test("parsePlannerSubtasks: raw JSON and ```json fences both work", () => {
	const plain = parsePlannerSubtasks(planJson(twoSubs()));
	assert.equal(plain.length, 2);
	assert.deepEqual(plain[0], { id: "t1", title: "core", intent: "implement the core logic" });
	assert.deepEqual(plain[1], { id: "t2", title: "tests", intent: "cover it with tests", scope: "test/" });
	const fenced = parsePlannerSubtasks(`Sure thing\n\`\`\`json\n${planJson(twoSubs())}\n\`\`\`\nDone`);
	assert.equal(fenced.length, 2);
});

test("parsePlannerSubtasks: malformed output → throw (<2 / >8 / not JSON / subtasks not an array)", () => {
	assert.throws(() => parsePlannerSubtasks(planJson(twoSubs().slice(0, 1))), /2–8/);
	assert.throws(() => parsePlannerSubtasks(planJson(Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, title: "x", intent: "y" })))), /2–8/);
	assert.throws(() => parsePlannerSubtasks("no json here at all"), /JSON/);
	assert.throws(() => parsePlannerSubtasks(JSON.stringify({ subtasks: "nope" })), /2–8/);
});

test("parsePlannerSubtasks: duplicated id / empty field → throw naming the spot", () => {
	assert.throws(() => parsePlannerSubtasks(planJson([{ id: "t1", title: "a", intent: "x" }, { id: "t1", title: "b", intent: "y" }])), /duplicated/);
	assert.throws(() => parsePlannerSubtasks(planJson([{ id: "t1", title: "a", intent: "" }, { id: "t2", title: "b", intent: "y" }])), /intent is empty/);
	assert.throws(() => parsePlannerSubtasks(planJson([{ id: "", title: "a", intent: "x" }, { id: "t2", title: "b", intent: "y" }])), /id is empty/);
});

test("buildPlannerPrompt: embeds the intent + the 2–8 subtask rule and states sequential order", () => {
	const p = buildPlannerPrompt("MY BIG TASK", 120_000);
	assert.match(p, /MY BIG TASK/);
	assert.match(p, /2 to 8 subtasks/);
	assert.match(p, /SEQUENTIAL/);
});

// ---------- mergeSubtaskDrafts (merged criteria get unique ids, scope/constraints deduped)

test("mergeSubtaskDrafts: 2 drafts — criteria concatenated + re-idded c1..cN (colliding ids fixed), duplicates deduped, approach prefixed", () => {
	const d1 = { subtask: "t1", draft: parseDraftForMerge("t1") };
	const d2 = { subtask: "t2", draft: parseDraftForMerge("t2") };
	const m = mergeSubtaskDrafts("BIG", "the whole intent", [d1, d2]);
	assert.equal(m.title, "BIG");
	assert.equal(m.intent, "the whole intent");
	assert.deepEqual(m.criteria.map((c) => c.id), ["c1", "c2", "c3", "c4"]); // the two "same-id" no longer collide
	assert.equal(m.criteria.length, 4);
	assert.deepEqual(m.scope, ["scope-t1/", "scope-t2/"]);
	assert.deepEqual(m.constraints, ["shared-constraint", "c-t1", "c-t2"]);
	assert.deepEqual(m.specDebt, ["debt-a"]); // deduped
	assert.ok(m.approach.every((a, i) => a.startsWith(i === 0 ? "[t1] " : "[t2] ")));
});

function parseDraftForMerge(marker) {
	// a draft of the same shape parseSpecDraft returns (built directly to avoid a dependency loop)
	return JSON.parse(specJson(marker));
}

// ---------- compileDecomposed (orchestration — fake runTask, asserts sequential + fail-fast)

const fakePlanner = (output, ok = true) => ({ ok, output });
const runFor = (calls, handlers) => async (role, task) => {
	calls.push([role, task]);
	return handlers[role](task);
};

test("compileDecomposed: happy path — planner first, then requirements per subtask in order (sequential only)", async () => {
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

test("compileDecomposed: planner failure (ok=false or malformed output) → throws immediately, never launches requirements", async () => {
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
	assert.equal(calls.length, 2); // only the second planner round — requirements still uncalled
});

test("compileDecomposed: a subtask failing mid-way stops everything (later subtasks never launch), no half-spec is offered", async () => {
	const calls = [];
	const threeSubs = [...twoSubs(), { id: "t3", title: "docs", intent: "write docs" }];
	const runTask = runFor(calls, {
		planner: () => Promise.resolve(fakePlanner(planJson(threeSubs))),
		requirements: (task) =>
			task.includes("t2") ? Promise.resolve({ ok: false, output: "timeout" }) : Promise.resolve(fakePlanner(specJson("t1"))),
	});
	await assert.rejects(compileDecomposed("X", runTask, (st) => `PROMPT[${st.id}]`), /subtask t2/);
	assert.deepEqual(calls.map(([role, task]) => [role, String(task)]),
		[["planner", calls[0][1]], ["requirements", "PROMPT[t1]"], ["requirements", "PROMPT[t2]"]]); // t3 never launched
});

test("compileDecomposed: a subtask asking to clarify → throw (decompose has no per-subtask clarify — caller falls back)", async () => {
	const runTask = runFor([], {
		planner: () => Promise.resolve(fakePlanner(planJson(twoSubs()))),
		requirements: () => Promise.resolve(fakePlanner(JSON.stringify({ questions: ["which db?"] }))),
	});
	await assert.rejects(compileDecomposed("X", runTask, (st) => st.id), /clarify/);
});

// ---------- planner is a first-class role: wired into every per-role registry like the others

test("planner role: present in SUBAGENT_EXCLUDE_TOOLS (read-only), STRIP_FLAGS and TIMEOUT_MS", () => {
	assert.deepEqual(SUBAGENT_EXCLUDE_TOOLS.planner, ["write", "edit"]);
	assert.ok(Array.isArray(SUBAGENT_STRIP_FLAGS.planner) && SUBAGENT_STRIP_FLAGS.planner.length > 0);
	assert.ok(SUBAGENT_TIMEOUT_MS.planner > 0);
});

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyQualityGate,
	buildRequirementsPrompt,
	buildSubagentArgv,
	extractJsonObject,
	findSimilarSpec,
	isMachineCheckable,
	parseSpecDraft,
} from "../extensions/zense-harness/index.ts";

const GOOD_SPEC = {
	title: "Fix login redirect",
	intent: "users hit /login twice",
	scope: ["src/auth"],
	constraints: ["no new deps"],
	criteria: [
		{ id: "c1", text: "login test passes", check: "npm test" },
		{ text: "guard exists", check: "path exists: src/auth/guard.ts" }, // missing id → auto c2
	],
	specDebt: [],
};

test("extractJsonObject: tolerates plain JSON, fences and surrounding prose", () => {
	const json = JSON.stringify(GOOD_SPEC);
	assert.deepEqual(extractJsonObject(json), GOOD_SPEC);
	assert.equal(extractJsonObject("```json\n" + json + "\n```").title, "Fix login redirect");
	assert.equal(extractJsonObject("Here is the spec!\n" + json + "\nHope this helps.").intent, "users hit /login twice");
	assert.equal(extractJsonObject("no json at all"), undefined);
});

test("parseSpecDraft: valid spec (plain/fenced) → kind spec with normalized ids and defaults", () => {
	const parsed = parseSpecDraft(JSON.stringify(GOOD_SPEC));
	assert.equal(parsed.kind, "spec");
	assert.equal(parsed.draft.criteria[1].id, "c2"); // id auto-assign
	const fenced = parseSpecDraft("here's the draft:\n```json\n" + JSON.stringify({ title: "T", criteria: [{ text: "x", check: "npm test" }] }) + "\n```");
	assert.equal(fenced.kind, "spec");
	assert.deepEqual(fenced.draft.scope, []); // missing array → []
	assert.equal(fenced.draft.title, "T");
});

test("parseSpecDraft: approach normalize — missing/invalid → [], valid array → kept", () => {
	const withApproach = parseSpecDraft(JSON.stringify({ ...GOOD_SPEC, approach: ["add approach field to Spec/SpecDraft", "wire prompt contract + renderSpecMd", "npm test green"] }));
	assert.equal(withApproach.kind, "spec");
	assert.deepEqual(withApproach.draft.approach, ["add approach field to Spec/SpecDraft", "wire prompt contract + renderSpecMd", "npm test green"]);
	const missing = parseSpecDraft(JSON.stringify(GOOD_SPEC));
	assert.equal(missing.kind, "spec");
	assert.deepEqual(missing.draft.approach, []); // missing → []
	const invalid = parseSpecDraft(JSON.stringify({ ...GOOD_SPEC, approach: 42 }));
	assert.deepEqual(invalid.draft.approach, []); // invalid → []
	// the clarify/error contract holds: clarify wins only when no criteria exist
	assert.equal(parseSpecDraft(JSON.stringify({ questions: ["q"], approach: ["x"] })).kind, "clarify");
});

test("buildRequirementsPrompt: JSON contract includes approach (presentational, not a machine-checked criterion)", () => {
	const p = buildRequirementsPrompt("add dark mode", []);
	assert.match(p, /"approach": string\[\]/);
	assert.match(p, /approach: 3–7 short bullets/);
	assert.match(p, /NOT a machine-checked criterion/);
});

test("parseSpecDraft: clarify shape (questions only) → kind clarify; questions+criteria → spec", () => {
	const clarify = parseSpecDraft(JSON.stringify({ questions: ["which env?", "which db?"] }));
	assert.equal(clarify.kind, "clarify");
	assert.deepEqual(clarify.questions, [
		{ question: "which env?", choices: [] },
		{ question: "which db?", choices: [] },
	]);
	// with criteria present it's a real draft, not a clarification
	const withCriteria = parseSpecDraft(JSON.stringify({ questions: ["q"], ...GOOD_SPEC }));
	assert.equal(withCriteria.kind, "spec");
});

test("parseSpecDraft: clarify questions normalize — choices shape, mixed legacy, junk skipped, cap 5", () => {
	// new shape: the sub-agent attaches choices for quick human picking
	const withChoices = parseSpecDraft(JSON.stringify({ questions: [{ question: "pick env?", choices: ["dev", "prod"] }] }));
	assert.equal(withChoices.kind, "clarify");
	assert.deepEqual(withChoices.questions, [{ question: "pick env?", choices: ["dev", "prod"] }]);
	// both shapes may mix in one array: legacy string + new object
	const mixed = parseSpecDraft(JSON.stringify({ questions: ["plain?", { question: "with choice?", choices: ["a"] }] }));
	assert.deepEqual(mixed.questions, [
		{ question: "plain?", choices: [] },
		{ question: "with choice?", choices: ["a"] },
	]);
	// items without a real question are skipped
	const junky = parseSpecDraft(JSON.stringify({ questions: [{ foo: 1 }, "real?"] }));
	assert.deepEqual(junky.questions, [{ question: "real?", choices: [] }]);
	// zero questions left → not clarify (falls back to the criteria-missing error per contract)
	assert.equal(parseSpecDraft(JSON.stringify({ questions: [{ foo: 1 }] })).kind, "error");
	// the cap of 5 stays (keeps dialogs short)
	const many = parseSpecDraft(JSON.stringify({ questions: ["1", "2", "3", "4", "5", "6"] }));
	assert.equal(many.questions.length, 5);
});

test("parseSpecDraft: invalid outputs → kind error with a specific reason (retry feedback)", () => {
	assert.equal(parseSpecDraft("sure, let me think about it").kind, "error");
	assert.match(parseSpecDraft(JSON.stringify({ title: "T" })).error, /criteria/); // criteria missing
	const badItem = parseSpecDraft(JSON.stringify({ criteria: [{ text: "x" }] }));
	assert.equal(badItem.kind, "error");
	assert.match(badItem.error, /\[0\]\.check/); // names the index so the model fixes the right spot
});

test("isMachineCheckable: runnable commands / path-exists pass, manual/ambiguous fail", () => {
	assert.ok(isMachineCheckable("npm test"));
	assert.ok(isMachineCheckable("node --test test/x.mjs"));
	assert.ok(isMachineCheckable("path exists: src/auth/guard.ts"));
	assert.ok(isMachineCheckable("run `vitest run`"));
	assert.ok(!isMachineCheckable("manual review by the team"));
	assert.ok(!isMachineCheckable("ask the human to verify it works"));
	assert.ok(!isMachineCheckable("GET /health returns 200")); // no command token → forced human review
});

test("applyQualityGate: empty scope and non-machine checks are forced into specDebt with notes", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-draft-"));
	try {
		const gated = applyQualityGate(dir, {
			title: "T",
			intent: "fix things",
			scope: [],
			constraints: [],
			criteria: [
				{ id: "c1", text: "tests pass", check: "npm test" },
				{ id: "c2", text: "looks good", check: "manual visual QA" },
			],
			specDebt: [],
		});
		assert.deepEqual(gated.notes, ["empty-scope", "manual-check:c2"]);
		assert.equal(gated.draft.specDebt.length, 2);

		// a scope pointing at a nonexistent path → the quality gate catches it (a typo'd scope is toothless)
		const ghost = applyQualityGate(dir, { ...gated.draft, scope: ["ghost/path-xyz"], specDebt: [] });
		assert.ok(ghost.notes.some((n) => n.startsWith("scope-missing:ghost/path-xyz")));
		assert.ok(ghost.draft.specDebt.some((d) => d.includes("ghost/path-xyz")));
		assert.match(gated.draft.specDebt[0], /scope/);
		assert.match(gated.draft.specDebt[1], /c2/);
		assert.equal(gated.draft.criteria.length, 2); // criteria untouched, only flagged

		// a good draft (scope hits a real repo path — the wave 2/3 scope-missing rule) → specDebt untouched
		mkdirSync(join(dir, "src", "auth"), { recursive: true });
		const clean = applyQualityGate(dir, { ...GOOD_SPEC, title: "Unique title xyz", intent: "unrelated intent qrs" });
		assert.deepEqual(clean.notes, []);
		assert.equal(clean.draft.specDebt.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("findSimilarSpec: archived spec with overlapping title+intent is flagged (Jaccard ≥ 0.5)", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-sim-"));
	try {
		assert.equal(findSimilarSpec(dir, { ...GOOD_SPEC }), null); // no specs dir yet → null
		const specsDir = join(dir, ".zense", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(
			join(specsDir, "2026-01-01-00-00-00-v1-fix-login-redirect.json"),
			JSON.stringify({ title: "fix login redirect", intent: "users hit the login page twice" }),
		);
		const hit = findSimilarSpec(dir, { ...GOOD_SPEC, title: "fix login redirect bug", intent: "users hit the login page twice" });
		assert.ok(hit, "must catch the similar spec");
		assert.match(hit.file, /fix-login-redirect/);
		const miss = findSimilarSpec(dir, { ...GOOD_SPEC, title: "database migration tooling", intent: "add schema versioning for postgres" });
		assert.equal(miss, null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildSubagentArgv: requirements role is read-only (--exclude-tools write,edit), others untouched", () => {
	const ro = buildSubagentArgv("draft a spec", "anthropic/claude-sonnet", ["write", "edit"]);
	assert.deepEqual(ro.slice(0, 4), ["PI_ZENSE_SUBAGENT=1", "pi", "--mode", "json"]);
	const xt = ro.indexOf("--exclude-tools");
	assert.ok(xt > 0 && ro[xt + 1] === "write,edit");
	const md = ro.indexOf("--model");
	assert.ok(md > xt, "--exclude-tools must come before --model");
	assert.equal(ro.at(-1), "draft a spec");

	const plain = buildSubagentArgv("grade it");
	assert.ok(!plain.includes("--exclude-tools"));
	assert.equal(plain.at(-1), "grade it");
});

test("buildSubagentArgv: per-role strip flags — grader/reviewer boot fully bare, requirements keep skills/extensions", () => {
	const FULL = ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"];
	for (const role of ["grader", "reviewer"]) {
		const a = buildSubagentArgv(`task-${role}`, undefined, undefined, role);
		for (const f of FULL) assert.ok(a.includes(f), `${role} must have ${f}`);
		assert.equal(a.at(-1), `task-${role}`, "the task must always be argv's last element");
		// strip flags sit after --no-session and before the task (before --exclude-tools/--model when present)
		assert.ok(a.indexOf("--no-themes") > a.indexOf("--no-session"), `${role}: strip flags must come after --no-session`);
	}
	// grader combined with --exclude-tools + --model → ordering: strip flags lead both
	const g = buildSubagentArgv("grade", "sonnet", ["write", "edit"], "grader");
	assert.ok(g.indexOf("--no-skills") < g.indexOf("--exclude-tools"), "strip flags must come before --exclude-tools");
	assert.ok(g.indexOf("--exclude-tools") < g.indexOf("--model"), "--exclude-tools must come before --model (standing contract)");
	// requirements: repo exploration needs skills/extensions visible — strip only themes/prompt-templates
	const req = buildSubagentArgv("draft", undefined, undefined, "requirements");
	assert.ok(req.includes("--no-themes") && req.includes("--no-prompt-templates"));
	assert.ok(!req.includes("--no-skills") && !req.includes("--no-extensions"), "requirements must not strip skills/extensions");
	// no role / unknown role → no strip flags (checking only real strip flags — argv always contains --no-session)
	const STRIP_ONLY = ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"];
	assert.ok(!STRIP_ONLY.some((f) => buildSubagentArgv("x").includes(f)));
	assert.ok(!STRIP_ONLY.some((f) => buildSubagentArgv("x", undefined, undefined, "mystery").includes(f)));
});

test("buildRequirementsPrompt: enforces explore-first, JSON-only output and the clarify contract", () => {
	const p = buildRequirementsPrompt("add dark mode", []);
	assert.match(p, /EXPLORE \(read-only/);
	assert.match(p, /NO write\/edit tools/);
	assert.match(p, /"questions"/);
	assert.match(p, /"choices"/); // grilling loop: the sub-agent may attach answer options
	assert.match(p, /type their own/); // the user can always type their own answer
	assert.match(p, /1–2 most decision-critical/); // few questions per round, several rounds
	assert.match(p, /Request: add dark mode$/);
	assert.doesNotMatch(p, /Past lessons/);
	const withLessons = buildRequirementsPrompt("x", ["📚 lesson one"]);
	assert.match(withLessons, /Past lessons[\s\S]*lesson one/);
});

test("applyQualityGate: unsubstituted placeholder in check → specDebt + notes (fix check before signing)", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-ph-"));
	try {
		const gated = applyQualityGate(dir, {
			title: "T",
			intent: "i",
			scope: ["."],
			constraints: [],
			criteria: [
				{ id: "c1", text: "ok", check: "npm test" },
				{ id: "c2", text: "ph", check: "path exists: src/<module>/x.ts" },
			],
			specDebt: [],
		});
		assert.ok(gated.notes.includes("placeholder:c2"));
		assert.ok(!gated.notes.some((n) => n.startsWith("placeholder:c1")));
		assert.ok(gated.draft.specDebt.some((d) => d.includes("unsubstituted placeholder in its check") && d.includes("<module>")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

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
		{ text: "guard exists", check: "path exists: src/auth/guard.ts" }, // id หาย → auto c2
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
	const fenced = parseSpecDraft("draft ครับ:\n```json\n" + JSON.stringify({ title: "T", criteria: [{ text: "x", check: "npm test" }] }) + "\n```");
	assert.equal(fenced.kind, "spec");
	assert.deepEqual(fenced.draft.scope, []); // array หาย → []
	assert.equal(fenced.draft.title, "T");
});

test("parseSpecDraft: clarify shape (questions only) → kind clarify; questions+criteria → spec", () => {
	const clarify = parseSpecDraft(JSON.stringify({ questions: ["which env?", "which db?"] }));
	assert.equal(clarify.kind, "clarify");
	assert.deepEqual(clarify.questions, ["which env?", "which db?"]);
	// มี criteria แล้ว = draft จริง ไม่ใช่ clarification
	const withCriteria = parseSpecDraft(JSON.stringify({ questions: ["q"], ...GOOD_SPEC }));
	assert.equal(withCriteria.kind, "spec");
});

test("parseSpecDraft: invalid outputs → kind error with a specific reason (retry feedback)", () => {
	assert.equal(parseSpecDraft("sure, let me think about it").kind, "error");
	assert.match(parseSpecDraft(JSON.stringify({ title: "T" })).error, /criteria/); // criteria หาย
	const badItem = parseSpecDraft(JSON.stringify({ criteria: [{ text: "x" }] }));
	assert.equal(badItem.kind, "error");
	assert.match(badItem.error, /\[0\]\.check/); // บอก index ให้ model แก้ตรงจุด
});

test("isMachineCheckable: runnable commands / path-exists pass, manual/ambiguous fail", () => {
	assert.ok(isMachineCheckable("npm test"));
	assert.ok(isMachineCheckable("node --test test/x.mjs"));
	assert.ok(isMachineCheckable("path exists: src/auth/guard.ts"));
	assert.ok(isMachineCheckable("run `vitest run`"));
	assert.ok(!isMachineCheckable("manual review by the team"));
	assert.ok(!isMachineCheckable("ask the human to verify it works"));
	assert.ok(!isMachineCheckable("GET /health returns 200")); // ไม่มี command token → forced human review
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
		assert.match(gated.draft.specDebt[0], /scope/);
		assert.match(gated.draft.specDebt[1], /c2/);
		assert.equal(gated.draft.criteria.length, 2); // criteria ไม่ถูกลบ แค่ flagged

		// draft ดี → ไม่แตะ specDebt เพิ่ม
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
		assert.equal(findSimilarSpec(dir, { ...GOOD_SPEC }), null); // ยังไม่มี specs dir → null
		const specsDir = join(dir, ".pi", "zense", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(
			join(specsDir, "2026-01-01-00-00-00-v1-fix-login-redirect.json"),
			JSON.stringify({ title: "fix login redirect", intent: "users hit the login page twice" }),
		);
		const hit = findSimilarSpec(dir, { ...GOOD_SPEC, title: "fix login redirect bug", intent: "users hit the login page twice" });
		assert.ok(hit, "ต้องจับ spec ที่คล้ายกันได้");
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
	assert.ok(md > xt, "--exclude-tools ต้องมาก่อน --model");
	assert.equal(ro.at(-1), "draft a spec");

	const plain = buildSubagentArgv("grade it");
	assert.ok(!plain.includes("--exclude-tools"));
	assert.equal(plain.at(-1), "grade it");
});

test("buildRequirementsPrompt: enforces explore-first, JSON-only output and the clarify contract", () => {
	const p = buildRequirementsPrompt("add dark mode", []);
	assert.match(p, /EXPLORE \(read-only/);
	assert.match(p, /NO write\/edit tools/);
	assert.match(p, /"questions"/);
	assert.match(p, /Request: add dark mode$/);
	assert.doesNotMatch(p, /Past lessons/);
	const withLessons = buildRequirementsPrompt("x", ["📚 lesson one"]);
	assert.match(withLessons, /Past lessons[\s\S]*lesson one/);
});

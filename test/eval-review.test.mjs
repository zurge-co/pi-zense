import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyQualityGate,
	buildGraderPrompt,
	buildRequirementsPrompt,
	buildReviewerPrompt,
	gatherRepoFacts,
	loadSpecExemplar,
	parseGraderOutput,
	parseReviewerPacket,
	runCheckProbes,
	SUBAGENT_EXCLUDE_TOOLS,
} from "../extensions/zense-harness/index.ts";

const CRITERIA = [
	{ id: "C1", text: "tests pass", check: "npm test" },
	{ id: "C2", text: "file exists", check: "path exists: src/x.ts" },
];

test("parseGraderOutput: full contract → verdicts + evidence + overall", () => {
	const p = parseGraderOutput("C1: PASS: npm test exit 0 (30 pass)\nC2: FAIL: src/x.ts not found\nOVERALL: FAIL", CRITERIA);
	assert.deepEqual(p.perCriteria, { C1: "PASS", C2: "FAIL" });
	assert.deepEqual(p.failedIds, ["C2"]);
	assert.deepEqual(p.missingIds, []);
	assert.deepEqual(p.passNoEvidence, []);
	assert.equal(p.overall, "FAIL");
	assert.match(p.evidence.C1, /exit 0/);
});

test("parseGraderOutput: missing ids / missing OVERALL / PASS without evidence are detected, not silently passed", () => {
	// id ที่ grader ลืมตอบ → coverage ไม่ครบ (เดิมถูกเมินเงียบๆ)
	assert.deepEqual(parseGraderOutput("C1: PASS: ran and it worked\nOVERALL: PASS", CRITERIA).missingIds, ["C2"]);
	// OVERALL หาย → overall=null (caller ต้องถือว่า inconclusive)
	assert.equal(parseGraderOutput("C1: PASS: ok\nC2: PASS: ok", CRITERIA).overall, null);
	// PASS โดยไม่แนบหลักฐาน → reject (ปิดช่องตอบมั่วแบบมั่นใจ)
	assert.deepEqual(parseGraderOutput("C1: PASS\nc2: PASS:\nOVERALL: PASS", [{ id: "C1", text: "x", check: "y" }]).passNoEvidence, ["C1"]);
	// id มี char พิเศษก็ไม่พัง (regex escaped)
	const weird = parseGraderOutput("c-1.2: PASS: ok\nOVERALL: PASS", [{ id: "c-1.2", text: "x", check: "y" }]);
	assert.equal(weird.perCriteria["c-1.2"], "PASS");
});

test("runCheckProbes: path-exists resolved in-process, runnable checks execute, manual checks are skipped", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-probe-"));
	try {
		writeFileSync(join(dir, "here.txt"), "x");
		const probes = runCheckProbes(dir, [
			{ id: "p1", text: "a", check: "path exists: here.txt" },
			{ id: "p2", text: "b", check: "path exists: nope.txt" },
			{ id: "p3", text: "c", check: "node --version" },
			{ id: "p4", text: "d", check: 'node -e "process.exit(7)"' },
			{ id: "p5", text: "e", check: "manual visual QA" },
		]);
		assert.deepEqual(probes.map((p) => p.status), ["pass", "fail", "pass", "fail", "skipped"]);
		assert.match(probes[1].detail, /not found/);
		assert.equal(probes[3].exitCode, 7);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runCheckProbes: compound checks (path exists && shell / && path exists) are evaluated per segment, all must pass", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-probe-compound-"));
	try {
		writeFileSync(join(dir, "here.txt"), "x");
		writeFileSync(join(dir, "two.txt"), "y");
		const probes = runCheckProbes(dir, [
			// exists ล้วน (หลาย path) — pass ได้ทุก an / fail ถ้าขาดสักตัว เดิมหน้า regex anchored ไม่จับ compound นี้เลย
			{ id: "c1", text: "two files", check: "path exists: here.txt && path exists: two.txt" },
			{ id: "c2", text: "missing one", check: "path exists: here.txt && path exists: nope.txt" },
			// ปน shell — เดิมหลุดไป sh -c ทั้งก้อน → "path" ไม่ใช่คำสั่ง → exit 127 false-FAIL
			{ id: "c3", text: "exists + shell pass", check: "path exists: here.txt && node --version" },
			{ id: "c4", text: "exists missing + shell pass", check: "path exists: nope.txt && node --version" },
			{ id: "c5", text: "exists ok + shell fail", check: 'node --version && path exists: here.txt && node -e "process.exit(3)"' },
			// shell segment ที่เครื่องมือตัดสินไม่ได้ปนอยู่ใน compound → skipped ทั้ง criterion (ไม่เดา)
			{ id: "c6", text: "unrunnable segment", check: "path exists: here.txt && manual visual QA" },
		]);
		assert.deepEqual(probes.map((p) => p.status), ["pass", "fail", "pass", "fail", "fail", "skipped"]);
		assert.match(probes[1].detail, /not found: nope\.txt/);
		assert.match(probes[2].detail, /exists: here\.txt/);
		assert.match(probes[3].detail, /not found: nope\.txt/);
		assert.equal(probes[4].exitCode, 3);
		assert.match(probes[5].detail, /not machine-runnable/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runCheckProbes: shell-only check containing quoted '&&' is NOT split (runs verbatim)", () => {
	const probes = runCheckProbes(tmpdir(), [
		{ id: "q1", text: "quoted && literal", check: 'test "$(echo \'a && b\')" = "a && b"' },
		{ id: "q2", text: "normal && chain", check: "node --version && echo ok" },
	]);
	assert.deepEqual(probes.map((p) => p.status), ["pass", "pass"]);
});

test("SUBAGENT_EXCLUDE_TOOLS: grader and reviewer are read-only like requirements", () => {
	for (const role of ["requirements", "grader", "reviewer"]) assert.deepEqual(SUBAGENT_EXCLUDE_TOOLS[role], ["write", "edit"]);
	assert.equal(SUBAGENT_EXCLUDE_TOOLS["unknown-role"], undefined);
});

test("gatherRepoFacts: reads package scripts + README head + layout, tolerates bare dirs", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-facts-"));
	try {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test test/x.mjs" } }));
		writeFileSync(join(dir, "README.md"), "# Demo\nhello world\n");
		mkdirSync(join(dir, "src"));
		const facts = gatherRepoFacts(dir).join("\n");
		assert.match(facts, /package: demo/);
		assert.match(facts, /test="node --test test\/x\.mjs"/);
		assert.match(facts, /README\.md \(head\)/);
		assert.match(facts, /top-level dirs: src/);
		// dir เปล่า → ไม่ throw และไม่มี facts
		const bare = mkdtempSync(join(tmpdir(), "zense-facts-bare-"));
		try {
			assert.deepEqual(gatherRepoFacts(bare), []);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadSpecExemplar: picks the newest APPROVED spec with criteria, skips unapproved/broken", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-exemplar-"));
	try {
		assert.equal(loadSpecExemplar(dir), null); // ยังไม่มี archive
		const specsDir = join(dir, ".zense", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(
			join(specsDir, "2026-01-01-00-00-00-v1-old-signed.json"),
			JSON.stringify({ title: "old signed", intent: "do old thing", approved: true, scope: ["src"], criteria: [{ id: "c1", text: "t", check: "npm test" }], specDebt: [] }),
		);
		writeFileSync(
			join(specsDir, "2026-02-01-00-00-00-v2-new-unsigned.json"),
			JSON.stringify({ title: "new unsigned", intent: "x", approved: false, scope: [], criteria: [{ id: "c1", text: "t", check: "npm test" }], specDebt: [] }),
		);
		writeFileSync(join(specsDir, "2026-03-01-00-00-00-v3-broken.json"), "{not json");
		const ex = loadSpecExemplar(dir);
		assert.ok(ex);
		assert.match(ex, /old signed/, "ต้องข้ามไฟล์ที่ใหม่กว่าแต่ unsigned/broken แล้วหยิบตัวที่ approved");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildGraderPrompt: probe results are authoritative, evidence mandatory, read-only stated", () => {
	const spec = { version: 1, title: "T", intent: "i", scope: ["src"], constraints: [], criteria: CRITERIA, specDebt: [], approved: true };
	const p = buildGraderPrompt(spec, [{ id: "C1", status: "fail", exitCode: 1, detail: "boom" }, { id: "C2", status: "pass", detail: "exists" }], "recent commits:\nabc123 x", "");
	assert.match(p, /probe: FAIL \(exit 1\) — boom/);
	assert.match(p, /probe: PASS — exists/);
	assert.match(p, /NO write\/edit tools/);
	assert.match(p, /Reward-hacking checklist/);
	assert.match(p, /Change summary/);
	assert.match(p, /A PASS without evidence is rejected/);
	// retry feedback ถูกต่อท้าย
	assert.match(buildGraderPrompt(spec, [], "", "no verdict given for: C2"), /SYSTEM FEEDBACK: your previous response was rejected: no verdict given for: C2/);
});

test("parseReviewerPacket: full schema ok + TL;DR extracted; missing sections reported for retry feedback", () => {
	const good = [
		"## TL;DR",
		"- merged wave 2",
		"- eval PASS with probes",
		"- safe to deploy",
		"- extra line beyond 3 is truncated",
		"## Intent vs Implementation",
		"matched",
		"## Risks",
		"none",
		"## Rollback",
		"git revert abc",
		"## Human actions",
		"none",
	].join("\n");
	const parsed = parseReviewerPacket(good);
	assert.equal(parsed.ok, true);
	assert.deepEqual(parsed.missing, []);
	assert.equal(parsed.tldr.split("\n").length, 3);
	assert.match(parsed.tldr, /merged wave 2/);
	const bad = parseReviewerPacket("Some free text without headers at all");
	assert.equal(bad.ok, false);
	assert.deepEqual(bad.missing, ["TL;DR", "Intent vs Implementation", "Risks", "Rollback", "Human actions"]);
	assert.equal(bad.tldr, "");
});

test("buildReviewerPrompt: carries eval evidence + git + flags/debt, defines strict section contract", () => {
	const p = buildReviewerPrompt(
		"make things fast",
		{ verdict: "PASS", perCriteria: { C1: "PASS", C2: "FAIL" }, probes: [{ id: "C1", status: "pass", detail: "ok" }] },
		["out-of-scope write: x"],
		["debt one"],
		[{ kind: "need-fix", detail: "criteria failed: C2" }],
		"recent commits:\nabc impl v2",
		"",
	);
	assert.match(p, /Intent: make things fast/);
	assert.match(p, /Eval verdict: PASS/);
	assert.match(p, /C2=FAIL/);
	assert.match(p, /C1:pass/);
	assert.match(p, /out-of-scope write: x/);
	assert.match(p, /debt one/);
	assert.match(p, /need-fix: criteria failed: C2/);
	assert.match(p, /abc impl v2/);
	assert.match(p, /never write "to be implemented"/);
	assert.match(p, /## Human actions/);
	assert.match(buildReviewerPrompt("i", undefined, [], [], [], "", "Rollback"), /missing sections: Rollback/);
});

test("buildRequirementsPrompt: facts + exemplar spliced in, request stays last (backward compatible)", () => {
	const base = buildRequirementsPrompt("add x", []);
	assert.match(base, /Request: add x$/);
	assert.doesNotMatch(base, /Repository facts/);
	const withCtx = buildRequirementsPrompt("add x", ["lesson A"], ["- scripts: test=..."], '{"title":"old"}');
	const factsAt = withCtx.indexOf("Repository facts");
	const exemplarAt = withCtx.indexOf("previously SIGNED spec");
	const lessonsAt = withCtx.indexOf("Past lessons");
	const requestAt = withCtx.indexOf("Request: add x");
	assert.ok(exemplarAt > -1 && exemplarAt < factsAt && factsAt < lessonsAt && lessonsAt < requestAt);
});

test("applyQualityGate: scope pointing at a non-existent path is caught (gate would be toothless otherwise)", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-scope-"));
	try {
		mkdirSync(join(dir, "src", "real-dir"), { recursive: true }); // path จริง → ไม่โดน flag
		const { notes, draft } = applyQualityGate(dir, {
			title: "t",
			intent: "i",
			scope: ["src/real-dir", "ghost/nope-xyz"],
			constraints: [],
			criteria: [{ id: "c1", text: "t", check: "npm test" }],
			specDebt: [],
		});
		assert.ok(notes.some((n) => n.startsWith("scope-missing:ghost/nope-xyz")));
		assert.ok(!notes.some((n) => n.startsWith("scope-missing:src/real-dir")));
		assert.ok(draft.specDebt.some((d) => d.includes("ghost/nope-xyz")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

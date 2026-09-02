import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	normalizeShellCommand,
	applyQualityGate,
	buildGraderPrompt,
	buildRequirementsPrompt,
	buildReviewerPrompt,
	gatherRepoFacts,
	gitChangeSummary,
	hasUnsubstitutedPlaceholder,
	loadSpecExemplar,
	modelMatchesPattern,
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

test("runCheckProbes: malformed/usage-error check commands classify as skipped (NOT fail) — no false probe-primacy FAIL loop", () => {
	const probes = runCheckProbes(tmpdir(), [
		// เคสเจอจริงจาก eval ที่ FAIL เทียม: helm arg error / test usage error — คำสั่งเสียเอง ไม่ใช่ artifact ผิด
		{ id: "u1", text: "helm arg error", check: `node -e "console.error('Error: expected at most two arguments, unexpected: +, grep'); process.exit(1)"` },
		{ id: "u2", text: "test usage error", check: `node -e "console.error('sh: test: too many arguments'); process.exit(2)"` },
		{ id: "u3", text: "command not found", check: "this-command-does-not-exist-xyz --version jq" },
		// เช็คที่รันได้แต่ artifact ไม่ผ่าน = ยัง fail เต็มตัว (probe primacy ยังทับ grader ได้)
		{ id: "u4", text: "silent exit 1", check: 'node -e "process.exit(1)"' },
		{ id: "u5", text: "grep no match", check: "echo hello | grep -q goodbye" },
		// compound: shell segment คำสั่งเสีย → skipped ทั้ง criterion (ตัดสินไม่ได้ ไม่เดา)
		{ id: "u6", text: "compound with broken segment", check: `node --version && node -e "console.error('usage: x [opts]'); process.exit(2)"` },
	]);
	assert.deepEqual(probes.map((p) => p.status), ["skipped", "skipped", "skipped", "fail", "fail", "skipped"]);
	assert.match(probes[0].detail, /probe command error/);
	assert.match(probes[2].detail, /probe command error/);
	assert.equal(probes[3].exitCode, 1);
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
		// dir เปล่า → ไม่มี fact ของ repo (toolchain fact ของ host มีได้ — repo แบบ cargo/go ไม่มี package.json ก็ต้องใช้), ไม่ throw
		const bare = mkdtempSync(join(tmpdir(), "zense-facts-bare-"));
		try {
			assert.ok(gatherRepoFacts(bare).every((f) => f.startsWith("- toolchain on PATH")));
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
	assert.match(p, /C1: pass — ok/); // r2: probe แนบ detail verbatim แทน id:status ล้วน
	assert.match(p, /out-of-scope write: x/);
	assert.match(p, /debt one/);
	assert.match(p, /need-fix: criteria failed: C2/);
	assert.match(p, /abc impl v2/);
	assert.match(p, /never write "to be implemented"/);
	assert.match(p, /## Human actions/);
	assert.match(buildReviewerPrompt("i", undefined, [], [], [], "", "Rollback"), /was rejected: Rollback/); // r5: feedback ใช้ได้ทั้ง schema และ grounding
});

test("buildReviewerPrompt: stale lastEval (version/tree) is dropped and warned", () => {
	const ev = {
		verdict: "PASS",
		perCriteria: { C1: "PASS" },
		probes: [{ id: "C1", status: "pass", detail: "ok" }],
		specVersion: 1,
		head: "tree-aaa",
	};
	// spec version ไม่ตรง → stale: ตัด verdict/per-criteria/probe ทิ้ง + เตือน
	const staleV = buildReviewerPrompt("i", ev, [], [], [], "", "", { specVersion: 2, head: "tree-aaa" });
	assert.doesNotMatch(staleV, /Eval verdict: PASS/);
	assert.doesNotMatch(staleV, /C1=PASS/);
	assert.doesNotMatch(staleV, /C1: pass/);
	assert.match(staleV, /STALE eval evidence/);
	// tree ไม่ตรง (แก้โค้ดหลัง eval) → stale เช่นกัน
	const staleT = buildReviewerPrompt("i", ev, [], [], [], "", "", { specVersion: 1, head: "tree-bbb" });
	assert.doesNotMatch(staleT, /Eval verdict: PASS/);
	assert.match(staleT, /STALE eval evidence/);
	// fresh (version+tree ตรง) → render เหมือนเดิมทุกบรรทัด
	const fresh = buildReviewerPrompt("i", ev, [], [], [], "", "", { specVersion: 1, head: "tree-aaa" });
	assert.match(fresh, /Eval verdict: PASS/);
	assert.match(fresh, /C1=PASS/);
	assert.match(fresh, /C1: pass — ok/); // r2: probe detail verbatim
	assert.doesNotMatch(fresh, /STALE/);
});

test("gitChangeSummary: baseline scopes log+diff to baseline..HEAD", () => {
	const cwd = mkdtempSync(join(tmpdir(), "zense-gitbase-"));
	try {
		const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git(["init", "-q"]);
		git(["config", "user.email", "t@t"]);
		git(["config", "user.name", "t"]);
		writeFileSync(join(cwd, "old-round-file.txt"), "old\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "old-round commit"]);
		const baseline = git(["rev-parse", "HEAD"]).trim();
		writeFileSync(join(cwd, "new-round-file.txt"), "new\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "current-round commit"]);
		const scoped = gitChangeSummary(cwd, baseline);
		assert.match(scoped, /current-round commit/); // เห็นเฉพาะ commit ของรอบนี้
		assert.doesNotMatch(scoped, /old-round commit/); // commit ก่อน baseline ต้องไม่ปน
		assert.match(scoped, /new-round-file\.txt/); // diffstat เทียบ baseline เห็นไฟล์ใหม่
		assert.doesNotMatch(scoped, /old-round-file\.txt/);
		// degrade: ไม่ส่ง baseline → behavior เดิม (log ทั้งประวัติ); baseline ใน dir ที่ไม่ใช่ repo → ไม่ throw
		assert.match(gitChangeSummary(cwd), /old-round commit/);
		const nonGit = mkdtempSync(join(tmpdir(), "zense-nogit-base-"));
		try {
			assert.equal(gitChangeSummary(nonGit, "deadbeef"), "");
		} finally {
			rmSync(nonGit, { recursive: true, force: true });
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
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

test("canReuseWorktree: null/missing-dir → false, existing dir → true (กัน spec bump ทำงานค้างหลุดเป็น orphan)", async () => {
	const { canReuseWorktree } = await import("../extensions/zense-harness/index.ts");
	assert.equal(canReuseWorktree(null), false);
	assert.equal(canReuseWorktree(undefined), false);
	assert.equal(canReuseWorktree({ root: "/nonexistent-zense-wt-xyz-123", branch: "zense/impl/v1-x", dir: "/nonexistent-zense-wt-xyz-123" }), false);
	const dir = mkdtempSync(join(tmpdir(), "zense-reuse-"));
	try {
		// reuse = เงื่อนไขเดียวที่เปลี่ยนคือ dir อยู่จริง — branch/dir metadata เดิมต้องไม่ถูกแตะ
		assert.equal(canReuseWorktree({ root: dir, branch: "zense/impl/v3-old", dir }), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hasUnsubstitutedPlaceholder: returns offending token for angle/brace templates, null for clean checks", () => {
	assert.equal(hasUnsubstitutedPlaceholder("path exists: <path>"), "<path>");
	assert.equal(hasUnsubstitutedPlaceholder("path exists: src/<module>/x.ts"), "<module>");
	assert.equal(hasUnsubstitutedPlaceholder("{name} gate"), "{name}");
	assert.equal(hasUnsubstitutedPlaceholder("npm test"), null);
	assert.equal(hasUnsubstitutedPlaceholder('node -e "process.exit(1)"'), null);
	// shell จริง: redirection/grep ไม่ใช่ placeholder; ${VAR} ถูกยกเว้น (lookbehind)
	assert.equal(hasUnsubstitutedPlaceholder("cat nofile 2>&1 | grep -q ok"), null);
	assert.equal(hasUnsubstitutedPlaceholder('grep -q "${HOME}" README.md'), null);
});

test("runCheckProbes: unsubstituted placeholder in check → skipped (NOT fail), detail points to re-spec", () => {
	const probes = runCheckProbes(tmpdir(), [
		{ id: "ph1", text: "angle placeholder path", check: "path exists: src/<module>/index.ts" },
		{ id: "ph2", text: "brace placeholder shell", check: 'grep -q "ok" {file}' },
		{ id: "ph3", text: "clean shell", check: "node --version" },
	]);
	assert.deepEqual(probes.map((p) => p.status), ["skipped", "skipped", "pass"]);
	assert.match(probes[0].detail, /unsubstituted placeholder "<module>"/);
	assert.match(probes[0].detail, /fix spec via zense_spec/);
	assert.match(probes[1].detail, /unsubstituted placeholder "\{file\}"/);
});

test("modelMatchesPattern: exact / thinking-suffix / case-insensitive match, rejects other providers and prefixes", () => {
	assert.ok(modelMatchesPattern("openai/gpt-4.1", "openai/gpt-4.1"));
	assert.ok(modelMatchesPattern("openai/gpt-4.1", "openai/gpt-4.1:high"));
	assert.ok(modelMatchesPattern("OpenAI/GPT-4.1", "openai/gpt-4.1"));
	assert.ok(!modelMatchesPattern("openai/gpt-4.1", "anthropic/claude"));
	assert.ok(!modelMatchesPattern("synthetic/syn:large:text", "synthetic/syn:large")); // prefix ไม่ใช่ suffix pair
});

test("normalizeShellCommand: strips leading bash:/sh:/shell:/zsh: prefix once, no-op otherwise", () => {
	assert.equal(normalizeShellCommand("bash: node --version"), "node --version");
	assert.equal(normalizeShellCommand("sh:npm test"), "npm test");
	assert.equal(normalizeShellCommand("SHELL: node --version"), "node --version");
	assert.equal(normalizeShellCommand("zsh: make build"), "make build");
	// no-op: ไม่มี prefix / prefix อยู่กลางสตริง / ทั้งก้อนเป็น shell command จริง
	assert.equal(normalizeShellCommand("npm test"), "npm test");
	assert.equal(normalizeShellCommand("bash --version"), "bash --version");
	assert.equal(normalizeShellCommand('echo "a" && bash: node --version'), 'echo "a" && bash: node --version');
});

test("runCheckProbes: leading runner prefix executes the stripped command (pass/fail/cmdErr ตามจริง)", () => {
	const probes = runCheckProbes(tmpdir(), [
		{ id: "n1", text: "prefixed pass", check: "bash: node --version" },
		{ id: "n2", text: "prefixed real fail", check: 'sh: node -e "process.exit(7)"' },
		{ id: "n3", text: "prefixed missing cmd", check: "bash: definitely-missing-command-xyz --version" },
		{ id: "n4", text: "prefixed compound", check: "shell: node --version && path exists: definitely-missing-file-xyz" },
	]);
	assert.deepEqual(probes.map((p) => p.status), ["pass", "fail", "skipped", "fail"]);
	assert.equal(probes[1].exitCode, 7); // fail จริง = execute จริง ไม่ใช่ 127
	assert.equal(probes[2].exitCode, 127); // คำสั่งข้างในหาย → cmdErr ยัง skipped เหมือนเดิม
	assert.match(probes[2].detail, /probe command error/);
	assert.match(probes[3].detail, /not found: definitely-missing-file-xyz/);
});

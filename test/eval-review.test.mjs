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
	lintSpecChecks,
	CHECK_FORMAT_CONTRACT,
	SUBAGENT_EXCLUDE_TOOLS,
	SUBAGENT_STRIP_FLAGS,
	buildCompactProbeSection,
	buildEvalResultText,
	buildPendingApplyEvidencePrefix,
	buildReviewResultText,
	COMMENT_DISCIPLINE_GUIDELINE,
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
	// ids the grader forgot → incomplete coverage (used to be ignored silently)
	assert.deepEqual(parseGraderOutput("C1: PASS: ran and it worked\nOVERALL: PASS", CRITERIA).missingIds, ["C2"]);
	// missing OVERALL → overall=null (the caller must treat it as inconclusive)
	assert.equal(parseGraderOutput("C1: PASS: ok\nC2: PASS: ok", CRITERIA).overall, null);
	// PASS without evidence → rejected (closes the confident-bluff hole)
	assert.deepEqual(parseGraderOutput("C1: PASS\nc2: PASS:\nOVERALL: PASS", [{ id: "C1", text: "x", check: "y" }]).passNoEvidence, ["C1"]);
	// ids with special chars don't break it (regex escaped)
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
			// pure exists (multiple paths) — passes only when all exist; the old anchored regex never matched this compound at all
			{ id: "c1", text: "two files", check: "path exists: here.txt && path exists: two.txt" },
			{ id: "c2", text: "missing one", check: "path exists: here.txt && path exists: nope.txt" },
			// mixed with shell — used to fall through to sh -c whole → "path" isn't a command → exit 127 false-FAIL
			{ id: "c3", text: "exists + shell pass", check: "path exists: here.txt && node --version" },
			{ id: "c4", text: "exists missing + shell pass", check: "path exists: nope.txt && node --version" },
			{ id: "c5", text: "exists ok + shell fail", check: 'node --version && path exists: here.txt && node -e "process.exit(3)"' },
			// an unjudgable shell segment inside a compound → the whole criterion is skipped (never guessed)
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
		// real cases from false FAILs: helm arg error / test usage error — the command itself is broken, not the artifact
		{ id: "u1", text: "helm arg error", check: `node -e "console.error('Error: expected at most two arguments, unexpected: +, grep'); process.exit(1)"` },
		{ id: "u2", text: "test usage error", check: `node -e "console.error('sh: test: too many arguments'); process.exit(2)"` },
		{ id: "u3", text: "command not found", check: "this-command-does-not-exist-xyz --version jq" },
		// checks that ran fine but the artifact missed = still full fails (probe primacy may still override the grader)
		{ id: "u4", text: "silent exit 1", check: 'node -e "process.exit(1)"' },
		{ id: "u5", text: "grep no match", check: "echo hello | grep -q goodbye" },
		// compound: a broken shell segment → the whole criterion is skipped (can't judge, never guess)
		{ id: "u6", text: "compound with broken segment", check: `node --version && node -e "console.error('usage: x [opts]'); process.exit(2)"` },
	]);
	assert.deepEqual(probes.map((p) => p.status), ["skipped", "skipped", "skipped", "fail", "fail", "skipped"]);
	assert.match(probes[0].detail, /probe command error/);
	assert.match(probes[2].detail, /probe command error/);
	assert.equal(probes[3].exitCode, 1);
});

test("lintSpecChecks: spec-side broken checks (127 / not-runnable / placeholder) flagged, artifact-fails silent", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-lint-"));
	try {
		const r = lintSpecChecks(dir, [
			{ id: "b1", text: "t", check: "bash -c no-such-cmd-qqq" }, // exit 127 → cmdErr → skipped → broken
			{ id: "b2", text: "t", check: "definitely-not-a-real-cmd-xyz --version" }, // not machine-runnable → skipped → broken
			{ id: "b3", text: "t", check: "path exists: src/<module>/x" }, // unsubstituted placeholder → skipped → broken
			{ id: "k1", text: "t", check: "path exists: no-such-artifact-abc" }, // artifact not yet implemented → fail → no warning
			{ id: "k2", text: "t", check: "test 1 -eq 2" }, // good command, genuinely fails → no warning
			{ id: "k3", text: "t", check: "node --version" }, // pass → no warning
		]);
		assert.deepEqual(r.broken.sort(), ["b1", "b2", "b3"]);
		assert.ok(r.notes.some((n) => n.includes("b1")), "a note must name the broken id");
		assert.ok(r.notes.every((n) => n.startsWith("check-lint:")), "every note must start with check-lint:");
		// empty/all-passing criteria → nothing to warn about
		assert.deepEqual(lintSpecChecks(dir, []), { broken: [], notes: [] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CHECK_FORMAT_CONTRACT + requirements prompt: contract markers (sh -c / path exists: / && / ** / specDebt / npm test)", () => {
	for (const marker of ["sh -c", "path exists:", "&&", "**", "specDebt", "npm test"])
		assert.ok(CHECK_FORMAT_CONTRACT.includes(marker), `contract missing marker "${marker}"`);
	const p = buildRequirementsPrompt("probe", []);
	for (const marker of ["sh -c", "path exists:", "specDebt", "&&", "**", "npm test"])
		assert.ok(p.includes(marker), `requirements prompt missing marker "${marker}"`);
	// the prompt must embed the very same contract blob (single source of truth) — never fork the wording
	assert.ok(p.includes(CHECK_FORMAT_CONTRACT.slice(0, 120)), "prompt must embed CHECK_FORMAT_CONTRACT");
});

test("zense_spec schema: criteria.check description uses CHECK_FORMAT_CONTRACT (single source of truth)", async () => {
	const { readFileSync } = await import("node:fs");
	const { join, dirname } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "zense-harness", "index.ts"), "utf8");
	assert.match(src, /check:\s*Type\.String\(\{ description: CHECK_FORMAT_CONTRACT \}\)/, "the schema must reference the same contract blob");
	// commitSpec (the choke point of both set and compile) must run lint before state.spec is built
	const i = src.indexOf("const commitSpec");
	const j = src.indexOf("pi.registerTool", i);
	assert.ok(j > i, "registerTool after commitSpec not found");
	assert.ok(src.slice(i, j).includes("lintSpecChecks"), "commitSpec must wire lintSpecChecks");
	assert.ok(src.slice(i, src.indexOf("state.spec = {", i)).includes("lintSpecChecks"), "lint must run before state.spec is created");
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
		// a bare dir → no repo facts (the host toolchain fact is fine — package.json-less cargo/go repos need it), no throw
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
		assert.equal(loadSpecExemplar(dir), null); // no archive yet
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
		assert.match(ex, /old signed/, "must skip the newer-but-unsigned/broken files and pick the approved one");
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
	// retry feedback gets appended
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
	assert.match(p, /C1: pass — ok/); // r2: probes carry their detail verbatim, not bare id:status
	assert.match(p, /out-of-scope write: x/);
	assert.match(p, /debt one/);
	assert.match(p, /need-fix: criteria failed: C2/);
	assert.match(p, /abc impl v2/);
	assert.match(p, /never write "to be implemented"/);
	assert.match(p, /## Human actions/);
	assert.match(buildReviewerPrompt("i", undefined, [], [], [], "", "Rollback"), /was rejected: Rollback/); // r5: feedback covers both schema and grounding
});

test("buildReviewerPrompt: stale lastEval (version/tree) is dropped and warned", () => {
	const ev = {
		verdict: "PASS",
		perCriteria: { C1: "PASS" },
		probes: [{ id: "C1", status: "pass", detail: "ok" }],
		specVersion: 1,
		head: "tree-aaa",
	};
	// version mismatch → stale: verdict/per-criteria/probes dropped + warning
	const staleV = buildReviewerPrompt("i", ev, [], [], [], "", "", { specVersion: 2, head: "tree-aaa" });
	assert.doesNotMatch(staleV, /Eval verdict: PASS/);
	assert.doesNotMatch(staleV, /C1=PASS/);
	assert.doesNotMatch(staleV, /C1: pass/);
	assert.match(staleV, /STALE eval evidence/);
	// tree mismatch (code changed after eval) → stale too
	const staleT = buildReviewerPrompt("i", ev, [], [], [], "", "", { specVersion: 1, head: "tree-bbb" });
	assert.doesNotMatch(staleT, /Eval verdict: PASS/);
	assert.match(staleT, /STALE eval evidence/);
	// fresh (version+tree match) → renders every line as before
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
		assert.match(scoped, /current-round commit/); // only this round's commit shows
		assert.doesNotMatch(scoped, /old-round commit/); // pre-baseline commits must not leak in
		assert.match(scoped, /new-round-file\.txt/); // the baseline-referenced diffstat sees the new file
		assert.doesNotMatch(scoped, /old-round-file\.txt/);
		// degrade: no baseline → previous behavior (full history); baseline in a non-repo dir → no throw
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

test("buildPendingApplyEvidencePrefix: the reviewer can't mistake main for committed — a clear staged-uncommitted label when pendingApply exists", () => {
	// with pendingApply (applied, awaiting a human commit): must state clearly that changes are staged-but-uncommitted by design
	const p = buildPendingApplyEvidencePrefix(true, false);
	assert.match(p, /staged, uncommitted/);
	assert.match(p, /a human commits after this review/);
	assert.match(p, /no new commits since baseline.+expected/);
	// human edits during review → an extra note, but the review proceeds (not stale)
	const h = buildPendingApplyEvidencePrefix(true, true);
	assert.match(h, /edited AFTER eval\+apply/);
	assert.match(h, /review as normal/);
	// no pendingApply (old flow / pre-eval) → no stray label
	assert.equal(buildPendingApplyEvidencePrefix(false, false), "");
	// concatenated into buildReviewerPrompt as gitSummary, the label must survive into the actual prompt
	const prompt = buildReviewerPrompt("i", undefined, [], [], [], buildPendingApplyEvidencePrefix(true, false) + "\n" + "diffstat vs baseline:\n src.ts | 2 ++", "", {
		specVersion: 1,
		head: "tree-x",
	});
	assert.match(prompt, /staged, uncommitted/);
	assert.match(prompt, /src\.ts \| 2/); // the staged-changes diffstat still rides with the evidence
});

test("gitChangeSummary: staged-but-uncommitted changes (pendingApply) still show in diffstat/porcelain — the reviewer sees full evidence", () => {
	const cwd = mkdtempSync(join(tmpdir(), "zense-staged-"));
	try {
		const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git(["init", "-q"]);
		git(["config", "user.email", "t@t"]);
		git(["config", "user.name", "t"]);
		writeFileSync(join(cwd, "base.txt"), "base\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "baseline commit"]);
		const baseline = git(["rev-parse", "HEAD"]).trim();
		// simulate post-apply-back state: new file staged, HEAD unmoved (no commit yet)
		writeFileSync(join(cwd, "applied.txt"), "staged only\n");
		git(["add", "applied.txt"]);
		const s = gitChangeSummary(cwd, baseline);
		assert.match(s, /applied\.txt/); // both porcelain and diffstat must see the staged change
		assert.doesNotMatch(s, /commits since baseline/); // no new commits after baseline (apply-back never commits — by design)
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
		mkdirSync(join(dir, "src", "real-dir"), { recursive: true }); // a real path → not flagged
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

test("canReuseWorktree: null/missing-dir → false, existing dir → true (guards against a spec bump orphaning in-progress work)", async () => {
	const { canReuseWorktree } = await import("../extensions/zense-harness/index.ts");
	assert.equal(canReuseWorktree(null), false);
	assert.equal(canReuseWorktree(undefined), false);
	assert.equal(canReuseWorktree({ root: "/nonexistent-zense-wt-xyz-123", branch: "zense/impl/v1-x", dir: "/nonexistent-zense-wt-xyz-123" }), false);
	const dir = mkdtempSync(join(tmpdir(), "zense-reuse-"));
	try {
		// reuse = the only changing condition is the dir existing on disk — its branch/dir metadata must stay intact
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
	// real shell: redirection/grep are not placeholders; ${VAR} is excepted (lookbehind)
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
	assert.ok(!modelMatchesPattern("synthetic/syn:large:text", "synthetic/syn:large")); // a prefix is not a suffix pair
});

test("normalizeShellCommand: strips leading bash:/sh:/shell:/zsh: prefix once, no-op otherwise", () => {
	assert.equal(normalizeShellCommand("bash: node --version"), "node --version");
	assert.equal(normalizeShellCommand("sh:npm test"), "npm test");
	assert.equal(normalizeShellCommand("SHELL: node --version"), "node --version");
	assert.equal(normalizeShellCommand("zsh: make build"), "make build");
	// no-op: no prefix / prefix mid-string / a genuine shell command as a whole
	assert.equal(normalizeShellCommand("npm test"), "npm test");
	assert.equal(normalizeShellCommand("bash --version"), "bash --version");
	assert.equal(normalizeShellCommand('echo "a" && bash: node --version'), 'echo "a" && bash: node --version');
});

test("runCheckProbes: leading runner prefix executes the stripped command (true pass/fail/cmdErr)", () => {
	const probes = runCheckProbes(tmpdir(), [
		{ id: "n1", text: "prefixed pass", check: "bash: node --version" },
		{ id: "n2", text: "prefixed real fail", check: 'sh: node -e "process.exit(7)"' },
		{ id: "n3", text: "prefixed missing cmd", check: "bash: definitely-missing-command-xyz --version" },
		{ id: "n4", text: "prefixed compound", check: "shell: node --version && path exists: definitely-missing-file-xyz" },
	]);
	assert.deepEqual(probes.map((p) => p.status), ["pass", "fail", "skipped", "fail"]);
	assert.equal(probes[1].exitCode, 7); // a real fail = really executed, not 127
	assert.equal(probes[2].exitCode, 127); // inner command missing → cmdErr, still skipped as before
	assert.match(probes[2].detail, /probe command error/);
	assert.match(probes[3].detail, /not found: definitely-missing-file-xyz/);
});

// ----- M: per-role strip flags table
test("SUBAGENT_STRIP_FLAGS: grader/reviewer fully bare, requirements strips only themes/templates", () => {
	const FULL = ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"];
	assert.deepEqual(SUBAGENT_STRIP_FLAGS.grader, FULL);
	assert.deepEqual(SUBAGENT_STRIP_FLAGS.reviewer, FULL);
	assert.deepEqual(SUBAGENT_STRIP_FLAGS.requirements, ["--no-themes", "--no-prompt-templates"]);
	assert.equal(SUBAGENT_STRIP_FLAGS["unknown-role"], undefined);
});

// ----- M: compact tool-result builders
test("buildCompactProbeSection: detail only for non-pass probes; passes collapse to one line", () => {
	const section = buildCompactProbeSection([
		{ id: "c1", status: "pass", detail: "ok" },
		{ id: "c2", status: "fail", exitCode: 1, detail: "npm test exploded\nstack line 2" },
		{ id: "c3", status: "skipped", detail: "not machine-runnable" },
		{ id: "c4", status: "pass", detail: "ok too" },
	]);
	assert.match(section, /## Probes/);
	assert.match(section, /- c2: fail \(exit 1\) — npm test exploded/);
	assert.match(section, /- c3: skipped — not machine-runnable/);
	assert.match(section, /probes pass: c1,c4/); // passes merged into one line
	assert.ok(!section.includes("stack line 2"), "detail must be cut to one line");
	assert.ok(!section.includes("- c1:"), "a passing probe gets no detail line of its own");
});

test("buildEvalResultText PASS: verdict + per-criterion verdicts + zense_review directive + log hint", () => {
	const text = buildEvalResultText({
		verdict: "PASS",
		criteria: [
			{ id: "C1", text: "tests pass", check: "npm test" },
			{ id: "C2", text: "file exists", check: "path exists: src/x.ts" },
		],
		perCriteria: { C1: "PASS", C2: "PASS" },
		evidence: { C1: "npm test exit 0", C2: "file found" },
		failedIds: [],
		probeOverrides: [],
		probes: [
			{ id: "C1", status: "pass", detail: "ok" },
			{ id: "C2", status: "pass", detail: "ok" },
		],
		trajectory: ["out-of-scope write: x"],
		specDebt: ["manual QA"],
		logPath: ".zense/subagents/t-grader.log",
	});
	assert.match(text, /✅ Eval PASS/);
	assert.match(text, /zense_review/, "the PASS directive must order zense_review immediately (the agent once silently considered itself done)");
	assert.match(text, /- C1: PASS — npm test exit 0/);
	assert.match(text, /- C2: PASS — file found/);
	assert.match(text, /probes pass: C1,C2/);
	assert.match(text, /out-of-scope write/);
	assert.match(text, /manual QA/);
	assert.match(text, /\.zense\/subagents\/t-grader\.log/);
	assert.match(text, /read it yourself/, "must point the agent at the log to read itself");
});

test("buildEvalResultText FAIL: failing criteria only + evidence capped at 120 chars + no lines for passing ones", () => {
	const longEvidence = "x".repeat(200);
	const text = buildEvalResultText({
		verdict: "FAIL",
		criteria: [
			{ id: "C1", text: "a", check: "npm test" },
			{ id: "C2", text: "b", check: "npm run build" },
		],
		perCriteria: { C1: "PASS", C2: "FAIL" },
		evidence: { C1: "passed fine", C2: `${longEvidence}\nsecond line` },
		failedIds: ["C2"],
		probeOverrides: ["C2"],
		probes: [
			{ id: "C1", status: "pass", detail: "ok" },
			{ id: "C2", status: "fail", exitCode: 2, detail: "build broke" },
		],
		trajectory: [],
		specDebt: [],
		logPath: ".zense/subagents/t-grader.log",
	});
	assert.match(text, /❌ Eval FAIL/);
	assert.match(text, /failing criteria: C2/);
	assert.match(text, /probe override → FAIL \[C2\]/);
	assert.match(text, /- C2: FAIL — /);
	assert.ok(!text.includes("- C1: PASS"), "the FAIL branch must cut passing per-criteria lines");
	const c2Line = text.split("\n").find((l) => l.startsWith("- C2:"));
	assert.ok(c2Line.length <= 121 + "- C2: FAIL — ".length, `evidence must be cut to ~120 chars (got ${c2Line.length})`);
	assert.ok(!text.includes("second line"), "evidence must stay one line");
	assert.match(text, /probes pass: C1/);
	assert.match(text, /build broke/);
	assert.ok(text.length < 2_500, `the FAIL text must be significantly shorter than the old raw dump (got ${text.length} chars)`);
});

test("buildReviewResultText: TL;DR + counts + log hint; the failure branch carries the error tail and the log", () => {
	const okText = buildReviewResultText({ ok: true, tlDr: "all good", trajectoryCount: 2, escalationCount: 1, logPath: ".zense/subagents/t-reviewer.log" });
	assert.match(okText, /all good/);
	assert.match(okText, /trajectory flags: 2 · escalations: 1/);
	assert.match(okText, /t-reviewer\.log/);
	assert.ok(okText.length < 600, "the compact result must be shorter than the old packet slice(0,4000)");
	const errText = buildReviewResultText({ ok: false, tlDr: "", trajectoryCount: 0, escalationCount: 0, logPath: ".zense/subagents/t-reviewer.log", errorOutput: "exited code=1" });
	assert.match(errText, /reviewer failed: exited code=1/);
	assert.match(errText, /t-reviewer\.log/);
});

// ----- M: comment-discipline guideline
test("COMMENT_DISCIPLINE_GUIDELINE: covers all 5 mandatory rules and stays short", () => {
	assert.match(COMMENT_DISCIPLINE_GUIDELINE, /non-obvious/); // WHY only
	assert.match(COMMENT_DISCIPLINE_GUIDELINE, /WHAT a line does/i); // no what-comments
	assert.match(COMMENT_DISCIPLINE_GUIDELINE, /banner/i); // no separators/banners
	assert.match(COMMENT_DISCIPLINE_GUIDELINE, /JSDoc/i); // no docstring boilerplate
	assert.match(COMMENT_DISCIPLINE_GUIDELINE, /existing decision-recording comments/i); // never delete the repo's existing comments
	const lines = COMMENT_DISCIPLINE_GUIDELINE.split("\n");
	assert.ok(lines.length <= 10, `the guideline must stay ~8 lines (got ${lines.length})`);
});

// TDZ guard (2026-09-08): zense_eval's inconclusive branch once crashed "Cannot access
// 'probeSection' before initialization" because it was declared after the branch — the bug
// survived because no test covered that error path
test("TDZ guard: probeSection is declared exactly once and always before the inconclusive branch", async () => {
	const { readFileSync } = await import("node:fs");
	const { join, dirname } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "zense-harness", "index.ts"), "utf8");
	const decl = [...src.matchAll(/const probeSection = buildCompactProbeSection\(probes\)/g)];
	assert.equal(decl.length, 1, "probeSection must be declared exactly once");
	const branch = src.indexOf("if (!grade.ok || !parsed || !parsed.overall)");
	assert.ok(branch > 0, "inconclusive branch not found (renamed?)");
	assert.ok(decl[0].index < branch, "probeSection must be declared before the inconclusive branch (TDZ regression)");
	// evalView had the same bug once (inconclusive used evalView.logPath before its declaration) — no use before const evalView
	const lines = src.split("\n");
	const evalViewDecl = lines.findIndex((l) => l.includes("const evalView"));
	const prematureUse = lines.findIndex((l, i) => l.includes("evalView.logPath") && i < evalViewDecl);
	assert.equal(prematureUse, -1, "evalView.logPath used before its declaration (TDZ regression)");
});

import { strict as assert } from "node:assert";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	aggregateMemory,
	buildDistilledMemory,
	clearDirFiles,
	distillImpact,
	distillTaskPrompt,
	fmtBytes,
	MAX_DISTILL_MEMORY_BYTES,
	memorySummaryLines,
	parseDistilledLessons,
	replaceFileAtomic,
} from "../extensions/zense-harness/index.ts";

/** fake repo with a .zense fixture in tmp — returns a cleanup fn */
const makeRepo = () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-distill-"));
	mkdirSync(join(dir, ".zense", "specs"), { recursive: true });
	mkdirSync(join(dir, ".zense", "subagents"), { recursive: true });
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("distillImpact: counts memory lines + file count/size of specs and subagents", () => {
	const { dir, cleanup } = makeRepo();
	try {
		writeFileSync(join(dir, ".zense", "memory.jsonl"), '{"at":1,"phase":"x","note":"a"}\n{"at":2,"phase":"y","note":"b"}\n\n');
		writeFileSync(join(dir, ".zense", "specs", "s1.json"), "{}");
		writeFileSync(join(dir, ".zense", "specs", "s1.md"), "hello");
		writeFileSync(join(dir, ".zense", "subagents", "g.log"), "x".repeat(100));
		const imp = distillImpact(dir);
		assert.equal(imp.memoryLines, 2); // blank lines don't count
		assert.ok(imp.memoryBytes > 0);
		assert.equal(imp.specFiles, 2);
		assert.equal(imp.specBytes, 7);
		assert.equal(imp.logFiles, 1);
		assert.equal(imp.logBytes, 100);
	} finally {
		cleanup();
	}
});

test("distillImpact: no .zense at all → zeros everywhere (the empty-memory guard uses this)", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-distill-"));
	try {
		const imp = distillImpact(dir);
		assert.deepEqual(imp, { memoryLines: 0, memoryBytes: 0, specFiles: 0, specBytes: 0, logFiles: 0, logBytes: 0 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseDistilledLessons: accepts raw JSON, fences and surrounding prose (same extractJsonObject)", () => {
	for (const text of [
		'{"lessons": ["a", "b"]}',
		'```json\n{"lessons": ["a"]}\n```',
		'here is the result {"lessons": ["x"]} done',
	]) {
		const r = parseDistilledLessons(text);
		assert.equal(r.ok, true, text);
	}
});

test("parseDistilledLessons: whitespace incl. newlines collapses to one line (keeps JSONL valid)", () => {
	const r = parseDistilledLessons('{"lessons": ["  a\\n b  c "]}');
	assert.equal(r.ok, true);
	assert.deepEqual(r.lessons, ["a b c"]);
});

test("parseDistilledLessons: rejects every malformed output shape → the caller must abort", () => {
	for (const text of [
		"no JSON at all",
		'[1,2,3]',
		'{"lessons": []}',
		'{"lessons": "not-array"}',
		'{"lessons": [42]}',
		'{"lessons": ["ok", "  "]}',
		`{"lessons": [${Array.from({ length: 51 }, () => '"x"').join(",")}]}`,
		`{"lessons": ["${"y".repeat(401)}"]}`,
	]) {
		assert.equal(parseDistilledLessons(text).ok, false, text.slice(0, 40));
	}
});

test("buildDistilledMemory: every line parses with the original aggregateMemory, and the lesson text flows into the eval channel", () => {
	const { dir, cleanup } = makeRepo();
	try {
		writeFileSync(join(dir, ".zense", "memory.jsonl"), buildDistilledMemory(["the gate must block writes before signing", "the grader often timed out at 240s"]));
		const agg = aggregateMemory(dir);
		assert.equal(agg.total, 2);
		assert.deepEqual(agg.evals, ["distilled · the gate must block writes before signing", "distilled · the grader often timed out at 240s"]);
		assert.equal(agg.misc, 0);
	} finally {
		cleanup();
	}
});

test("distilled memory + subsequent new lessons (every existing prefix kind) flow through the unchanged aggregateMemory/memorySummaryLines parser", () => {
	const { dir, cleanup } = makeRepo();
	try {
		const mem = join(dir, ".zense", "memory.jsonl");
		writeFileSync(mem, buildDistilledMemory(["the gate must block before signing"]));
		// lessons accumulated *after* a distill — all existing prefix kinds must co-parse
		appendFileSync(mem, JSON.stringify({ at: 1, phase: "maintenance", note: "flag: unsigned override: edit" }) + "\n");
		appendFileSync(mem, JSON.stringify({ at: 2, phase: "requirements", note: "escalation: need-permission: write blocked: spec unsigned" }) + "\n");
		appendFileSync(mem, JSON.stringify({ at: 3, phase: "evaluation", note: "sub-agent failed: grader" }) + "\n");
		appendFileSync(mem, JSON.stringify({ at: 4, phase: "maintenance", note: "distilled: a freeform lesson without a known prefix" }) + "\n");
		const agg = aggregateMemory(dir);
		assert.equal(agg.total, 5);
		assert.equal(agg.flags.get("unsigned override: edit"), 1); // flag: still aggregates
		assert.equal(agg.esc.get("need-permission"), 1); // escalation: still aggregates
		assert.equal(agg.subFails.get("grader"), 1); // sub-agent failed: still aggregates
		assert.equal(agg.misc, 1); // freeform "distilled:" lands in misc (shown as a count)
		// the unchanged memorySummaryLines must render, and the distilled lesson (eval channel) must show up in the summary fed to compile_spec
		const lines = memorySummaryLines(dir).join("\n");
		assert.match(lines, /5 lessons/);
		assert.match(lines, /eval history.*distilled · the gate must block before signing/);
		assert.match(lines, /unsigned override: edit ×1/);
	} finally {
		cleanup();
	}
});

test("lessons longer than 60 chars survive aggregateMemory/memorySummaryLines in full (regression: the eval channel used to truncate at 60)", () => {
	const { dir, cleanup } = makeRepo();
	try {
		// a 160-char lesson — clearly over the old eval-channel truncation ceiling
		const longLesson = "the gate must block every write before the spec is signed, otherwise the agent edits code ahead of any human signature, breaking the harness's core promise--1234567890";
		assert.ok(longLesson.length > 60);
		writeFileSync(join(dir, ".zense", "memory.jsonl"), buildDistilledMemory([longLesson]));
		const agg = aggregateMemory(dir);
		assert.equal(agg.evals[0], `distilled · ${longLesson}`); // complete, no slice(0, 60)
		// a regular (non-distilled) eval entry is still truncated at 60 as before — behavior unchanged
		appendFileSync(join(dir, ".zense", "memory.jsonl"), JSON.stringify({ at: 9, phase: "evaluation", note: `eval: ${"x".repeat(120)}` }) + "\n");
		const agg2 = aggregateMemory(dir);
		assert.equal(agg2.evals[1].length, 60);
		assert.ok(memorySummaryLines(dir).join("\n").includes(longLesson)); // feeds compile_spec in full
	} finally {
		cleanup();
	}
});

test("replaceFileAtomic: writes via tmp then renames — new content correct, no tmp files left", () => {
	const { dir, cleanup } = makeRepo();
	try {
		const p = join(dir, ".zense", "memory.jsonl");
		writeFileSync(p, "old");
		replaceFileAtomic(p, "new");
		assert.equal(readFileSync(p, "utf8"), "new");
		assert.ok(!readdirSync(join(dir, ".zense")).some((f) => f.endsWith(".tmp")));
	} finally {
		cleanup();
	}
});

test("distillTaskPrompt: embeds the full memory content inline (no reliance on a truncating read tool) + size ceiling is a single constant", () => {
	const prompt = distillTaskPrompt('{"note":"a"}\n{"note":"b"}', 2);
	assert.ok(prompt.includes('{"note":"a"}') && prompt.includes('{"note":"b"}'));
	assert.match(prompt, /MEMORY JSONL START \(2 entries\)/);
	assert.match(prompt, /do not try to read any file/);
	assert.ok(MAX_DISTILL_MEMORY_BYTES > 0);
});

test("distill's deletion scope: specs/ + subagents/ only — the protected set (adr/, config.json, models.json, spec.json, spec.md, worktree/) must survive intact", () => {
	const { dir, cleanup } = makeRepo();
	try {
		// the promised protected set — build every piece around memory
		mkdirSync(join(dir, ".zense", "adr"), { recursive: true });
		mkdirSync(join(dir, ".zense", "worktree"), { recursive: true });
		writeFileSync(join(dir, ".zense", "adr", "001-x.md"), "DENY: node_modules/");
		writeFileSync(join(dir, ".zense", "config.json"), "{}");
		writeFileSync(join(dir, ".zense", "models.json"), "{}");
		writeFileSync(join(dir, ".zense", "spec.json"), "{}");
		writeFileSync(join(dir, ".zense", "spec.md"), "# spec");
		writeFileSync(join(dir, ".zense", "memory.jsonl"), buildDistilledMemory(["a"]));
		// runDistill's deletion step: clearDirFiles is invoked only on these 2 dirs (specs keeps nothing, subagents keeps the distiller log)
		writeFileSync(join(dir, ".zense", "specs", "old.json"), "{}");
		writeFileSync(join(dir, ".zense", "subagents", "old.log"), "x");
		writeFileSync(join(dir, ".zense", "subagents", "latest-distiller.log"), "y");
		clearDirFiles(join(dir, ".zense", "specs"));
		clearDirFiles(join(dir, ".zense", "subagents"), new Set(["latest-distiller.log"]));
		// everything protected survives
		for (const p of ["adr/001-x.md", "config.json", "models.json", "spec.json", "spec.md", "memory.jsonl"])
			assert.ok(readFileSync(join(dir, ".zense", p), "utf8").length > 0, p);
		assert.equal(readdirSync(join(dir, ".zense", "worktree")).filter((f) => !f.startsWith(".")).length, 0); // worktree/ undeleted (was empty anyway)
		assert.deepEqual(readdirSync(join(dir, ".zense", "adr")), ["001-x.md"]); // adr/ intact
		assert.deepEqual(readdirSync(join(dir, ".zense", "specs")), []); // specs cleared
		assert.deepEqual(readdirSync(join(dir, ".zense", "subagents")), ["latest-distiller.log"]); // logs cleared except kept
	} finally {
		cleanup();
	}
});

test("clearDirFiles: deletes files only, respects the keep set — the dir itself stays", () => {
	const { dir, cleanup } = makeRepo();
	try {
		const d = join(dir, ".zense", "subagents");
		writeFileSync(join(d, "a.log"), "1");
		writeFileSync(join(d, "b.log"), "2");
		writeFileSync(join(d, "keep.log"), "3");
		const n = clearDirFiles(d, new Set(["keep.log"]));
		assert.equal(n, 2);
		assert.equal(readFileSync(join(d, "keep.log"), "utf8"), "3");
		assert.equal(clearDirFiles(join(dir, ".zense", "nope")), 0); // missing dir → 0, no throw
	} finally {
		cleanup();
	}
});

test("fmtBytes: human-readable units for the confirm dialog", () => {
	assert.equal(fmtBytes(512), "512B");
	assert.equal(fmtBytes(2048), "2.0KB");
	assert.equal(fmtBytes(2 * 1_048_576), "2.0MB");
});

test("regression: runDistill must resolve strip flags via subagentStripFlagsAsync (not the static map) — otherwise subagentExtInclude.distiller is ignored, the provider extension never loads → model not found", async () => {
	const { readFileSync: rf } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const { dirname } = await import("node:path");
	const src = rf(join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "zense-harness", "index.ts"), "utf8");
	const i = src.indexOf("const runDistill");
	assert.ok(i >= 0, "runDistill not found");
	const j = src.indexOf("runSubagent(", i);
	assert.ok(j > i, "runDistill must call runSubagent");
	const call = src.slice(j, src.indexOf(";", j));
	assert.ok(call.includes('await subagentStripFlagsAsync("distiller"'), "call site must use await subagentStripFlagsAsync(\"distiller\", ...) so the config.json include list is re-added as -e flags");
	assert.ok(!call.includes("SUBAGENT_STRIP_FLAGS.distiller"), "must not pass the static SUBAGENT_STRIP_FLAGS.distiller (bare boot drops every extension)");
});

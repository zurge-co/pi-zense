import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	SUBAGENT_STRIP_FLAGS,
	buildRequirementsPrompt,
	buildSubagentArgv,
	listInstalledExtensions,
	subagentExtIncludes,
	subagentStripFlagsAsync,
	writeSubagentExtIncludes,
} from "../extensions/zense-harness/index.ts";

// ext-config (spec v7, 2026-09-08): per-role sub-agent extension loading —
// DEFAULT = unload everything (uniform bare boot; extensions with gates/hangs can't block
// subprocesses), the user ticks some back in (opt-in). Persists to local .zense + seed-once global.
const mkTmp = () => mkdtempSync(join(tmpdir(), "zense-extcfg-"));
const writeCfg = (dir, obj) => {
	mkdirSync(join(dir, ".zense"), { recursive: true });
	writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify(obj));
};

test("default (no config): roles whose base has --no-extensions → flags unchanged (bare boot)", async () => {
	const dir = mkTmp();
	const globalDir = mkTmp();
	try {
		const flags = await subagentStripFlagsAsync("grader", dir, undefined, mkTmp(), globalDir);
		assert.deepEqual(flags, SUBAGENT_STRIP_FLAGS.grader);
		assert.deepEqual(subagentExtIncludes("grader", dir, undefined, globalDir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("default: a role whose base lacks --no-extensions (requirements) → gets it added (uniform bare)", async () => {
	const dir = mkTmp();
	const globalDir = mkTmp();
	try {
		assert.ok(!SUBAGENT_STRIP_FLAGS.requirements.includes("--no-extensions"));
		const flags = await subagentStripFlagsAsync("requirements", dir, undefined, mkTmp(), globalDir);
		assert.ok(flags.includes("--no-extensions"));
		assert.ok(flags.includes("--no-themes") && flags.includes("--no-prompt-templates"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("include list: -e only for still-installed+enabled paths; uninstalled/unknown ones dropped silently", async () => {
	const dir = mkTmp();
	const agentDir = mkTmp();
	const globalDir = mkTmp();
	try {
		// a fake extension in the tmp project — DefaultPackageManager must see it (top-level origin, project scope)
		mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
		const fakePath = join(dir, ".pi", "extensions", "fake-ext.ts");
		writeFileSync(fakePath, "export default function (pi) {}\n");
		const installed = await listInstalledExtensions(dir, agentDir);
		assert.ok(
			installed.some((e) => e.path === fakePath),
			`the fake extension must be enumerated (got: ${installed.map((e) => e.path).join(", ") || "none"})`,
		);
		writeCfg(dir, { subagentExtInclude: { grader: [fakePath, "/nonexistent/gone.ts"] } });
		const flags = await subagentStripFlagsAsync("grader", dir, undefined, agentDir, globalDir);
		assert.ok(flags.includes("--no-extensions"));
		const eIdx = flags.indexOf("-e");
		assert.ok(eIdx >= 0 && flags[eIdx + 1] === fakePath, "-e must point at fake-ext.ts");
		assert.ok(!flags.includes("/nonexistent/gone.ts"), "an uninstalled path must be dropped");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("corrupt/wrong-typed config → built-in [] (never throws)", () => {
	const dir = mkTmp();
	try {
		writeCfg(dir, "{oops");
		assert.deepEqual(subagentExtIncludes("grader", dir, undefined, mkTmp()), []);
		writeCfg(dir, { subagentExtInclude: { grader: 42 } });
		assert.deepEqual(subagentExtIncludes("grader", dir, undefined, mkTmp()), []);
		writeCfg(dir, { subagentTimeoutMs: { grader: 1 } });
		assert.deepEqual(subagentExtIncludes("grader", dir, undefined, mkTmp()), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("chain: no local(cwd) → fallbackCwd; neither → global; local beats global", () => {
	const cwd = mkTmp();
	const fallback = mkTmp();
	const globalDir = mkTmp();
	try {
		mkdirSync(join(globalDir), { recursive: true });
		writeFileSync(join(globalDir, "config.json"), JSON.stringify({ subagentExtInclude: { grader: ["/g.ts"] } }));
		assert.deepEqual(subagentExtIncludes("grader", cwd, fallback, globalDir), ["/g.ts"]); // global fallback
		writeCfg(fallback, { subagentExtInclude: { grader: ["/f.ts"] } });
		assert.deepEqual(subagentExtIncludes("grader", cwd, fallback, globalDir), ["/f.ts"]); // fallbackCwd beats global
		writeCfg(cwd, { subagentExtInclude: { grader: ["/l.ts", "/l2.ts"] } });
		assert.deepEqual(subagentExtIncludes("grader", cwd, fallback, globalDir), ["/l.ts", "/l2.ts"]); // local beats everything
	} finally {
		for (const d of [cwd, fallback, globalDir]) rmSync(d, { recursive: true, force: true });
	}
});

test("writer: always persists LOCAL .zense/config.json (other keys intact); GLOBAL seeds once, never overwrites", () => {
	const dir = mkTmp();
	const globalDir = mkTmp();
	try {
		const cfgPath = join(dir, ".zense", "config.json");
		writeCfg(dir, { subagentTimeoutMs: { grader: 999 } });
		// first time: seed global
		let r = writeSubagentExtIncludes(dir, "grader", ["/a.ts"], globalDir);
		assert.equal(r.globalSeeded, true);
		assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).subagentExtInclude.grader, ["/a.ts"]);
		assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).subagentTimeoutMs.grader, 999); // other keys intact
		assert.deepEqual(JSON.parse(readFileSync(join(globalDir, "config.json"), "utf8")).subagentExtInclude.grader, ["/a.ts"]);
		// second time: local changes, global untouched (user's rule: present = skip)
		r = writeSubagentExtIncludes(dir, "grader", ["/b.ts"], globalDir);
		assert.equal(r.globalSeeded, false);
		assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).subagentExtInclude.grader, ["/b.ts"]);
		assert.deepEqual(JSON.parse(readFileSync(join(globalDir, "config.json"), "utf8")).subagentExtInclude.grader, ["/a.ts"]);
		// the global file lives only under the injected globalDir (real ~/.pi untouched)
		// value=null: deletes local only — no seed, global untouched
		r = writeSubagentExtIncludes(dir, "grader", null, globalDir);
		assert.equal(r.globalSeeded, false);
		assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).subagentExtInclude, undefined); // all gone → the key itself is removed
		assert.deepEqual(JSON.parse(readFileSync(join(globalDir, "config.json"), "utf8")).subagentExtInclude.grader, ["/a.ts"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("buildSubagentArgv: stripFlags override lands in argv (c3); omitted → built-in map works", () => {
	const custom = buildSubagentArgv("task", undefined, ["write"], "grader", ["--no-skills", "--no-extensions", "-e", "/tmp/x.ts"]);
	assert.ok(custom.includes("/tmp/x.ts"));
	assert.ok(custom.includes("--no-extensions"));
	const dflt = buildSubagentArgv("task", undefined, ["write"], "grader");
	assert.ok(dflt.includes("--no-extensions"));
});

// anti-hang: real minute budget in the requirements prompt (spec v2 — carried over, moved into this file)
test("buildRequirementsPrompt: embeds the real minute budget + a slow-command clause pushing them to specDebt", () => {
	const p = buildRequirementsPrompt("intent", [], [], null, 600_000);
	assert.match(p, /about 10 minutes/);
	assert.match(p, /specDebt instead of burning your budget/);
	assert.match(buildRequirementsPrompt("intent", []), /about 5 minutes/); // backward-compat default
});

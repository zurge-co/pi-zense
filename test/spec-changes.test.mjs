import { strict as assert } from "node:assert";
import test from "node:test";
import { buildSpecChanges, groupSpecChanges, renderSpecChangesTui, renderSpecMd } from "../extensions/zense-harness/index.ts";

const baseSpec = (over = {}) => ({
	version: 1,
	title: "Fix login redirect",
	intent: "users hit /login twice",
	approach: ["read auth code", "patch guard"],
	scope: ["src/auth"],
	constraints: ["no new deps"],
	criteria: [
		{ id: "c1", text: "login test passes", check: "npm test" },
		{ id: "c2", text: "guard exists", check: "path exists: src/auth/guard.ts" },
	],
	specDebt: ["verify UX by eye"],
	approved: false,
	...over,
});

test("buildSpecChanges: identical spec → a single warning line (never re-present silently)", () => {
	const prev = baseSpec({ version: 3 });
	const next = baseSpec({ version: 4 });
	const lines = buildSpecChanges(prev, next);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /No changes from v3/);
	assert.ok(lines[0].startsWith("⚠️"));
});

test("buildSpecChanges: title / intent changes", () => {
	const prev = baseSpec({ version: 1 });
	const next = baseSpec({ version: 2, title: "New title", intent: "different intent" });
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.some((l) => l.includes('title: "Fix login redirect" → "New title"')));
	assert.ok(lines.some((l) => l.startsWith("intent:")));
});

test("buildSpecChanges: criteria added / removed / changed (text and check)", () => {
	const prev = baseSpec({ version: 1 });
	const next = baseSpec({
		version: 2,
		criteria: [
			{ id: "c1", text: "login test passes", check: "npm test" }, // unchanged
			{ id: "c2", text: "guard renders", check: "path exists: src/auth/guard.tsx" }, // text+check changed
			{ id: "c3", text: "session persists", check: "npx vitest run" }, // added
		],
	});
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.some((l) => l.startsWith("criteria +: c3: session persists")));
	assert.ok(!lines.some((l) => l.includes("c1"))); // unchanged → not reported
	const c2 = lines.find((l) => l.startsWith("criteria ~: c2"));
	assert.ok(c2, "expected a criteria ~: c2 line");
	assert.ok(c2.includes('text: "guard exists" → "guard renders"'));
	assert.ok(c2.includes('check: "path exists: src/auth/guard.ts" → "path exists: src/auth/guard.tsx"'));

	// removed
	const removed = buildSpecChanges(next, prev).find((l) => l.startsWith("criteria −:"));
	assert.equal(removed, "criteria −: c3: session persists");
});

test("buildSpecChanges: scope / constraints / approach / specDebt list diffs (+/−)", () => {
	const prev = baseSpec({ version: 1 });
	const next = baseSpec({
		version: 2,
		approach: ["read auth code", "patch guard", "add regression test"],
		scope: ["src/auth", "src/session"],
		constraints: [],
		specDebt: [],
	});
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.includes("approach +: add regression test"));
	assert.ok(lines.includes("scope +: src/session"));
	assert.ok(lines.includes("constraints −: no new deps"));
	assert.ok(lines.includes("specDebt −: verify UX by eye"));
});

test("buildSpecChanges: tolerates missing optional field (old persisted spec has no approach)", () => {
	const prev = baseSpec({ version: 1 });
	delete prev.approach; // persisted spec from before the approach field
	const next = baseSpec({ version: 2 });
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.includes("approach +: read auth code"));
	assert.ok(!lines.some((l) => l.startsWith("approach −:")));
});

test("renderSpecMd: Changes section only when the spec has changesFrom — v2 shows it, older specs render as before without crashing", () => {
	const changes = ["scope +: src/session", "⚠️ No changes from v9"];
	const withChanges = baseSpec({ version: 10, changesFrom: changes });
	const md = renderSpecMd(withChanges);
	assert.ok(md.includes("## Changes in v10 (vs v9)"));
	// grouped into a sub-heading + numbered list (not flat bullets)
	assert.ok(md.includes("### Scope\n1. scope +: src/session"));
	assert.ok(!md.includes("- scope +: src/session"));
	// ⚠️ warning line renders verbatim, no heading
	assert.ok(md.includes("⚠️ No changes from v9"));
	// the changes section sits before Intent — the signer sees the change before the full text
	assert.ok(md.indexOf("## Changes in v10") < md.indexOf("## Intent"));

	// backward compat: missing/empty field → no section
	const old = baseSpec({ version: 10 });
	assert.ok(!renderSpecMd(old).includes("## Changes"));
	const empty = baseSpec({ version: 10, changesFrom: [] });
	assert.ok(!renderSpecMd(empty).includes("## Changes"));
});

test("groupSpecChanges: fixed group order + numbering restarts at 1 per group + +/−/~ markers kept", () => {
	const lines = buildSpecChanges(
		baseSpec({ version: 1 }),
		baseSpec({
			version: 2,
			title: "New title",
			intent: "new intent",
			approach: ["read auth code", "patch guard", "add regression test"],
			scope: ["src/auth", "src/session"],
			constraints: [],
			criteria: [
				{ id: "c1", text: "login test passes", check: "npm test" },
				{ id: "c2", text: "guard renders", check: "path exists: src/auth/guard.tsx" },
				{ id: "c3", text: "session persists", check: "npx vitest run" },
			],
			specDebt: [],
		}),
	);
	const md = groupSpecChanges(lines);
	// fixed group order: Title & intent → Approach → Scope → Constraints → Criteria → Spec debt
	const order = ["### Title & intent", "### Approach", "### Scope", "### Constraints", "### Criteria", "### Spec debt"]
		.filter((h) => md.includes(h))
		.map((h) => md.indexOf(h));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
	// each group is a numbered list restarting at 1 + verbatim items (markers +/−/~ kept)
	assert.ok(md.includes("### Approach\n1. approach +: add regression test"));
	assert.ok(md.includes("1. scope +: src/session"));
	assert.ok(md.includes("1. constraints −: no new deps"));
	assert.ok(md.includes("1. specDebt −: verify UX by eye"));
	assert.ok(md.includes("1. criteria ~: c2"));
	assert.ok(md.includes("2. criteria +: c3: session persists (check: npx vitest run)"));
	// the title change lands in the Title & intent group
	assert.ok(md.includes('### Title & intent\n1. title: "Fix login redirect" → "New title"\n2. intent:'));
});

test("groupSpecChanges: ⚠️ identical line renders verbatim without a heading", () => {
	const md = groupSpecChanges(["⚠️ No changes from v3 — the new spec is identical to the previous version"]);
	assert.equal(md, "⚠️ No changes from v3 — the new spec is identical to the previous version");
});

test("groupSpecChanges: ungroupable lines land last in ### Other (never drop a change)", () => {
	const md = groupSpecChanges(["approach +: x", "unrecognized line"]);
	assert.ok(md.indexOf("### Approach") < md.indexOf("### Other"));
	assert.ok(md.includes("### Other\n1. unrecognized line"));
});

const tag = (role, t) => `<${role}>${t}</>`; // fake colorFn — ties marker → role for assertions

test("renderSpecChangesTui: drops redundant heading labels + colors by marker (+ → success / − → error / ~ → warning)", () => {
	const lines = buildSpecChanges(
		baseSpec({ version: 1 }),
		baseSpec({
			version: 2,
			title: "New title",
			intent: "new intent",
			approach: ["read auth code", "patch guard", "add regression test"],
			scope: ["src/auth", "src/session"],
			constraints: [],
			criteria: [
				{ id: "c1", text: "login test passes", check: "npm test" },
				{ id: "c2", text: "guard renders", check: "path exists: src/auth/guard.tsx" },
				{ id: "c3", text: "session persists", check: "npx vitest run" },
			],
			specDebt: [],
		}),
	);
	const out = renderSpecChangesTui(baseSpec({ version: 2, changesFrom: lines }), tag);
	const md = out.join("\n");
	// header first, then groups in the same fixed order as the archive
	assert.equal(out[0], "## Changes in v2 (vs v1)");
	const order = ["### Title & intent", "### Approach", "### Scope", "### Constraints", "### Criteria", "### Spec debt"]
		.filter((h) => md.includes(h))
		.map((h) => md.indexOf(h));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
	// items lost their redundant heading labels ("1. <detail>") — +/−/~ markers became color
	assert.ok(md.includes("### Approach\n<success>1. add regression test</>"));
	assert.ok(md.includes("### Scope\n<success>1. src/session</>"));
	assert.ok(md.includes("### Constraints\n<error>1. no new deps</>"));
	assert.ok(md.includes("### Spec debt\n<error>1. verify UX by eye</>"));
	assert.ok(!/(^|\n)\d+\. [+−~]/.test(md), "no marker may remain after the list number");
	assert.ok(!md.includes("approach +") && !md.includes("scope +"), "no redundant heading labels may remain");
	// criteria: ~ → warning (with text/check details intact) and + → success
	const c2 = out.find((l) => l.startsWith("<warning>"));
	assert.ok(c2, "expected a warning-colored criteria ~ item");
	assert.ok(c2.includes('1. c2 text: "guard exists" → "guard renders"'));
	assert.ok(md.includes("<success>2. c3: session persists (check: npx vitest run)</>"));
	// title/intent stay neutral (uncolored)
	assert.ok(out.includes('1. title: "Fix login redirect" → "New title"'));
	assert.ok(out.some((l) => l.startsWith("2. intent:")));
});

test("renderSpecChangesTui: ⚠️ identical is neutral verbatim without a heading; no changesFrom → []", () => {
	const warn = "⚠️ No changes from v3 — the new spec is identical to the previous version";
	const out = renderSpecChangesTui(baseSpec({ version: 4, changesFrom: [warn] }), tag);
	assert.deepEqual(out, ["## Changes in v4 (vs v3)", "", warn]);
	assert.deepEqual(renderSpecChangesTui(baseSpec({ version: 4 }), tag), []);
	assert.deepEqual(renderSpecChangesTui(baseSpec({ version: 4, changesFrom: [] }), tag), []);
});

test("renderSpecChangesTui: Other lines are neutral and land last, like the archive", () => {
	const out = renderSpecChangesTui(baseSpec({ version: 2, changesFrom: ["scope +: x", "unrecognized line"] }), tag);
	const md = out.join("\n");
	assert.ok(md.indexOf("### Scope\n<success>1. x</>") < md.indexOf("### Other\n1. unrecognized line"));
});

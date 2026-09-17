import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BUILTIN_PROVIDER_IDS,
	PROVIDER_MISSING_RX,
	buildProviderMissingGuidance,
	diagnoseProviderMissing,
	findProviderExtension,
	mergeExtInclude,
	providerIdOfModelPattern,
	subagentExtIncludes,
	usedProviderOf,
	writeSubagentExtIncludes,
} from "../extensions/zense-harness/index.ts";

// provider-missing diagnosis + auto-heal (spec 2026-09-17): sub-agent boot bare (--no-extensions)
// strips the provider extension (e.g. @aliou/pi-synthetic) → post-run diagnosis, because
// the provider a role needs is only knowable at run time (per-role models.json may differ
// from the main agent's) — auto-heal retry + persist, or mark failed with guidance pointing
// at /zense:ext-config:<role>
const mkTmp = () => mkdtempSync(join(tmpdir(), "zense-provdiag-"));

test("providerIdOfModelPattern / usedProviderOf: provider is everything before '/', no '/' = undefined", () => {
	assert.equal(providerIdOfModelPattern("synthetic/hf:x:free"), "synthetic");
	assert.equal(providerIdOfModelPattern("Anthropic/Claude-Sonnet"), "anthropic");
	assert.equal(providerIdOfModelPattern("sonnet:high"), undefined);
	assert.equal(providerIdOfModelPattern("/no-leading"), undefined);
	assert.equal(usedProviderOf("openai/gpt-4o"), "openai");
	assert.equal(usedProviderOf(undefined), undefined);
	assert.equal(usedProviderOf("noSlash"), undefined);
});

test("findProviderExtension: finds the extension with registerProvider + the provider id; prefers a /provider/ path segment", () => {
	const exts = [
		{ path: "/x/pkg/extensions/quota/index.ts", enabled: true, source: "npm:pkg", scope: "user" },
		{ path: "/x/pkg/extensions/provider/index.ts", enabled: true, source: "npm:pkg", scope: "user" },
	];
	const reader = (p) =>
		p.endsWith("provider/index.ts")
			? 'import { registerSyntheticProvider } from "./x";\nregisterProvider(pi);\n// synthetic\nid: "synthetic"'
			: "export default function (pi) {}\n";
	const hit = findProviderExtension("synthetic", exts, reader);
	assert.equal(hit.path, "/x/pkg/extensions/provider/index.ts");
	assert.ok(hit.label.length > 0);
});

test("findProviderExtension: skips disabled / unreadable files / no registerProvider", () => {
	const exts = [
		{ path: "/x/a/provider/index.ts", enabled: false, source: "", scope: "user" }, // disabled → skipped
		{ path: "/x/b/provider/index.ts", enabled: true, source: "", scope: "user" }, // unreadable → skipped
		{ path: "/x/c/other/index.ts", enabled: true, source: "", scope: "user" }, // has the id but no registerProvider → skipped
	];
	const reader = (p) => (p === "/x/b/provider/index.ts" ? undefined : "synthetic synthetic\n");
	assert.equal(findProviderExtension("synthetic", exts, reader), undefined);
});

test("findProviderExtension: multiple top-score ties = ambiguous → undefined (never guesses)", () => {
	const exts = [
		{ path: "/x/pkgA/extensions/provider/index.ts", enabled: true, source: "", scope: "user" },
		{ path: "/x/pkgB/extensions/provider/index.ts", enabled: true, source: "", scope: "user" },
	];
	const reader = () => 'registerProvider(pi); // synthetic\nid: "synthetic"';
	assert.equal(findProviderExtension("synthetic", exts, reader), undefined);
});

test("mergeExtInclude: appends once (idempotent — an existing path returns the same identity)", () => {
	const cur = ["/x/a.ts"];
	const merged = mergeExtInclude(cur, "/x/b.ts");
	assert.deepEqual(merged, ["/x/a.ts", "/x/b.ts"]);
	assert.equal(mergeExtInclude(merged, "/x/b.ts"), merged); // identity — the caller uses !== to detect 'nothing to write'
});

test("diagnoseProviderMissing: silent fallback (usedModel has a different provider) → provider-mismatch", () => {
	const d = diagnoseProviderMissing("synthetic/hf:x:free", { ok: true, output: "...", usedModel: "openai/gpt-4o" });
	assert.equal(d?.kind, "provider-mismatch");
	assert.equal(d?.patternProvider, "synthetic");
});

test("diagnoseProviderMissing: ok run + provider matches the pattern → no heal", () => {
	assert.equal(diagnoseProviderMissing("synthetic/hf:x:free", { ok: true, output: "", usedModel: "synthetic/hf:x:free" }), undefined);
	assert.equal(diagnoseProviderMissing("synthetic/hf:x", { ok: false, output: "boom", usedModel: "synthetic/hf:x" }), undefined);
});

test("diagnoseProviderMissing: built-in provider skips the heal (wrong id/missing auth isn't bare-boot)", () => {
	assert.ok(BUILTIN_PROVIDER_IDS.has("anthropic"));
	assert.equal(diagnoseProviderMissing("anthropic/claude-55", { ok: true, output: "", usedModel: "openai/gpt-4o" }), undefined);
});

test("diagnoseProviderMissing: hard error with usedModel uncaptured → hard-missing per PROVIDER_MISSING_RX", () => {
	const out = "sub-agent exited code=1\nError: no models found matching 'synthetic/hf:x:free'\n";
	const d = diagnoseProviderMissing("synthetic/hf:x:free", { ok: false, output: out });
	assert.equal(d?.kind, "hard-missing");
	// ordinary failures (timeout/tool noise) must not false-positive
	assert.ok(!PROVIDER_MISSING_RX.test("sub-agent exited code=143 signal=null (timeout SIGTERM)"));
	assert.equal(diagnoseProviderMissing("synthetic/hf:x", { ok: false, output: "sub-agent exited code=143 (TIMEOUT)" }), undefined);
	// no pattern / no provider in pattern → no diagnosis
	assert.equal(diagnoseProviderMissing(undefined, { ok: false, output: "no models found matching x" }), undefined);
	assert.equal(diagnoseProviderMissing("sonnet:high", { ok: false, output: "no models found matching x" }), undefined);
});

test("buildProviderMissingGuidance: with a hit → points at /zense:ext-config:<role> + non-interactive on <path>", () => {
	const g = buildProviderMissingGuidance("grader", "synthetic", { hit: { path: "/x/pkg/extensions/provider/index.ts", label: "provider/index.ts" } });
	assert.ok(g.includes("grader"));
	assert.ok(g.includes("/zense:ext-config:grader"), "must point at the per-role command, not a generic ext-config");
	assert.ok(g.includes("/zense ext-config-show grader on /x/pkg/extensions/provider/index.ts"));
	assert.ok(g.includes("pi login synthetic"), "broken despite inclusion = auth");
	const retried = buildProviderMissingGuidance("grader", "synthetic", { hit: { path: "/x/p/index.ts", label: "p" }, autoRetried: true });
	assert.ok(retried.includes("auto-include"), "a failed auto-retry must say it tried");
});

test("buildProviderMissingGuidance: already included but falling back → points at auth; no hit → points at installing / changing the model", () => {
	const inc = buildProviderMissingGuidance("reviewer", "synthetic", {
		hit: { path: "/x/pkg/extensions/provider/index.ts", label: "provider/index.ts" },
		alreadyIncluded: true,
	});
	assert.ok(inc.includes("auth") && inc.includes("pi login synthetic"));
	assert.ok(!inc.includes("tick"), "already included → must not order another tick");
	const none = buildProviderMissingGuidance("grader", "acme-llm");
	assert.ok(none.includes("/zense models"), "no extension found → offer changing the role's model");
	assert.ok(!none.includes("ext-config-show grader on"), "no path = never orders on <path>");
});

test("persist path: writeSubagentExtIncludes writes the merged include list (local + global seed) and reads back correctly", () => {
	const dir = mkTmp();
	const globalDir = mkTmp();
	try {
		mkdirSync(join(dir, ".zense"), { recursive: true });
		const hitPath = "/x/pkg/extensions/provider/index.ts";
		const cur = subagentExtIncludes("grader", dir, undefined, globalDir);
		assert.deepEqual(cur, []);
		const merged = mergeExtInclude(cur, hitPath);
		writeSubagentExtIncludes(dir, "grader", merged, globalDir);
		assert.deepEqual(subagentExtIncludes("grader", dir, undefined, globalDir), [hitPath]);
		// first-time global seed — global holds the same include
		assert.deepEqual(subagentExtIncludes("grader", undefined, undefined, globalDir), [hitPath]);
		// merging again (idempotent) + rewriting — no path duplication
		writeSubagentExtIncludes(dir, "grader", mergeExtInclude([hitPath], hitPath), globalDir);
		assert.deepEqual(subagentExtIncludes("grader", dir, undefined, globalDir), [hitPath]);
		// the local file keeps its other keys (the writer's standing contract)
		const raw = JSON.parse(readFileSync(join(dir, ".zense", "config.json"), "utf8"));
		assert.ok(raw.subagentExtInclude.grader.includes(hitPath));
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

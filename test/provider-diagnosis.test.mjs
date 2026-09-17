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
// ตัด extension ผู้ลง provider (เช่น @aliou/pi-synthetic) → วินิจฉัย post-run เพราะ provider ที่ role
// ต้องการรู้แน่ได้แค่ตอนรัน (models.json ต่อ role อาจต่างจาก main agent) — auto-heal retry + persist
// หรือ mark failed พร้อม guidance ชี้ /zense:ext-config:<role>
const mkTmp = () => mkdtempSync(join(tmpdir(), "zense-provdiag-"));

test("providerIdOfModelPattern / usedProviderOf: แยก provider ก่อน '/', ไม่มี '/' = undefined", () => {
	assert.equal(providerIdOfModelPattern("synthetic/hf:x:free"), "synthetic");
	assert.equal(providerIdOfModelPattern("Anthropic/Claude-Sonnet"), "anthropic");
	assert.equal(providerIdOfModelPattern("sonnet:high"), undefined);
	assert.equal(providerIdOfModelPattern("/no-leading"), undefined);
	assert.equal(usedProviderOf("openai/gpt-4o"), "openai");
	assert.equal(usedProviderOf(undefined), undefined);
	assert.equal(usedProviderOf("noSlash"), undefined);
});

test("findProviderExtension: เจอ extension ที่มี registerProvider + provider id; prefer segment /provider/", () => {
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

test("findProviderExtension: ข้าม disabled / ไฟล์อ่านไม่ได้ / ไม่มี registerProvider", () => {
	const exts = [
		{ path: "/x/a/provider/index.ts", enabled: false, source: "", scope: "user" }, // disabled → ข้าม
		{ path: "/x/b/provider/index.ts", enabled: true, source: "", scope: "user" }, // อ่านไม่ได้ → ข้าม
		{ path: "/x/c/other/index.ts", enabled: true, source: "", scope: "user" }, // มี id แต่ไม่มี registerProvider → ข้าม
	];
	const reader = (p) => (p === "/x/b/provider/index.ts" ? undefined : "synthetic synthetic\n");
	assert.equal(findProviderExtension("synthetic", exts, reader), undefined);
});

test("findProviderExtension: หลายตัวคะแนนสูงสุดเท่ากัน = ambiguous → undefined (ไม่เดา)", () => {
	const exts = [
		{ path: "/x/pkgA/extensions/provider/index.ts", enabled: true, source: "", scope: "user" },
		{ path: "/x/pkgB/extensions/provider/index.ts", enabled: true, source: "", scope: "user" },
	];
	const reader = () => 'registerProvider(pi); // synthetic\nid: "synthetic"';
	assert.equal(findProviderExtension("synthetic", exts, reader), undefined);
});

test("mergeExtInclude: append ครั้งเดียว (idempotent — มีแล้วคืนตัวเดิมเป๊ะ)", () => {
	const cur = ["/x/a.ts"];
	const merged = mergeExtInclude(cur, "/x/b.ts");
	assert.deepEqual(merged, ["/x/a.ts", "/x/b.ts"]);
	assert.equal(mergeExtInclude(merged, "/x/b.ts"), merged); // identity — caller ใช้ !== ดัก 'ไม่ต้องเขียน'
});

test("diagnoseProviderMissing: silent fallback (usedModel คนละ provider) → provider-mismatch", () => {
	const d = diagnoseProviderMissing("synthetic/hf:x:free", { ok: true, output: "...", usedModel: "openai/gpt-4o" });
	assert.equal(d?.kind, "provider-mismatch");
	assert.equal(d?.patternProvider, "synthetic");
});

test("diagnoseProviderMissing: run ok + provider ตรง pattern → ไม่เข้า heal", () => {
	assert.equal(diagnoseProviderMissing("synthetic/hf:x:free", { ok: true, output: "", usedModel: "synthetic/hf:x:free" }), undefined);
	assert.equal(diagnoseProviderMissing("synthetic/hf:x", { ok: false, output: "boom", usedModel: "synthetic/hf:x" }), undefined);
});

test("diagnoseProviderMissing: built-in provider ข้าม heal (id ผิด/auth หาย ไม่ใช่ bare-boot)", () => {
	assert.ok(BUILTIN_PROVIDER_IDS.has("anthropic"));
	assert.equal(diagnoseProviderMissing("anthropic/claude-55", { ok: true, output: "", usedModel: "openai/gpt-4o" }), undefined);
});

test("diagnoseProviderMissing: hard error ตอน usedModel จับไม่ได้ → hard-missing ตาม PROVIDER_MISSING_RX", () => {
	const out = "sub-agent exited code=1\nError: no models found matching 'synthetic/hf:x:free'\n";
	const d = diagnoseProviderMissing("synthetic/hf:x:free", { ok: false, output: out });
	assert.equal(d?.kind, "hard-missing");
	// ความล้มเหลวทั่วไป (timeout/tool noise) ห้าม false-positive
	assert.ok(!PROVIDER_MISSING_RX.test("sub-agent exited code=143 signal=null (timeout SIGTERM)"));
	assert.equal(diagnoseProviderMissing("synthetic/hf:x", { ok: false, output: "sub-agent exited code=143 (TIMEOUT)" }), undefined);
	// ไม่มี pattern / ไม่มี provider ใน pattern → ไม่วินิจฉัย
	assert.equal(diagnoseProviderMissing(undefined, { ok: false, output: "no models found matching x" }), undefined);
	assert.equal(diagnoseProviderMissing("sonnet:high", { ok: false, output: "no models found matching x" }), undefined);
});

test("buildProviderMissingGuidance: มี hit → ชี้ /zense:ext-config:<role> + non-interactive on <path>", () => {
	const g = buildProviderMissingGuidance("grader", "synthetic", { hit: { path: "/x/pkg/extensions/provider/index.ts", label: "provider/index.ts" } });
	assert.ok(g.includes("grader"));
	assert.ok(g.includes("/zense:ext-config:grader"), "ต้องชี้คำสั่ง per-role ไม่ใช่ generic ext-config");
	assert.ok(g.includes("/zense ext-config-show grader on /x/pkg/extensions/provider/index.ts"));
	assert.ok(g.includes("pi login synthetic"), "กรณี include แล้วยังพัง = auth");
	const retried = buildProviderMissingGuidance("grader", "synthetic", { hit: { path: "/x/p/index.ts", label: "p" }, autoRetried: true });
	assert.ok(retried.includes("auto-include"), "auto-retry พังต้องบอกว่าลองแล้ว");
});

test("buildProviderMissingGuidance: include อยู่แล้วแต่ fallback → ชี้ auth; ไม่มี hit → ชี้ติดตั้ง/เปลี่ยน model", () => {
	const inc = buildProviderMissingGuidance("reviewer", "synthetic", {
		hit: { path: "/x/pkg/extensions/provider/index.ts", label: "provider/index.ts" },
		alreadyIncluded: true,
	});
	assert.ok(inc.includes("auth") && inc.includes("pi login synthetic"));
	assert.ok(!inc.includes("tick"), "include อยู่แล้ว ไม่ควรสั่ง tick ซ้ำ");
	const none = buildProviderMissingGuidance("grader", "acme-llm");
	assert.ok(none.includes("/zense models"), "หา ext ไม่เจอ → เสนอเปลี่ยน model ของ role");
	assert.ok(!none.includes("ext-config-show grader on"), "ไม่มี path = ไม่ควรสั่ง on <path>");
});

test("persist path: writeSubagentExtIncludes เขียน merged include (local + seed global) อ่านกลับตรง", () => {
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
		// global seed ครั้งแรก — global มี include เดียวกัน
		assert.deepEqual(subagentExtIncludes("grader", undefined, undefined, globalDir), [hitPath]);
		// merge ซ้ำ (idempotent) แล้วเขียนซ้ำ ไม่ซ้อน path
		writeSubagentExtIncludes(dir, "grader", mergeExtInclude([hitPath], hitPath), globalDir);
		assert.deepEqual(subagentExtIncludes("grader", dir, undefined, globalDir), [hitPath]);
		// ไฟล์ local คง key อื่น (contract เดิมของ writer)
		const raw = JSON.parse(readFileSync(join(dir, ".zense", "config.json"), "utf8"));
		assert.ok(raw.subagentExtInclude.grader.includes(hitPath));
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

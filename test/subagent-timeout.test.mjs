import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildRequirementsPrompt,
	gatherRepoFacts,
	probeToolchain,
	subagentTimeout,
} from "../extensions/zense-harness/index.ts";

// B: timeout ต่อ role — ป้องกัน regression ของ bug "code=143 signal=null" (timeout ถูกรายงานเป็น crash)
test("subagentTimeout: per-role map, default fallback, env override", () => {
	assert.equal(subagentTimeout("requirements"), 600_000);
	assert.equal(subagentTimeout("grader"), 600_000);
	assert.equal(subagentTimeout("reviewer"), 480_000);
	assert.equal(subagentTimeout("unknown-role"), 300_000); // role แปลก → default
	assert.equal(subagentTimeout("requirements", { ZENSE_SUBAGENT_TIMEOUT_MS: "120000" }), 120_000);
	assert.equal(subagentTimeout("requirements", {}), 600_000); // ไม่มี env = ไม่ override
	assert.equal(subagentTimeout("requirements", { ZENSE_SUBAGENT_TIMEOUT_MS: "0" }), 600_000); // ค่าไม่ valid ไม่ override
	assert.equal(subagentTimeout("requirements", { ZENSE_SUBAGENT_TIMEOUT_MS: "-5" }), 600_000);
	assert.equal(subagentTimeout("requirements", { ZENSE_SUBAGENT_TIMEOUT_MS: "abc" }), 600_000);
});

// C: toolchain probe — filter เฉพาะที่มีจริง + best-effort ไม่ throw แม้ PATH พัง
test("probeToolchain: keeps existing tools only, tolerates failure", () => {
	const r = probeToolchain(["node", "definitely-not-a-tool-xyz-123"]);
	assert.ok(r.includes("node")); // test รันบน node → ต้องเจอ
	assert.ok(!r.includes("definitely-not-a-tool-xyz-123"));
	assert.deepEqual(probeToolchain(["definitely-not-a-tool-xyz-123"]), []);
	assert.deepEqual(probeToolchain(["node"], { PATH: "/nonexistent-dir-xyz" }), []); // PATH ว่าง → [] ไม่ throw
});

// C: gatherRepoFacts ต้องดัน toolchain fact (ให้ sub-agent ไม่ต้อง probe ทีละตัวจนชน timeout)
test("gatherRepoFacts: toolchain fact + package facts from tmp dir", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-facts-"));
	try {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
		const facts = gatherRepoFacts(dir);
		assert.ok(facts.some((f) => f.includes("package: demo")));
		assert.ok(facts.some((f) => f.includes("scripts:") && f.includes("node --test")));
		const toolFact = facts.find((f) => f.includes("toolchain on PATH"));
		assert.ok(toolFact, "missing toolchain fact");
		assert.match(toolFact, /node/);
		assert.match(toolFact, /do NOT re-probe/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// C: manifest ต่อ ecosystem — repo ที่ไม่มี package.json (cargo/go/deno) ต้องได้ fact ครอบ ไม่ให้เดาเอง
test("gatherRepoFacts: ecosystem manifests (non-npm repos) become facts", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-manifests-"));
	try {
		writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"demo\"\n");
		writeFileSync(join(dir, "go.mod"), "module demo\n");
		writeFileSync(join(dir, "app.csproj"), "<Project/>\n");
		const facts = gatherRepoFacts(dir).join("\n");
		assert.match(facts, /Cargo\.toml/);
		assert.match(facts, /go\.mod/);
		assert.match(facts, /app\.csproj/);
		assert.match(facts, /do not re-scan/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// C: prompt ต้องสั่งเรื่อง hard time limit + ไม่ re-probe สิ่งที่ facts มี (ต้นตอ code=143 เดิม)
test("buildRequirementsPrompt: hard time limit + batched probe + trust facts", () => {
	const p = buildRequirementsPrompt("do x", [], ["- toolchain on PATH: node"]);
	assert.match(p, /HARD wall-clock limit/);
	assert.match(p, /ONE bash loop/);
	assert.match(p, /do NOT re-probe one-by-one|never probe toolchains or test commands one-by-one/);
});

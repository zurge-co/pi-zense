import { strict as assert } from "node:assert";
import test from "node:test";
import {
	firstAdrDenyViolation,
	parseAdrDenyRules,
} from "../extensions/zense-harness/index.ts";

test("regression: token parsing never collapses a normal DENY line to its first character", () => {
	const adr = [
		"DENY: node_modules/",
		'DENY: activity === "terminal" ? ()',
	].join("\n");

	const rules = parseAdrDenyRules(adr);
	assert.deepEqual(rules.map((rule) => rule.constraint), [
		"node_modules/",
		'activity === "terminal" ? ()',
	]);
	assert.ok(rules.every((rule) => rule.constraint.length > 1));

	assert.equal(firstAdrDenyViolation("src/index.ts", adr), undefined);
	assert.equal(firstAdrDenyViolation("src/launch.ts", adr), undefined);
	assert.equal(
		firstAdrDenyViolation("packages/app/node_modules/pkg/index.js", adr),
		"ADR constraint: node_modules/ denied (see ADR)",
	);
});

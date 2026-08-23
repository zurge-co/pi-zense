import { strict as assert } from "node:assert";
import test from "node:test";
import {
	firstAdrDenyViolation,
	parseAdrDenyLine,
	parseAdrDenyRules,
} from "../extensions/zense-harness/index.ts";

test("no-reason DENY lines keep the entire constraint intact", () => {
	const rule = parseAdrDenyLine("DENY: node_modules/");
	assert.equal(rule?.constraint, "node_modules/");
	assert.equal(rule?.reason, undefined);
});

test("REASON separators split exactly once and trim surrounding whitespace", () => {
	const rule = parseAdrDenyLine("  deny:  api/legacy   →   avoid legacy mutation  ");
	assert.equal(rule?.constraint, "api/legacy");
	assert.equal(rule?.reason, "avoid legacy mutation");
});

test("later arrows remain part of the reason", () => {
	const rule = parseAdrDenyLine("DENY: src/parser → first → keep me");
	assert.equal(rule?.constraint, "src/parser");
	assert.equal(rule?.reason, "first → keep me");
});

test("parse handles CRLF, prefixes without spaces, and never creates a constraint from irrelevant lines", () => {
	const rules = parseAdrDenyRules([
		"DenY:src/legacy\r",
		"this is not a DENY rule",
		"DENY:",
		"  DENY:   \t  ",
		"deny: generated/build\r",
	].join("\n"));

	assert.deepEqual(rules.map((rule) => rule.constraint), ["src/legacy", "generated/build"]);
});

test("full constraints block matching nested targets with the established message", () => {
	const reason = firstAdrDenyViolation("src/x/node_modules/index.js", "DENY: node_modules/ → generated dependency");
	assert.equal(reason, "ADR constraint: node_modules/ denied (generated dependency)");
});

test("matching targets without a reason keep the see-ADR fallback", () => {
	const reason = firstAdrDenyViolation("packages/api/legacy/routes.ts", "DENY: api/legacy");
	assert.equal(reason, "ADR constraint: api/legacy denied (see ADR)");
});

test("missing or empty targets are never blocked", () => {
	const adr = "DENY: node_modules/\r\nDENY: src/legacy";
	assert.equal(firstAdrDenyViolation(undefined, adr), undefined);
	assert.equal(firstAdrDenyViolation("", adr), undefined);
});

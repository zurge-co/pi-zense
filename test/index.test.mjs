import { strict as assert } from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import test from "node:test";
import {
	firstAdrDenyViolation,
	panelize,
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

test("panelize: fake theme.bg injectable via structural type — token 'selectedBg' reaches theme.bg", () => {
	const calls = [];
	const fake = { bg: (color, text) => { calls.push(color); return `<${color}>${text}</${color}>`; } };
	const out = panelize(fake, ["hi"], 10);
	assert.deepEqual(calls, ["selectedBg"]);
	assert.match(out[0], /^<selectedBg>/);
});

test("panelize: a line shorter than w gets padded to full width, then bg-wrapped whole", () => {
	const fake = { bg: (_c, text) => `[BG]${text}[/BG]` };
	const [padded] = panelize(fake, ["abc"], 8);
	// the content inside the bg wrap must be exactly w wide (abc + 5 spaces)
	assert.equal(padded.slice(4, -5).length, 8);
	assert.equal(padded, `[BG]abc${" ".repeat(5)}[/BG]`);
});

test("panelize: width measured via visibleWidth — ANSI escapes take no screen; overlong lines get no negative padding", () => {
	const fake = { bg: (_c, text) => `{${text}}` };
	const [ansiLine] = panelize(fake, ["\x1b[31mRED\x1b[39m"], 10);
	// "RED" is 3 wide on screen → padded by 7 cells even though its string is far longer
	assert.equal(visibleWidth(ansiLine.slice(1, -1)), 10);
	const [longLine] = panelize(fake, ["twelve-chars-x"], 5);
	assert.ok(!longLine.includes("  ")); // w smaller than the content → never attempts negative padding
});

test("missing or empty targets are never blocked", () => {
	const adr = "DENY: node_modules/\r\nDENY: src/legacy";
	assert.equal(firstAdrDenyViolation(undefined, adr), undefined);
	assert.equal(firstAdrDenyViolation("", adr), undefined);
});

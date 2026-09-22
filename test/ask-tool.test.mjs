// ask-tool: zense_ask pure helpers (src/ask.ts) + index.ts source regression guards
// (tool registered as "zense_ask", ctx.hasUI checked before any picker is awaited)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	asAskQuestions,
	formatAskAnswers,
	ASK_MAX_QUESTIONS,
	ASK_NO_UI_TEXT,
} from "../extensions/zense-harness/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(join(here, "..", rel), "utf8");

// ---------- asAskQuestions (normalize raw tool params → picker questions)

test("asAskQuestions: bare strings and {question, choices} objects both normalize", () => {
	const qs = asAskQuestions(["plain question?", { question: "with choices?", choices: ["a", "b"] }]);
	assert.deepEqual(qs, [
		{ question: "plain question?", choices: [] },
		{ question: "with choices?", choices: ["a", "b"] },
	]);
});

test("asAskQuestions: empty/garbage items are dropped; questions and choices are trimmed", () => {
	const qs = asAskQuestions([{ question: "  real?  ", choices: ["  x  ", "", "y"] }, { question: "" }, 42, null, { noquestion: true }]);
	assert.deepEqual(qs, [{ question: "real?", choices: ["x", "y"] }]);
});

test("asAskQuestions: nothing usable → undefined (the tool reports an error instead of asking)", () => {
	assert.equal(asAskQuestions(undefined), undefined);
	assert.equal(asAskQuestions("not an array"), undefined);
	assert.equal(asAskQuestions([]), undefined);
	assert.equal(asAskQuestions([{ question: "   " }, { choices: ["orphan"] }]), undefined);
});

test("asAskQuestions: choices capped at 6 and questions at ASK_MAX_QUESTIONS (picker stays readable)", () => {
	const many = asAskQuestions([{ question: "q", choices: ["1", "2", "3", "4", "5", "6", "7", "8"] }]);
	assert.equal(many[0].choices.length, 6);
	const qs = asAskQuestions(Array.from({ length: ASK_MAX_QUESTIONS + 3 }, (_, i) => `q${i}?`));
	assert.equal(qs.length, ASK_MAX_QUESTIONS);
});

// ---------- formatAskAnswers (result text the agent reads)

test("formatAskAnswers: answered questions render 'question → answer' numbered in order", () => {
	const text = formatAskAnswers([
		{ question: "db?", answer: "sqlite" },
		{ question: "ui?", answer: "tui" },
	]);
	assert.equal(text, "1. db?\n   → sqlite\n2. ui?\n   → tui");
});

test("formatAskAnswers: skipped (Esc) is named explicitly — never infer an answer", () => {
	const text = formatAskAnswers([{ question: "db?", answer: undefined }]);
	assert.match(text, /\(skipped/);
	assert.match(text, /do NOT infer/);
});

// ---------- ASK_NO_UI_TEXT (graceful RPC/print fallback)

test("ASK_NO_UI_TEXT: tells the agent to fall back to plain numbered chat text", () => {
	assert.match(ASK_NO_UI_TEXT, /no interactive UI/i);
	assert.match(ASK_NO_UI_TEXT, /plain chat text/);
});

// ---------- index.ts source regression guards (wiring can't run under node:test)

test("source: zense_ask is registered via pi.registerTool with its name literal", () => {
	const src = readSrc("extensions/zense-harness/index.ts");
	assert.match(src, /name:\s*"zense_ask"/);
});

test("source: the no-UI branch checks ctx.hasUI and returns ASK_NO_UI_TEXT before any picker", () => {
	const src = readSrc("extensions/zense-harness/index.ts");
	const i = src.indexOf('"zense_ask"');
	assert.ok(i > 0);
	const body = src.slice(i);
	assert.ok(body.includes("askClarifyQuestion"), "picker path must reuse askClarifyQuestion");
	const guard = body.indexOf("!ctx.hasUI");
	const picker = body.indexOf("askClarifyQuestion");
	assert.ok(guard !== -1 && picker !== -1 && guard < picker, "ctx.hasUI guard must come before the picker call (no hang in RPC/print)");
	assert.match(body, /ASK_NO_UI_TEXT/);
});

test("source: registration sits after askClarifyQuestion/zensePick are defined (factory-closure TDZ order)", () => {
	const src = readSrc("extensions/zense-harness/index.ts");
	const def = src.indexOf("const askClarifyQuestion");
	const reg = src.indexOf('"zense_ask"');
	assert.ok(def !== -1 && reg !== -1 && def < reg, "askClarifyQuestion must be defined before the zense_ask registration references it");
});

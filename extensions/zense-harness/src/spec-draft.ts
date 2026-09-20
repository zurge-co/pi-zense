// zense-harness module: requirements draft parsing: clarify/spec JSON parse, machine-checkable heuristic, quality gate + duplicate-spec guard (moved verbatim from index.ts — see AGENTS.md map)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { zenseDir, type Criterion } from "./types.ts";
import { hasUnsubstitutedPlaceholder } from "./evidence.ts";

// ----------------------------------------------------------------------------- requirements draft parsing (module scope — exported for unit tests)

export interface SpecDraft {
	title: string;
	intent: string;
	approach: string[];
	scope: string[];
	constraints: string[];
	criteria: Criterion[];
	specDebt: string[];
}

/** One clarify question (normalized): supports a legacy bare string (choices empty) and the
 *  newer shape where the sub-agent attaches answer options — the human picks from the list or
 *  chooses "Other (type your own)". */
export interface ClarifyQuestion {
	question: string;
	choices: string[];
}

export type DraftParse =
	| { kind: "spec"; draft: SpecDraft }
	| { kind: "clarify"; questions: ClarifyQuestion[] }
	| { kind: "error"; error: string };

const asStringArray = (v: unknown): string[] | undefined =>
	Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;

/** Normalize clarify-draft questions → ClarifyQuestion[]: legacy string → empty choices;
 *  {question, choices} → kept as-is (max 6 options, keeps the dialog short); items without a
 *  real question are skipped; nothing left → undefined (falls through to the criteria-missing
 *  error per contract, not clarify). */
export const asClarifyQuestions = (v: unknown): ClarifyQuestion[] | undefined => {
	if (!Array.isArray(v)) return undefined;
	const out: ClarifyQuestion[] = [];
	for (const x of v) {
		if (typeof x === "string") {
			const q = x.trim();
			if (q) out.push({ question: q, choices: [] });
		} else if (x && typeof x === "object" && !Array.isArray(x)) {
			const o = x as Record<string, unknown>;
			const q = typeof o.question === "string" ? o.question.trim() : "";
			if (q) out.push({ question: q, choices: (asStringArray(o.choices) ?? []).slice(0, 6) });
		}
	}
	return out.length ? out : undefined;
};

/**
 * Extract a single JSON object from sub-agent output — tolerant of raw JSON, ```json fences,
 * and surrounding prose (first-'{' to last-'}'), because models love adding prose despite
 * being told not to; a single strict parse would fail needlessly often.
 */
export const extractJsonObject = (text: string): unknown => {
	const candidates: string[] = [text.trim()];
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) candidates.push(fence[1].trim());
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
	for (const c of candidates) {
		try {
			return JSON.parse(c);
		} catch {
			/* try the next candidate */
		}
	}
	return undefined;
};

/**
 * A: parse + validate the requirements sub-agent draft per contract:
 *   - spec shape    → {title,intent,approach,scope,constraints,criteria[{id,text,check}],specDebt}
 *   - clarify shape (F) → {"questions": [...]} (ask back instead of guessing) — counts as
 *     clarify only when no criteria are present; questions may be bare strings (legacy) or
 *     {question, choices} objects (answer options for fast human picking)
 *   - anything else → error describing what broke (used as feedback on the round-2 retry)
 * Minor shape issues are normalized (missing criteria ids → auto c1..n, missing arrays → []),
 * but empty criteria / items without text+check are invalid — a spec without teeth is worse
 * than none.
 */
export const parseSpecDraft = (text: string): DraftParse => {
	const raw = extractJsonObject(text);
	if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw))
		return { kind: "error", error: "output is not a JSON object (no parseable JSON found — the prompt instructs output ONLY JSON)" };
	const o = raw as Record<string, unknown>;
	const qs = asClarifyQuestions(o.questions);
	if (qs?.length && o.criteria === undefined) return { kind: "clarify", questions: qs.slice(0, 5) };
	if (!Array.isArray(o.criteria) || o.criteria.length === 0)
		return { kind: "error", error: "criteria must be an array with at least 1 item (each needs a check that is a runnable command)" };
	const criteria: Criterion[] = [];
	for (let i = 0; i < o.criteria.length; i++) {
		const c = o.criteria[i] as Record<string, unknown> | null;
		if (!c || typeof c !== "object") return { kind: "error", error: `criteria[${i}] is not an object` };
		const ctext = typeof c.text === "string" ? c.text.trim() : "";
		const check = typeof c.check === "string" ? c.check.trim() : "";
		if (!ctext) return { kind: "error", error: `criteria[${i}].text is empty or not a string` };
		if (!check) return { kind: "error", error: `criteria[${i}].check is empty or not a string` };
		criteria.push({ id: typeof c.id === "string" && c.id.trim() ? c.id.trim() : `c${i + 1}`, text: ctext, check });
	}
	return {
		kind: "spec",
		draft: {
			title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : "untitled",
			intent: typeof o.intent === "string" ? o.intent : "",
			approach: asStringArray(o.approach) ?? [],
			scope: asStringArray(o.scope) ?? [],
			constraints: asStringArray(o.constraints) ?? [],
			criteria,
			specDebt: asStringArray(o.specDebt) ?? [],
		},
	};
};

/**
 * Heuristic: can the harness/grader actually run this check automatically? Passes on known
 * command tokens, backtick-quoted commands, '$'-prompts, or a path-exists pattern; words like
 * "manual"/"by eye" fail immediately. The quality gate (G) pushes uncheckable criteria into
 * specDebt (forced human review). Intentionally permissive (false negatives beat false
 * positives: anything uncertain must land in specDebt).
 */
export const isMachineCheckable = (check: string): boolean => {
	const s = check.toLowerCase();
	if (/\bmanual(ly)?\b|by eye|visually|eyeball|ask (the )?human/.test(s)) return false;
	if (/path exists|file exists|exists:/.test(s)) return true;
	if (/`[^`]+`/.test(check) || /^\s*\$/.test(check)) return true;
	return /\b(npm|pnpm|yarn|bun|npx|node|deno|pytest|python3?|pip|cargo|go|make|just|mvn|gradle|dotnet|composer|php|ruby|bundle|bash|sh|zsh|curl|wget|git|grep|rg|ls|cat|head|tail|find|test|diff|cmp|wc|jq|yq|stat|tsc|vitest|jest|mocha|uv|turbo|docker)\b/i.test(check);
};

const tokenSet = (s: string): Set<string> =>
	new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));

export const jaccard = (a: Set<string>, b: Set<string>): number => {
	if (!a.size || !b.size) return 0;
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	return inter / (a.size + b.size - inter);
};

/** G: duplicate-spec guard — scan the newest 20 archive specs (.zense/specs/*.json) and
 *  compare title+intent tokens; Jaccard ≥ 0.5 counts as "similar" (loose enough to catch
 *  paraphrases without flagging genuinely different work). */
export const findSimilarSpec = (cwd: string, draft: SpecDraft): { file: string; title: string; score: number } | null => {
	const dir = join(zenseDir(cwd), "specs");
	if (!existsSync(dir)) return null;
	const mine = tokenSet(`${draft.title} ${draft.intent}`);
	let best: { file: string; title: string; score: number } | null = null;
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).slice(-20)) {
		try {
			const old = JSON.parse(readFileSync(join(dir, f), "utf8")) as { title?: string; intent?: string };
			const score = jaccard(mine, tokenSet(`${old.title ?? ""} ${old.intent ?? ""}`));
			if (score >= 0.5 && (!best || score > best.score)) best = { file: f, title: old.title ?? "?", score };
		} catch {
			/* skip corrupt archive files */
		}
	}
	return best;
};

/**
 * G: harness-side quality gate — the sub-agent is good at drafting, but the harness must be
 * skeptical on the human's behalf: empty scope / unverifiable check / duplicate of an old spec
 * → forced into specDebt (human review at eval/review). Returns a new draft (no mutation)
 * plus short notes about what was added (telemetry + tool-result messaging).
 */
export const applyQualityGate = (cwd: string, draft: SpecDraft): { draft: SpecDraft; notes: string[] } => {
	const notes: string[] = [];
	const extraDebt: string[] = [];
	if (!draft.scope.length) {
		extraDebt.push("quality-gate: scope not specified — every write would pass the scope check; name the path prefixes the agent may touch");
		notes.push("empty-scope");
	}
	// W3: a scope typo = silently toothless gate — a prefix with no real path matches no writes
	for (const s of draft.scope) {
		const prefix = s.replace(/\*+$/, "").replace(/\/+$/, "");
		if (prefix && !existsSync(join(cwd, prefix))) {
			extraDebt.push(`quality-gate: scope \"${s}\" matches no real path in the repo — check the spelling/structure before signing`);
			notes.push(`scope-missing:${s.slice(0, 30)}`);
		}
	}
	for (const c of draft.criteria) {
		const ph = hasUnsubstitutedPlaceholder(c.check);
		if (ph) {
			extraDebt.push(`quality-gate: ${c.id} has an unsubstituted placeholder in its check ("${ph}") — fix the check before signing`);
			notes.push(`placeholder:${c.id}`);
		} else if (!isMachineCheckable(c.check)) {
			extraDebt.push(`quality-gate: ${c.id} has a check that can't be verified automatically ("${c.check.slice(0, 80)}") — requires human verification`);
			notes.push(`manual-check:${c.id}`);
		}
	}
	const similar = findSimilarSpec(cwd, draft);
	if (similar) {
		extraDebt.push(`quality-gate: intent looks similar to old spec "${similar.title}" (${similar.file}, similarity=${similar.score.toFixed(2)}) — confirm it isn't redundant before signing`);
		notes.push(`similar:${similar.file}`);
	}
	return { draft: { ...draft, specDebt: [...draft.specDebt, ...extraDebt] }, notes };
};

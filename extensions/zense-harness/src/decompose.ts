// zense-harness module: decompose-then-compile: planner subtasks, big-intent detection, draft merging (moved verbatim from index.ts — see AGENTS.md map)

import { extractJsonObject, parseSpecDraft, type SpecDraft } from "./spec-draft.ts";

// ----------------------------------------------------------------------------- decompose-then-compile (module scope — exported for unit tests)

/** One planner subtask — id unique within the plan; intent self-contained (that round's
 *  requirements sub-agent sees only this intent — not the original, not other subtasks). */
export interface PlannerSubtask { id: string; title: string; intent: string; scope?: string }

/** Deterministic decomposition thresholds: count both words (whitespace-separated languages)
 *  and characters (Thai/Chinese have no whitespace — word count alone would never trigger
 *  even for huge intents). Heuristic values, tunable later; determinism is what the tests
 *  need. */
export const DECOMPOSE_MAX_WORDS = 100;
export const DECOMPOSE_MAX_CHARS = 800;
export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
export const needsDecompose = (intent: string): boolean =>
	wordCount(intent) > DECOMPOSE_MAX_WORDS || intent.trim().length > DECOMPOSE_MAX_CHARS;

/** Planner-sub-agent prompt — its only job is decomposing a big intent into subtasks (single
 *  JSON); no deep exploration (each subtask's requirements agent has its own time budget)
 *  and no spec drafting. */
export const buildPlannerPrompt = (intent: string, timeoutMs = 300_000): string =>
	`You are the PLANNER sub-agent for a spec-gated SDLC harness. The task below is too large to hand to a single requirements agent (it would exceed its time budget), so your ONLY job is to decompose it into subtasks. You do NOT draft the spec yourself — a separate requirements agent will handle each subtask, seeing ONLY that subtask's "intent" text (never this message, never the other subtasks).

` +
	`Output exactly ONE JSON object — no markdown fences, no commentary:
{"subtasks": [{"id": "t1", "title": "short title", "intent": "self-contained description — repeat any shared context the requirements agent will need", "scope": "optional path prefix this subtask may touch"}]}
` +
	`Rules:
- 2 to 8 subtasks. If the task does not split naturally, split by layer instead (core logic vs wiring vs tests/docs).
- Execution is SEQUENTIAL in your array order — earlier subtasks must never depend on later ones.
- Each "intent" must stand alone; never write "same as above" or reference other subtasks by name.
- ids must be unique, short, stable (t1, t2, …).
- You run under a HARD wall-clock limit of about ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes and you are READ-ONLY — you may skim README/package layout briefly to ground the split, but do not run test suites and do not modify anything.

Task: ${intent}`;

/** Parse + validate planner output: one JSON object with 2–8 subtasks [{id,title,intent,
 *  scope?}], ids unique — throws errors with specific messages (feedback for log/fallback)
 *  rather than returning half a plan. */
export const parsePlannerSubtasks = (text: string): PlannerSubtask[] => {
	const raw = extractJsonObject(text);
	if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error("planner output is not a JSON object (no parseable JSON found — the prompt instructs output ONLY JSON)");
	const o = (raw as Record<string, unknown>).subtasks;
	if (!Array.isArray(o) || o.length < 2 || o.length > 8)
		throw new Error(`planner output: subtasks must be an array of 2–8 items (got ${Array.isArray(o) ? o.length : "non-array"})`);
	const seen = new Set<string>();
	const out: PlannerSubtask[] = [];
	for (let i = 0; i < o.length; i++) {
		const s = o[i] as Record<string, unknown> | null;
		if (!s || typeof s !== "object") throw new Error(`planner output: subtasks[${i}] is not an object`);
		const id = typeof s.id === "string" ? s.id.trim() : "";
		const title = typeof s.title === "string" ? s.title.trim() : "";
		const intent = typeof s.intent === "string" ? s.intent.trim() : "";
		if (!id) throw new Error(`planner output: subtasks[${i}].id is empty or not a string`);
		if (seen.has(id)) throw new Error(`planner output: subtask id "${id}" is duplicated`);
		if (!title) throw new Error(`planner output: subtasks[${i}].title is empty`);
		if (!intent) throw new Error(`planner output: subtasks[${i}].intent is empty — the requirements agent sees only this field, it must not be empty`);
		seen.add(id);
		const scope = typeof s.scope === "string" && s.scope.trim() ? s.scope.trim() : undefined;
		out.push({ id, title, intent, ...(scope ? { scope } : {}) });
	}
	return out;
};

/** Merge all subtask drafts into one SpecDraft: criteria concatenated then re-idded c1..cN
 *  (every sub-agent drafts its own ids from c1 — collisions guaranteed otherwise);
 *  scope/constraints/specDebt deduped; approach bullets get a [subtask] prefix so the signer
 *  can see which subtask each came from. */
export const mergeSubtaskDrafts = (title: string, intent: string, drafts: { subtask: string; draft: SpecDraft }[]): SpecDraft => ({
	title,
	intent,
	approach: drafts.flatMap((d) => d.draft.approach.map((a) => `[${d.subtask}] ${a}`)),
	scope: [...new Set(drafts.flatMap((d) => d.draft.scope))],
	constraints: [...new Set(drafts.flatMap((d) => d.draft.constraints))],
	criteria: drafts.flatMap((d) => d.draft.criteria).map((c, i) => ({ ...c, id: `c${i + 1}` })),
	specDebt: [...new Set(drafts.flatMap((d) => d.draft.specDebt))],
});

/** Pure decompose-then-compile orchestration: runTask is an injected dependency (prod =
 *  launchSubagent, test = fake) so the whole flow is unit-testable without spawning pi.
 *  Any failure throws immediately (never offer half a spec): planner failure/malformation,
 *  subtask failure, unparseable draft, or a clarify request (decompose has no per-subtask
 *  clarify — the caller falls back to a single compile). */
export const compileDecomposed = async (
	intent: string,
	runTask: (role: "planner" | "requirements", task: string) => Promise<{ ok: boolean; output: string }>,
	mkRequirementsPrompt: (subtask: PlannerSubtask) => string,
	plannerTimeoutMs = 300_000,
): Promise<{ subtasks: PlannerSubtask[]; drafts: { subtask: string; draft: SpecDraft }[] }> => {
	const plan = await runTask("planner", buildPlannerPrompt(intent, plannerTimeoutMs));
	if (!plan.ok) throw new Error(`planner sub-agent failed: ${plan.output.split("\n")[0].slice(0, 200)}`);
	const subtasks = parsePlannerSubtasks(plan.output);
	const drafts: { subtask: string; draft: SpecDraft }[] = [];
	for (const st of subtasks) { // sequential only — never parallel (rate limits + shared time budget)
		const r = await runTask("requirements", mkRequirementsPrompt(st));
		if (!r.ok) throw new Error(`requirements sub-agent failed on subtask ${st.id} ("${st.title}"): ${r.output.split("\n")[0].slice(0, 200)}`);
		const parsed = parseSpecDraft(r.output);
		if (parsed.kind === "clarify")
			throw new Error(`subtask ${st.id}: requirements asked to clarify (${parsed.questions.length} question(s)) — decompose has no per-subtask clarify; caller falls back to a single compile`);
		if (parsed.kind === "error")
			throw new Error(`subtask ${st.id}: draft invalid — ${parsed.error}`);
		drafts.push({ subtask: st.id, draft: parsed.draft });
	}
	return { subtasks, drafts };
};

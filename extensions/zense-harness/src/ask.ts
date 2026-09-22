// zense-harness module: zense_ask pure helpers — question normalization, answer rendering, no-UI text (see AGENTS.md map)

import { asClarifyQuestions, type ClarifyQuestion } from "./spec-draft.ts";

// ----------------------------------------------------------------------------- zense_ask helpers (module scope — exported for unit tests)

/** One zense_ask question — identical shape to ClarifyQuestion on purpose: the index.ts
 *  factory passes these straight into askClarifyQuestion (with choices → zensePick ending in
 *  "Other (type your own)"; without → plain input). No picker fork. */
export type AskQuestion = ClarifyQuestion;

/** Interactive cap: 5 questions per call (same ceiling as the requirements clarify loop) —
 *  more is form-filling, not a decision check-in. */
export const ASK_MAX_QUESTIONS = 5;

/** Normalize raw tool params → AskQuestion[]: delegates to the clarify normalizer (trim,
 *  drop empty questions, cap choices at 6 so the picker stays readable), then caps the
 *  question count. undefined when nothing usable remains. */
export const asAskQuestions = (v: unknown): AskQuestion[] | undefined => asClarifyQuestions(v)?.slice(0, ASK_MAX_QUESTIONS);

/** One asked question + the human's answer; undefined = Esc/empty = skipped. */
export interface AskAnswer {
	question: string;
	answer: string | undefined;
}

/** Result text: one numbered "question → answer" per item; skipped questions are named
 *  explicitly so the agent can't silently infer an answer the human never gave. */
export const formatAskAnswers = (answers: AskAnswer[]): string =>
	answers
		.map(
			(a, i) =>
				`${i + 1}. ${a.question}\n   → ${a.answer === undefined ? "(skipped — the human pressed Esc; do NOT infer an answer, continue without it or ask again later)" : a.answer}`,
		)
		.join("\n");

/** No-UI (RPC/print) graceful response — returned as a NORMAL (non-error) result without
 *  awaiting any picker, so a headless session never hangs. Tells the agent to fall back to
 *  plain numbered chat text for this turn. */
export const ASK_NO_UI_TEXT =
	"This session has no interactive UI (RPC/print mode) — the multiple-choice picker cannot open and zense_ask will not block. Ask the human the same questions as plain chat text instead (a short numbered option list is acceptable there) and continue from their reply.";

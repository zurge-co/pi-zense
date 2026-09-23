// zense-harness module: cycle closure: resetCycleState, one-shot context bulletins, freshState (moved verbatim from index.ts — see AGENTS.md map)

import { type State } from "./types.ts";

// ----------------------------------------------------------------------------- cycle closure: bulletin + reset (module scope — exported for unit tests)
/** Two symptoms of sloppy closure: (1) the agent doesn't know the human accepted/discarded/
 *  committed (it only ever sees tool results) → a one-shot contextBulletin rides the next
 *  turn's system prompt (never sendUserMessage — that would trigger a new turn);
 *  (2) a leftover state.spec would make commitSpec continue the version counter for an
 *  entirely new job → resetCycleState clears cycle scope so new work starts at v1. */

/** Cycle reset: clears only round-scoped state — keeps session observability (turnsUsed/
 *  tokensUsed/subagentRuns/trajectoryFlags/escalations) and never touches .zense/spec.json or
 *  the on-disk specs archive (history). Call only on successful closure (accept/discard/
 *  reconcile with an empty index); idempotent. */
export const resetCycleState = (s: State): void => {
	s.spec = undefined;
	s.longRun = undefined; // cycle closure after a COMPLETED tracker (acceptPending applies back + marks done) — mid-longrun phase closure never calls resetCycleState, it keeps the ref
	s.phase = "requirements";
	s.lastEval = undefined;
	s.baselineHead = undefined;
	s.evalOverrideFails = undefined;
	s.specSource = undefined;
	s.specMdPath = undefined;
	s.specJsonPath = undefined;
	s.lastCompileLessons = undefined;
	s.worktreeLeaveNotified = undefined;
};

/** one-shot getter: returns the bulletin and clears the field immediately (caller persists —
 *  otherwise it would ride every system prompt); undefined when absent. */
export const takeContextBulletin = (s: { contextBulletin?: string }): string | undefined => {
	const b = s.contextBulletin;
	if (b !== undefined) s.contextBulletin = undefined;
	return b;
};

/** ≤2-line messages prefixed '[zense]' — pinned to the next turn's system prompt; no heavy markdown */
export const buildAcceptBulletin = (specVersion: number, title: string, amendedCount: number): string =>
	`[zense] spec v${specVersion} "${title}" was accepted + committed on main${amendedCount ? ` (human amended ${amendedCount} file(s) after the grader passed)` : ""} — cycle reset; new work starts at spec v1`;

export const buildReconcileBulletin = (specVersion: number): string =>
	`[zense] spec v${specVersion}'s pendingApply was closed by the human outside the flow (committed, or the change dropped) — cycle reset; new work starts at spec v1`;

export const buildDiscardBulletin = (specVersion: number): string =>
	`[zense] spec v${specVersion}'s change was discarded — reverse patch removed it from main — cycle reset; new work starts at spec v1`;

export const freshState = (): State => ({
	phase: "requirements",
	turnsUsed: 0,
	tokensUsed: 0,
	escalations: [],
	trajectoryFlags: [],
	gateEnabled: true,
	subagentRuns: [],
});

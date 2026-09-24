// zense-harness module: longrun status bar — the compact, always-on tracker/phase/cycle
// indicator in the pi footer (2026-09-24). Pure helper (fs read only): index.ts wires it
// into the updateWidget closure; tests import it from the entry point's re-exports.

import type { LongRunRef, State, Tracker } from "./types.ts";
import { findPhase, loadTracker } from "./longrun.ts";

/** Compact footer line for an active longrun: `zense · <slug> <done>/<total> · <id> <title>
 *  | (between phases) · <cycle phase>`. Refreshed from updateWidget at every longrun
 *  state-mutation point — incl. the AUTO self-advance (autoLoopAdvance → retain-none
 *  context reset → zense_longrun next), which no human drives; during the reset→next gap
 *  activePhase is unset and the line truthfully shows "(between phases)". Returns undefined
 *  when nothing should be shown (no longrun in session, or the tracker is
 *  gone/planning/done/abandoned) so the caller CLEARS the footer entry instead of leaving
 *  a stale line behind. */
export const longrunStatusText = (cwd: string, lr: LongRunRef | undefined, cyclePhase: State["phase"]): string | undefined => {
	if (!lr) return undefined;
	const t: Tracker | null = loadTracker(cwd, lr.slug);
	if (!t || t.status !== "active") return undefined;
	const done = t.phases.filter((p) => p.status === "done").length;
	const phase = lr.activePhase ? findPhase(t, lr.activePhase) : undefined;
	const phaseSeg = phase ? `${phase.id} ${phase.title}` : "(between phases)";
	return `zense · ${t.slug} ${done}/${t.phases.length} · ${phaseSeg} · ${cyclePhase}`;
};

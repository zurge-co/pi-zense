// zense-harness module: longrun v2 — the autonomous loop (signed ONCE via the tracker, no
// per-phase human gate): eval PASS auto-checkpoints and advances, eval FAIL auto-fixes
// bounded by AUTO_FIX_MAX_ROUNDS, and the context between phases is hard-reset by a
// DETERMINISTIC compaction override (capsule as the whole summary, retain-none cut) — never
// an LLM auto-summary lugging pi's default ~20k-token tail (that was v1's growing-context
// bug). Pure helpers only; session-compact/session wiring lives in index.ts.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Tracker, type TrackerPhase } from "./types.ts";
import { buildContextCapsule, longrunDir, nextPendingPhase } from "./longrun.ts";

/** Max consecutive eval FAILs the auto loop fixes on its own before escalating need-decision
 *  (bound discipline mirrors evalOverrideFails' deadlock guard — an autonomous loop without
 *  a bound is a token furnace). */
export const AUTO_FIX_MAX_ROUNDS = 2;

/** Auto gating is explicit: only a tracker SIGNED as autonomous runs without human gates —
 *  undefined/false keeps the v1 manual close/fail semantics forever. */
export const autoLoopEnabled = (t: Tracker): boolean => t.auto === true;

export const digestPath = (cwd: string, slug: string): string => join(longrunDir(cwd, slug), "digest.md");

/** FAIL round inside the auto loop: pointed re-drive against exactly the failed criteria.
 *  The agent gets this appended to the FAIL result — no human until rounds run out. */
export const buildAutoFixPrompt = (phase: TrackerPhase, failed: { id: string; text: string }[], roundsLeft: number): string =>
	[
		`auto-fix (${roundsLeft} round(s) left before the human is called in) — phase ${phase.id} "${phase.title}" failed these signed criteria:`,
		...failed.map((f) => `  ${f.id}: ${f.text}`),
		`fix ONLY what those require — stay inside scope (${phase.scope.join(", ")}), don't restructure, don't add criteria — then call zense_eval again`,
	].join("\n");

/** Appended to the auto-advance result: after the retain-none cut this kickoff is the ONLY
 *  instruction the fresh context carries — it must be fully self-sufficient. */
export const buildNextPhaseKickoff = (_cwd: string, t: Tracker, nextPhase: TrackerPhase): string =>
	[
		`AUTO-CONTINUE longrun "${t.slug}": the previous phase was checkpointed and this context was hard-reset to the capsule (retain-none — nothing of the prior phase remains).`,
		`call zense_longrun next now to activate phase ${nextPhase.id} "${nextPhase.title}" — it re-reads the tracker from disk and emits the signed phase spec; never reconstruct state from memory`,
	].join("\n");

/** The capsule rendered AS the compaction summary (deterministic — the harness supplies this
 *  to pi's session_before_compact instead of letting an LLM summarize the old context). */
export const buildCompactionCapsule = (cwd: string, t: Tracker): string => {
	const next = nextPendingPhase(t);
	if (!next)
		return `[zense longrun] ${t.slug} — every phase is done; the whole set awaits the single final human review (staged in main) · see digest.md`;
	return buildContextCapsule(cwd, t, next, { label: "Next phase" });
};

/** Minimal slice of pi's CompactionPreparation (structural — the handler passes the real one) */
export interface CompactionPreparationLike {
	firstKeptEntryId: string;
	tokensBefore: number;
}

/** The retain-none cut for a phase transition: NOTHING of the prior phase survives —
 *  markerId (a fresh entry appended right before ctx.compact) when available, else the very
 *  last entry in the branch (the advance tool result — tiny); only when neither exists do we
 *  degrade to pi's default cut (never silently, the caller flags it). */
export const retainNoneCut = (preparation: CompactionPreparationLike, markerId: string | undefined, lastEntryId?: string): string =>
	markerId ?? lastEntryId ?? preparation.firstKeptEntryId;

// ----- digest.md — the ONE human review artifact at the end of the set: per phase the
//       intent/goal, the signed criteria + their verdicts, and the files changed + why

export const renderDigestMd = (t: Tracker, readPhaseSummary: (p: TrackerPhase) => string): string => {
	const lines = [
		`# ${t.title} — longrun digest (the single review)`,
		"",
		`tracker v${t.version} \`${t.slug}\` · ${t.phases.filter((p) => p.status === "done").length}/${t.phases.length} phases done · branch ${t.worktreeBranch}`,
		`generated ${new Date().toISOString()} — every phase ran under the ONE tracker signature; criteria verdicts come from the passing zense_eval of each phase`,
		"",
	];
	for (const p of t.phases) {
		const icon = p.status === "done" ? "✅" : p.status === "active" ? "▶️" : "⏳";
		lines.push(`## ${icon} ${p.id} — ${p.title}`, "", `**Intent/goal:** ${p.intent || "(none)"}`, "");
		if (p.criteria.length) {
			lines.push("**Signed criteria — verdict:**", "");
			for (const c of p.criteria) {
				const v = p.criteriaVerdicts?.[c.id] ?? (p.status === "done" ? "PASS" : "—");
				lines.push(`- ${v === "PASS" ? "✓" : v === "FAIL" ? "✗" : "·"} ${c.id} (${v}) — ${c.text}`);
			}
			lines.push("");
		}
		if (p.filesChanged?.length) {
			lines.push("**Files changed:**", "");
			for (const f of p.filesChanged) lines.push(`- ${f}`);
			lines.push("");
		}
		const summary = p.status === "done" ? readPhaseSummary(p) : "";
		if (summary) lines.push(`**Why / what was done:** ${summary}`, "");
		if (p.checkpoint) lines.push(`checkpoint: \`${p.checkpoint.slice(0, 12)}\``, "");
	}
	return lines.join("\n");
};

/** Write .zense/long-running/<slug>/digest.md from the tracker (phases/*.md supply the
 *  rationale text — first non-heading line, same convention as the capsule). Returns the path. */
export const buildLongrunDigest = (cwd: string, t: Tracker): string => {
	const readSummary = (p: TrackerPhase): string => {
		if (!p.summaryPath) return "";
		try {
			const full = join(longrunDir(cwd, t.slug), p.summaryPath);
			if (!existsSync(full)) return "";
			return readFileSync(full, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("## Files")) ?? "";
		} catch {
			return "";
		}
	};
	const p = digestPath(cwd, t.slug);
	writeFileSync(p, renderDigestMd(t, readSummary));
	return p;
};

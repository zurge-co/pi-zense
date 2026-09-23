// zense-harness module: core types (Criterion/Spec/State/SubagentRun/Worktree/PendingApply) + zenseDir (moved verbatim from index.ts — see AGENTS.md map)

import { join } from "node:path";
import { type ProbeResult } from "./evidence.ts";

// ----------------------------------------------------------------------------- types

export interface Criterion {
	id: string; text: string; check: string; verified?: boolean;
	origin?: "tracker" | "compiled"; // longrun: criteria seeded by the signed tracker (may never be dropped) vs ones the agent added at phase compile
}
export interface Spec {
	version: number;
	title: string;
	intent: string;
	approach?: string[];       // shown in the sign dialog; optional — older persisted specs lack this field
	scope: string[];           // path globs the agent may touch
	constraints: string[];
	criteria: Criterion[];
	specDebt: string[];        // unverifiable items → forced human review
	approved: boolean;
	approvedAt?: number;
	approvedBy?: string;         // provenance when NOT signed via the dialog (e.g. "tracker:<slug>@v<N>" — tracker signature confers approval)
	changesFrom?: string[];    // diff vs previous version (commitSpec computes at v>=2 — never re-present an identical spec silently)
}
export interface State {
	phase: "requirements" | "design" | "implementation" | "eval" | "review" | "maintenance";
	spec?: Spec;
	turnsUsed: number;
	tokensUsed: number;
	escalations: { kind: string; detail: string; at: number }[];
	trajectoryFlags: string[];
	gateEnabled: boolean;
	subagentRuns: SubagentRun[];
	lastCompileLessons?: number;    // memory lessons fed into the latest compile_spec
	specSource?: "set" | "compile"; // whether current spec came from the agent (set) or sub-agent (compile) — telemetry
	lastEval?: { verdict: string; perCriteria: Record<string, string>; failedIds: string[]; probes: ProbeResult[]; at: number; specVersion?: number; head?: string }; // latest zense_eval evidence feeds the reviewer (specVersion+head pin it to the current round so stale evidence can't leak)
	baselineHead?: string;      // main repo HEAD at spec approval — scopes git evidence (log/diff) to this round only
	evalOverrideFails?: { specVersion: number; ids: string[]; count: number }; // anti-loop: same override-only FAIL ids on the same spec version → escalate DEADLOCK instead of looping "go fix it"
	specMdPath?: string;            // archive spec .md of the current version (zense_eval appends results here)
	specJsonPath?: string;          // archive spec .json of the current version
	worktree?: Worktree | null;     // active session worktree (null = work directly in main)
	longRun?: LongRunRef;           // active long-running requirement (cleared on cycle closure / tracker done)
	worktreeLeaveNotified?: boolean; // dedupe: notify "unmerged worktree" once per creation
	pendingApply?: PendingApply;    // change staged into main after eval PASS, awaiting human commit (ADR-003)
	contextBulletin?: string;      // one-shot cycle-closure message pinned to the next turn's system prompt (consumed then cleared) — so the agent knows the human accepted/discarded/committed
}
export interface SubagentRun {
	role: string;
	ok: boolean;
	summary: string;
	at: number;
	startedAt?: number;
	logPath?: string;            // .zense/subagents/<stamp>-<role>.log — written live during the run
	model?: string;              // model the sub-agent actually ran ('provider/id' from JSONL events) — compared with .zense/models.json to catch silent pi fallbacks
	status?: "running" | "done" | "failed";
	retried?: boolean;           // provider-missing heal: this run was retried once with '-e <provider ext>'
	autoIncluded?: boolean;      // provider-missing heal: retry succeeded → persist path merged into the role's include list
}
/** Active per-session worktree: every main-agent tool call is redirected here
 *  (by mutating event.input); on eval PASS the work is applied back to main as
 *  staged changes (no commit — ADR-003). Prevents two sessions stomping each other. */
export interface Worktree {
	root: string;               // absolute path of the worktree (nested under <repo>/.zense/worktree/)
	branch: string;             // zense/impl/v<N>-<stamp>
	dir: string;                // === root (kept duplicated for semantic clarity at worktree remove)
	baseline?: string;          // main HEAD before branch creation — the git-evidence baseline for this round
}
/** Change applyWorktreeBack staged in main (not yet committed) — persisted across sessions
 *  so session start can reconcile (still staged / committed / discarded outside the flow). */
export interface PendingApply {
	specVersion: number;
	branch: string;             // branch the apply came from (traceability — deleted after apply)
	paths: string[];            // repo-relative paths staged at apply (undo hint + status summary)
	appliedAt: number;
	preApplyHead?: string;      // main HEAD before apply (squash doesn't move HEAD — reconcile uses it to detect outside commits)
}

/** One phase of a long-running requirement. status has no "review" granularity on purpose:
 *  a phase stays "active" from activation through eval/review until zense_longrun close
 *  (accept → done+checkpoint, fail → back to pending) — mid-flight review state lives in
 *  the cycle State, not the tracker. */
export interface TrackerPhase {
	id: string;                  // "p1", "pre", … — unique within the tracker
	title: string;
	intent: string;
	scope: string[];
	constraints: string[];
	criteria: Criterion[];       // seed criteria — carried verbatim (same ids) into the compiled phase spec
	status: "pending" | "active" | "done" | "failed";
	baseline?: string;           // longrun-branch HEAD at phase activation — per-phase git-evidence baseline + fail-reset point
	checkpoint?: string;         // commit sha written at phase accept
	specVersion?: number;
	adrs?: number[];
	summaryPath?: string;        // phases/<id>.md closure summary
}
/** The human-signed plan of a long-running requirement — tracker.json is the ONLY source
 *  of truth the harness trusts (ambient-state distrust, ADR-004); tracker.md is its render. */
export interface Tracker {
	version: number;             // bump on every signed amendment (re-plan mid-flight = re-sign)
	slug: string;                // requirement-name — directory + branch key
	title: string;
	intent: string;
	worktreeBranch: string;      // zense/longrun/<slug> — ONE worktree for the whole set (ADR-004)
	status: "planning" | "active" | "done" | "abandoned";
	phases: TrackerPhase[];
	approvedAt?: number;
	updatedAt: number;
}
export interface LongRunRef {
	slug: string;
	trackerVersion: number;
	activePhase?: string;
	awaitingFinalApply?: boolean; // all phases checkpointed, final applyWorktreeBack refused (dirty main) — close retries the apply instead of re-checkpointing
}

export const zenseDir = (cwd: string) => join(cwd, ".zense");

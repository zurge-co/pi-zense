// zense-harness module: core types (Criterion/Spec/State/SubagentRun/Worktree/PendingApply) + zenseDir (moved verbatim from index.ts — see AGENTS.md map)

import { join } from "node:path";
import { type ProbeResult } from "./evidence.ts";

// ----------------------------------------------------------------------------- types

export interface Criterion { id: string; text: string; check: string; verified?: boolean }
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

export const zenseDir = (cwd: string) => join(cwd, ".zense");

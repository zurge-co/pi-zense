// zense-harness module: long-running mode — multi-phase requirements signed ONCE via a
// tracker, run phase-by-phase in ONE shared worktree, merged into main only when the whole
// set completes (ADR-004). Pure helpers only; wiring (zense_longrun tool, /zense longrun)
// lives in index.ts.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zenseDir, type Criterion, type Tracker, type TrackerPhase } from "./types.ts";
import { gitOk } from "./worktree.ts";
import { gitAddButZense, NOT_ZENSE } from "./pending-apply.ts";

// ----- paths / identity

export const longrunningRoot = (cwd: string): string => join(zenseDir(cwd), "long-running");
export const longrunDir = (cwd: string, slug: string): string => join(longrunningRoot(cwd), slug);
export const trackerPath = (cwd: string, slug: string): string => join(longrunDir(cwd, slug), "tracker.json");
export const longrunBranch = (slug: string): string => `zense/longrun/${slug}`;

/** requirement-name slug — same unicode-aware slugger as commitSpec's archive files */
export const slugifyTitle = (title: string): string =>
	title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "untitled";

// ----- tracker persistence (atomic — tracker.json must survive a crash mid-write: resume
//       reads it as the ONLY source of truth, ADR-004 ambient-state distrust)

export const saveTracker = (cwd: string, tracker: Tracker): void => {
	const dir = longrunDir(cwd, tracker.slug);
	mkdirSync(join(dir, "phases"), { recursive: true });
	tracker.updatedAt = Date.now();
	const tmp = join(dir, `tracker.json.tmp-${process.pid}`);
	writeFileSync(tmp, JSON.stringify(tracker, null, 2));
	renameSync(tmp, trackerPath(cwd, tracker.slug));
	writeFileSync(join(dir, "tracker.md"), renderTrackerMd(tracker)); // human view — always re-rendered from the json
};

export const loadTracker = (cwd: string, slug: string): Tracker | null => {
	try {
		const p = trackerPath(cwd, slug);
		if (!existsSync(p)) return null;
		const t = JSON.parse(readFileSync(p, "utf8")) as Tracker;
		if (!t || typeof t.slug !== "string" || !Array.isArray(t.phases)) return null;
		return t;
	} catch {
		return null;
	}
};

/** Signed-tracker sanity — dupes/missing checks would silently break per-phase compiles */
export const validateTracker = (tracker: Tracker): string[] => {
	const errors: string[] = [];
	if (!tracker.slug.trim()) errors.push("slug is empty");
	if (!tracker.phases.length) errors.push("tracker has no phases");
	const seen = new Set<string>();
	for (const p of tracker.phases) {
		if (!p.id.trim()) errors.push("a phase has an empty id");
		if (seen.has(p.id)) errors.push(`duplicate phase id: ${p.id}`);
		seen.add(p.id);
		if (!p.title.trim()) errors.push(`phase ${p.id}: empty title`);
		if (!p.scope.length) errors.push(`phase ${p.id}: empty scope`);
		for (const c of p.criteria)
			if (!c.id.trim() || !c.check.trim()) errors.push(`phase ${p.id}: criterion "${c.id || "?"}" has empty id/check`);
	}
	return errors;
};

export const renderTrackerMd = (t: Tracker): string => {
	const icon = (s: TrackerPhase["status"]) => (s === "done" ? "✅" : s === "active" ? "▶️" : s === "failed" ? "❌" : "⏳");
	const lines = [
		`# ${t.title} — long-running tracker v${t.version}`,
		"",
		`status: ${t.status}${t.approvedAt ? ` · signed ${new Date(t.approvedAt).toISOString()}` : " (unsigned)"}`,
		`branch: ${t.worktreeBranch} (one worktree for the whole set — merged into main only when every phase is done, ADR-004)`,
		"",
		"## Requirement",
		"",
		t.intent || "(see specs.md)",
		"",
		"## Phases",
		"",
	];
	for (const p of t.phases) {
		lines.push(`### ${icon(p.status)} ${p.id} — ${p.title}`);
		if (p.intent) lines.push("", p.intent);
		lines.push("", `- scope: ${p.scope.join(", ")}`);
		if (p.constraints.length) lines.push(`- constraints: ${p.constraints.join("; ")}`);
		if (p.criteria.length) lines.push(`- criteria: ${p.criteria.map((c) => c.id).join(", ")}`);
		if (p.checkpoint) lines.push(`- checkpoint: ${p.checkpoint.slice(0, 12)}`);
		if (p.summaryPath) lines.push(`- summary: ${p.summaryPath}`);
		lines.push("");
	}
	return lines.join("\n");
};

// ----- phase selection

export const findPhase = (t: Tracker, id: string): TrackerPhase | undefined => t.phases.find((p) => p.id === id);
export const nextPendingPhase = (t: Tracker): TrackerPhase | undefined => t.phases.find((p) => p.status === "pending");
export const allPhasesDone = (t: Tracker): boolean => t.phases.length > 0 && t.phases.every((p) => p.status === "done");

/** Phase-spec criteria = tracker seeds (origin "tracker", IDs immutable — they carry the
 *  human signature) + agent extras (origin "compiled"). Guard returns the IDs of seed
 *  criteria a compiled spec would have dropped — must be empty before approval. */
export const mergePhaseCriteria = (seed: Criterion[], extra: Criterion[] = []): Criterion[] => [
	...seed.map((c) => ({ ...c, origin: "tracker" as const })),
	...extra.filter((c) => !seed.some((s) => s.id === c.id)).map((c) => ({ ...c, origin: "compiled" as const })),
];
export const droppedSeedIds = (seed: Criterion[], compiled: Criterion[]): string[] =>
	seed.filter((s) => !compiled.some((c) => c.id === s.id)).map((s) => s.id);

// ----- planner (plan without an explicit phase list): the requirements doc goes in, an
//       ordered phase list with seed criteria comes out as JSON — the human signs the
//       RESULT, so a model-drafted plan never bypasses review

export interface LongrunPlanPhase {
	id?: string;
	title: string;
	intent: string;
	scope: string[];
	constraints?: string[];
	criteria: Criterion[];
}

export const buildLongrunPlannerPrompt = (title: string, intent: string, specsMd: string): string =>
	[
		`You are planning the execution of ONE requirement as an ordered sequence of phases (a "longrun tracker").`,
		`Requirement: ${title}`,
		intent ? `Intent: ${intent}` : "",
		specsMd ? `Requirement doc:\n${specsMd}` : "",
		"",
		"Return ONLY a JSON object (no fences, no commentary):",
		`{"phases":[{"id":"p1","title":"...","intent":"...","scope":["path/prefix",...],"constraints":["..."],"criteria":[{"id":"P1C1","text":"observable outcome","check":"a single shell command that exits 0 when done"}]}]}`,
		"",
		"Rules:",
		"- 2–6 phases, ordered by dependency — each phase must be independently reviewable (a clean diff, a clear done-state)",
		"- pre-phase (id \"pre\") only when exploration/scaffolding genuinely precedes implementation",
		"- every criterion's check must be a REAL runnable command (verify it would execute; no placeholders like <path>)",
		"- criteria are the phase's signature — few but decisive (1–4 per phase)",
		"- scope entries are path prefixes the implementing agent may touch; keep them tight",
	].join("\n");

/** Parse a planner sub-agent's output into phase drafts. Accepts bare JSON or fenced JSON
 *  (models add ```json despite instructions — strip, don't punish). Structural errors get
 *  actionable messages: the caller retries with an explicit phases list. */
export const parseLongrunPlan = (output: string): { ok: true; phases: LongrunPlanPhase[] } | { ok: false; error: string } => {
	const stripped = output.replace(/```(?:json)?\s*\n?/g, "").replace(/```/g, "");
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start === -1 || end <= start) return { ok: false, error: "no JSON object found in planner output" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped.slice(start, end + 1));
	} catch (e) {
		return { ok: false, error: `JSON.parse failed: ${(e as Error).message.slice(0, 120)}` };
	}
	const phases = (parsed as { phases?: unknown }).phases;
	if (!Array.isArray(phases) || !phases.length) return { ok: false, error: '"phases" must be a non-empty array' };
	for (const [i, ph] of phases.entries()) {
		const p = ph as Partial<LongrunPlanPhase>;
		if (typeof p?.title !== "string" || !p.title.trim()) return { ok: false, error: `phase #${i + 1}: missing title` };
		if (typeof p?.intent !== "string" || !p.intent.trim()) return { ok: false, error: `phase #${i + 1}: missing intent` };
		if (!Array.isArray(p.scope) || !p.scope.length || !p.scope.every((s) => typeof s === "string"))
			return { ok: false, error: `phase "${p.title}": scope must be a non-empty string array` };
		if (!Array.isArray(p.criteria)) return { ok: false, error: `phase "${p.title}": criteria must be an array` };
		for (const c of p.criteria as Partial<Criterion>[])
			if (typeof c?.id !== "string" || typeof c?.text !== "string" || typeof c?.check !== "string" || !c.check.trim())
				return { ok: false, error: `phase "${p.title}": every criterion needs id/text/check` };
	}
	return { ok: true, phases: phases as LongrunPlanPhase[] };
};

/** Build the phase's spec fields from the tracker entry (used by zense_longrun next →
 *  commitSpec). Seed criteria carry the tracker's signature — see mergePhaseCriteria. */
export const compilePhaseSpec = (
	t: Tracker,
	phase: TrackerPhase,
	extraCriteria: Criterion[] = [],
): { title: string; intent: string; scope: string[]; constraints: string[]; criteria: Criterion[]; specDebt: string[]; provenance: string } => ({
	title: `longrun(${t.slug}) ${phase.id} – ${phase.title}`,
	intent: `${phase.intent}\n\n[longrun "${t.slug}" tracker v${t.version} — approved by the tracker's signature; review gate at phase end; worktree ${t.worktreeBranch}]`,
	scope: phase.scope,
	constraints: phase.constraints,
	criteria: mergePhaseCriteria(phase.criteria, extraCriteria),
	specDebt: [],
	provenance: `tracker:${t.slug}@v${t.version}`,
});

// ----- context capsule: the ONLY thing carried into a fresh phase after a compact/new
//       session — done phases collapse to one line each, the active phase is spelled out

export const buildContextCapsule = (cwd: string, t: Tracker, active: TrackerPhase, opts?: { label?: string }): string => {
	const label = opts?.label ?? "Active phase";
	const summaryOf = (p: TrackerPhase): string => {
		if (!p.summaryPath) return p.checkpoint ? `checkpoint ${p.checkpoint.slice(0, 12)}` : "(no summary)";
		try {
			const first = readFileSync(join(longrunDir(cwd, t.slug), p.summaryPath), "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
			return first ?? "(no summary)";
		} catch {
			return "(summary unreadable)";
		}
	};
	const lines = [
		`[zense longrun] ${t.slug} — "${t.title}" (tracker v${t.version}, signed)`,
		`Requirement: ${(t.intent || "").split("\n")[0].slice(0, 300)}`,
		`Progress: ${t.phases.map((p) => `${p.id}${p.status === "done" ? "✓" : p.status === "active" ? "▶" : "·"}`).join(" ")}`,
	];
	const done = t.phases.filter((p) => p.status === "done");
	if (done.length) {
		lines.push("Done phases:");
		for (const p of done) lines.push(`  ${p.id} "${p.title}" — ${summaryOf(p)}`);
	}
	const adrs = t.phases.flatMap((p) => p.adrs ?? []);
	lines.push(
		`${label} ${active.id} "${active.title}": ${active.intent}`,
		`  scope: ${active.scope.join(", ")}${active.constraints.length ? ` · constraints: ${active.constraints.join("; ")}` : ""}`,
		`  seed criteria (signed — carry ALL into the phase spec): ${active.criteria.map((c) => c.id).join(", ") || "(none)"}`,
		...(adrs.length ? [`  ADRs so far: ${adrs.join(", ")} (re-read .zense/adr/ before irreversible choices)`] : []),
		`Worktree: .zense/worktree/longrun-${t.slug} (branch ${t.worktreeBranch}) — every write lands there; main stays untouched until the whole set passes review.`,
	);
	return lines.join("\n");
}

// ----- git semantics (ADR-004): checkpoint per accepted phase, fail = reset --hard, and
//       ambient-state distrust — every transition starts with a reconcile

/** Stage everything (except .zense) in the worktree and commit as the phase checkpoint.
 *  nothing-to-commit is a VALID close (the phase may have produced only .zense artifacts). */
export const checkpointCommit = (wtRoot: string, message: string): { ok: boolean; sha?: string; msg: string } => {
	const add = gitAddButZense(wtRoot);
	if (!add.ok) return { ok: false, msg: `git add failed: ${add.err}` };
	if (gitOk(["diff", "--cached", "--quiet"], wtRoot).ok) {
		const h = gitOk(["rev-parse", "HEAD"], wtRoot);
		return { ok: true, ...(h.ok ? { sha: h.out.trim() } : {}), msg: "nothing to commit (checkpoint = phase baseline)" };
	}
	const cm = gitOk(["commit", "-m", message, "--no-verify"], wtRoot);
	if (!cm.ok) return { ok: false, msg: cm.err };
	const h = gitOk(["rev-parse", "HEAD"], wtRoot);
	return h.ok ? { ok: true, sha: h.out.trim(), msg: h.out.trim() } : { ok: false, msg: "committed but rev-parse failed" };
};

/** Phase-discard semantics — always reset --hard to the phase baseline, never a reverse
 *  patch (DENY rule, ADR-004): the checkpoint chain makes the reset exact. */
export const resetToCheckpoint = (wtRoot: string, sha: string): { ok: boolean; msg: string } => {
	const r = gitOk(["reset", "--hard", sha], wtRoot);
	if (!r.ok) return { ok: false, msg: r.err };
	gitOk(["clean", "-fd", "--", ".", NOT_ZENSE], wtRoot); // untracked phase leftovers — .zense excluded per policy
	return { ok: true, msg: `reset --hard ${sha.slice(0, 12)}` };
};

export interface ReconcileResult {
	/** ok = ready to run; missing = worktree dir gone (caller reattaches); the rest need
	 *  either auto-heal (healable) or a human pick via zense_ask/dialog */
	status: "ok" | "missing-worktree" | "wrong-branch" | "detached" | "checkpoint-diverged";
	actualBranch?: string;
	dirty: string[];          // uncommitted changes outside .zense (porcelain lines)
	commitsSinceCheckpoint: number;
	healable: boolean;        // auto git switch is safe (nothing uncommitted to lose)
}

/** The ambient-state-distrust precondition: never ask "what branch are we on?" — assert the
 *  tracker.json expectation against reality. Run before every next/resume/close. */
export const reconcileLongrunWorktree = (wtRoot: string | undefined, expectedBranch: string, lastCheckpoint?: string): ReconcileResult => {
	if (!wtRoot || !existsSync(wtRoot))
		return { status: "missing-worktree", dirty: [], commitsSinceCheckpoint: 0, healable: true };
	const br = gitOk(["rev-parse", "--abbrev-ref", "HEAD"], wtRoot);
	const actual = br.ok ? br.out.trim() : "";
	const dirty = gitOk(["status", "--porcelain", "--", ".", NOT_ZENSE], wtRoot);
	const dirtyLines = dirty.ok ? dirty.out.split("\n").map((s) => s.trimEnd()).filter(Boolean) : [];
	const healable = dirtyLines.length === 0;
	let commits = 0;
	if (lastCheckpoint) {
		// the recorded checkpoint must be an ancestor of HEAD — if the branch was rewound/
		// rebased behind our back, the checkpoint chain is broken → human, never auto-heal
		const anc = gitOk(["merge-base", "--is-ancestor", lastCheckpoint, "HEAD"], wtRoot);
		if (!anc.ok)
			return { status: "checkpoint-diverged", ...(actual ? { actualBranch: actual } : {}), dirty: dirtyLines, commitsSinceCheckpoint: 0, healable: false };
		commits = Number(gitOk(["rev-list", "--count", `${lastCheckpoint}..HEAD`], wtRoot).out.trim() || "0");
	}
	if (actual === "HEAD") return { status: "detached", dirty: dirtyLines, commitsSinceCheckpoint: commits, healable };
	if (actual !== expectedBranch)
		return { status: "wrong-branch", ...(actual ? { actualBranch: actual } : {}), dirty: dirtyLines, commitsSinceCheckpoint: commits, healable };
	return { status: "ok", actualBranch: actual, dirty: dirtyLines, commitsSinceCheckpoint: commits, healable };
};

/** Auto-heal half of reconcile: switch back to the expected branch (only when clean — the
 *  dirty case always goes through a human pick first). */
export const healToBranch = (wtRoot: string, expectedBranch: string): { ok: boolean; msg: string } => {
	const sw = gitOk(["switch", expectedBranch], wtRoot);
	return sw.ok ? { ok: true, msg: `switched to ${expectedBranch}` } : { ok: false, msg: sw.err };
};

/** Abandon teardown: remove the longrun worktree + branch for good. main needs no undo —
 *  a longrun NEVER staged anything into it (that's the whole ADR-004 upside: abandoning a
 *  half-done requirement set is a single rm). The tracker itself is kept as status
 *  "abandoned" by the caller (audit trail). */
export const abandonLongrunWorktree = (cwd: string, t: Tracker): { ok: boolean; msg: string } => {
	const wtRoot = join(zenseDir(cwd), "worktree", `longrun-${t.slug}`);
	if (existsSync(wtRoot) && !gitOk(["worktree", "remove", wtRoot, "--force"], cwd).ok)
		return { ok: false, msg: `git worktree remove failed for ${wtRoot} — remove manually` };
	gitOk(["branch", "-D", t.worktreeBranch], cwd); // already gone when the worktree was pruned mid-flow — best-effort
	return { ok: true, msg: `worktree + branch ${t.worktreeBranch} removed` };
};

// ----- closure summary (phases/<id>.md — the capsule reads its first line later)

export const writePhaseSummary = (cwd: string, t: Tracker, phase: TrackerPhase, summary: string, filesChanged: string[]): string => {
	const rel = `phases/${phase.id}.md`;
	const body = [
		`# ${phase.id} — ${phase.title} (closed ${new Date().toISOString()})`,
		"",
		summary.trim() || "(no summary provided)",
		"",
		...(filesChanged.length ? ["## Files changed", "", ...filesChanged.map((f) => `- ${f}`)] : []),
		"",
	].join("\n");
	writeFileSync(join(longrunDir(cwd, t.slug), rel), body);
	return rel;
};

/** Append one line to specs.md change-log — the requirement doc accumulates what actually
 *  happened, so a fresh session can read ONE file for the whole story. */
export const appendSpecsLog = (cwd: string, slug: string, line: string): void => {
	try {
		appendFileSync(join(longrunDir(cwd, slug), "specs.md"), `\n- ${new Date().toISOString()} ${line}\n`);
	} catch {
		/* best-effort */
	}
};

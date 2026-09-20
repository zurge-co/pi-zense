// zense-harness module: ADR-003 apply-back: commit message, snapshot, apply worktree→main staged, discard/accept (moved verbatim from index.ts — see AGENTS.md map)

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zenseDir, type Spec, type Worktree } from "./types.ts";
import { gitOk } from "./worktree.ts";

/** single-line commit subject (≤72 chars) — built from the human-signed spec title */
export const sanitizeSubject = (title: string): string => {
	const oneLine = (title || "").replace(/\s+/g, " ").trim();
	if (!oneLine) return "zense impl";
	return oneLine.length <= 72 ? oneLine : oneLine.slice(0, 71).trimEnd() + "…";
};

/** Commit message for the squashed impl commit — deterministic from the spec (its signed title
 *  describes the work for real) + squashed interim-commit subjects kept in the body. */
export const composeCommitMessage = (spec: Spec, interimSubjects: string[]): string => {
	const subject = sanitizeSubject(spec.title || `zense impl v${spec.version}`);
	const body: string[] = [];
	if (spec.intent?.trim()) body.push(spec.intent.trim());
	if (interimSubjects.length) body.push(`Squashed interim commits:\n${interimSubjects.map((s) => `- ${s}`).join("\n")}`);
	body.push(`zense spec v${spec.version} — eval PASS`);
	return `${subject}\n\n${body.join("\n\n")}\n`;
};

// ----- pending apply (ADR-003: eval PASS → apply into main as staged changes; the human commits after review)

export const PENDING_PATCH = "pending-apply.patch"; // reverse patch of the applied change — used by discardPendingApply
export const PENDING_MSG = "pending-apply.msg";     // ready-made commit message (from the squashed commit) — human may `commit -F`
export const NOT_ZENSE = ":!.zense";                // pathspec: everything except .zense (harness state never enters apply/undo)

/** Is this a git working tree? Every git-dependent feature (pre-spec dirty guard, worktree,
 *  apply-back) must degrade silently when false (non-git projects shouldn't see these guards). */
export const isGitRepo = (cwd: string): boolean => gitOk(["rev-parse", "--is-inside-work-tree"], cwd).ok;

/** Uncommitted changes outside .zense (porcelain lines like " M src/x.ts", "?? new.ts");
 *  empty = clean or not a git repo. Used as the pre-spec guard: a new spec's worktree branches
 *  from the HEAD at approval time, so uncommitted work would neither follow into the worktree
 *  nor be covered by the baseline — even though the agent sees the files in main. */
export const uncommittedChanges = (cwd: string): string[] => {
	const r = gitOk(["status", "--porcelain", "--", ".", NOT_ZENSE], cwd);
	if (!r.ok) return [];
	return r.out.split("\n").map((s) => s.trimEnd()).filter(Boolean);
};

/** Commit message for the snapshot auto-commit — never fixed text: built from the actual file
 *  list (subject ≤72 chars via sanitizeSubject; full list always in the body). */
export const composeSnapshotMessage = (dirty: string[]): string => {
	const names = dirty.map((l) => l.slice(3).replace(/^"|"$/g, "")).filter(Boolean); // porcelain: "XY <path>" (octal-quoted when it has spaces/non-ASCII)
	// drop file names from the subject one by one until it fits 72 chars (don't let sanitizeSubject
	// truncate blindly — the "(+N)" suffix would be lost); body always lists every file
	let subject = "";
	for (let take = Math.min(3, names.length); take >= 0 && !subject; take--) {
		const more = names.length > take ? ` (+${names.length - take})` : "";
		const cand = sanitizeSubject(`chore: snapshot pre-spec${take ? `: ${names.slice(0, take).join(", ")}${more}` : more ? ` (${names.length} files)` : ""}`);
		if (!cand.endsWith("…") || take === 0) subject = cand; // accept truncation only at take=0 (prefix alone too long — near-impossible)
	}
	return `${subject}\n\nFiles snapshotted (uncommitted at pre-spec check):\n${names.map((n) => `- ${n}`).join("\n")}\n`;
};

/** Stage every change except .zense (policy: harness state never enters index/commit).
 *  Do NOT use an exclude pathspec (`git add -A -- . ':!.zense'`): git ≥2.55 fatals
 *  "The following paths are ignored by one of your .gitignore files: .zense" as soon as
 *  traversal hits an ignored dir, exclusion notwithstanding (seen on git 2.55.0) → snapshots
 *  report "git add failed" despite correct policy.
 *  Works in every case: plain add (ignored files skipped, exit 0), then always unstage .zense —
 *  covers projects that don't ignore .zense (add -A would slurp all harness state incl.
 *  .zense/worktree/). reset back to HEAD if it exists (tracked .zense stays staged as before),
 *  otherwise rm --cached (no HEAD yet). Best-effort; not-in-index → no-op. */
export const gitAddButZense = (cwd: string): { ok: boolean; out: string; err: string } => {
	const add = gitOk(["add", "-A", "--", "."], cwd);
	if (!add.ok) return add;
	const head = gitOk(["rev-parse", "--verify", "-q", "HEAD"], cwd);
	if (head.ok) gitOk(["reset", "-q", "--", ".zense"], cwd); // reset <paths> to HEAD — tracked .zense keeps its index state
	else gitOk(["rm", "-r", "--cached", "-q", "--ignore-unmatch", ".zense"], cwd); // no HEAD to reset — index-only removal, worktree untouched
	return add;
};

/** Snapshot-commit pending changes (human chose "commit for me" in the pre-spec dialog).
 *  Mirrors harness behavior: add -A except .zense (via gitAddButZense) + --no-verify;
 *  nothing staged → ok with msg="nothing to commit". */
export const snapshotUncommitted = (cwd: string, message: string): { ok: boolean; msg: string } => {
	const add = gitAddButZense(cwd);
	// without this check, an add failure would surface at commit time as "nothing to commit" — report the real cause
	if (!add.ok) return { ok: false, msg: `git add failed: ${add.err}` };
	if (gitOk(["diff", "--cached", "--quiet"], cwd).ok) return { ok: true, msg: "nothing to commit" };
	const cm = gitOk(["commit", "-m", message, "--no-verify"], cwd);
	if (!cm.ok) return { ok: false, msg: cm.err };
	const h = gitOk(["rev-parse", "--short", "HEAD"], cwd);
	return { ok: true, msg: h.ok ? h.out.trim() : "committed" };
};

export interface ApplyBackResult {
	ok: boolean;
	conflict?: boolean;   // merge --squash clashed — main was rolled back; worktree kept for human resolution
	dirtyMain?: boolean;  // guard: main had uncommitted changes outside .zense → refused before touching the branch (worktree kept)
	msg: string;
	paths: string[];      // repo-relative paths staged in main (empty = no source change at all)
	commitMsg?: string;   // message of the squashed branch commit — offered to the human as a ready-made commit command
}

/** Apply the worktree branch into main as **staged-only** (no commit — ADR-003: the human
 *  reviews in main and makes the final commit, or asks the agent):
 *  0) guard: main dirty outside .zense → refuse (mixed changes make undo hard) — branch
 *     untouched, so retry is always possible
 *  1) squash interim branch commits into one (.zense excluded per policy)
 *  2) git merge --squash — stages everything without creating a commit/merge state
 *  3) store a reverse patch (git diff --cached) at .zense/pending-apply.patch so
 *     discardPendingApply can restore exactly
 *  conflict → non-.zense rolled back to HEAD manually (--squash writes no MERGE_HEAD, so
 *  merge --abort is unavailable) and conflict=true returned with the worktree kept;
 *  success → worktree + branch cleaned up. */
export const applyWorktreeBack = (cwd: string, spec: Spec, wt: Worktree): ApplyBackResult => {
	// 0. guard: main must be clean (except .zense) — refuse before touching the branch
	const dirty = gitOk(["status", "--porcelain", "--", ".", NOT_ZENSE], cwd);
	if (dirty.ok && dirty.out.trim())
		return {
			ok: false,
			dirtyMain: true,
			paths: [],
			msg: `main has uncommitted changes outside .zense/ — not applying (mixed changes make undo hard): commit/stash them first, then re-eval\n${dirty.out.trim().split("\n").slice(0, 10).join("\n")}`,
		};
	// 1. squash: find the branch point and fold interim commits into one (.zense excluded)
	const mb = gitOk(["merge-base", wt.branch, "HEAD"], cwd);
	const base = mb.ok ? mb.out.trim() : "";
	const interimSubjects = base ? gitOk(["log", "--format=%s", `${base}..HEAD`], wt.root).out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
	// stage worktree changes (except .zense) incl. untracked files (git diff --quiet HEAD misses those)
	// via gitAddButZense: exclude-pathspec + git add fails when .zense is ignored (git ≥2.55 — see helper)
	gitAddButZense(wt.root);
	if (!gitOk(["diff", "--cached", "--quiet"], wt.root).ok) {
		gitOk(["commit", "-m", "(interim — squashed at apply-back)", "--no-verify"], wt.root);
	}
	const ahead = base ? Number(gitOk(["rev-list", "--count", `${base}..HEAD`], wt.root).out.trim() || "0") : 0;
	if (base && ahead > 0) {
		gitOk(["reset", "--soft", base], wt.root); // index still holds the union diff of all interim commits
		gitOk(["reset", "-q", "HEAD", "--", ".zense"], wt.root); // policy: .zense never follows into main (best-effort unstage)
		if (!gitOk(["diff", "--cached", "--quiet"], wt.root).ok) {
			gitOk(["commit", "-m", composeCommitMessage(spec, interimSubjects), "--no-verify"], wt.root);
		} else {
			// no source diff left (interim commits touched only .zense) → reset branch to base to avoid an empty squash commit
			gitOk(["reset", "--hard", base], wt.root);
		}
	} else if (!gitOk(["diff", "--cached", "--quiet"], wt.root).ok) {
		// no branch point found → can't squash, but still commit what's staged with a spec-derived message
		gitOk(["commit", "-m", composeCommitMessage(spec, []), "--no-verify"], wt.root);
	}
	// keep the squashed message (before the branch is deleted) so the human can commit with it
	const branchMsg = gitOk(["log", "-1", "--format=%B", wt.branch], cwd);
	const commitMsg = branchMsg.ok && branchMsg.out.trim() ? branchMsg.out.trim() + "\n" : composeCommitMessage(spec, interimSubjects);
	// 2. apply into main as staged-only — never finalize a merge commit
	if (!gitOk(["merge", "--squash", wt.branch], cwd).ok) {
		// --squash writes no MERGE_HEAD → merge --abort is unavailable: roll back non-.zense manually
		// (guard 0 guarantees no uncommitted/untracked change outside .zense pre-merge → nothing human lost)
		gitOk(["reset", "-q", "HEAD", "--", ".", NOT_ZENSE], cwd);
		gitOk(["restore", "--staged", "--worktree", "--source=HEAD", "--", ".", NOT_ZENSE], cwd);
		gitOk(["clean", "-fd", "--", ".", NOT_ZENSE], cwd);
		return { ok: false, conflict: true, paths: [], msg: `apply conflict — main was rolled back; fix manually: cd ${wt.root}, resolve/commit on branch ${wt.branch}, then git merge --squash ${wt.branch} in main` };
	}
	// 3. staged paths + reverse patch for discard (patch may be empty — interim commits touching only .zense)
	const paths = gitOk(["diff", "--cached", "--name-only", "--", ".", NOT_ZENSE], cwd).out.split("\n").map((s) => s.trim()).filter(Boolean);
	const patch = gitOk(["diff", "--cached", "--binary", "--", ".", NOT_ZENSE], cwd);
	mkdirSync(zenseDir(cwd), { recursive: true });
	writeFileSync(join(zenseDir(cwd), PENDING_PATCH), patch.ok ? patch.out : "");
	// 4. cleanup worktree + branch (the full change now lives in main's index)
	gitOk(["worktree", "remove", wt.dir, "--force"], cwd);
	gitOk(["branch", "-D", wt.branch], cwd);
	return { ok: true, paths, commitMsg, msg: `applied ${wt.branch} → main (staged, uncommitted — spec v${spec.version}; human commits after review)` };
};

/** Undo applyWorktreeBack: unstage everything, then reverse-apply the stored patch → main
 *  returns to its exact pre-apply state (reverse only touches patched files — unrelated human
 *  work is safe). Reverse failing means a human edit collided with the patch → fail loudly,
 *  never silently delete human work (caller escalates). On success the patch/msg are removed. */
export const discardPendingApply = (cwd: string): { ok: boolean; msg: string } => {
	const patchPath = join(zenseDir(cwd), PENDING_PATCH);
	if (!existsSync(patchPath))
		return { ok: false, msg: `${patchPath} not found — cannot undo automatically; revert manually: git restore --staged --worktree -- <paths>` };
	gitOk(["reset", "-q", "HEAD", "--", "."], cwd); // unstage everything first — the reverse patch then touches only the working tree
	if (readFileSync(patchPath, "utf8").trim()) {
		const rr = gitOk(["apply", "-R", "--whitespace=nowarn", patchPath], cwd);
		if (!rr.ok)
			return { ok: false, msg: `reverse-apply failed (were the applied files edited afterwards?): ${rr.err}\nNever delete human work silently — inspect yourself with git status / git diff` };
	}
	rmSync(patchPath, { force: true });
	rmSync(join(zenseDir(cwd), PENDING_MSG), { force: true });
	return { ok: true, msg: "discarded — main restored to its pre-apply state (reverse patch succeeded)" };
};

export interface AcceptResult {
	ok: boolean;
	msg: string;
	amendedFiles: string[];      // files the human edited after the grader passed (name-only, evalTree → HEAD^{tree})
	warnings: string[];          // soft-mode anomalies (never refuse — attached to the report)
	committedOnBehalf: boolean;  // harness committed staged leftovers on the human's explicit request
}

/** Accept side of pendingApply (discard's counterpart):
 *  soft verification, never refuses for mere anomalies: clean index = the human committed
 *  themselves; staged leftovers → commit on their behalf only when commitIfStaged=true (and
 *  WITHOUT --no-verify: the human accepted, hooks should run); clean index but HEAD still
 *  preApplyHead → the change likely vanished via out-of-band reset/stash rather than a commit
 *  → attach a warning, still accept (soft mode).
 *  Human delta: diff evalTree (the index tree at apply/grade time — lastEval.head was repinned)
 *  against HEAD^{tree} → files the human edited post-grade become a learned lesson
 *  (.zense excluded per policy). Success removes patch+msg: from here, undo means plain
 *  git revert, not the reverse patch. */
export const acceptPendingApply = (
	cwd: string,
	opts: { evalTree?: string; preApplyHead?: string; commitIfStaged?: boolean } = {},
): AcceptResult => {
	const patchPath = join(zenseDir(cwd), PENDING_PATCH);
	if (!existsSync(patchPath))
		return { ok: false, msg: `no pending apply to accept (${PENDING_PATCH} not found — already accepted/committed, or never applied)`, amendedFiles: [], warnings: [], committedOnBehalf: false };
	const warnings: string[] = [];
	let committedOnBehalf = false;
	if (!gitOk(["diff", "--cached", "--quiet"], cwd).ok) {
		// still staged = human hasn't committed — commit on their behalf only when explicitly asked
		if (!opts.commitIfStaged)
			return {
				ok: false,
				msg: "staged changes are still pending (not yet committed) — either commit yourself with `git commit -F .zense/pending-apply.msg` then accept again, or ask the harness to commit for you (commitIfStaged=true / /zense accept commit)",
				amendedFiles: [],
				warnings,
				committedOnBehalf: false,
			};
		const cr = gitOk(["commit", "-F", join(zenseDir(cwd), PENDING_MSG)], cwd);
		if (!cr.ok)
			return { ok: false, msg: `commit on your behalf failed (hook rejected or missing config?): ${cr.err}\nCheck git status and commit manually`, amendedFiles: [], warnings, committedOnBehalf: false };
		committedOnBehalf = true;
	} else if (opts.preApplyHead && gitOk(["rev-parse", "HEAD"], cwd).out.trim() === opts.preApplyHead) {
		warnings.push(
			`index is empty but HEAD is still ${opts.preApplyHead.slice(0, 12)} (the pre-apply point) — the change likely vanished via out-of-band reset/stash rather than a commit; check git status / git log before trusting the work is in`,
		);
	}
	const amendedFiles: string[] = [];
	if (opts.evalTree) {
		const headTree = gitOk(["rev-parse", "HEAD^{tree}"], cwd);
		if (headTree.ok && headTree.out.trim() && headTree.out.trim() !== opts.evalTree) {
			const d = gitOk(["diff", "--name-only", opts.evalTree, "HEAD^{tree}", "--", ".", NOT_ZENSE], cwd);
			if (d.ok) amendedFiles.push(...d.out.split("\n").map((s) => s.trim()).filter(Boolean));
		}
	}
	rmSync(patchPath, { force: true });
	rmSync(join(zenseDir(cwd), PENDING_MSG), { force: true });
	return { ok: true, msg: "pending apply closed — the change is durable in main (further undo = plain git revert)", amendedFiles, warnings, committedOnBehalf };
};

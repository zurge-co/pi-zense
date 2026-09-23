// zense-harness module: git worktree isolation: path rewrite, command prefixing, worktree create/reuse (moved verbatim from index.ts — see AGENTS.md map)

import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { zenseDir, type Spec, type Worktree } from "./types.ts";

/** single-quote shell-escape for paths with spaces/special chars */
const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Remap an agent-requested path (relative to session cwd = main repo) to the same relative
 * location under the worktree root. Paths outside the repo (e.g. pi docs in node_modules)
 * and anything under .zense/ (harness state lives in main) are returned unchanged.
 */
export const rewritePathForWorktree = (cwd: string, wtRoot: string, path: string): string => {
	if (!path) return path;
	const abs = resolve(cwd, path);
	const rel = relative(cwd, abs).split(sep).join("/");
	if (!rel || rel.startsWith("..")) return path;           // outside repo → no redirect
	if (rel === ".zense" || rel.startsWith(".zense/")) return path; // harness state lives in main
	return join(wtRoot, rel);
};

/** Prefix a bash command with `cd <wtRoot> &&` so it runs inside the worktree */
export const buildWorktreeCommand = (cmd: string, wtRoot: string): string =>
	`cd ${shellQuote(wtRoot)} && ${cmd}`;

// ----- git worktree helpers (module scope — exported for integration tests)

/** non-throwing git runner returning {ok,out,err} — for best-effort worktree ops */
export const gitOk = (args: string[], cwd: string): { ok: boolean; out: string; err: string } => {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, out: out.toString(), err: "" };
	} catch (e: any) {
		const err = (e?.stderr?.toString?.() ?? e?.message ?? String(e)).split("\n")[0];
		return { ok: false, out: "", err };
	}
};

/** Does the existing worktree still exist on disk? Reusing it matters when a spec version is
 *  bumped mid-implementation: recreating a fresh worktree would orphan in-progress work and make
 *  the next eval run against an empty tree → FAIL despite finished work (hit for real at v3→v4). */
export const canReuseWorktree = (wt: Worktree | null | undefined): boolean => !!wt && existsSync(wt.root);

/** Create this session's git worktree at spec approval. Nested under <repo>/.zense/worktree/
 *  so zense state stays in one workspace. Best-effort: failure (not a git repo / name clash)
 *  returns null and the caller degrades to working in main. */
export const createWorktree = (cwd: string, spec: Spec): Worktree | null => {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const branch = `zense/impl/v${spec.version}-${stamp}`;
	const wtParent = join(zenseDir(cwd), "worktree");
	const wtRoot = join(wtParent, `${basename(cwd)}-wt-${stamp}`);
	mkdirSync(wtParent, { recursive: true });
	const head = gitOk(["rev-parse", "HEAD"], cwd); // round baseline = main HEAD before branching (always before worktree add)
	if (gitOk(["worktree", "add", wtRoot, "-b", branch], cwd).ok !== true) return null;
	excludeFromGitStatus(cwd, wtParent);
	// copy current spec + memory into the worktree so bash-based reads see current state (not checkout-time state);
	// adr/ too: check probes run with cwd=worktree, and a spec may legitimately scope .zense/adr
	// (e.g. "ADR recorded") — without the mirror such checks false-fail inside the sandbox
	const wtZense = join(wtRoot, ".zense");
	mkdirSync(wtZense, { recursive: true });
	for (const f of ["spec.json", "spec.md", "memory.jsonl"]) {
		const src = join(zenseDir(cwd), f);
		if (existsSync(src)) copyFileSync(src, join(wtZense, f));
	}
	const adrSrc = join(zenseDir(cwd), "adr");
	if (existsSync(adrSrc)) cpSync(adrSrc, join(wtZense, "adr"), { recursive: true });
	return { root: wtRoot, branch, dir: wtRoot, ...(head.ok ? { baseline: head.out.trim() } : {}) };
};

/** Longrun worktree (ADR-004): ONE worktree per requirement for the whole tracker —
 *  created at plan-sign, REUSED across sessions/phases (reattach by slug is the whole point:
 *  resume must land in the same branch so checkpoints chain). Returns null when the slot is
 *  occupied by a non-worktree dir (could hold human work — never auto-delete; the caller
 *  escalates instead). */
export const ensureLongrunWorktree = (cwd: string, slug: string, branch: string): { wt: Worktree; created: boolean } | null => {
	const wtParent = join(zenseDir(cwd), "worktree");
	const wtRoot = join(wtParent, `longrun-${slug}`);
	const head = gitOk(["rev-parse", "HEAD"], cwd); // whole-set baseline = main HEAD at creation (per-phase baselines live in the tracker)
	if (existsSync(wtRoot)) {
		if (!gitOk(["rev-parse", "--is-inside-work-tree"], wtRoot).ok) return null;
		return { wt: { root: wtRoot, branch, dir: wtRoot, ...(head.ok ? { baseline: head.out.trim() } : {}) }, created: false };
	}
	mkdirSync(wtParent, { recursive: true });
	// orphaned branch (worktree dir pruned but branch survived) → re-checkout; else fresh branch
	const haveBranch = gitOk(["rev-parse", "--verify", "-q", branch], cwd).ok;
	const add = haveBranch ? gitOk(["worktree", "add", wtRoot, branch], cwd) : gitOk(["worktree", "add", wtRoot, "-b", branch], cwd);
	if (!add.ok) return null;
	excludeFromGitStatus(cwd, wtParent);
	return { wt: { root: wtRoot, branch, dir: wtRoot, ...(head.ok ? { baseline: head.out.trim() } : {}) }, created: true };
};

/** Keep zense-created dirs (e.g. .zense/worktree/) out of main's git status — best-effort
 *  append to .git/info/exclude (local-only, never touches tracked user files). */
const excludeFromGitStatus = (cwd: string, absPath: string): void => {
	try {
		const top = gitOk(["rev-parse", "--show-toplevel"], cwd);
		if (!top.ok) return;
		const repoRoot = realpathSync(top.out.trim());
		const rel = relative(repoRoot, realpathSync(absPath)).split(sep).join("/");
		if (!rel || rel.startsWith("..")) return;
		const gitCommon = gitOk(["rev-parse", "--git-common-dir"], cwd);
		if (!gitCommon.ok) return;
		const excludeFile = join(resolve(cwd, gitCommon.out.trim()), "info", "exclude");
		const line = `/${rel}/`;
		const cur = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
		if (cur.split("\n").some((l) => l.trim() === line)) return;
		appendFileSync(excludeFile, `${cur && !cur.endsWith("\n") ? "\n" : ""}${line}\n`);
	} catch {
		/* best-effort */
	}
};

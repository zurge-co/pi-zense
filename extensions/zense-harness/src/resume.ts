// zense-harness module: /zense resume discovery: spec from disk, archive paths, session worktree, pendingApply restore (moved verbatim from index.ts — see AGENTS.md map)

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zenseDir, type Spec, type Tracker, type Worktree, type PendingApply } from "./types.ts";
import { gitOk } from "./worktree.ts";
import { PENDING_PATCH, NOT_ZENSE } from "./pending-apply.ts";

// ----- new-session resume helpers (/zense resume: explicit adoption only — a session
//       that does not resume abandons the old cycle; nothing here runs automatically)

/** Adopt the latest on-disk spec into a fresh session: parse + validate .zense/spec.json.
 *  synced by syncApprovedSpecFiles, so approved:true on disk = genuinely signed. Minimal
 *  shape check only (numeric version, string title, array scope/criteria); optional fields
 *  default to [] — older persisted specs lack approach. Corrupt/absent → null. */
export const loadSpecFromDisk = (cwd: string): Spec | null => {
	try {
		const p = join(zenseDir(cwd), "spec.json");
		if (!existsSync(p)) return null;
		const s = JSON.parse(readFileSync(p, "utf8")) as Partial<Spec>;
		if (!s || typeof s.version !== "number" || typeof s.title !== "string") return null;
		if (!Array.isArray(s.scope) || !Array.isArray(s.criteria)) return null;
		return {
			version: s.version,
			title: s.title,
			intent: typeof s.intent === "string" ? s.intent : "",
			...(Array.isArray(s.approach) ? { approach: s.approach } : {}),
			scope: s.scope,
			constraints: Array.isArray(s.constraints) ? s.constraints : [],
			criteria: s.criteria,
			specDebt: Array.isArray(s.specDebt) ? s.specDebt : [],
			approved: s.approved === true,
			...(typeof s.approvedAt === "number" ? { approvedAt: s.approvedAt } : {}),
			...(Array.isArray(s.changesFrom) ? { changesFrom: s.changesFrom } : {}),
		};
	} catch {
		return null;
	}
};

/** Locate the archive pair (.zense/specs/<stamp>-v<N>-<slug>.{json,md}) for a spec version
 *  so a resumed state gets working specJsonPath/specMdPath (zense_eval appends outcomes to
 *  the archive .md). Files are timestamp-prefixed → the newest copy sorts last. */
export const findSpecArchivePaths = (cwd: string, version: number): { json?: string; md?: string } => {
	try {
		const dir = join(zenseDir(cwd), "specs");
		if (!existsSync(dir)) return {};
		const files = readdirSync(dir)
			.filter((f) => f.includes(`-v${version}-`))
			.sort();
		const jsons = files.filter((f) => f.endsWith(".json"));
		const mds = files.filter((f) => f.endsWith(".md"));
		return {
			...(jsons.length ? { json: join(dir, jsons[jsons.length - 1]) } : {}),
			...(mds.length ? { md: join(dir, mds[mds.length - 1]) } : {}),
		};
	} catch {
		return {};
	}
};

/** Rewire a previous session's worktree: scan .zense/worktree/* for a REAL git worktree on a
 *  zense/impl/ branch. Prefer an exact version match (zense/impl/v<N>-…); a version bump
 *  mid-implementation keeps the old branch name (cosmetic — see approveCurrentSpec), so a
 *  single unmatched candidate is still adopted (caller warns); several unmatched candidates
 *  = ambiguous → null rather than guessing (would mix two rounds of work). */
export const findSessionWorktree = (cwd: string, specVersion: number): { wt: Worktree; exactVersion: boolean } | null => {
	try {
		const parent = join(zenseDir(cwd), "worktree");
		if (!existsSync(parent)) return null;
		const candidates: { wt: Worktree; exactVersion: boolean }[] = [];
		for (const entry of readdirSync(parent)) {
			const dir = join(parent, entry);
			try {
				if (!statSync(dir).isDirectory()) continue;
			} catch {
				continue;
			}
			if (!gitOk(["rev-parse", "--is-inside-work-tree"], dir).ok) continue; // real worktrees only (never adopt a stray dir)
			const br = gitOk(["rev-parse", "--abbrev-ref", "HEAD"], dir);
			if (!br.ok || !br.out.trim().startsWith("zense/impl/")) continue;
			const branch = br.out.trim();
			candidates.push({ wt: { root: dir, branch, dir }, exactVersion: branch.startsWith(`zense/impl/v${specVersion}-`) });
		}
		const exact = candidates.find((c) => c.exactVersion);
		if (exact) return exact;
		return candidates.length === 1 ? candidates[0] : null; // one leftover = unambiguous (stale branch name ok); many = refuse to guess
	} catch {
		return null;
	}
};

/** Restore pendingApply across session boundaries: eval PASS applied the change into main as
 *  staged changes, the human then opened a NEW session to review+commit — without this the
 *  new session's /zense accept|discard finds "no pending apply". Requires BOTH the helper
 *  patch file (proves an apply happened) AND a non-empty staged index (proves it's still
 *  pending) — an empty index means the human closed it outside the flow → null. */
export const restorePendingApply = (cwd: string, specVersion: number): PendingApply | null => {
	try {
		const patchPath = join(zenseDir(cwd), PENDING_PATCH);
		if (!existsSync(patchPath)) return null;
		if (gitOk(["diff", "--cached", "--quiet"], cwd).ok) return null; // empty index = committed/discarded already
		const names = gitOk(["diff", "--cached", "--name-only", "--", ".", NOT_ZENSE], cwd);
		return {
			specVersion,
			branch: "(resumed)", // the apply already deleted the source branch — the pointer is for traceability only
			paths: names.ok ? names.out.trim().split("\n").filter(Boolean) : [],
			appliedAt: statSync(patchPath).mtimeMs,
		};
	} catch {
		return null;
	}
};

/** Everything /zense resume needs, discovered from disk in one call (spec → archive pair →
 *  worktree → pendingApply). null = nothing resumable (no valid spec.json). worktree/
 *  pendingApply are optional by design: a gone worktree or closed apply never blocks resume.
 *  pendingApply is only probed for signed specs (an apply can't exist before approval). */
export interface ResumeDiscovery {
	spec: Spec;
	specJsonPath?: string;
	specMdPath?: string;
	worktree?: Worktree;
	worktreeExactVersion?: boolean; // false = adopted a single leftover whose branch predates the spec version (caller warns)
	pendingApply?: PendingApply;
}

/** Long-running resume discovery: scan .zense/long-running/<slug>/tracker.json — the
 *  tracker is the only source of truth (ADR-004), so resume never needs session memory.
 *  Sorted by updatedAt desc; callers filter by status (active first is the common UX). */
export const discoverLongrunTrackers = (cwd: string): Tracker[] => {
	try {
		const root = join(zenseDir(cwd), "long-running");
		if (!existsSync(root)) return [];
		const out: Tracker[] = [];
		for (const entry of readdirSync(root)) {
			try {
				const p = join(root, entry, "tracker.json");
				if (!statSync(p).isFile()) continue;
				const t = JSON.parse(readFileSync(p, "utf8")) as Tracker;
				if (t && typeof t.slug === "string" && Array.isArray(t.phases)) out.push(t);
			} catch {
				/* skip corrupt entries — a broken tracker must not block the others */
			}
		}
		return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	} catch {
		return [];
	}
};

export const discoverResumeState = (cwd: string): ResumeDiscovery | null => {
	const spec = loadSpecFromDisk(cwd);
	if (!spec) return null;
	const arch = findSpecArchivePaths(cwd, spec.version);
	const out: ResumeDiscovery = {
		spec,
		...(arch.json ? { specJsonPath: arch.json } : {}),
		...(arch.md ? { specMdPath: arch.md } : {}),
	};
	const found = findSessionWorktree(cwd, spec.version);
	if (found) {
		out.worktree = found.wt;
		out.worktreeExactVersion = found.exactVersion;
	}
	if (spec.approved) {
		const pa = restorePendingApply(cwd, spec.version);
		if (pa) out.pendingApply = pa;
	}
	return out;
};

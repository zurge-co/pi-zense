// zense-harness module: spec version diff → change summary, spec markdown rendering, on-disk spec sync, fullscreen default (moved verbatim from index.ts — see AGENTS.md map)

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ThemeColor } from "@earendil-works/pi-coding-agent";
import { zenseDir, type Spec } from "./types.ts";

// ----------------------------------------------------------------------------- spec version change summary (module scope — exported for unit tests)

/** Field-by-field diff between prev and next spec as human-readable summary lines.
 *  Re-spec loop requirement: when eval/review fails and a new spec version is committed,
 *  the signer must see exactly what changed — never re-present an identical spec silently.
 *  Criteria diffed by id: added (+) / removed (−) / changed (~ text/check); list fields
 *  (approach/scope/constraints/specDebt) diffed as sets. No changes at all → one warning
 *  line (callers use it to detect identical specs). */
export const buildSpecChanges = (prev: Spec, next: Spec): string[] => {
	const lines: string[] = [];
	if (prev.title !== next.title) lines.push(`title: "${prev.title}" → "${next.title}"`);
	if (prev.intent !== next.intent) lines.push(`intent: changed (read the new text in the spec below)`);
	const listDiff = (label: string, a: string[], b: string[]) => {
		for (const x of b.filter((x) => !a.includes(x))) lines.push(`${label} +: ${x}`);
		for (const x of a.filter((x) => !b.includes(x))) lines.push(`${label} −: ${x}`);
	};
	listDiff("approach", prev.approach ?? [], next.approach ?? []);
	listDiff("scope", prev.scope ?? [], next.scope ?? []);
	listDiff("constraints", prev.constraints ?? [], next.constraints ?? []);
	const prevById = new Map((prev.criteria ?? []).map((c) => [c.id, c]));
	const nextById = new Map((next.criteria ?? []).map((c) => [c.id, c]));
	for (const [id, c] of nextById) {
		const p = prevById.get(id);
		if (!p) lines.push(`criteria +: ${id}: ${c.text} (check: ${c.check})`);
		else if (p.text !== c.text || p.check !== c.check)
			lines.push(
				`criteria ~: ${id}` +
					(p.text !== c.text ? ` text: "${p.text}" → "${c.text}"` : "") +
					(p.check !== c.check ? ` check: "${p.check}" → "${c.check}"` : ""),
			);
	}
	for (const [id, c] of prevById) if (!nextById.has(id)) lines.push(`criteria −: ${id}: ${c.text}`);
	listDiff("specDebt", prev.specDebt ?? [], next.specDebt ?? []);
	return lines.length
		? lines
		: [`⚠️ No changes from v${prev.version} — the new spec is identical to the previous version`];
};

/** Group the flat changesFrom lines (from buildSpecChanges) into render-friendly sections.
 *  Parses only the original line prefixes (persisted format untouched). Group order fixed by
 *  CHANGE_GROUPS; empty groups hidden; ⚠️ identical-spec warnings render verbatim without a
 *  heading; ungroupable lines land in `### Other` last. */
export const CHANGE_GROUPS: ReadonlyArray<[string, (line: string) => boolean]> = [
	["Title & intent", (l) => l.startsWith("title:") || l.startsWith("intent:")],
	["Approach", (l) => l.startsWith("approach ")],
	["Scope", (l) => l.startsWith("scope ")],
	["Constraints", (l) => l.startsWith("constraints ")],
	["Criteria", (l) => l.startsWith("criteria ")],
	["Spec debt", (l) => l.startsWith("specDebt ")],
];

/** Bucket change lines by CHANGE_GROUPS (fixed order) — shared by groupSpecChanges (archive .md)
 *  and renderSpecChangesTui (sign dialog) so the grouping logic never drifts. */
const bucketSpecChanges = (lines: string[]) => {
	const buckets = new Map<string, string[]>();
	const warns: string[] = [];
	const other: string[] = [];
	for (const line of lines) {
		if (line.startsWith("⚠️")) {
			warns.push(line);
			continue;
		}
		const group = CHANGE_GROUPS.find(([, match]) => match(line));
		if (group) {
			const bucket = buckets.get(group[0]) ?? [];
			bucket.push(line);
			buckets.set(group[0], bucket);
		} else other.push(line);
	}
	return { buckets, warns, other };
};

export const groupSpecChanges = (lines: string[]): string => {
	const { buckets, warns, other } = bucketSpecChanges(lines);
	const numbered = (items: string[]) => items.map((x, i) => `${i + 1}. ${x}`).join("\n");
	const parts: string[] = [];
	if (warns.length) parts.push(warns.join("\n"));
	for (const [heading] of CHANGE_GROUPS) {
		const items = buckets.get(heading);
		if (items?.length) parts.push(`### ${heading}\n${numbered(items)}`);
	}
	if (other.length) parts.push(`### Other\n${numbered(other)}`);
	return parts.join("\n\n");
};

/** Theme color for each change direction: + add = success / − remove = error / ~ change = warning */
export type ChangeMarkRole = Extract<ThemeColor, "success" | "error" | "warning">;

/** Render the "## Changes in v{N}" section for the sign dialog (TUI only — the archive .md
 *  keeps plain-text label+marker via groupSpecChanges since files can't show color):
 *  items drop the redundant heading label ("approach +: x" → "1. x") and get colored by
 *  direction instead. Grouping identical to the archive via bucketSpecChanges.
 *  Returns unwrapped lines; [] when the spec has no changesFrom. */
export const renderSpecChangesTui = (spec: Spec, color: (role: ChangeMarkRole, text: string) => string): string[] => {
	if (!spec.changesFrom?.length) return [];
	const { buckets, warns, other } = bucketSpecChanges(spec.changesFrom);
	const ROLE = { "+": "success", "−": "error", "~": "warning" } as const;
	// "<label> <marker>: <detail>" → "N. <detail>" colored by marker; unmatched lines stay neutral
	const renderItem = (line: string, n: number): string => {
		const m = /^(\S+) ([+−~]): (.*)$/.exec(line);
		return m ? color(ROLE[m[2] as keyof typeof ROLE], `${n}. ${m[3]}`) : `${n}. ${line}`;
	};
	const groups: string[][] = [];
	if (warns.length) groups.push([...warns]); // ⚠️ verbatim, no heading (matches groupSpecChanges)
	for (const [heading] of CHANGE_GROUPS) {
		const items = buckets.get(heading);
		if (items?.length) groups.push([`### ${heading}`, ...items.map((x, i) => renderItem(x, i + 1))]);
	}
	if (other.length) groups.push(["### Other", ...other.map((x, i) => `${i + 1}. ${x}`)]);
	return [`## Changes in v${spec.version} (vs v${spec.version - 1})`, "", ...groups.flatMap((g, i) => (i ? ["", ...g] : g))];
};

/** Render a spec as markdown — used for both the archive .md and the sign dialog.
 *  v>=2 with changesFrom gets a "## Changes in v{N} (vs v{N-1})" section before Intent
 *  so the signer sees what changed up front. */
export const renderSpecMd = (s: Spec): string =>
	`# Spec v${s.version}: ${s.title}\napproved: ${s.approved}\n\n` +
	(s.changesFrom?.length
		? `## Changes in v${s.version} (vs v${s.version - 1})\n${groupSpecChanges(s.changesFrom)}\n\n`
		: "") +
	`## Intent\n${s.intent}\n\n${s.approach?.length ? "## Approach\n" + s.approach.map((x) => `- ${x}`).join("\n") + "\n\n" : ""}## Scope\n${s.scope.map((x) => `- ${x}`).join("\n")}\n\n## Constraints\n${s.constraints.map((x) => `- ${x}`).join("\n")}\n\n## Acceptance criteria\n${s.criteria.map((c) => `- [ ] ${c.id}: ${c.text} *(check: ${c.check})*`).join("\n")}\n\n## Spec debt (human-verified only)\n${s.specDebt.map((x) => `- ${x}`).join("\n")}\n`;

/** Sync the approval back to spec files on disk:
 *  commitSpec writes files with approved:false, while approveCurrentSpec only updates in-memory
 *  state — .zense/spec.{json,md} plus archive copies must follow or graders/scripts keep seeing
 *  approved:false. Best-effort: unwritable/missing files are skipped silently. */
export const syncApprovedSpecFiles = (cwd: string, spec: Spec, paths?: { json?: string; md?: string }): boolean => {
	const json = JSON.stringify(spec, null, 2);
	const md = renderSpecMd(spec);
	const targets: Array<[string | undefined, string]> = [
		[join(zenseDir(cwd), "spec.json"), json],
		[join(zenseDir(cwd), "spec.md"), md],
		[paths?.json, json],
		[paths?.md, md],
	];
	let wroteAny = false;
	for (const [p, content] of targets) {
		try {
			if (!p || !existsSync(p)) continue;
			writeFileSync(p, content);
			wroteAny = true;
		} catch {
			/* best-effort */
		}
	}
	return wroteAny;
};

/**
 * Merge "tuiMode": "fullscreen" into settings.json — only when the key is absent.
 * pi's public extension API has no tuiMode setter, so we write the file directly.
 * null = existing file unparseable/not an object → never overwrite (protects user settings).
 * changed=false = user already chose a tuiMode (even "regular") → respect it, touch nothing.
 */
export const applyFullscreenDefault = (raw: string | undefined): { text: string; changed: boolean } | null => {
	if (raw === undefined || !raw.trim()) return { text: `${JSON.stringify({ tuiMode: "fullscreen" }, null, 2)}\n`, changed: true };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	if ("tuiMode" in (parsed as Record<string, unknown>)) return { text: raw, changed: false };
	return { text: `${JSON.stringify({ ...(parsed as Record<string, unknown>), tuiMode: "fullscreen" }, null, 2)}\n`, changed: true };
};

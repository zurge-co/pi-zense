// zense-harness module: eval/review grading + rendering — grader output parse, grader/reviewer prompts, compact eval/review result text, review packet validation + hallucination detector (moved verbatim from index.ts — see AGENTS.md map)

import { existsSync } from "node:fs";
import { type Criterion, type Spec } from "./types.ts";
import { type ProbeResult } from "./evidence.ts";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface GradeParse {
	perCriteria: Record<string, "PASS" | "FAIL">;
	evidence: Record<string, string>;
	failedIds: string[];
	missingIds: string[];      // criteria the grader gave no verdict on — spotty coverage (previously ignored silently)
	passNoEvidence: string[];  // PASS without trailing evidence — closes the "confident bluff" hole
	overall: "PASS" | "FAIL" | null;
}

/**
 * W2: stricter grader-verdict parsing — contract:
 *   <id>: PASS: <evidence> / <id>: FAIL: <evidence> ... last line OVERALL: PASS|FAIL
 * Three old holes made "broken output = free pass": ids the regex missed were ignored
 * (incomplete coverage), a missing OVERALL flowed unknown → PASS, and PASS needed no
 * evidence. Pure for direct unit tests.
 */
export const parseGraderOutput = (output: string, criteria: Criterion[]): GradeParse => {
	const perCriteria: Record<string, "PASS" | "FAIL"> = {};
	const evidence: Record<string, string> = {};
	for (const c of criteria) {
		// NB: [ \t], not \s, after the verdict — \s eats the newline and evidence would slurp the next line
		const m = output.match(new RegExp(`^\\s*${escapeRe(c.id)}[ \\t]*:[ \\t]*(PASS|FAIL)\\b[ \\t]*:?[ \\t]*([^\\r\\n]*)$`, "im"));
		if (m) {
			perCriteria[c.id] = m[1].toUpperCase() as "PASS" | "FAIL";
			evidence[c.id] = (m[2] ?? "").trim();
		}
	}
	const om = output.match(/^\s*OVERALL\s*:\s*(PASS|FAIL)\b/im);
	return {
		perCriteria,
		evidence,
		failedIds: criteria.filter((c) => perCriteria[c.id] === "FAIL").map((c) => c.id),
		missingIds: criteria.filter((c) => !(c.id in perCriteria)).map((c) => c.id),
		passNoEvidence: criteria.filter((c) => perCriteria[c.id] === "PASS" && !evidence[c.id]).map((c) => c.id),
		overall: om ? (om[1].toUpperCase() as "PASS" | "FAIL") : null,
	};
};

/** W2/W3: grader prompt — evidence-anchored contract + probe results (harness-executed =
 *  ground truth) + real diff + reward-hacking checklist + explicit read-only notice — pure
 *  builder for tests/reuse. */
export const buildGraderPrompt = (spec: Spec, probes: ProbeResult[], diffSummary: string, feedback: string): string =>
	`You are the OUTPUT-EVAL grader. Judge each acceptance criterion from EVIDENCE ONLY — the probe results below were executed by the harness itself and are ground truth. You have NO write/edit tools; never modify the repo (if a check truly needs a fixture, create it in a tmp dir only).\n\n` +
	`Reward-hacking checklist (auto-FAIL the related criteria if found): tests weakened/deleted/skipped, assertions removed, writes outside spec scope, placeholder or stub code claimed as done. Compare the change summary below against the spec scope.\n\n` +
	`Probe status guide: FAIL = the harness ran the check and the artifact does NOT satisfy it (authoritative — do not PASS that criterion). SKIPPED = the harness could not judge (manual check, or the check command itself is malformed/errored) — SKIPPED is NOT evidence of artifact failure; verify that criterion yourself with read-only commands and judge on the evidence you gather.\n\n` +
	`Criteria & probe results (harness-executed, authoritative):\n${spec.criteria
		.map((c, i) => {
			const p = probes[i];
			const r = p ? `${p.status.toUpperCase()}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ""} — ${p.detail}` : "n/a";
			return `- ${c.id}: ${c.text}\n  check: ${c.check}\n  probe: ${r}`;
		})
		.join("\n")}\n\n` +
	`Spec scope (writes must stay inside): ${spec.scope.join(", ") || "(none declared)"}\n\n` +
	(diffSummary ? `Change summary (git, at eval time):\n${diffSummary}\n\n` : "") +
	`Output STRICTLY (one line per criterion; evidence is MANDATORY — cite the probe result or a command you ran + its output. A PASS without evidence is rejected):\n` +
	`<id>: PASS: <evidence>\n<id>: FAIL: <evidence>\n…\nOVERALL: PASS|FAIL\n` +
	`No extra commentary. The last line must be exactly 'OVERALL: PASS' or 'OVERALL: FAIL'.` +
	(feedback ? `\n\nSYSTEM FEEDBACK: your previous response was rejected: ${feedback}. Return the corrected format only.` : "");

// ----------------------------------------------------------------------------- M: compact tool-result display text
// Previously every zense_eval/zense_review branch appended raw sub-agent output (up to ~16k
// chars from runSubagent) into the permanent conversation history → re-paid as input on every
// turn after eval. These builders render only what the main agent needs for its next decision
// (verdict, per-criteria one-liners, failed probes, directives, log path to read on demand) —
// full data still lives in details{} and .zense/subagents/*.log; nothing leaves the pipeline.

/** Trim evidence to one short line — hard ceiling so the tool result can't balloon back */
const oneLineEvidence = (s: string, max = 120): string => {
	const line = (s ?? "").split("\n")[0].trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Compact probe section: detail only for non-pass probes; passing ones collapse to one line
 *  (starts with \n\n like the old probeSection — callers keep concatenating the same way). */
export const buildCompactProbeSection = (probes: ProbeResult[]): string => {
	const passIds = probes.filter((p) => p.status === "pass").map((p) => p.id);
	const lines = probes
		.filter((p) => p.status !== "pass")
		.map((p) => `- ${p.id}: ${p.status}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ""} — ${oneLineEvidence(p.detail, 200)}`);
	if (passIds.length) lines.push(`probes pass: ${passIds.join(",")}`);
	return `\n\n## Probes (harness-executed, authoritative)\n${lines.join("\n") || "(no probes)"}`;
};

/** Input for buildEvalResultText — every field already exists in the handler (no raw
 *  sub-agent output pulled in). */
export interface EvalResultView {
	verdict: string;
	criteria: Criterion[];
	perCriteria: Record<string, "PASS" | "FAIL">;
	evidence: Record<string, string>;
	failedIds: string[];
	probeOverrides: string[];
	probes: ProbeResult[];
	trajectory: string[];
	specDebt: string[];
	logPath: string; // .zense/subagents/*.log path — the agent reads it itself when it needs detail
}

/** Render zense_eval's result text for both PASS/FAIL — FAIL shows only failing criteria
 *  (keeps passing ones out of the agent's attention); both end with the full-log pointer +
 *  directives. Never touch the directives (FAIL = go fix, PASS = mandatory zense_review — the
 *  agent once silently considered itself done). */
export const buildEvalResultText = (v: EvalResultView): string => {
	const out: string[] = [
		v.verdict === "PASS"
			? "✅ Eval PASS — next step (mandatory): call `zense_review` immediately so the reviewer sub-agent builds the review packet — do not summarize or close out with the user until zense_review has been called"
			: "❌ Eval FAIL — go fix it, then call zense_eval again (do not proceed to review until it passes)",
	];
	if (v.verdict === "FAIL") {
		out.push(`failing criteria: ${v.failedIds.length ? v.failedIds.join(", ") : "(overall FAIL — see the evidence below or the full log)"}`);
		if (v.probeOverrides.length)
			out.push(
				`⚠ probe override → FAIL [${v.probeOverrides.join(", ")}]: the harness ran the check itself and it failed despite the grader's PASS — two possible causes: (1) the artifact is genuinely wrong → read the probe detail below and fix it; (2) the spec's check command itself is broken (placeholder/wrong path — no artifact change will ever pass) → commit a new zense_spec version with a fixed check and re-sign`,
			);
	}
	// FAIL: only failing criteria (less noise); PASS: all of them to confirm coverage
	const showIds = v.verdict === "FAIL" ? new Set(v.failedIds) : null;
	const critLines = v.criteria
		.filter((c) => !showIds || showIds.has(c.id))
		.map((c) => `- ${c.id}: ${v.perCriteria[c.id] ?? "?"} — ${oneLineEvidence(v.evidence[c.id] ?? "")}`);
	if (critLines.length) out.push("", "## Verdicts", ...critLines);
	out.push(buildCompactProbeSection(v.probes).slice(2)); // strip the leading \n\n — out already separates lines
	out.push("", "## Trajectory flags", v.trajectory.join("\n") || "(none)");
	out.push("", "## Spec debt (needs human)", v.specDebt.join("\n") || "(none)");
	out.push("", `🧪 raw grader output (per-criterion detail) is in the log: ${v.logPath} — read it yourself if needed`);
	return out.join("\n");
};

/** Render zense_review's result text — previously the whole reviewer.output.slice(0,4_000);
 *  now TL;DR + counts + log path (the full packet lives in details{} and the
 *  zense-review-packet card in the transcript). */
export const buildReviewResultText = (opts: { ok: boolean; tlDr: string; trajectoryCount: number; escalationCount: number; logPath: string; errorOutput?: string }): string =>
	opts.ok
		? `✅ Review packet ready — open the review card in the transcript\n\n${opts.tlDr}\n\ntrajectory flags: ${opts.trajectoryCount} · escalations: ${opts.escalationCount}\n\n🧪 the full packet (every section) is in the log: ${opts.logPath} — read it yourself if needed`
		: `reviewer failed: ${opts.errorOutput ?? "(no output)"}\n\n🧪 log: ${opts.logPath}`;

/** M (comment discipline): system-prompt appendix for the implementation phase only — cuts
 *  output tokens from excess comments (what-comments / JSDoc boilerplate / banners) with
 *  "comment = WHY, not WHAT" as the rule, scoped to new/touched lines — existing
 *  decision-recording comments in the repo stay untouched. */
export const COMMENT_DISCIPLINE_GUIDELINE = [
	"Code-comment discipline for this implementation phase (saves tokens; keep the code readable):",
	"- Comment only the non-obvious: WHY a decision was made, an invariant that must hold, or a trap/edge case.",
	"- Never narrate WHAT a line does (the code already says it). No banner/separator comments (// ---- style).",
	"- No JSDoc/docstring boilerplate on self-describing functions; document parameters only when non-obvious.",
	"- Leave TODO/FIXME only when real follow-up exists, with reason; do not scatter them as filler.",
	"- Applies to NEW code and lines you touch. Do not delete or rewrite existing decision-recording comments.",
].join("\n");

const REVIEW_SECTIONS = ["TL;DR", "Intent vs Implementation", "Risks", "Rollback", "Human actions"] as const;

export interface PacketParse {
	ok: boolean;
	missing: string[];
	tldr: string;
}

/** W2: validate the reviewer packet against its fixed schema — the old raw 900-char slice
 *  waved packets with no TL;DR through. ok requires every section; missing drives retry
 *  feedback. */
export const parseReviewerPacket = (text: string): PacketParse => {
	const missing = REVIEW_SECTIONS.filter((s) => !new RegExp(`^##\\s*${escapeRe(s)}\\s*$`, "im").test(text));
	let tldr = "";
	const m = text.match(/^##\s*TL;DR\s*$/im);
	if (m?.index !== undefined) {
		const rest = text.slice(m.index + m[0].length);
		const next = rest.search(/^##\s/m);
		tldr = (next === -1 ? rest : rest.slice(0, next)).trim().split("\n").filter((l) => l.trim()).slice(0, 3).join("\n");
	}
	return { ok: missing.length === 0, missing, tldr };
};

/** r4 (2026-09-02): hallucination detector for packets — extract tokens that "claim to be
 *  real" and check they appear in the evidence the harness actually fed (BACKLOG item 5: a
 *  reviewer once invented ENTROPY_TIMEOUT_MINS / SUB_AGENT_KILLED / a fake commit hash).
 *  Catches 3 shapes: SCREAMING_SNAKE with at least one _ (avoids PASS/FAIL/OVERALL
 *  false positives), 7–40-char hex (commit hashes), backticked text — multi-word backticks =
 *  prose emphasis, skipped; single-word backticks that look like paths pass when the file
 *  really exists (pathExists injectable for tests). */
export const findUngroundedTokens = (packet: string, evidence: string, pathExists: (p: string) => boolean = existsSync): string[] => {
	const found = new Set<string>();
	const isPathy = (t: string) => t.includes("/") || /\.[a-z]{1,6}$/i.test(t);
	for (const m of packet.matchAll(/`([^`\n]+)`/g)) {
		const t = m[1].trim();
		if (!t || /\s/.test(t) || evidence.includes(t)) continue;
		const bare = t.replace(/:\d+$/, ""); // file:line → drop :line first (else the extension regex can't match and the path check breaks)
		if (isPathy(bare) && pathExists(bare)) continue;
		found.add(t);
	}
	for (const m of packet.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) if (!evidence.includes(m[0])) found.add(m[0]);
	for (const m of packet.matchAll(/\b[0-9a-f]{7,40}\b/g)) if (!evidence.includes(m[0])) found.add(m[0]);
	return [...found];
};

/** Is this eval evidence from the current round? Stale when the spec version changed, or the
 *  evaluated tree differs from the tree under review (tree SHA, not commit SHA, on purpose:
 *  after eval PASS the harness repins to the tree the reviewer will actually see — the
 *  index tree at apply-back (write-tree) — so ordinary rounds don't false-stale).
 *  No current passed (legacy callsite) → no check, for backward compat. */
export const isLastEvalStale = (
	lastEval: { specVersion?: number; head?: string } | undefined,
	current: { specVersion?: number; head?: string } | undefined,
): boolean => {
	if (!lastEval || !current) return false;
	if (current.specVersion !== undefined && lastEval.specVersion !== current.specVersion) return true;
	if (current.head !== undefined && lastEval.head !== current.head) return true;
	return false;
};

/** W2: the reviewer's evidence pack — the packet must be facts-grounded, not guessed from
 *  the intent (pre-upgrade incident: a packet wrote "To be implemented" about finished work
 *  because the prompt held only a one-line intent). Evidence must belong to the current round
 *  only: git summary is baseline-scoped by the caller, and lastEval mismatching the spec
 *  version / tree at review time (freshness) is dropped with a warning — the reviewer must
 *  never judge from stale evidence. */
export const buildReviewerPrompt = (
	intent: string,
	lastEval: { verdict?: string; perCriteria?: Record<string, string>; failedIds?: string[]; probes?: ProbeResult[]; specVersion?: number; head?: string } | undefined,
	flags: string[],
	specDebt: string[],
	escalations: { kind: string; detail: string }[],
	gitSummary: string,
	feedback: string,
	freshness?: { specVersion?: number; head?: string }, // spec version + tree SHA (HEAD^{tree}) of the tree under review
	criteria?: { id?: string; text: string; check?: string }[], // r2: verbatim criteria (instead of bare id=verdict)
): string => {
	const stale = isLastEvalStale(lastEval, freshness);
	const ev = stale ? undefined : lastEval;
	// r2: probes carry their real detail (used to be compressed to id:status, letting the
	// reviewer invent the detail — BACKLOG item 5)
	const probeLines = (ev?.probes ?? [])
		.map((p) => `  - ${p.id}: ${p.status}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ""} — ${p.detail.split("\n")[0].slice(0, 160)}`)
		.join("\n");
	const criteriaLines = (criteria ?? [])
		.map((c) => `  - ${c.id ?? "?"}: ${ev?.perCriteria?.[c.id ?? ""] ?? "?"} — ${c.text}${c.check ? ` [check: ${c.check}]` : ""}`)
		.join("\n");
	return `You are the REVIEWER sub-agent. The work is DONE and already machine-graded — ground every statement in the evidence below; never write \"to be implemented\".\n\n` +
	`Evidence:\n- Intent: ${intent}\n- Eval verdict: ${ev?.verdict ?? "(no eval record)"}` +
	(stale ? `\n- ⚠️ STALE eval evidence withheld: the stored zense_eval result belongs to an older spec version (v${lastEval?.specVersion ?? "?"}) or tree (${lastEval?.head?.slice(0, 8) ?? "?"}) — re-run zense_eval before trusting any eval verdict.` : "") +
	(criteriaLines ? `\n- Criteria verdicts (authoritative — id: verdict — text [check]):\n${criteriaLines}` : ev?.perCriteria && Object.keys(ev.perCriteria).length ? `\n- Per-criteria verdicts: ${Object.entries(ev.perCriteria).map(([id, v]) => `${id}=${v}`).join(", ")}` : "") +
	(probeLines ? `\n- Probe results (harness-executed, verbatim):\n${probeLines}` : "") +
	`\n- Trajectory flags: ${flags.length ? flags.join(" | ") : "(none)"}` +
	`\n- Spec debt (human-verified): ${specDebt.length ? specDebt.join(" | ") : "(none)"}` +
	`\n- Escalations: ${escalations.length ? escalations.map((e) => `${e.kind}: ${e.detail.slice(0, 80)}`).join(" | ") : "(none)"}` +
	(gitSummary ? `\n- Git evidence:\n${gitSummary}` : "") +
	`\n- Pipeline tools (for referencing only): zense_spec, zense_adr, zense_eval, zense_review\n\n` +
	`GROUNDING CONTRACT (hard rules):\n` +
	`- Every commit hash, file path, line number, identifier, env-var name and config key you mention MUST be copied VERBATIM from the Evidence block above — never invent or reconstruct one from memory.\n` +
	`- Anything not present in the Evidence is NOT a fact: omit it, or move it to "Human actions" phrased as an open question.\n` +
	`- The TL;DR must state the eval verdict exactly as recorded and must not contradict per-criteria verdicts, trajectory flags or escalations.\n\n` +
	`Produce an incident-report-style review packet with EXACTLY these section headers (one per line):\n` +
	`## TL;DR\n(max 3 lines — the 90-second answer for a human deciding whether to deploy)\n` +
	`## Intent vs Implementation\n## Risks\n(name up to 3 spots the human MUST eyeball — file:line copied verbatim from the Evidence, or omit the line number)\n` +
	`## Rollback\n(concrete commands, e.g. git revert <hash> / files to restore — no vague advice)\n` +
	`## Human actions\n(follow-ups only a human can do: spec debt, unanswered questions)\n` +
	`Do NOT dump raw diffs; summarize. No commentary outside the sections.` +
	(feedback ? `\n\nSYSTEM FEEDBACK: your previous packet was rejected: ${feedback}. Output the full corrected packet with all headers.` : "");
};

/** Preamble to the reviewer's git evidence after apply-back (ADR-003): states plainly that
 *  changes are staged-but-uncommitted under pendingApply awaiting a human commit (stops the
 *  reviewer from assuming main was committed — "no new commits since baseline" is normal in
 *  this flow) + a note for human edits after eval+apply (index tree ≠ pinned tree).
 *  Pure builder → unit-tested in test/eval-review.test.mjs */
export const buildPendingApplyEvidencePrefix = (pendingApply: boolean, humanEdited: boolean): string =>
	(pendingApply
		? 'NOTE: the git evidence below shows staged, uncommitted changes in the main working tree (by design — a human commits after this review; "no new commits since baseline" is expected).\n'
		: "") +
	(humanEdited
		? "NOTE: files were edited AFTER eval+apply (index tree differs from the pinned tree — a human is editing during review); review as normal but surface this in the packet.\n"
		: "");

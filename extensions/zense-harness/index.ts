/**
 * zense-harness — AI-driven SDLC harness for pi, per PLAN.md.
 *
 * The name "zense" puns on the Thai word for "sign" — every agent task
 * carries a human signature (spec approval = input-side signature,
 * review packet = output-side approval)
 *
 * Loop: spec → criteria → implementation → dual eval → exception review → learn.
 *
 * Architecture (see README):
 *   - The harness itself is ONE pi extension; "sub-agents" are isolated
 *     `pi -p` (print-mode) subprocesses spawned per phase task, so each phase
 *     gets a clean context window and a structured artifact back.
 *   - Gates are enforced with pi's tool_call interception + human confirms.
 *
 * Phases:
 *   P1 Requirements : zense_spec tool → append-only archive .zense/specs/
 *                     <timestamp>-v{n}-<slug>.{json,md} (never overwritten) +
 *                     .zense/spec.{json,md} as always-latest copies
 *   P2 Design       : zense_adr tool → .zense/adr/NNN-*.md (deny rules checked live)
 *   P3 Implementation: specification gate + escalation
 *   P4 Dual eval    : zense_eval (output eval vs criteria) + trajectory heuristics
 *   P5 Review/Deploy: zense_review builds a review-packet card (exception-based)
 *   P6 Maintenance  : memory.jsonl learning log; incidents feed new criteria
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Box, Container, Key, Markdown, matchesKey, SelectList, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import { DefaultPackageManager, SettingsManager, getAgentDir, DynamicBorder, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";

// ----------------------------------------------------------------------------- module map
// This file is ONLY the extension entry point. The ~130 module-scope helpers it once held
// now live thematically under ./src/ (one read call ≈ one concern — see AGENTS.md map).
// The export * lines preserve the exact public surface tests import from this entry point.

export * from "./src/types.ts";
export * from "./src/spec-changes.ts";
export * from "./src/worktree.ts";
export * from "./src/resume.ts";
export * from "./src/pending-apply.ts";
export * from "./src/cycle.ts";
export * from "./src/spec-draft.ts";
export * from "./src/subagent-config.ts";
export * from "./src/decompose.ts";
export * from "./src/esc-guard.ts";
export * from "./src/evidence.ts";
export * from "./src/eval-review.ts";
export * from "./src/adr-deny.ts";
export * from "./src/subagent-runner.ts";
export * from "./src/memory.ts";
export * from "./src/models.ts";
export * from "./src/ask.ts";
export * from "./src/longrun.ts";

// The original package import block (top of file) already covers every external the factory
// body needs — the lines below are only the local src/ bindings the factory uses by name.
import { zenseDir, type Criterion, type LongRunRef, type Spec, type State, type SubagentRun, type Tracker, type TrackerPhase, type Worktree as WorktreeT } from "./src/types.ts";
import { buildSpecChanges, renderSpecChangesTui, renderSpecMd, syncApprovedSpecFiles, applyFullscreenDefault } from "./src/spec-changes.ts";
import { rewritePathForWorktree, buildWorktreeCommand, gitOk, canReuseWorktree, createWorktree, ensureLongrunWorktree } from "./src/worktree.ts";
import { loadSpecFromDisk, discoverResumeState, findSpecArchivePaths, discoverLongrunTrackers } from "./src/resume.ts";
import {
	allPhasesDone, appendSpecsLog, buildContextCapsule, checkpointCommit, droppedSeedIds, findPhase, healToBranch,
	abandonLongrunWorktree, buildLongrunPlannerPrompt, compilePhaseSpec, loadTracker, longrunBranch, longrunDir,
	nextPendingPhase, parseLongrunPlan, reconcileLongrunWorktree,
	renderTrackerMd, resetToCheckpoint, saveTracker, slugifyTitle, validateTracker, writePhaseSummary,
} from "./src/longrun.ts";
import { composeCommitMessage, PENDING_PATCH, PENDING_MSG, NOT_ZENSE, isGitRepo, uncommittedChanges, composeSnapshotMessage, snapshotUncommitted, applyWorktreeBack, discardPendingApply, acceptPendingApply } from "./src/pending-apply.ts";
import { resetCycleState, takeContextBulletin, buildAcceptBulletin, buildReconcileBulletin, buildDiscardBulletin, freshState } from "./src/cycle.ts";
import { parseSpecDraft, applyQualityGate, type ClarifyQuestion } from "./src/spec-draft.ts";
import { SUBAGENT_EXCLUDE_TOOLS, subagentTimeout, zenseGlobalConfigDir, extDisplayLabel, listInstalledExtensions, subagentExtIncludes, writeSubagentExtIncludes, subagentStripFlagsAsync, modelMatchesPattern, PROVIDER_MISSING_RX, findProviderExtension, mergeExtInclude, diagnoseProviderMissing, buildProviderMissingGuidance, buildRequirementsPrompt } from "./src/subagent-config.ts";
import { createEscGuard } from "./src/esc-guard.ts";
import { gatherRepoFacts, loadSpecExemplar, gitChangeSummary, CHECK_FORMAT_CONTRACT, runCheckProbes, lintSpecChecks } from "./src/evidence.ts";
import { parseGraderOutput, buildGraderPrompt, buildCompactProbeSection, buildEvalResultText, buildReviewResultText, COMMENT_DISCIPLINE_GUIDELINE, parseReviewerPacket, findUngroundedTokens, isLastEvalStale, buildReviewerPrompt, buildPendingApplyEvidencePrefix, type GradeParse, type EvalResultView } from "./src/eval-review.ts";
import { firstAdrDenyViolation } from "./src/adr-deny.ts";
import { fmtTok, subagentLogPath, runSubagent } from "./src/subagent-runner.ts";
import { aggregateMemory, memorySummaryLines, distillImpact, fmtBytes, parseDistilledLessons, buildDistilledMemory, clearDirFiles, MAX_DISTILL_MEMORY_BYTES, replaceFileAtomic, distillTaskPrompt } from "./src/memory.ts";
import { readModelsConfig, resolveModelPattern, writeModelsConfig, availableModelChoices, panelize } from "./src/models.ts";
import { asAskQuestions, formatAskAnswers, ASK_NO_UI_TEXT, type AskAnswer } from "./src/ask.ts";

// ----------------------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	// Sub-agent invocations must not re-enter the harness.
	if (process.env.PI_ZENSE_SUBAGENT === "1") return;

	let state = freshState();

	// ----- persistence (appendEntry restores across reloads/resumes)
	const persist = () => pi.appendEntry("zense-state", state);
	const readdirAdrs = (cwd: string): string[] => {
		const dir = join(zenseDir(cwd), "adr");
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter((f) => f.endsWith(".md"));
	};
	const adrText = (cwd: string) =>
		readdirAdrs(cwd)
			.map((f) => readFileSync(join(zenseDir(cwd), "adr", f), "utf8"))
			.join("\n---\n")
			.slice(0, 12_000);

	// ----- git worktree isolation (per-session: every main-agent tool call is redirected into
	//       the worktree until eval PASS applies it back — two sessions can't stomp each other)
	// (git helpers gitOk/createWorktree/applyWorktreeBack/discardPendingApply live at module scope for tests)

	/** Fullscreen default so pi-zense installs require no manual setup: set once, only when the
	 *  key is absent, interactive TUI only (sub-agents bail at factory start via
	 *  PI_ZENSE_SUBAGENT) — best-effort; a settings-write failure must never break startup. */
	const ensureFullscreenDefault = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		try {
			const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
			const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
			const merged = applyFullscreenDefault(raw);
			if (!merged || !merged.changed) return; // null = corrupt existing file (skip); !changed = user already chose (respect)
			mkdirSync(dirname(settingsPath), { recursive: true });
			writeFileSync(settingsPath, merged.text);
			learn(ctx, "fullscreen default: tuiMode=fullscreen (install default — takes effect on the next pi launch)");
			ctx.ui.notify(
				"🖥 zense: fullscreen TUI mode is now the default in ~/.pi/agent/settings.json — takes effect on the next pi launch (this session: /settings → TUI mode; to opt out: change tuiMode in that file)",
				"info",
			);
		} catch {
			/* best-effort */
		}
	};

	pi.on("session_start", async (_ev, ctx) => {
		ensureFullscreenDefault(ctx);
		// ESC guard: (re-)register on every session_start — pi clears extension input listeners
		// on session invalidation/reload (resetExtensionUI), dropping the old listener; calling
		// the old unsubscribe first is a safe no-op (pi-tui keeps a Set keyed by function → no
		// duplicates, no crashes)
		escGuard.reset(); // the previous session's overlays were popped by pi — don't let stale entries eat the new session's ESC
		if (ctx.mode === "tui") {
			escGuardUnsubscribe?.();
			escGuardUnsubscribe = ctx.ui.onTerminalInput(escGuard.handleInput);
		}
		for (const e of ctx.sessionManager.getEntries())
			if (e.type === "custom" && e.customType === "zense-state")
				state = { ...freshState(), ...(e.data as State) };
		lastWidget = undefined; // pi clears widgets on session switch/reload → resend even identical text
		// discovery only — NEVER auto-adopt: a fresh session that finds an on-disk spec gets a
		// hint to /zense resume; ignoring it = the old cycle is abandoned (left untouched on disk)
		if (!state.spec && ctx.hasUI) {
			const disk = loadSpecFromDisk(ctx.cwd);
			if (disk)
				ctx.ui.notify(
					`📄 found spec v${disk.version}${disk.approved ? " (signed)" : ""} on disk: ${disk.title} — run /zense resume to continue it, or ignore to abandon`,
					"info",
				);
		}
		// reconcile pendingApply across sessions/restarts: is the applied change still staged in main?
		if (state.pendingApply) {
			const pa = state.pendingApply;
			if (gitOk(["diff", "--cached", "--quiet"], ctx.cwd).ok) {
				// index is empty → the human committed or dropped it outside the flow → clear the
				// pointer quietly + sweep the helper files
				learn(ctx, `pendingApply reconcile: spec v${pa.specVersion} — index is empty (committed/discarded outside the flow)`);
				state.pendingApply = undefined;
				rmSync(join(zenseDir(ctx.cwd), PENDING_PATCH), { force: true });
				rmSync(join(zenseDir(ctx.cwd), PENDING_MSG), { force: true });
				// a silent clear used to leave the agent believing work was still pending (and the
				// version counter running on) — now announced via bulletin + cycle reset
				state.contextBulletin = buildReconcileBulletin(pa.specVersion);
				resetCycleState(state);
				persist();
			} else {
				ctx.ui.notify(
					`⏳ zense: changes from spec v${pa.specVersion} (${pa.paths.length} file(s)) are staged in main awaiting a commit — review, then git commit -F .zense/pending-apply.msg · after committing → /zense accept · unhappy → /zense discard (reverse patch)`,
					"warning",
				);
			}
		}
		updateWidget(ctx);
	});

	const activeRun = (): SubagentRun | undefined => {
		for (let i = state.subagentRuns.length - 1; i >= 0; i--) if (state.subagentRuns[i].status === "running") return state.subagentRuns[i];
		return undefined;
	};

	/** Cache of the widget text last actually sent — setWidget builds fresh Text/Container
	 *  components even for identical content, making the dock below the transcript relayout
	 *  during sub-agent runs (2s tick + hooks call updateWidget often) → the view jitters.
	 *  Dedupe at string level: setWidget only when the text really changed. */
	let lastWidget: string | undefined;

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const s = state.spec;
		const run = activeRun();
		const line =
			`ZENSE ▸ ${state.phase.toUpperCase()} · spec: ${s ? (s.approved ? "✅v" + s.version : "⏳unapproved") : "—"}` +
			` · turns ${state.turnsUsed} · tok ${fmtTok(state.tokensUsed)}` +
			(run ? ` · 🧪 ${run.role} ▶ ${Math.round((Date.now() - (run.startedAt ?? run.at)) / 1000)}s (ctrl+_ live · Esc cancels)` : "") +
			(state.worktree ? ` · 🌳 ${basename(state.worktree.root)}` : "") +
			(state.pendingApply ? ` · ⏳staged v${state.pendingApply.specVersion}` : "") +
			(state.trajectoryFlags.length ? ` · ⚠ ${state.trajectoryFlags.length} traj-flags` : "") +
			(state.escalations.length ? ` · 🚨 ${state.escalations.length}` : "");
		if (line === lastWidget) return; // same content → don't rebuild the component (prevents dock relayout)
		lastWidget = line;
		ctx.ui.setWidget("zense", [line]);
	};

	/** Redirect main-agent tool calls into the worktree (mutates event.input) — the agent
	 *  works inside the worktree without knowing. Sub-agents are separate processes and
	 *  unaffected (they carry their own cwd). */
	const applyRedirect = (ev: any, ctx: ExtensionContext) => {
		let wt = state.worktree;
		// self-heal: the worktree got applied/deleted outside the flow (e.g. applyWorktreeBack
		// called manually after an auto-apply miss) → a stale pointer would prefix every bash
		// with a "cd <wtRoot>" that no longer exists — clear silently when the dir is gone
		if (wt && !existsSync(wt.root)) {
			learn(ctx, "worktree self-heal: " + wt.root + " is gone (applied out-of-band?) — clearing the stale pointer");
			state.worktree = null;
			persist(); updateWidget(ctx);
			wt = null;
		}
		if (!wt) return;
		if (ev.toolName === "write" || ev.toolName === "edit" || ev.toolName === "read") {
			const p = (ev.input as { path?: string })?.path;
			if (typeof p === "string") ev.input.path = rewritePathForWorktree(ctx.cwd, wt.root, p);
		} else if (ev.toolName === "bash") {
			const c = (ev.input as { command?: string })?.command;
			if (typeof c === "string") ev.input.command = buildWorktreeCommand(c, wt.root);
		}
	};

	/** provider-missing auto-heal (2026-09-17): called when diagnosis finds the pattern's
	 *  provider missing from bare boot. Find the providing extension (findProviderExtension) →
	 *  retry once with '-e <path>'; on success (ok + the model genuinely matches the pattern —
	 *  guards against including the wrong extension and still silently falling back) → merge +
	 *  persist into the role's include list via writeSubagentExtIncludes (main repo only — the
	 *  worktree fallback reads it already) + announce the opt-out path; failed retry / no ext
	 *  found / ambiguous / already included (suspect auth) → mark failed with per-role guidance,
	 *  persist nothing. */
	const healProviderMismatch = async (
		ctx: ExtensionContext,
		role: string,
		modelPattern: string,
		r0: { ok: boolean; output: string; logPath: string; usedModel?: string },
		subCwd: string,
		stripFlags: string[],
		task: string,
		onChunk: ((chunk: string) => void) | undefined,
		run: SubagentRun,
		patternProvider: string,
	): Promise<{ ok: boolean; output: string; logPath: string; usedModel?: string }> => {
		const include = subagentExtIncludes(role, subCwd, ctx.cwd);
		const hit = findProviderExtension(patternProvider, await listInstalledExtensions(subCwd));
		const alreadyIncluded = hit ? include.includes(hit.path) : false;
		if (hit && !alreadyIncluded) {
			ctx.ui.notify(`🔁 zense: provider "${patternProvider}" is unavailable in the sub-agent (${role}) — retrying with extension '${hit.label}' loaded`, "info");
			run.retried = true;
			const r2 = await runSubagent(role, task, subCwd, subagentTimeout(role, subCwd, ctx.cwd), onChunk, r0.logPath, modelPattern, SUBAGENT_EXCLUDE_TOOLS[role], [...stripFlags, "-e", hit.path]);
			if (r2.ok && r2.usedModel && modelMatchesPattern(r2.usedModel, modelPattern)) {
				const merged = mergeExtInclude(include, hit.path);
				if (merged !== include) writeSubagentExtIncludes(ctx.cwd, role, merged);
				run.autoIncluded = true;
				learn(ctx, `provider auto-heal: ${role} — auto-included '${hit.label}' for provider "${patternProvider}" (merged + persisted into .zense/config.json)`);
				ctx.ui.notify(`✅ zense: auto-included '${hit.label}' for role ${role} (provider "${patternProvider}") — undo with /zense ext-config-show ${role} off ${hit.path}`, "info");
				return r2;
			}
			learn(ctx, `provider auto-heal failed: ${role} — still broken with '${hit.label}' included (ok=${r2.ok} used=${r2.usedModel ?? "?"} wanted ${modelPattern})`);
			return { ...r2, ok: false, output: `${buildProviderMissingGuidance(role, patternProvider, { hit, autoRetried: true })}\n---\n${r2.output}` };
		}
		learn(ctx, `provider missing: ${role} needs "${patternProvider}" but can't heal — ${hit ? (alreadyIncluded ? "extension already included, still falling back (suspect auth)" : "extension ambiguous/unusable") : "no provider extension found"}`);
		return { ...r0, ok: false, output: `${buildProviderMissingGuidance(role, patternProvider, { hit, alreadyIncluded })}\n---\n${r0.output}` };
	};

	const launchSubagent = async (
		ctx: ExtensionContext,
		role: string,
		task: string,
		onChunk?: (chunk: string) => void,
		signal?: AbortSignal, // pi agent-turn signal (Esc) — threaded into runSubagent so the user can cancel mid-run
	): Promise<{ ok: boolean; output: string; logPath: string }> => {
		const logPath = subagentLogPath(ctx.cwd, role);
		const mainModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		const modelPattern = resolveModelPattern(ctx.cwd, role, mainModel);
		const run: SubagentRun = { role, ok: false, summary: "", at: Date.now(), startedAt: Date.now(), logPath, status: "running" };
		state.subagentRuns.push(run);
		updateWidget(ctx);
		const tick = setInterval(() => updateWidget(ctx), 2_000); // keeps the elapsed counter moving in the widget
		try {
			// use the worktree root as cwd when one is active → grader/reviewer run/test what was actually changed
			const subCwd = state.worktree?.root ?? ctx.cwd;
			// C: read-only roles (SUBAGENT_EXCLUDE_TOOLS) can draft specs/read the repo but not edit code
			// B: per-role timeout — built-in map + agent-visible knob .zense/config.json (subagentTimeoutMs);
			// subCwd first, then ctx.cwd (a worktree has no .zense of its own → config lives in the main repo)
			const stripFlags = await subagentStripFlagsAsync(role, subCwd, ctx.cwd);
			const r0 = await runSubagent(role, task, subCwd, subagentTimeout(role, subCwd, ctx.cwd), onChunk, logPath, modelPattern, SUBAGENT_EXCLUDE_TOOLS[role], stripFlags, signal);
			// provider-missing diagnosis (2026-09-17, pure fn diagnoseProviderMissing): silent
			// fallback (usedModel has a different provider than the pattern) / hard error (stderr
			// matches PROVIDER_MISSING_RX) → heal
			const diagnosis = diagnoseProviderMissing(modelPattern, r0);
			let r = r0;
			let healHandled = false;
			// a user cancel (Esc) is not a provider problem — never auto-heal/relaunch after it
			if (diagnosis && !signal?.aborted) {
				healHandled = true;
				r = await healProviderMismatch(ctx, role, modelPattern!, r0, subCwd, stripFlags, task, onChunk, run, diagnosis.patternProvider);
			}
			run.ok = r.ok;
			run.summary = r.output.slice(0, 300);
			run.status = r.ok ? "done" : "failed";
			if (r.usedModel) run.model = r.usedModel;
			// verify the actually-run model matches the config — pi can fall back to its default
			// silently when a pattern won't resolve (unknown provider/id → no error, lands on the
			// saved default = usually the main agent's model)
			if (!healHandled && modelPattern && r.usedModel && !modelMatchesPattern(r.usedModel, modelPattern)) {
				learn(ctx, `sub-agent model mismatch: ${role} requested ${modelPattern} but ran ${r.usedModel}`);
				ctx.ui.notify(`⚠ sub-agent model mismatch: ${role} — config asked for "${modelPattern}" but actually ran "${r.usedModel}" (pi fallback? check .zense/models.json / /zense models)`, "warning");
			}
			if (!r.ok) learn(ctx, `sub-agent failed: ${role} — ${r.output.split("\n")[0].slice(0, 160)}`);
			return r;
		} finally {
			clearInterval(tick);
			persist();
			updateWidget(ctx);
		}
	};


	// ----- Phase 1 gate: no implementation on unapproved spec (hard enforcement)

	pi.on("tool_call", async (ev, ctx) => {
		// gate off → skip gate/scope/ADR but still redirect into the worktree (when active)
		if (!state.gateEnabled) { applyRedirect(ev, ctx); return; }
		const isWrite = ev.toolName === "write" || ev.toolName === "edit";
		// read/bash bypass gate/scope (write-only) — only redirect when a worktree exists
		if (!isWrite) { applyRedirect(ev, ctx); return; }

		if (state.phase === "requirements" || !state.spec?.approved) {
			if (!ctx.hasUI) {
				escalate("need-permission", "write blocked: spec unsigned (no UI)", ctx);
				// no-spec → /zense approve can never work → tell the agent to commit a spec first
				return { block: true, reason: state.spec
					? "Zense gate: the spec is not yet signed — the user must sign via the next dialog or /zense approve first"
					: state.longRun
						? `Zense gate: longrun "${state.longRun.slug}" is between phases — call zense_longrun next to acquire the signed phase spec (writes outside a phase are blocked by design)`
						: "Zense gate: there is no spec in the system at all — call zense_spec (recommended: action=compile_spec) to commit one first; the user can then sign from the dialog immediately. A spec pasted in chat does not count" };
			}
			// the signature lives on this dialog — signing continues the work immediately, no
			// follow-up /zense approve needed (TUI: full spec shown before signing; RPC: plain select)
			const s = state.spec;
			let choice: string | null | undefined;
			if (s && ctx.mode === "tui") {
				choice = await specSignDialog(ctx, s, `Zense gate: ${ev.toolName} is about to write code while spec v${s.version} is unsigned — read before signing`, [
					{ value: "sign", label: "🔏 Sign & approve the spec, then continue", description: "signing opens the gate; this write passes immediately" },
					{ value: "override", label: "⚠️ Allow this once (override without signing)", description: "adds a trajectory flag" },
					{ value: "block", label: "⛔ Block for now", description: "the agent waits for a signature / a fresh spec" },
				]);
			} else {
				choice = await ctx.ui.select(
					`Zense gate: ${ev.toolName} is about to write code with an unsigned spec${s ? ` (v${s.version}: ${s.title} — full text at .zense/spec.md)` : " (no spec yet)"}`,
					[
						...(s ? ["🔏 Sign & approve the spec, then continue"] : []),
						"⚠️ Allow this once (override without signing)",
						"⛔ Block for now (the agent compiles a spec / waits for a signature)",
					],
				);
			}
			if (choice === "sign" || choice?.startsWith("🔏")) approveCurrentSpec(ctx); // sign = gate opens, continue right away
			else if (choice === "override" || choice?.startsWith("⚠️")) {
				state.trajectoryFlags.push(`unsigned override: ${ev.toolName}`);
				learn(ctx, `flag: unsigned override: ${ev.toolName}`);
				// H: a compiled spec still overridden unsigned is a draft-quality signal → logged
				//    loudly as a lesson for the next compile to reflect on (loop H closes here)
				if (state.specSource === "compile" && state.spec)
					learn(ctx, `flag: compiled spec v${state.spec.version} overridden unsigned (${ev.toolName})`);
				ctx.ui.notify("⚠ overriding without a signed spec — trajectory flag added", "warning");
			} else {
				escalate("need-permission", "write blocked: spec unsigned", ctx);
				return { block: true, reason: state.spec
					? "Zense gate: the spec is not yet signed — pick 🔏 Sign in the next dialog, or ask the user to run /zense approve"
					: "Zense gate: there is no spec in the system at all — call zense_spec (recommended: action=compile_spec) to commit one first; the user can then sign from the dialog immediately. Pasting a spec in chat does not approve anything" };
			}
		}

		// Scope check: writes outside spec.scope are trajectory flags.
		const target = (ev.input as { path?: string })?.path;
		if (target && state.spec?.scope?.length) {
			const rel = relative(ctx.cwd, resolve(ctx.cwd, target));
			const inScope = state.spec.scope.some((g) => rel.startsWith(g.replace(/\*\*?$/, "")));
			if (!inScope) {
				state.trajectoryFlags.push(`out-of-scope write: ${rel}`);
				ctx.ui.notify(`⚠ trajectory: ${rel} outside spec.scope`, "warning");
			}
		}


		// Design-constraint checker: complete ADR "DENY:" constraints block matching write targets.
		const adrViolation = firstAdrDenyViolation(target, adrText(ctx.cwd));
		if (adrViolation) return { block: true, reason: adrViolation };
		// redirect this write into the worktree last (after scope/ADR checks run on the original
		// main-repo path)
		applyRedirect(ev, ctx);
	});

	// ----- M (comment discipline): guideline appended to the system prompt only during
	// implementation (the system prompt ships every turn — pay for it only while code is
	// actually being written; leaving implementation removes it again)
	pi.on("before_agent_start", async (event, ctx) => {
		let sp = event.systemPrompt;
		if (state.phase === "implementation") sp += "\n\n" + COMMENT_DISCIPLINE_GUIDELINE;
		// cycle-closure bulletin (2026-09-17): one-shot — consumed and persisted at once so it
		// never rides every turn; sendUserMessage is avoided on purpose (it always triggers a new
		// turn = a wasted LLM call + a surprise at session open)
		const bulletin = takeContextBulletin(state);
		if (bulletin) {
			sp += "\n\n" + bulletin;
			persist();
		}
		// old fast path: nothing changed → undefined, no new systemPrompt copy
		if (sp === event.systemPrompt) return;
		return { systemPrompt: sp };
	});

	// ----- Phase 3: turn/token usage meter

	pi.on("turn_end", async (ev, ctx) => {
		state.turnsUsed++;
		// count AssistantMessages only (human-approved 2026-09-09): widget "tok" = LLM tokens —
		// ToolResultMessage usage is tool-execution usage, explicitly "not part of main LLM
		// context accounting" per pi-ai
		const m = ev.message as { role?: string; usage?: { totalTokens?: number } } | undefined;
		state.tokensUsed += m?.role === "assistant" ? (m.usage?.totalTokens ?? 0) : 0;
		updateWidget(ctx);
		persist();
	});

	// ----- Phase 4: trajectory eval heuristics at run end

	pi.on("agent_end", async (ev, ctx) => {
		const calls = ev.messages.flatMap((m: any) => m.toolCalls ?? []);
		const failed = ev.messages.flatMap((m: any) =>
			m.role === "toolResult" && m.details?.isError ? [m] : [],
		).length;

		for (const c of calls) {
			const p = c.arguments?.path ?? c.arguments?.command ?? "";
			if (/\.(test|spec)\.(ts|js|py)/.test(p) && (c.name === "edit" || c.name === "write"))
				flag("modified/deleted test file: " + p, ctx);
			if (c.name === "bash" && /rm\s+.*test|--delete|-u jest/.test(p))
				flag("suspicious test mutation: " + p, ctx);
		}
		if (calls.length >= 5 && failed / calls.length > 0.5)
			flag(`retry storm: ${failed}/${calls.length} tool calls failed`, ctx);

		// worktree still active when the agent run ends (eval hasn't PASSed) → notify once per
		// creation (dedupe) so the human knows one is lying around
		if (state.worktree && !state.worktreeLeaveNotified) {
			state.worktreeLeaveNotified = true;
			ctx.ui.notify(`🌳 worktree left unmerged (not yet applied to main): ${state.worktree.dir}\nbranch ${state.worktree.branch} — will be applied as staged changes (no commit) automatically when eval passes`, "info");
			persist();
		}
		persist();
	});

	const flag = (msg: string, ctx: ExtensionContext) => {
		if (!state.trajectoryFlags.includes(msg)) {
			state.trajectoryFlags.push(msg);
			learn(ctx, `flag: ${msg}`);
			ctx.ui.notify(`⚠ trajectory-eval: ${msg}`, "warning");
		}
	};

	const escalate = (kind: string, detail: string, ctx: ExtensionContext) => {
		state.escalations.push({ kind, detail, at: Date.now() });
		learn(ctx, `escalation: ${kind}: ${detail}`);
		persist();
		updateWidget(ctx);
	};

	// ----- ESC guard: one instance per extension — every zense dialog opens/closes through
	// zenseCustom below

	const escGuard = createEscGuard();
	let escGuardUnsubscribe: (() => void) | undefined;

	/** Wraps ctx.ui.custom for every harness dialog — registers open/close with escGuard so ESC
	 *  while a dialog is open gets consumed by the guard (closing the topmost dialog = this
	 *  one) instead of leaking into pi's defaultEditor.onEscape (streaming abort) when focus
	 *  slips off the overlay. Dialogs need no changes to their own handleInput: when focus is
	 *  genuinely on the dialog, ESC hits the guard first anyway (input listeners run before
	 *  component routing). */
	const zenseCustom = <T>(
		ctx: ExtensionContext,
		options: unknown, // pi keeps options in 2 shapes (overlay/non-overlay) — passed through via cast
		factory: (tui: any, theme: any, kb: any, done: (v: T) => void) => any,
	): Promise<T> =>
		ctx.ui.custom<T>((tui, theme, kb, done) => {
			let closed = false;
			// closing with null semantics = cancel, matching every dialog's original ESC (every
			// callsite already accepts a T that includes null)
			const trackedDone = (v: T) => {
				if (closed) return; // guards against double done (e.g. factory throws after resolve)
				closed = true;
				handle.close();
				done(v);
			};
			const handle = escGuard.open(() => trackedDone(null as T));
			try {
				return factory(tui, theme, kb, trackedDone);
			} catch (e) {
				trackedDone(null as T); // factory died before returning a component — drop the guard entry, don't leak it
				throw e;
			}
		}, options as never);

	// ----- spec presentation: the dialog must show the full spec before a signing decision
	// (pi-tui's ScrollView needs layout integration, so we scroll manually via offset + slice)

	// zense dialogs render as overlays floating above the transcript instead of inline walls
	// of text — closing returns to the previous context instantly
	// (pi mechanism: ctx.ui.custom({ overlay: true, overlayOptions }))

	const OVERLAY_LG = { overlay: true, overlayOptions: { width: "92%", minWidth: 60, maxHeight: "85%" } } as const; // spec sign dialog (long spec to read)
	const OVERLAY_MD = { overlay: true, overlayOptions: { width: "80%", minWidth: 56, maxHeight: "80%" } } as const; // mid-size pickers
	const OVERLAY_XL = { overlay: true, overlayOptions: { width: "95%", minWidth: 60, maxHeight: "90%" } } as const; // live tail

	/** One scroll keymap shared by all dialogs (spec sign / live tail) — never fork it, it
	 *  would drift: ↑/↓ one line, ←/→ one page, g top, G bottom (plain printable keys, work in
	 *  every terminal, no clash with Mac fn-keys). No Ctrl chords — the shortest set that works
	 *  identically across both dialogs. */
	type ScrollAction = { dir: 1 | -1; page: boolean } | "top" | "bottom" | null;
	const scrollKeyAction = (data: string): ScrollAction => {
		if (matchesKey(data, Key.up)) return { dir: -1, page: false };
		if (matchesKey(data, Key.down)) return { dir: 1, page: false };
		if (matchesKey(data, Key.left)) return { dir: -1, page: true };
		if (matchesKey(data, Key.right)) return { dir: 1, page: true };
		if (data === "g") return "top";
		if (data === "G") return "bottom";
		return null;
	};

	const specSignDialog = (ctx: ExtensionContext, spec: Spec, question: string, items: SelectItem[]): Promise<string | null> =>
		zenseCustom<string | null>(ctx, OVERLAY_LG, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const title = new Text(theme.fg("accent", theme.bold(`🔏 ${question}`)), 1, 0);
			const hint = new Text(
				theme.fg(
					"warning",
					`Read the entire spec below before deciding to sign` +
						(state.lastCompileLessons ? ` · 📚 fed ${state.lastCompileLessons} lessons from memory at compile time` : ""),
				),
				1,
				0,
			);
			// spec body via plain Markdown, minus the Changes section (changesFrom: undefined) —
			// Changes render separately via renderSpecChangesTui (drops the redundant heading label
			// + colors instead of +/− markers)
			const md = new Markdown(renderSpecMd({ ...spec, changesFrom: undefined }), 0, 0, {
				heading: (t) => theme.fg("accent", theme.bold(t)),
				link: (t) => theme.fg("accent", t),
				linkUrl: (t) => theme.fg("dim", t),
				code: (t) => theme.fg("success", t),
				codeBlock: (t) => theme.fg("success", t),
				codeBlockBorder: (t) => theme.fg("dim", t),
				quote: (t) => theme.fg("muted", t),
				quoteBorder: (t) => theme.fg("dim", t),
				hr: (t) => theme.fg("dim", t),
				listBullet: (t) => theme.fg("accent", t),
				bold: (t) => theme.bold(t),
				italic: (t) => theme.italic(t),
				strikethrough: (t) => t,
				underline: (t) => theme.underline(t),
			});
			let lines: string[] = [];
			let cachedWidth = -1;
			let offset = 0;
			// spec-body height: use the overlay's full share of the terminal (85% of rows per
			// OVERLAY_LG) — reserve 9 lines for border/title/hint/range/options ≤3/bottomHint or
			// the overlay's maxHeight clips it (tune reserve and maxHeight together, always)
			const bodyRows = () => Math.max(4, Math.floor(tui.terminal.rows * 0.85) - 9);
			const maxOffset = () => Math.max(0, lines.length - bodyRows());

			return {
				render: (w: number) => {
					if (w !== cachedWidth) {
						cachedWidth = w;
						const wBody = Math.max(20, w - 6);
						// the Changes section (colored +/−/~) first, then the spec body from Markdown — both wrapped at the same width
						const changeLines = renderSpecChangesTui(spec, (role, t) => theme.fg(role, t)).flatMap((ln) =>
							ln ? wrapTextWithAnsi(ln, wBody) : [""],
						);
						lines = [...changeLines, ...(changeLines.length ? [""] : []), ...md.render(wBody)];
					}
					offset = Math.max(0, Math.min(offset, maxOffset()));
					const h = bodyRows();
					const out: string[] = [];
					out.push(...border.render(w), ...title.render(w), ...hint.render(w));
					const slice = lines.slice(offset, offset + h);
					for (const ln of slice) out.push("  " + ln);
					for (let i = slice.length; i < h; i++) out.push(""); // keep the dialog height steady
					const range =
						lines.length > h
							? `— spec lines ${offset + 1}-${Math.min(offset + h, lines.length)}/${lines.length} —`
							: `— full spec shown (${lines.length} lines) —`;
					out.push(...new Text(theme.fg("dim", range), 1, 0).render(w));
					// actions are direct hotkeys (not a SelectList) so the arrows stay free for scrolling:
					//   y = first item (🔏 sign) / o = middle item (⚠️ override — only in the 3-option
					//   gate dialog) / n,Esc = last item or cancel
					out.push(`  ${theme.fg("accent", theme.bold(`[y] ${items[0].label}`))}`);
					if (items.length > 2) out.push(`  ${theme.fg("muted", `[o] ${items[1].label}`)}`);
					const nLabel = (items.length > 2 ? items[2] : items[1])?.label ?? "Decide later";
					out.push(`  ${theme.fg("muted", `[n] ${nLabel}`)}`);
					out.push(...new Text(theme.fg("dim", "↑↓ line • ←→ page • g top • G bottom"), 1, 0).render(w));
					out.push(...border.render(w));
					return panelize(theme, out, w);
				},
				invalidate: () => {
					cachedWidth = -1;
				},
				handleInput: (data: string) => {
					// direct hotkeys instead of ↑↓+Enter: y sign / o override (gate dialog only) /
					// n,Esc later — the done() values must stay identical at every callsite
					// (the gate/approve flow reads 'sign'/'override'/null)
					if (data === "y") done(items[0].value);
					else if (data === "o" && items.length > 2) done(items[1].value);
					else if (data === "n" || matchesKey(data, Key.escape)) done(null);
					else {
						const act = scrollKeyAction(data);
						if (act === "top") offset = 0;
						else if (act === "bottom") offset = maxOffset();
						else if (act) offset = Math.max(0, Math.min(maxOffset(), offset + act.dir * (act.page ? bodyRows() : 1)));
					}
					tui.requestRender();
				},
			};
		});

	/** ext-config: checkbox dialog picking the extensions a sub-agent will load — default
	 *  all-unticked (the user opts in). Returns the array of ticked paths = to be loaded
	 *  (includes), or null on cancel; not a SelectList (that's single-select). */
	const extConfigDialog = (ctx: ExtensionContext, role: string, items: { path: string; label: string; checked: boolean }[]): Promise<string[] | null> =>
		zenseCustom<string[] | null>(ctx, OVERLAY_MD, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			let cursor = 0;
			const checked = items.map((i) => i.checked);
			const visRows = () => Math.max(6, Math.floor(tui.terminal.rows * 0.6));
			return {
				render: (w: number) => {
					const h = visRows();
					const start = Math.max(0, Math.min(cursor - 2, Math.max(0, items.length - h)));
					const out: string[] = [];
					out.push(...border.render(w));
					out.push(...new Text(theme.fg("accent", theme.bold(`🧩 sub-agent extensions — role "${role}" (default: bare boot · space = opt into loading)`)), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", "↑↓ move • space toggle • a = load all • n = load none • enter save • esc cancel"), 1, 0).render(w));
					for (let i = start; i < Math.min(items.length, start + h); i++) {
						const box = checked[i] ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
						const mark = i === cursor ? theme.fg("accent", "▸") : " ";
						const line = ` ${mark} ${box} ${items[i].label}`;
						out.push(i === cursor ? theme.bold(line) : line);
					}
					if (items.length > h) out.push(...new Text(theme.fg("dim", `— ${start + 1}-${Math.min(start + h, items.length)}/${items.length} —`), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", `${checked.filter(Boolean).length}/${items.length} extensions will load`), 1, 0).render(w));
					out.push(...border.render(w));
					return panelize(theme, out, w);
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
					else if (matchesKey(data, Key.down)) cursor = Math.min(items.length - 1, cursor + 1);
					else if (data === " ") checked[cursor] = !checked[cursor];
					else if (data === "a") checked.fill(true);
					else if (data === "n") checked.fill(false);
					else if (matchesKey(data, Key.enter)) {
						// includes = the ticked ones — this used to return exclusions (!checked),
						// flipping the effect (unticked ones got loaded)
						done(items.filter((_, i) => checked[i]).map((it) => it.path));
						return;
					} else if (matchesKey(data, Key.escape)) {
						done(null);
						return;
					}
					tui.requestRender();
				},
			};
		});

	// ----- zense's shared picker: title + search filter + SelectList (reused for role/model picking)

	const zensePick = (ctx: ExtensionContext, title: string, items: SelectItem[], hint = ""): Promise<string | null> =>
		zenseCustom<string | null>(ctx, OVERLAY_MD, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const selectList = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			let filter = "";
			return {
				render: (w: number) =>
					panelize(theme, [
						...border.render(w),
						...new Text(theme.fg("accent", theme.bold(title)), 1, 0).render(w),
						...new Text(theme.fg("dim", `filter: ${filter || "(type to filter)"}${hint ? ` • ${hint}` : ""}`), 1, 0).render(w),
						...selectList.render(w),
						...new Text(theme.fg("dim", "↑↓ select • Enter confirm • Esc cancel • type = filter"), 1, 0).render(w),
						...border.render(w),
					], w),
				invalidate: () => {
					selectList.invalidate();
				},
				handleInput: (data: string) => {
					// navigation/confirm/cancel keys go to SelectList — printable chars feed the filter
					if (matchesKey(data, Key.backspace)) {
						filter = filter.slice(0, -1);
						selectList.setFilter(filter);
					} else if (data.length === 1 && data >= " " && !matchesKey(data, Key.enter)) {
						filter += data;
						selectList.setFilter(filter);
					} else {
						selectList.handleInput(data);
					}
					tui.requestRender();
				},
			};
		});

	// ----- requirements' clarify questions: with choices → picker (pick an option, or "Other
	// (type your own)"); without → direct input

	/** Ask one clarify question: empty choices → the old free-text input; with choices →
	 *  zensePick ending in "Other (type your own)", which opens a free-text input. Esc
	 *  (picker/input) → undefined = skip (matches input's original Esc semantics). */
	const askClarifyQuestion = async (ctx: ExtensionContext, q: ClarifyQuestion): Promise<string | undefined> => {
		if (!q.choices.length) return ctx.ui.input(`❓ requirements asks: ${q.question}`, "(a short answer is fine — Esc/empty = skip)");
		const FREE_TEXT = "__clarify_free_text__";
		const picked = await zensePick(ctx, `❓ requirements asks: ${q.question}`, [
			...q.choices.map((c) => ({ value: c, label: c })),
			{ value: FREE_TEXT, label: "Other (type your own)", description: "pick this, then type your answer" },
		]);
		if (picked === null) return undefined;
		if (picked === FREE_TEXT) return ctx.ui.input(`❓ requirements asks: ${q.question}`, "(type your answer — Esc/empty = skip)");
		return picked;
	};

	// ----- live sub-agent observability: watch output as it runs (is it stuck or not?)

	const tailViewer = (ctx: ExtensionContext, run: SubagentRun): Promise<null> =>
		zenseCustom<null>(ctx, OVERLAY_XL, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const tick = setInterval(() => tui.requestRender(), 1_000); // auto-refresh every 1s
			// whole log wrapped with wrapTextWithAnsi (ANSI preserved) instead of truncate — long
			// lines read fully, not chopped to "…"; cached on (width,size,mtime) so a big log
			// isn't re-wrapped every frame (1s refresh)
			let cacheKey = "";
			let wrapped: string[] = [];
			let offset = 0;
			let follow = true; // default: stick to the tail like before — scrolling up pauses, hitting bottom resumes
			const rows = () => Math.max(4, Math.floor(tui.terminal.rows * 0.9) - 6);
			const maxOffset = () => Math.max(0, wrapped.length - rows());
			const readWrapped = (wWrap: number): string[] => {
				const st = run.logPath && existsSync(run.logPath) ? statSync(run.logPath) : null;
				const key = `${wWrap}:${st ? `${st.size}:${Math.round(st.mtimeMs)}` : "none"}`;
				if (key !== cacheKey) {
					cacheKey = key;
					const raw = st ? readFileSync(run.logPath!, "utf8").split("\n") : ["(waiting for output…)"];
					wrapped = raw.flatMap((ln) => wrapTextWithAnsi(ln, wWrap));
				}
				return wrapped;
			};
			return {
				render: (w: number) => {
					const lines = readWrapped(Math.max(20, w - 4));
					// 90% of rows per OVERLAY_XL − 6 lines of header/tail/border — prevents clipping when rendered as an overlay
					const h = rows();
					if (follow) offset = maxOffset(); // stick to the tail until the user scrolls up
					offset = Math.max(0, Math.min(offset, maxOffset()));
					const status =
						run.status === "running"
							? `▶ running ${Math.round((Date.now() - (run.startedAt ?? run.at)) / 1000)}s`
							: run.ok
								? "✅ done"
								: "❌ failed";
					const out: string[] = [];
					out.push(...border.render(w));
					out.push(...new Text(theme.fg("accent", theme.bold(`🧪 sub-agent: ${run.role} — ${status}`)), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", run.logPath ? relative(ctx.cwd, run.logPath) : "(no log)"), 1, 0).render(w));
					const slice = lines.slice(offset, offset + h);
					for (const ln of slice) out.push("  " + ln);
					for (let i = slice.length; i < h; i++) out.push(""); // steady height, like the spec sign dialog
					const range = follow
						? "▶ tail (following end of log)"
						: `⏸ lines ${offset + 1}-${Math.min(offset + h, lines.length)}/${lines.length} — press G to resume following`;
					out.push(...new Text(theme.fg("dim", range), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", "auto refresh 1s • ↑↓ scroll • ←→ page • g/G top/bottom • Esc close (sub-agent keeps running)"), 1, 0).render(w));
					out.push(...border.render(w));
					return panelize(theme, out, w);
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { done(null); return; }
					const act = scrollKeyAction(data);
					if (act === "top") { offset = 0; follow = false; }
					else if (act === "bottom") { follow = true; offset = maxOffset(); }
					else if (act) {
						if (act.dir < 0) follow = false; // scrolling up = stop following
						offset = Math.max(0, Math.min(maxOffset(), offset + act.dir * (act.page ? rows() : 1)));
						if (offset >= maxOffset()) follow = true; // scrolling back to the bottom = resume following
					}
					tui.requestRender();
				},
				dispose: () => clearInterval(tick),
			};
		});

	const runLabel = (r: SubagentRun) =>
		`${r.status === "running" ? "▶" : r.ok ? "✅" : "❌"} ${r.role} @ ${new Date(r.startedAt ?? r.at).toLocaleTimeString()}`;

	const openAgentsViewer = async (ctx: ExtensionContext): Promise<void> => {
		const runs = state.subagentRuns;
		if (!runs.length) {
			ctx.ui.notify("no sub-agent runs in this session yet", "info");
			return;
		}
		const recent = runs.slice(-15).map((r, i) => ({ run: r, idx: runs.length - Math.min(runs.length, 15) + i })).reverse(); // newest first
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				recent.map(({ run: r }) => `${runLabel(r)}  log: ${r.logPath ? relative(ctx.cwd, r.logPath) : "—"}`).join("\n"),
				"info",
			);
			return;
		}
		const picked = await zenseCustom<string | null>(ctx, OVERLAY_MD, (tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("🧪 Zense sub-agent runs (pick one for a live tail)")), 1, 0));
			const list = new SelectList(
				recent.map(({ run: r, idx }) => ({
					value: String(idx),
					label: runLabel(r),
					description: `${r.summary ? r.summary.slice(0, 80) : ""} ${r.logPath ? "| " + relative(ctx.cwd, r.logPath) : ""}`.trim(),
				})),
				Math.min(recent.length, 10),
				{
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • Enter watch • Esc cancel"), 1, 0));
			container.addChild(new Spacer(1));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (w: number) => panelize(theme, container.render(w), w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
		const runIdx = picked == null ? -1 : Number(picked);
		if (runIdx < 0 || !state.subagentRuns[runIdx]) return;
		await tailViewer(ctx, state.subagentRuns[runIdx]);
	};

	/** 🔏 The spec signature — one helper shared by the zense_spec dialog, the gate dialog and
	 *  /zense approve */
	const approveCurrentSpec = (ctx: ExtensionContext) => {
		if (!state.spec) return false;
		state.spec.approved = true;
		state.spec.approvedAt = Date.now();
		state.phase = "implementation";
		// this round's git-evidence baseline: main repo HEAD before worktree creation
		// (best-effort — not a repo → undefined)
		{
			const baseRef = gitOk(["rev-parse", "HEAD"], ctx.cwd);
			state.baselineHead = baseRef.ok ? baseRef.out.trim() : undefined;
		}
		// auto worktree-per-session: create this session's worktree at implementation start
		// (no source writes could exist before — the gate blocks them) → every tool call is
		// redirected into it until eval PASS. Reuse the existing one when still on disk:
		// signing a new spec version mid-implementation must not orphan pending work in the old
		// worktree (the branch name keeps the old version number — cosmetic only; the merge
		// message already uses the current spec.version)
		if (canReuseWorktree(state.worktree)) {
			learn(ctx, `worktree reused: ${state.worktree!.branch} for spec v${state.spec.version}`);
		} else {
			const wt = createWorktree(ctx.cwd, state.spec);
			if (wt) {
				state.worktree = wt;
				state.worktreeLeaveNotified = false;
				learn(ctx, `worktree created: ${wt.branch} @ ${wt.root}`);
			} else {
				ctx.ui.notify(`🌳 couldn't create a worktree — working in main as normal (no per-session isolation)`, "warning");
			}
		}
		// spec.json/spec.md + the archive are still written approved:false (at commit time) —
		// sync the signature into the files before finishing
		syncApprovedSpecFiles(ctx.cwd, state.spec, { json: state.specJsonPath, md: state.specMdPath });
		// guard: an earlier spec's change is still staged awaiting a commit → warn early (the
		// next apply hits the dirty-main guard anyway)
		if (state.pendingApply)
			ctx.ui.notify(`⚠ spec v${state.pendingApply.specVersion} still has staged changes awaiting a commit in main — commit or discard them before starting new work (otherwise spec v${state.spec.version}'s apply will be refused by the guard)`, "warning");
		learn(ctx, `signed spec v${state.spec.version}`);
		persist();
		updateWidget(ctx);
		ctx.ui.notify(`🔏 Spec v${state.spec.version} signed — implementation gate open.`, "info");
		return true;
	};

	/** B: commit a spec in one step — new version + append-only archive into specs/ + latest
	 *  copies + immediate sign dialog. One helper shared by action=set (agent-authored) and
	 *  compile_spec (sub-agent-drafted) — identical behavior on both paths, no drift. */
	const commitSpec = async (
		ctx: ExtensionContext,
		fields: { title?: string; intent?: string; approach?: string[]; scope?: string[]; constraints?: string[]; criteria?: Criterion[]; specDebt?: string[] },
		source: "set" | "compile",
		// longrun: the signed tracker IS the signature — no dialog; provenance recorded on the
		// spec; baselineOverride pins git evidence to the phase start (longrun branch HEAD),
		// not to main's HEAD (which never moves during a longrun — ADR-004)
		opts?: { sign?: "ask" | "auto"; provenance?: string; baselineOverride?: string },
	): Promise<{ version: number; signed: boolean; mdPath: string; changes?: string[]; lint?: string[] }> => {
		const version = (state.spec?.version ?? 0) + 1;
		// deterministic commit-time check lint (one choke point for both action=set and
		// compile_spec): spec-side broken checks (dead command/placeholder/unrunnable) must
		// never reach eval (probe-primacy loops) → forced into specDebt so the human sees them
		// at signing; artifact-fail (good command, work not yet implemented) = normal → quiet
		let lintNotes: string[] = [];
		if (fields.criteria?.length) {
			const lint = lintSpecChecks(ctx.cwd, fields.criteria);
			if (lint.broken.length) {
				const existing = fields.specDebt ?? [];
				// dedupe against applyQualityGate entries already added for the same id
				// (placeholder/manual-check)
				const covered = (id: string): boolean => existing.some((d) => d.startsWith("quality-gate:") && d.includes(id));
				lintNotes = lint.notes.filter((_, i) => !covered(lint.broken[i]));
				fields = { ...fields, specDebt: [...existing, ...lintNotes] };
			}
		}
		// resolve the previous spec before overwriting — session state if present; after a
		// reload/resume the state is gone → best-effort fallback to .zense/spec.json (the latest
		// copy is still the old version at this point)
		let prevSpec: Spec | undefined = state.spec;
		if (!prevSpec) {
			try {
				const latestJson = join(zenseDir(ctx.cwd), "spec.json");
				if (existsSync(latestJson)) {
					const p = JSON.parse(readFileSync(latestJson, "utf8")) as Spec;
					if (p && typeof p.version === "number") prevSpec = p;
				}
			} catch {
				/* best-effort: unreadable → simply no Changes section; never break the commit */
			}
		}
		state.spec = {
			version,
			title: fields.title ?? "untitled",
			intent: fields.intent ?? "",
			approach: fields.approach ?? [],
			scope: fields.scope ?? [],
			constraints: fields.constraints ?? [],
			criteria: fields.criteria ?? [],
			specDebt: fields.specDebt ?? [],
			approved: false,
		};
		// re-spec (v>=2): always compute the change summary vs the previous version — the signer
		// must see what this version changes; never re-present an identical spec silently.
		// identical → buildSpecChanges returns a warning line + a lesson is logged (no block:
		// some flows re-version on purpose) | v1 has no prev → no changesFrom, unchanged behavior
		if (prevSpec && version >= 2) {
			const changes = buildSpecChanges(prevSpec, state.spec);
			state.spec.changesFrom = changes;
			if (changes.length === 1 && changes[0].startsWith("⚠️"))
				learn(ctx, `spec v${version} re-spec identical to v${version - 1} (no changes)`);
		}
		state.specSource = source; // H: remember the spec's origin — telemetry at gate overrides
		// Specs are append-only: every version gets a unique timestamped file in
		// .zense/specs/ so any past spec can be re-read. spec.{json,md} stay as
		// always-latest convenience copies.
		mkdirSync(zenseDir(ctx.cwd), { recursive: true });
		const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); // YYYY-MM-DD-HH-mm-ss
		const slug =
			(state.spec.title ?? "untitled").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
			"untitled";
		const specDir = join(zenseDir(ctx.cwd), "specs");
		mkdirSync(specDir, { recursive: true });
		const jsonPath = join(specDir, `${stamp}-v${version}-${slug}.json`);
		const mdPath = join(specDir, `${stamp}-v${version}-${slug}.md`);
		writeFileSync(jsonPath, JSON.stringify(state.spec, null, 2));
		writeFileSync(mdPath, renderSpecMd(state.spec));
		copyFileSync(jsonPath, join(zenseDir(ctx.cwd), "spec.json"));
		copyFileSync(mdPath, join(zenseDir(ctx.cwd), "spec.md"));
		state.specMdPath = mdPath;     // zense_eval appends its outcome to this file
		state.specJsonPath = jsonPath;
		// signing moment (zense/sign): ask for approval as soon as the spec is presented.
		// The spec was archived to disk first — the dialog shows the full text to read before
		// signing (TUI)
		let signed = false;
		if (opts?.sign === "auto") {
			state.spec.approvedBy = opts.provenance;
			signed = true;
			approveCurrentSpec(ctx);
			if (opts.baselineOverride) state.baselineHead = opts.baselineOverride;
			if (opts.provenance) learn(ctx, `spec v${state.spec.version} auto-approved by ${opts.provenance} (tracker signature)`);
		} else if (ctx.hasUI && ctx.mode === "tui") {
			const choice = await specSignDialog(ctx, state.spec, `Sign spec v${version}: ${state.spec.title}?`, [
				{ value: "sign", label: "🔏 Sign & approve — open the implementation gate", description: "a human signature = the agent may start implementing" },
				{ value: "later", label: "✏️ Not yet (I want to amend the spec first)", description: "sign later with /zense approve" },
			]);
			signed = choice === "sign";
			if (signed) approveCurrentSpec(ctx);
		} else if (ctx.hasUI) {
			const choice = await ctx.ui.select(
				`🔏 Sign spec v${version}: ${state.spec.title}? (full text at .zense/spec.md)`,
				[
					"🔏 Sign & approve — open the implementation gate",
					"✏️ Not yet (amend the spec first / sign later with /zense approve)",
				],
			);
			signed = !!choice && choice.startsWith("🔏");
			if (signed) approveCurrentSpec(ctx);
		}
		persist();
		updateWidget(ctx);
		return { version, signed, mdPath, ...(state.spec.changesFrom?.length ? { changes: state.spec.changesFrom } : {}), ...(lintNotes.length ? { lint: lintNotes } : {}) };
	};

	/** Suffix appended to zense_spec's tool result: a re-spec (v>=2) must also surface the
	 *  change summary to the agent/human in the transcript — not just in the dialog/archive
	 *  (an identical spec carries a ⚠️ warning line from buildSpecChanges). */
	const changesText = (r: { version: number; changes?: string[] }): string =>
		r.changes?.length
			? `\n\nChanges in v${r.version} (vs v${r.version - 1}):\n${r.changes.map((x) => `- ${x}`).join("\n")}`
			: "";

	// ----- tools exposed to the agent ("phase sub-agents" via pi.registerTool)

	pi.registerTool({
		name: "zense_spec",
		label: "Zense Spec",
		description:
			"Phase 1 (Requirements): compile conversation requirements into a structured, versioned spec artifact with machine-checkable acceptance criteria. Human approval is required before implementation.",
		promptSnippet: "Compile/approve the structured spec: intent, scope, criteria, spec-debt",
		promptGuidelines: [
			"Use zense_spec before any implementation to write the spec; list unverifiable requirements under specDebt.",
			"Prefer action=compile_spec: a read-only requirements sub-agent explores the repo, drafts machine-checkable criteria, asks the human clarifying questions if ambiguous, and commits the spec for signing in one step.",
			"A spec exists ONLY when committed via this tool — presenting it as chat text (pasting JSON/prose into the conversation) registers nothing, and /zense approve will then find 'No spec to approve'.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("set"), Type.Literal("compile_spec")] as const),
			intent: Type.Optional(Type.String({ description: "What the user wants and why" })),
			approach: Type.Optional(Type.Array(Type.String(), { description: "Planned work outline for the signer: main steps, files to create/modify, expected outcomes (presentational — not machine-checked)" })),
			scope: Type.Optional(Type.Array(Type.String(), { description: "Path prefixes the agent may modify" })),
			constraints: Type.Optional(Type.Array(Type.String())),
			criteria: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						text: Type.String(),
						check: Type.String({ description: CHECK_FORMAT_CONTRACT }),
					}),
				),
			),
			specDebt: Type.Optional(Type.Array(Type.String(), { description: "Unverifiable → forced human review" })),
			title: Type.Optional(Type.String()),
		}),
		async execute(_id, params, sig, _on, ctx) {
			if (params.action === "compile_spec") {
				if (!params.intent?.trim())
					return { content: [{ type: "text", text: "compile_spec requires intent — pass the user's request summary as intent and call again" }], details: {}, isError: true };
				// pre-spec dirty guard: this spec's worktree will branch from the HEAD at approval —
				// uncommitted changes in main would neither follow into the worktree nor be covered
				// by the baseline (baselineHead=HEAD) → ask the human before burning sub-agent budget
				let preSpecNote = "";
				// not a git repo → this feature is fully off (no check/ask/warn) — a project without
				// git has no baseline anyway
				const preDirty = isGitRepo(ctx.cwd) ? uncommittedChanges(ctx.cwd) : [];
				if (preDirty.length && ctx.hasUI) {
					persist(); updateWidget(ctx);
					const preview = preDirty.slice(0, 10).join("\n") + (preDirty.length > 10 ? `\n… (+${preDirty.length - 10} more)` : "");
					const choice = await ctx.ui.select(
						`⚠️ ${preDirty.length} uncommitted change(s) pending in main (outside .zense):\n${preview}\n\na new spec = baseline at the current HEAD — anything still uncommitted will not follow into the worktree when implementation starts`,
						[
							"📦 commit for me (snapshot the pending changes, then continue compiling)",
							"⏩ skip — continue compiling without committing",
							"🖐 I'll handle it myself — cancel this compile for now (Esc also cancels)",
						],
					);
					if (choice === undefined || choice.startsWith("🖐")) {
						return { content: [{ type: "text", text: `⏸ compile cancelled as chosen — ${preDirty.length} uncommitted change(s) in main\n\nWait for the human to deal with them (commit/stash), then call zense_spec compile_spec again — do not continue compiling on your own until the human says so` }], details: { preSpec: "aborted-dirty", dirty: preDirty }, isError: true };
					}
					if (choice.startsWith("📦")) {
						const snap = snapshotUncommitted(ctx.cwd, composeSnapshotMessage(preDirty));
						if (!snap.ok)
							return { content: [{ type: "text", text: `⚠️ snapshot commit failed: ${snap.msg}\ncommit manually, then call zense_spec compile_spec again` }], details: { preSpec: "snapshot-failed", dirty: preDirty }, isError: true };
						ctx.ui.notify(`📦 snapshotted ${preDirty.length} pending change(s) → ${snap.msg} — continuing compile`, "info");
						learn(ctx, `spec-compile: pre-spec snapshot commit ${snap.msg} (${preDirty.length} files)`);
					} else {
						state.trajectoryFlags.push(`spec compiled on a dirty main (${preDirty.length} uncommitted files)`);
						learn(ctx, `flag: pre-spec dirty skip — compiled while main had ${preDirty.length} uncommitted change(s)`);
						preSpecNote = ` ⚠️ main has ${preDirty.length} uncommitted change(s) (the human chose to skip) — baseline=HEAD does not cover them`;
					}
				} else if (preDirty.length) {
					// no UI to ask with — keep compiling, but flag it and warn in the result so the
					// agent can tell the human
					state.trajectoryFlags.push(`spec compiled on a dirty main (${preDirty.length} uncommitted files, no UI to ask)`);
					learn(ctx, `flag: pre-spec dirty (no UI) — compiled while main had ${preDirty.length} uncommitted change(s)`);
					preSpecNote = ` ⚠️ couldn't ask the human (no UI): main has ${preDirty.length} uncommitted change(s) — baseline=HEAD does not cover them; the human should commit/stash before implementation starts`;
				}
				const t0 = Date.now();
				// Layer 3 (learning loop): accumulated lessons from memory.jsonl go into the prompt as
				// before, so the new spec reflects past incidents (scope once too wide, frequent overrides…)
				const lessons = memorySummaryLines(ctx.cwd);
				state.lastCompileLessons = lessons.length ? aggregateMemory(ctx.cwd).total : 0;
				// W3: context priming + few-shot exemplar — the harness prepares the evidence/example
				// up front instead of hoping the model explores on its own
				const facts = gatherRepoFacts(ctx.cwd);
				const exemplar = loadSpecExemplar(ctx.cwd);
				let intent = params.intent.trim();
				let launches = 0;
				let clarifyRounds = 0;      // F: Q&A rounds with the human (max 4 — wayfinder-style grilling may loop, capped to avoid nagging)
				let parseRetried = false;   // A: one retry on invalid JSON
				let clarifyClosed = false;  // questions were pushed to specDebt — never clarify again (prevents an endless loop)
				// one loop handles both clarify (F) and parse-retry (A) — total budget 7 launches
				// (4 clarify + retry + final draft fit exactly)
				while (launches < 7) {
					launches++;
					// Esc before this (re)launch → stop the loop instead of spawning another sub-agent
					if (sig?.aborted)
						return { content: [{ type: "text", text: "⏸ compile_spec cancelled by the user (Esc) — the user interrupted on purpose — do NOT retry on your own; ask what they'd like instead" }], details: { cancelled: true }, isError: true };
					const draft = await launchSubagent(ctx, "requirements", buildRequirementsPrompt(intent, lessons, facts, exemplar, subagentTimeout("requirements", state.worktree?.root ?? ctx.cwd, ctx.cwd)), undefined, sig);
					if (!draft.ok && sig?.aborted)
						return { content: [{ type: "text", text: `⏸ compile_spec cancelled by the user (Esc) — the requirements sub-agent was killed mid-run (log: ${relative(ctx.cwd, draft.logPath)}). The user interrupted on purpose — do NOT retry on your own; ask what they'd like instead` }], details: { cancelled: true, logPath: draft.logPath }, isError: true };
					if (!draft.ok) return { content: [{ type: "text", text: `sub-agent failed: ${draft.output}` }], details: draft };
					const parsed = parseSpecDraft(draft.output);
					if (parsed.kind === "clarify" && !clarifyClosed && clarifyRounds < 4 && ctx.hasUI) {
						// F: ask the human one question at a time (Esc/blank = skip) — unanswered
						// questions go to specDebt, drafting continues conservatively
						clarifyRounds++;
						learn(ctx, `spec-draft: clarify round ${clarifyRounds} — ${parsed.questions.length} questions`);
						const answers: string[] = [];
						for (const q of parsed.questions) {
							const a = await askClarifyQuestion(ctx, q);
							if (a === undefined) break;
							if (a.trim()) answers.push(`- Q: ${q.question}\n  A: ${a.trim()}`);
						}
						const unanswered = parsed.questions.slice(answers.length);
						if (answers.length) intent += `\n\nHuman clarifications (authoritative — refine the request accordingly):\n${answers.join("\n")}`;
						if (unanswered.length) {
							clarifyClosed = true;
							intent += `\n\nUnanswered clarifying questions — list them in specDebt and proceed with conservative, explicit assumptions:\n${unanswered.map((q) => `- ${q.question}`).join("\n")}`;
						}
						continue;
					}
					if (parsed.kind === "clarify") {
						// genuinely can't ask (no UI / rounds exhausted / skipped) — questions go to
						// specDebt, drafting continues conservatively
						clarifyClosed = true;
						learn(ctx, `spec-draft: clarify forfeited (${!ctx.hasUI ? "no UI" : "rounds exhausted"}) — questions → specDebt`);
						intent += `\n\nClarifying questions that could NOT be asked — list them in specDebt and draft the spec with conservative, explicit assumptions:\n${parsed.questions.map((q) => `- ${q.question}`).join("\n")}`;
						continue;
					}
					if (parsed.kind === "error") {
						// A: one retry with specific feedback — the model fixes its output far more
						// accurately against a pointed error than against a bare "try again"
						if (!parseRetried) {
							parseRetried = true;
							learn(ctx, `spec-draft: JSON invalid — retrying with feedback (${parsed.error.slice(0, 120)})`);
							intent += `\n\nSYSTEM FEEDBACK: your previous output failed validation: ${parsed.error}. Return ONLY the corrected JSON object under the same rules — no fences, no commentary.`;
							continue;
						}
						learn(ctx, `spec-draft: JSON invalid after retry — returning the raw draft for the main agent to handle (legacy path)`);
						return { content: [{ type: "text", text: `draft validation failed (${parsed.error}) — raw output:\n${draft.output}` }], details: draft };
					}
					// G: harness-side quality gate before committing (empty scope / unrunnable check /
					// duplicate → specDebt)
					const gated = applyQualityGate(ctx.cwd, parsed.draft);
					if (gated.notes.length) learn(ctx, `spec-draft: quality-gate → ${gated.notes.join(", ")}`);
					// B: parsed OK → commit + sign dialog in one step (no action=set round-trip)
					const r = await commitSpec(ctx, gated.draft, "compile");
					// H: one-line telemetry per compile — the loop teaches itself whether it's slow,
					// how many questions it asked, what the gate found
					learn(ctx, `spec-compile: v${r.version} launches=${launches} clarify=${clarifyRounds} gate=[${gated.notes.join(",")}] check-lint=${r.lint?.length ?? 0} ${Date.now() - t0}ms signed=${r.signed}`);
					const verb = r.signed
						? "SIGNED 🔏 — human signature complete, implementation gate open"
						: "NOT approved — sign later with /zense approve";
					return {
						content: [{ type: "text", text: `Spec v${r.version} compiled by requirements sub-agent → committed one-step, archived at ${r.mdPath} (latest copies: .zense/spec.{json,md}). ${verb}.${clarifyRounds ? ` clarify rounds: ${clarifyRounds}.` : ""}${gated.notes.length ? ` quality-gate: ${gated.notes.join(", ")} (details in specDebt).` : ""}${r.lint?.length ? ` check-lint: ${r.lint.length} check(s) the probe can't run — fix the check, then re-spec (details in specDebt).` : ""}` + changesText(r) + preSpecNote }],
						details: { version: r.version, approved: r.signed, clarifyRounds, qualityGate: gated.notes, logPath: draft.logPath, ...(r.lint?.length ? { checkLint: r.lint } : {}) },
					};
				}
				return { content: [{ type: "text", text: `compile_spec used all ${launches} launches and still only got clarify/error — make the intent clearer and call again` }], details: {}, isError: true };
			}
			// action=set: the agent writes the spec itself, then commits — the same commitSpec as
			// compile (B) → identical behavior
			const r = await commitSpec(ctx, params, "set");
			if (r.lint?.length) learn(ctx, `spec-set: v${r.version} check-lint → ${r.lint.length} broken check(s) pushed to specDebt`);
			const verb = r.signed
				? "SIGNED 🔏 — human signature complete, implementation gate open"
				: "NOT approved — sign later with /zense approve";
			return {
				content: [{ type: "text", text: `Spec v${r.version} archived at ${r.mdPath} (latest copies: .zense/spec.{json,md}). ${verb}.${r.lint?.length ? ` check-lint: ${r.lint.length} check(s) the probe can't run — fix the check, then re-spec (details in specDebt).` : ""}` + changesText(r) }],
				details: { version: r.version, approved: r.signed, ...(r.lint?.length ? { checkLint: r.lint } : {}) },
			};
		},
	});

	pi.registerTool({
		name: "zense_adr",
		label: "Zense ADR",
		description:
			"Phase 2 (Design): record an Architecture Decision Record. One-way-door decisions need human approval (/zense adr-approve N). ADRs are re-read before every implementation run and DENY rules are enforced live.",
		promptSnippet: "Record an architecture decision (ADR) with status and optional DENY rules",
		parameters: Type.Object({
			title: Type.String(),
			decision: Type.String(),
			consequences: Type.String(),
			irreversible: Type.Boolean({ description: "One-way door → human approval gate" }),
			denyRules: Type.Optional(Type.Array(Type.String(), { description: "Path substrings forbidden by this decision" })),
		}),
		async execute(_id, p, _s, _o, ctx) {
			const dir = join(zenseDir(ctx.cwd), "adr");
			mkdirSync(dir, { recursive: true });
			const n = String(readdirAdrs(ctx.cwd).length + 1).padStart(3, "0");
			const file = join(dir, `${n}-${p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`);
			writeFileSync(
				file,
				`# ADR-${n}: ${p.title}\nstatus: ${p.irreversible ? "proposed (NEEDS HUMAN APPROVAL)" : "accepted"}\ndate: ${new Date().toISOString()}\n\n## Decision\n${p.decision}\n\n## Consequences\n${p.consequences}\n` +
					(p.denyRules ?? []).map((d) => `DENY: ${d}\n`).join(""),
			);
			persist();
			return { content: [{ type: "text", text: `ADR-${n} recorded at ${file}${p.irreversible ? " — pending human approval" : ""}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "zense_eval",
		label: "Zense Eval",
		description:
			"Phase 4: dual evaluation — output eval grades the artifact against approved spec criteria (delegated to the grader sub-agent); trajectory flags are attached. Spec-debt items become forced human review.",
		parameters: Type.Object({ note: Type.Optional(Type.String()) }),
		async execute(_id, _p, sig, onUpdate, ctx) {
			if (!state.spec) return { content: [{ type: "text", text: "No spec yet." }], details: {}, isError: true };
			onUpdate?.({ content: [{ type: "text", text: "running probes + grader sub-agent…" }], details: {} });
			// W3: probes — the harness runs criteria[].check itself first (deterministic) as
			// ground truth for the grader, overriding verdicts later (probe primacy). Runs in the
			// worktree when present (the code actually changed), otherwise main
			const evalRoot = state.worktree?.root ?? ctx.cwd;
			const probes = runCheckProbes(evalRoot, state.spec.criteria);
			const probeSummary = probes.map((p) => `${p.id}:${p.status}`).join(",");
			learn(ctx, `eval-probes: spec v${state.spec.version} → ${probeSummary}`);
			const diffSummary = gitChangeSummary(evalRoot, state.baselineHead);
			// stream the grader's output into the transcript live (throttled) — the user sees it
			// actually working instead of guessing whether it's stuck
			let tail = "";
			let lastPush = 0;
			const streamTail = (chunk: string) => {
				tail = (tail + chunk).split("\n").slice(-8).join("\n");
				const now = Date.now();
				if (now - lastPush > 700) {
					lastPush = now;
					onUpdate?.({ content: [{ type: "text", text: `🧪 grader ▶ running… (full log via /zense agents)\n${tail}` }], details: {} });
				}
			};
			// W2: retry loop (budget 3 launches) — contract-violating output (missing ids / no
			// OVERALL / PASS-without-evidence) → pointed feedback goes back for a self-fix instead
			// of one parse that silently ignores gaps.
			// (old bug found while refactoring: the per-criteria regex once wrote `\b` inside a
			//  template literal → materialized as a literal backspace byte in the file → individual
			//  verdicts were never parsed at all; the whole system leaned on the single OVERALL
			//  line!)
			let parsed: GradeParse | null = null;
			let grade: { ok: boolean; output: string; logPath: string } = { ok: false, output: "(not launched)", logPath: "" };
			let feedback = "";
			for (let launch = 0; launch < 3; launch++) {
				grade = await launchSubagent(ctx, "grader", buildGraderPrompt(state.spec, probes, diffSummary, feedback), streamTail, sig);
				if (!grade.ok) break;
				parsed = parseGraderOutput(grade.output, state.spec.criteria);
				const problems: string[] = [];
				if (!parsed.overall) problems.push("missing the final OVERALL line");
				if (parsed.missingIds.length) problems.push(`no verdict given for: ${parsed.missingIds.join(", ")}`);
				if (parsed.passNoEvidence.length) problems.push(`PASS without evidence rejected for: ${parsed.passNoEvidence.join(", ")}`);
				if (!problems.length) break;
				learn(ctx, `grader: output rejected (${problems.join("; ")}) — retry ${launch + 1}/3`);
				feedback = problems.join("; ");
				parsed = null;
			}
			// one probe section shared by FAIL/PASS/deadlock/inconclusive — compacted by M via
			// buildCompactProbeSection (pass collapses to one line; detail only for fail/skipped;
			// raw grade.output points at the log instead of embedding in the transcript).
			// Must be computed before the inconclusive branch below — it used to be declared after
			// it, so an inconclusive eval crashed TDZ "Cannot access 'probeSection' before
			// initialization" instead of escalating to the human
			const probeSection = buildCompactProbeSection(probes);
			// Esc killed the grader → don't escalate "inconclusive" to the human after their own interrupt
			if (!grade.ok && sig?.aborted)
				return { content: [{ type: "text", text: "⏸ eval cancelled by the user (Esc) — the grader sub-agent was killed mid-run. The user interrupted on purpose — do NOT re-run eval on your own; ask what they'd like instead" }], details: { cancelled: true, logPath: grade.logPath }, isError: true };
			// W2 (G): inconclusive — used to be "unknown silently flows to PASS" (= free merge
			// into main) → now escalates for the human to decide, with probe results (hard
			// evidence that's guaranteed to exist) and a non-looping way out (re-eval allowed)
			if (!grade.ok || !parsed || !parsed.overall) {
				const reason = !grade.ok ? "grader sub-agent failed" : "grader output invalid after retries";
				escalate("need-decision", `eval inconclusive: ${reason} — the human decides from the probes or orders a re-eval`, ctx);
				learn(ctx, `eval: spec v${state.spec.version} → inconclusive (${reason})`);
				persist(); updateWidget(ctx);
				return {
					content: [{ type: "text", text: `⚠️ Eval INCONCLUSIVE — ${reason}\nprobes: ${probeSummary}${probeSection}\n\ncannot decide reliably: the human should read the probe results above and decide themselves (a need-decision escalation has been recorded — /zense status), or order another zense_eval\n\n🧪 raw grader output is in the log: ${relative(ctx.cwd, grade.logPath)} — read it yourself if needed` }],
					details: { inconclusive: true, reason, probes, logPath: grade.logPath },
					isError: true,
				};
			}
			// W3: probe primacy — probe fail = criterion FAIL, overriding the grader's verdict
			// (probes are what the harness ran itself; a PASS from the grader on a red probe can't
			// be trusted — fooled)
			const probeOverrides: string[] = [];
			for (const p of probes)
				if (p.status === "fail" && parsed.perCriteria[p.id] !== "FAIL") {
					parsed.perCriteria[p.id] = "FAIL";
					parsed.evidence[p.id] = `probe override: ${p.detail}`;
					if (!parsed.failedIds.includes(p.id)) parsed.failedIds.push(p.id);
					probeOverrides.push(p.id);
				}
			if (probeOverrides.length) learn(ctx, `grader: probe overrides → FAIL [${probeOverrides.join(",")}]`);
			const failedCriteria = parsed.failedIds;
			const verdict = failedCriteria.length || parsed.overall === "FAIL" ? "FAIL" : "PASS";
			// M: the shared view for every branch — a pure builder renders the text (PASS/FAIL);
			// deadlock/inconclusive append their own directives
			const evalView: EvalResultView = {
				verdict,
				criteria: state.spec.criteria,
				perCriteria: parsed.perCriteria,
				evidence: parsed.evidence,
				failedIds: failedCriteria,
				probeOverrides,
				probes,
				trajectory: state.trajectoryFlags,
				specDebt: state.spec.specDebt,
				logPath: relative(ctx.cwd, grade.logPath),
			};
			learn(ctx, `eval: spec v${state.spec.version} → grader.ok=${grade.ok} verdict=${verdict} judged=${Object.keys(parsed.perCriteria).length}/${state.spec.criteria.length} failed=[${failedCriteria.join(",")}]${probeOverrides.length ? ` probeOverrides=[${probeOverrides.join(",")}]` : ""}`);
			// W2: keep evidence as reviewer input (zense_review builds its pack from lastEval).
			// Evidence is pinned to the current round: specVersion + tree SHA of the evaluated
			// tree (HEAD^{tree} — a tree, not a commit SHA, on purpose: apply-back after PASS
			// yields identical content (repinned as the index tree via write-tree), so an
			// ordinary round must not turn stale; the reviewer re-checks at review time)
		const evalTree = gitOk(["rev-parse", "HEAD^{tree}"], evalRoot);
		state.lastEval = {
			verdict, perCriteria: parsed.perCriteria, failedIds: failedCriteria, probes, at: Date.now(),
			specVersion: state.spec.version,
			...(evalTree.ok ? { head: evalTree.out.trim() } : {}),
		};
			// record the eval outcome into spec .md (archive + latest copy) as a new trailing
			// section (append-only, never overwrites)
			const evalTs = new Date().toISOString();
			const evalSection =
				`\n\n## Eval ${evalTs}\nverdict: **${verdict}** (grader.ok=${grade.ok})\n` +
				`probes (harness-executed): ${probeSummary}\n` +
				`per-criteria:\n${state.spec.criteria.map((c) => `- ${c.id}: ${parsed.perCriteria[c.id] ?? "?"}${parsed.perCriteria[c.id] === "FAIL" ? " — FAIL" : ""} — ${(parsed.evidence[c.id] ?? "").split("\n")[0].slice(0, 120)}`).join("\n")}\n` +
				(failedCriteria.length ? `failed: ${failedCriteria.join(", ")}\n` : "") +
				`\ngrader output:\n${grade.output.slice(-4_000)}\n`;
			if (state.specMdPath && existsSync(state.specMdPath)) appendFileSync(state.specMdPath, evalSection);
			const latestMd = join(zenseDir(ctx.cwd), "spec.md");
			if (existsSync(latestMd)) appendFileSync(latestMd, evalSection);
			if (verdict === "FAIL") {
				// FAIL loop → back to fixing: phase returns to implementation, a need-fix
				// escalation, isError telling the agent to fix + re-eval
				state.phase = "implementation";
				// anti-loop guard: a FAIL made purely of probe overrides (grader passes everything,
				// harness probes stay red) repeating with the same id set on the same spec version —
				// the agent can no longer fix anything (the artifact is correct per the judge; the
				// red checks may stem from a broken check) → DEADLOCK-escalate for a human decision
				// instead of looping "go fix it" forever (real case: c2-c6 overridden every round)
				const soleOverride = failedCriteria.length > 0 && probeOverrides.length === failedCriteria.length;
				const overrideKey = [...probeOverrides].sort().join(",");
				const prevOvf = state.evalOverrideFails;
				const sameOvf = !!(prevOvf && prevOvf.specVersion === state.spec.version && [...prevOvf.ids].sort().join(",") === overrideKey);
				if (soleOverride) {
					if (sameOvf && prevOvf && prevOvf.count >= 1) {
						escalate("need-decision", `eval deadlock: probes and grader irreconcilably disagree [${overrideKey}] (spec v${state.spec.version}) — probes keep failing while the grader passes everything`, ctx);
						state.evalOverrideFails = { specVersion: state.spec.version, ids: [...probeOverrides], count: prevOvf.count + 1 };
						persist(); updateWidget(ctx);
						return {
							content: [{ type: "text", text:
								`⚠️ Eval DEADLOCK — probes and grader irreconcilably disagree (spec v${state.spec.version}; a need-decision escalation has been recorded — /zense status)\n` +
								`harness probes keep failing [${overrideKey}] while the grader passes everything with evidence — looping "go fix it" achieves nothing (if the artifact is already right, there's nothing to fix)${probeSection}\n\n` +
								`human decides: if the spec's check commands are broken (placeholder/wrong path) → re-spec with zense_spec as a new version and re-sign; if the artifact is genuinely wrong → say exactly what to change` }],
							details: { deadlock: true, verdict, failedCriteria, probes, trajectory: state.trajectoryFlags },
							isError: true,
						};
					}
					state.evalOverrideFails = { specVersion: state.spec.version, ids: [...probeOverrides], count: sameOvf && prevOvf ? prevOvf.count + 1 : 1 };
				}
				state.escalations.push({ kind: "need-fix", detail: `criteria failed: ${failedCriteria.join(",") || "grader FAIL"}`, at: Date.now() });
				persist(); updateWidget(ctx);
				// M: text from the pure builder — raw grade.output no longer embeds in the
				// transcript (points at the log instead); only failing criteria's evidence shows
				return { content: [{ type: "text", text: buildEvalResultText(evalView) }], details: { ok: grade.ok, verdict, failedCriteria, probes, perCriteria: parsed.perCriteria, evidence: parsed.evidence, probeOverrides, trajectory: state.trajectoryFlags, logPath: grade.logPath }, isError: true };
			}
			// PASS: on to review (unknown is impossible here — inconclusive already escalated).
			// The next step must be spelled out in the returned text (like the FAIL branch) —
			// without it the agent considers itself done and answers the user, so the reviewer
			// never runs.
			delete state.evalOverrideFails; // anti-loop guard: a clean finish resets the counter
			// r1 (2026-09-02): PASS resolves the "go fix it" loop → clear need-fix escalations
			// left over from FAIL rounds; not clearing them lets the reviewer see a stale
			// "criteria failed: c2,c3,c6" in evidence and write a TL;DR contradicting the PASS
			// (real case at spec v1) — need-decision stays (still awaiting a human)
			state.escalations = state.escalations.filter((e) => e.kind !== "need-fix");
			// M: PASS goes through the same builder (verdict selects the text branch); the
			// "call zense_review immediately" directive lives in the builder
			const report = buildEvalResultText(evalView);
			// auto apply-back (ADR-003): on eval PASS → apply the worktree change into main
			// **staged-only, never auto-committed** — the human reviews the diff in main, then
			// makes the final commit (or asks the agent to)
			if (state.worktree && state.longRun) {
				// longrun (ADR-004): eval PASS does NOT apply back — the whole phase set merges at
				// tracker completion. The phase work stays in the longrun worktree; the reviewer
				// reads the phase diff there (baseline = phase start); the human accepts via
				// zense_longrun close (checkpoint commit) or rejects via zense_longrun fail (reset --hard)
				ctx.ui.notify(
					`🌳 longrun ${state.longRun.slug}: eval PASS — phase held in worktree ${state.worktree.branch} for human review (main untouched)\n` +
						`review: open ${state.worktree.root} or run zense_review → accept: zense_longrun close · reject: zense_longrun fail`,
					"info",
				);
			} else if (state.worktree) {
				const wtBranch = state.worktree.branch;
				const preHead = gitOk(["rev-parse", "HEAD"], ctx.cwd); // doesn't move during apply (squash never commits) — kept for reconcile
				const ar = applyWorktreeBack(ctx.cwd, state.spec, state.worktree);
				if (!ar.ok) {
					escalate("need-decision", `worktree apply: ${ar.msg}`, ctx);
					ctx.ui.notify(`⚠ ${ar.msg}`, "warning"); // guard/conflict → worktree kept — the reviewer can still read it
				} else {
					learn(ctx, `worktree applied: ${ar.msg}`);
					state.worktree = null;
					// the reviewer reads main after apply — repin lastEval.head to the **index** tree
					// (staged changes); HEAD^{tree} lacks them → would false-stale every round
					const idxTree = gitOk(["write-tree"], ctx.cwd);
					if (idxTree.ok && state.lastEval) state.lastEval.head = idxTree.out.trim();
					if (ar.paths.length) {
						state.pendingApply = { specVersion: state.spec.version, branch: wtBranch, paths: ar.paths, appliedAt: Date.now(), ...(preHead.ok ? { preApplyHead: preHead.out.trim() } : {}) };
						// ready-made commit message (written to a file — a multi-line message quoted in one
						// command breaks easily)
						try {
							writeFileSync(join(zenseDir(ctx.cwd), PENDING_MSG), ar.commitMsg ?? composeCommitMessage(state.spec, []));
						} catch {
							/* best-effort */
						}
						ctx.ui.notify(
							`🌳 applied into main as **staged — not yet committed** (${ar.paths.length} file(s) from ${wtBranch})\n` +
								`review now: git status · git diff --cached\n` +
								`➡️ once the review passes → commit: git commit -F .zense/pending-apply.msg (or ask the agent to commit)\n` +
								`⚠️ not durable until committed — git stash / reset --hard / checkout . would destroy it\n` +
								`✅ reviewed + committed → /zense accept — closes the pendingApply and records a lesson\n` +
								`↩️ unhappy → zense_discard (or /zense discard) — reverse patch restores main exactly`,
							"info",
						);
					} else {
						ctx.ui.notify(`🌳 worktree applied → main — nothing to stage (interim commits touched only .zense)`, "info");
					}
				}
			}
			state.phase = "review";
			persist(); updateWidget(ctx);
			return { content: [{ type: "text", text: report }], details: { ok: grade.ok, verdict, failedCriteria, trajectory: state.trajectoryFlags } };
		},
	});

	pi.registerTool({
		name: "zense_review",
		label: "Zense Review Packet",
		description: "Phase 5: build the exception-based review packet (TL;DR first, evidence linked, anomalies highlighted).",
		parameters: Type.Object({}),
		async execute(_id, _p, sig, _o, ctx) {
			// phase-order guard: review comes only after eval PASS (phase is set to "review" in
			// zense_eval)
			if (state.phase !== "review")
				return {
					content: [{ type: "text", text: `⛔ can't review yet — current phase is "${state.phase}" (eval must pass first)\ncall \`zense_eval\` first, then come back to zense_review` }],
					details: { phase: state.phase },
					isError: true,
				};
			// W2: evidence pack — lastEval (verdicts+probes), flags, specDebt, escalations and a
			// git summary go to the reviewer (previously a one-line intent → packets guessed,
			// e.g. "To be implemented" written about finished work). Evidence must belong to the
			// current round only: the git summary is scoped to the spec-approval baseline, and a
			// lastEval mismatching the current spec version/tree is cut from the prompt (see
			// isLastEvalStale in buildReviewerPrompt) instead of leaking stale judgments
			const reviewRoot = state.worktree?.root ?? ctx.cwd;
			// ADR-003: after apply, the change lives in the index, not HEAD — pin freshness to the
			// tree at apply time (lastEval.head was repinned to the index tree via write-tree)
			// instead of HEAD^{tree}, else every round turns false-stale; human edits during
			// review aren't stale, just noted for the reviewer below
			const headNow = state.pendingApply
				? state.lastEval?.head
					? { ok: true, out: state.lastEval.head, err: "" }
					: gitOk(["write-tree"], reviewRoot)
				: gitOk(["rev-parse", "HEAD^{tree}"], reviewRoot);
			const freshness = { specVersion: state.spec?.version, ...(headNow.ok ? { head: headNow.out.trim() } : {}) };
			if (isLastEvalStale(state.lastEval, freshness))
				learn(ctx, `review: lastEval stale (spec v${state.lastEval?.specVersion ?? "?"} ≠ v${freshness.specVersion ?? "?"} or the tree changed after eval) — old eval evidence cut from the reviewer prompt`);
			// human edits after eval+apply → the index tree differs from the pin — review
			// continues normally, just noted in the prompt
			const humanEdited = (() => {
				if (!state.pendingApply || !state.lastEval?.head) return false;
				const w = gitOk(["write-tree"], reviewRoot);
				return w.ok && w.out.trim() !== state.lastEval.head;
			})();
			if (humanEdited) learn(ctx, "review: files edited after apply (human edit during review) — noted in the packet");
			const gitEvidencePrefix = buildPendingApplyEvidencePrefix(!!state.pendingApply, humanEdited);
			let packetFeedback = "";
			const packetInput = (): string =>
				buildReviewerPrompt(state.spec?.intent ?? "(no spec)", state.lastEval, state.trajectoryFlags, state.spec?.specDebt ?? [], state.escalations,
					(gitEvidencePrefix ? gitEvidencePrefix + "\n" : "") + gitChangeSummary(reviewRoot, state.baselineHead), packetFeedback, freshness, state.spec?.criteria);
			let reviewer = await launchSubagent(ctx, "reviewer", packetInput(), undefined, sig);
			// Esc killed the reviewer → stop before the retry/grounding chain spawns more sub-agents
			if (!reviewer.ok && sig?.aborted)
				return { content: [{ type: "text", text: "⏸ review cancelled by the user (Esc) — the reviewer sub-agent was killed mid-run. The user interrupted on purpose — do NOT re-run review on your own; ask what they'd like instead" }], details: { cancelled: true, logPath: reviewer.logPath }, isError: true };
			let packetParse = parseReviewerPacket(reviewer.output);
			// A (schema): missing sections → one retry with feedback (replaces the raw 900-char
			// slice that waved anything through)
			if (reviewer.ok && !packetParse.ok) {
				learn(ctx, `reviewer: packet missing sections [${packetParse.missing.join(",")}] — retry`);
				packetFeedback = packetParse.missing.join(", ");
				reviewer = await launchSubagent(ctx, "reviewer", packetInput(), undefined, sig);
				packetParse = parseReviewerPacket(reviewer.output);
			}
			// r5 (grounding): packet tokens absent from the evidence = inventions → one retry with
			// the list; a second strike → trajectory flag "reviewer hallucination" so the human
			// knows to verify the packet before trusting it (review is advisory — never blocks)
			const checkGrounding = (text: string): string[] =>
				findUngroundedTokens(text, packetInput(), (p) => existsSync(join(reviewRoot, p)));
			let ungrounded = reviewer.ok ? checkGrounding(reviewer.output) : [];
			if (ungrounded.length) {
				learn(ctx, `reviewer: ungrounded tokens [${ungrounded.slice(0, 5).join(",")}] — retry`);
				packetFeedback = `ungrounded tokens not present in the evidence (remove them or quote verbatim): ${ungrounded.slice(0, 8).join(", ")}`;
				reviewer = await launchSubagent(ctx, "reviewer", packetInput(), undefined, sig);
				ungrounded = reviewer.ok ? checkGrounding(reviewer.output) : [];
				if (ungrounded.length) {
					state.trajectoryFlags.push(`reviewer hallucination: ${ungrounded.slice(0, 5).join(",")}`);
					learn(ctx, `flag: reviewer hallucination: ${ungrounded.slice(0, 5).join(",")}`);
					ctx.ui.notify(`⚠ reviewer cites tokens absent from the evidence: ${ungrounded.slice(0, 3).join(", ")} — trajectory flag added; verify the packet before using it`, "warning");
				}
			}
			const packet = {
				tlDr: packetParse.ok && packetParse.tldr ? packetParse.tldr : reviewer.output.slice(0, 900),
				trajectory: state.trajectoryFlags,
				specDebt: state.spec?.specDebt ?? [],
				escalations: state.escalations,
			};
			pi.appendEntry("zense-review-packet", packet);
			learn(ctx, `review packet: flags=${packet.trajectory.length}, escalations=${packet.escalations.length}, sections-ok=${packetParse.ok}${packetParse.missing.length ? ` missing=[${packetParse.missing.join(",")}]` : ""}`);
			// M: result text via the pure builder — previously the raw packet's slice(0,4_000)
			// entered the history permanently; the full packet still lives in details{} + the
			// review card + the log
			const reviewText = reviewer.ok
				? buildReviewResultText({ ok: true, tlDr: packet.tlDr, trajectoryCount: packet.trajectory.length, escalationCount: packet.escalations.length, logPath: relative(ctx.cwd, reviewer.logPath) })
				: buildReviewResultText({ ok: false, tlDr: "", trajectoryCount: 0, escalationCount: 0, logPath: relative(ctx.cwd, reviewer.logPath), errorOutput: reviewer.output.slice(-2_000) });
			return { content: [{ type: "text", text: reviewText }], details: { ...packet, logPath: reviewer.logPath } };
		},
	});

	pi.registerTool({
		name: "zense_discard",
		label: "Zense Discard Pending Apply",
		description:
			"Roll back the change staged into main after eval PASS (not yet committed) — unstage + reverse-apply the stored patch, restoring main to its exact pre-apply state; call this when the human reviewed the change and ordered it discarded.",
		parameters: Type.Object({}),
		async execute(_id, _p, _s, _o, ctx) {
			if (!state.pendingApply)
				return {
					content: [{ type: "text", text: state.longRun
						? `no pending apply to discard — longrun "${state.longRun.slug}" phases never stage into main (ADR-004). To reject the current phase's work: zense_longrun fail (git reset --hard to the phase baseline); to drop the whole requirement: zense_longrun abandon`
						: "no pending apply to discard (the change was already committed, or never applied)" }],
					details: { discarded: false },
					isError: true,
				};
			const v = state.pendingApply.specVersion;
			const dr = discardPendingApply(ctx.cwd);
			if (!dr.ok) {
				escalate("need-decision", `discard: ${dr.msg}`, ctx);
				return {
					content: [{ type: "text", text: `⚠️ discard failed: ${dr.msg}\na need-decision escalation has been recorded — the human resolves it with git themselves` }],
					details: { discarded: false },
					isError: true,
				};
			}
			state.pendingApply = undefined;
			// record it as an escalation too — a rejection is a key signal for the cycle (the next
			// reviewer packet/telemetry should see it)
			state.escalations.push({ kind: "discarded", detail: `spec v${v} apply discarded after human review`, at: Date.now() });
			learn(ctx, `spec v${v} discarded after review (reverse-applied patch)`);
			resetCycleState(state); // a failed closure still ends the round (tool path: the agent already got the tool result — no bulletin)
			persist();
			updateWidget(ctx);
			return {
				content: [{ type: "text", text: `🗑 discarded spec v${v}'s change — ${dr.msg}\nthis round of work is closed: to try a different approach → re-spec with zense_spec as a new version` }],
				details: { discarded: true, specVersion: v },
			};
		},
	});

	/** Accept side of pendingApply (shared by /zense accept and the zense_accept tool):
	 *  closes the account → learns the outcome into memory (accepted cleanly / with
	 *  amendments / warnings) → maintenance.
	 *  commitIfStaged=true means "the human asked for a commit on their behalf" — the helper
	 *  commits with the prepared message (hooks run normally). */
	const acceptPending = (ctx: ExtensionContext, commitIfStaged: boolean, notifyViaBulletin = false): { ok: boolean; text: string; specVersion?: number } => {
		if (!state.pendingApply)
			return { ok: false, text: "no pending apply to accept (already accepted/committed, or never applied)" };
		// longrun: this pendingApply is the WHOLE tracker's final apply — accepting it closes
		// the tracker (a mid-phase longrun has no pendingApply by construction, so hitting this
		// branch with state.longRun set can only mean the final apply)
		if (state.longRun) {
			const t = loadTracker(ctx.cwd, state.longRun.slug);
			if (t && t.status === "active") {
				t.status = "done";
				saveTracker(ctx.cwd, t);
				appendSpecsLog(ctx.cwd, t.slug, `tracker COMPLETE — final apply accepted on main`);
				learn(ctx, `longrun ${t.slug}: tracker v${t.version} done (${t.phases.length} phases) — merged into main`);
			}
		}
		const v = state.pendingApply.specVersion;
		const specTitle = state.spec?.title ?? ""; // captured before the reset — the bulletin needs it
		const r = acceptPendingApply(ctx.cwd, { evalTree: state.lastEval?.head, preApplyHead: state.pendingApply.preApplyHead, commitIfStaged });
		if (!r.ok) return { ok: false, text: `⚠️ accept failed: ${r.msg}` };
		state.pendingApply = undefined;
		// a positive outcome is a cycle signal too — push an "accepted" escalation (same
		// pattern as "discarded") so the next reviewer packet/telemetry sees both sides, not
		// just failures
		state.escalations.push({ kind: "accepted", detail: `spec v${v} accepted by human${r.amendedFiles.length ? ` — amended: ${r.amendedFiles.join(", ")}` : ""}`, at: Date.now() });
		const headNow = gitOk(["rev-parse", "HEAD"], ctx.cwd).out.trim().slice(0, 12);
		const amendLine = r.amendedFiles.length
			? `\n✏️ the human amended ${r.amendedFiles.length} file(s) after the grader passed: ${r.amendedFiles.join(", ")} — if unintended, inspect with git show HEAD`
			: "";
		learn(
			ctx,
			r.amendedFiles.length
				? `spec v${v} accepted @${headNow} with human amendments: ${r.amendedFiles.join(", ")}`
				: `spec v${v} accepted @${headNow} cleanly (no human amendments)`,
		);
		if (r.committedOnBehalf) learn(ctx, `spec v${v} accepted: harness committed staged change on human request`);
		for (const w of r.warnings) learn(ctx, `accept warning spec v${v}: ${w}`);
		// cycle closure (2026-09-17): a successful accept ends the round — reset cycle state so
		// the next job starts at spec v1; the bulletin only on the command path (/zense
		// accept): the tool path already hands the agent a tool result
		if (notifyViaBulletin) state.contextBulletin = buildAcceptBulletin(v, specTitle, r.amendedFiles.length);
		resetCycleState(state);
		persist();
		updateWidget(ctx);
		const warnText = r.warnings.length ? `\n⚠️ ${r.warnings.join("\n⚠️ ")}` : "";
		return {
			ok: true,
			specVersion: v,
			text: `✅ spec v${v} accepted — ${r.msg}${r.committedOnBehalf ? " (harness committed with the prepared message)" : ""}${amendLine}${warnText}\ncycle closed: the next piece of work starts with a new zense_spec (v1)`,
		};
	};

	pi.registerTool({
		name: "zense_accept",
		label: "Zense Accept Pending Apply",
		description:
			"Close the pending apply on the 'accept' side (zense_discard's counterpart) — call ONLY when (1) the human explicitly said they accept the work and already committed, or (2) the human asks the agent to commit for them (staged changes still pending → pass commitIfStaged=true to commit with .zense/pending-apply.msg, hooks running normally); never call unprompted. The result reports any files the human amended after the grader passed, and a lesson is recorded to memory.",
		parameters: Type.Object({
			commitIfStaged: Type.Optional(
				Type.Boolean({ description: "true only when the human said 'commit it for me': commit the pending staged changes with the prepared message, then accept", default: false }),
			),
		}),
		async execute(_id, p, _s, _o, ctx) {
			const r = acceptPending(ctx as ExtensionContext, !!p.commitIfStaged);
			return { content: [{ type: "text", text: r.text }], details: { accepted: r.ok, ...(r.specVersion !== undefined ? { specVersion: r.specVersion } : {}) }, isError: !r.ok };
		},
	});

	// ----- long-running mode (ADR-004): tracker-signed multi-phase requirements · one worktree
	//       for the whole set · per-phase human review gate · merge into main only at the end

	/** Reconcile precondition shared by next/close/resume (ambient-state distrust): assert the
	 *  worktree is on the tracker branch. Clean mismatches auto-heal; dirty/diverged states are
	 *  the human's call (picker) — never auto. lastCheckpoint = newest done phase's checkpoint. */
	const longrunReconcile = async (
		ctx: ExtensionContext,
		tracker: Tracker,
		lastCheckpoint?: string,
	): Promise<{ ok: boolean; text?: string; wt?: WorktreeT }> => {
		const wt = state.worktree && state.worktree.branch === tracker.worktreeBranch ? state.worktree : undefined;
		const rec = reconcileLongrunWorktree(wt?.root, tracker.worktreeBranch, lastCheckpoint);
		if (rec.status === "missing-worktree") {
			const ens = ensureLongrunWorktree(ctx.cwd, tracker.slug, tracker.worktreeBranch);
			if (!ens)
				return { ok: false, text: `❌ .zense/worktree/longrun-${tracker.slug} is occupied by a non-worktree directory — refusing to touch it (may hold human work); inspect/remove it manually` };
			state.worktree = ens.wt;
			state.worktreeLeaveNotified = false;
			learn(ctx, `longrun ${tracker.slug}: worktree ${ens.created ? "(re)created" : "reattached"}: ${tracker.worktreeBranch}`);
			persist();
			return { ok: true, wt: ens.wt };
		}
		if (rec.status === "checkpoint-diverged") {
			escalate("need-decision", `longrun ${tracker.slug}: checkpoint ${lastCheckpoint?.slice(0, 12)} is not an ancestor of ${tracker.worktreeBranch} HEAD (branch rewound outside the flow?)`, ctx);
			return { ok: false, text: `⛔ checkpoint-diverged: the recorded checkpoint ${lastCheckpoint?.slice(0, 12)} is not an ancestor of HEAD on ${tracker.worktreeBranch} — the branch moved outside the flow. Human resolution required (escalation recorded) — never auto-healed\ncheck: git -C ${state.worktree?.root ?? `.zense/worktree/longrun-${tracker.slug}`} log --oneline -10` };
		}
		if (rec.status === "wrong-branch" || rec.status === "detached") {
			if (rec.healable) {
				const h = healToBranch(wt!.root, tracker.worktreeBranch);
				if (!h.ok) return { ok: false, text: `❌ auto-heal failed switching back to ${tracker.worktreeBranch}: ${h.msg}` };
				learn(ctx, `longrun ${tracker.slug}: healed HEAD (${rec.status}${rec.actualBranch ? `: ${rec.actualBranch}` : ""}) → ${tracker.worktreeBranch}`);
				return { ok: true, wt: wt! };
			}
			// dirty tree on the wrong branch/detached = possibly the human's uncommitted review edits — only they may decide
			if (!ctx.hasUI)
				return { ok: false, text: `⛔ longrun worktree is on "${rec.actualBranch ?? "DETACHED"}" with ${rec.dirty.length} uncommitted change(s) (expected ${tracker.worktreeBranch}, no UI to ask) — human: cd ${wt!.root} && git status, then retry` };
			const preview = rec.dirty.slice(0, 10).join("\n") + (rec.dirty.length > 10 ? `\n… (+${rec.dirty.length - 10} more)` : "");
			const choice = await ctx.ui.select(
				`longrun worktree is on branch "${rec.actualBranch ?? "DETACHED"}" with ${rec.dirty.length} uncommitted change(s):\n${preview}\n\nexpected branch: ${tracker.worktreeBranch}`,
				[
					"📦 stash → switch back → pop onto the longrun branch (the changes belong to the phase work)",
					"🗑 discard the uncommitted changes, then switch back (destroys them)",
					"✋ cancel — I'll fix the worktree myself",
				],
			);
			if (!choice || choice.startsWith("✋"))
				return { ok: false, text: "reconcile cancelled by the human — resolve the longrun worktree branch state, then retry" };
			if (choice.startsWith("📦")) {
				gitOk(["stash", "push", "-u", "-m", "longrun-reconcile"], wt!.root);
				const h = healToBranch(wt!.root, tracker.worktreeBranch);
				if (!h.ok) return { ok: false, text: `❌ switch-back failed after stashing (changes are safe in git stash): ${h.msg}` };
				const pop = gitOk(["stash", "pop"], wt!.root);
				learn(ctx, `longrun ${tracker.slug}: stash-healed onto ${tracker.worktreeBranch}${pop.ok ? "" : " (pop reported conflicts)"}`);
				if (!pop.ok) return { ok: false, text: `⚠ switched back to ${tracker.worktreeBranch} but git stash pop reported conflicts — resolve them in ${wt!.root} first` };
			} else {
				gitOk(["reset", "-q", "--hard", "HEAD"], wt!.root);
				gitOk(["clean", "-fd", "--", ".", NOT_ZENSE], wt!.root);
				healToBranch(wt!.root, tracker.worktreeBranch);
				learn(ctx, `longrun ${tracker.slug}: discarded ${rec.dirty.length} uncommitted change(s) on human order, back on ${tracker.worktreeBranch}`);
			}
		}
		return { ok: true, wt: wt ?? undefined };
	};

	/** The final merge (tracker complete → ADR-003 staged apply-back, exactly once). Shared by
	 *  close's last-phase path and its dirty-main retry (awaitingFinalApply). */
	const longrunApplyFinal = (ctx: ExtensionContext, tracker: Tracker): { ok: boolean; text: string } => {
		if (!state.spec || !state.worktree) return { ok: false, text: "internal: final apply needs the last phase's spec + worktree in state" };
		const wtBranch = state.worktree.branch;
		const preHead = gitOk(["rev-parse", "HEAD"], ctx.cwd);
		const ar = applyWorktreeBack(ctx.cwd, state.spec, state.worktree);
		if (!ar.ok) {
			state.longRun = { ...state.longRun!, awaitingFinalApply: true } satisfies LongRunRef;
			persist();
			escalate("need-decision", `longrun ${tracker.slug} final apply: ${ar.msg}`, ctx);
			return { ok: false, text: `⚠ final apply refused: ${ar.msg}\nfix main, then call zense_longrun close again — the retry skips checkpointing and only retries the apply` };
		}
		learn(ctx, `longrun ${tracker.slug}: worktree applied: ${ar.msg}`);
		state.worktree = null;
		const idxTree = gitOk(["write-tree"], ctx.cwd); // same repin as eval-PASS: reviewer evidence must read the index tree
		if (idxTree.ok && state.lastEval) state.lastEval.head = idxTree.out.trim();
		if (ar.paths.length) {
			state.pendingApply = { specVersion: state.spec.version, branch: wtBranch, paths: ar.paths, appliedAt: Date.now(), ...(preHead.ok ? { preApplyHead: preHead.out.trim() } : {}) };
			try { writeFileSync(join(zenseDir(ctx.cwd), PENDING_MSG), ar.commitMsg ?? composeCommitMessage(state.spec, [])); } catch { /* best-effort */ }
		}
		persist();
		return {
			ok: true,
			text: `🌳 longrun "${tracker.slug}" COMPLETE — the whole phase set (${tracker.phases.length} phases) is staged in main (${ar.paths.length} file(s), not yet committed)\n` +
				`review: git status · git diff --cached — then commit: git commit -F .zense/pending-apply.msg → /zense accept (marks the tracker done)\n` +
				`↩️ unhappy with the whole set → zense_discard (reverse patch restores main; checkpoints stay on the deleted branch's reflog)`,
		};
	};

	/** Close out a phase's cycle scope but KEEP the longrun ref + worktree (unlike
	 *  resetCycleState, which runs only at whole-tracker closure). */
	const resetLongrunPhaseCycle = (slug: string, trackerVersion: number, extra?: Partial<LongRunRef>): void => {
		state.spec = undefined;
		state.phase = "requirements";
		state.lastEval = undefined;
		state.baselineHead = undefined;
		state.evalOverrideFails = undefined;
		state.specSource = undefined;
		state.specMdPath = undefined;
		state.specJsonPath = undefined;
		state.lastCompileLessons = undefined;
		state.worktreeLeaveNotified = undefined;
		state.pendingApply = undefined;
		state.longRun = { slug, trackerVersion, ...extra };
	};

	const trackerSummaryLines = (t: Tracker): string => {
		const done = t.phases.filter((p) => p.status === "done").length;
		return `${t.slug} — "${t.title}" [v${t.version} ${t.status}] ${done}/${t.phases.length} phases done · branch ${t.worktreeBranch}`;
	};

	pi.registerTool({
		name: "zense_longrun",
		label: "Zense Long-Running",
		description:
			"Long-running mode: a requirement too big for one cycle is planned ONCE as a signed tracker (phases: pre-phase, p1, p2, …) at .zense/long-running/<slug>/, then run phase-by-phase — each phase auto-compiles its spec from the tracker's seed criteria (no per-phase signature; the tracker IS the signature), runs in the ONE shared longrun worktree (ADR-004), and stops at a human review gate (close = checkpoint commit, fail = reset --hard). main gets the merge only when every phase is done. Resume anytime by requirement-name.",
		promptSnippet: "Run multi-phase requirements: signed tracker → per-phase loops in one worktree → merge at completion",
		promptGuidelines: [
			"Flow: init (specs.md) → plan (phases w/ seed criteria → human signs the tracker ONCE) → next (activate phase: capsule + auto-approved spec) → implement → zense_eval → zense_review → close (human accepted) or fail (human rejected) → next … → the last close merges into main.",
			"Never hand-ed .zense/long-running/*/tracker.json — the tool transitions are the only writers; resume (zense_longrun resume or /zense longrun resume) always works from disk.",
			"Between phases the write gate is shut: writes require an active phase spec from zense_longrun next — this is by design.",
			"When a reconcile/step returns a human-resolution text, surface it verbatim and wait — never retry destructive operations on your own.",
		],
		parameters: Type.Object({
			action: Type.Union(
				["init", "plan", "next", "close", "fail", "status", "resume", "abandon"].map((v) => Type.Literal(v)) as [
					ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[],
				],
			),
			slug: Type.Optional(Type.String({ description: "requirement-name (directory + branch key). Optional for resume (pick from a list); required elsewhere except init." })),
			title: Type.Optional(Type.String({ description: "init: requirement title" })),
			intent: Type.Optional(Type.String({ description: "init: what the whole requirement wants and why" })),
			specsMd: Type.Optional(Type.String({ description: "init: full specs.md content (the master requirement doc)" })),
			phases: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.Optional(Type.String({ description: "stable id (p1, pre, …) — auto-assigned when omitted" })),
						title: Type.String(),
						intent: Type.String({ description: "what this phase delivers and why" }),
						scope: Type.Array(Type.String()),
						constraints: Type.Optional(Type.Array(Type.String())),
						criteria: Type.Array(Type.Object({ id: Type.String(), text: Type.String(), check: Type.String({ description: CHECK_FORMAT_CONTRACT }) })),
					}),
					{ description: "plan: the phase list — seed criteria are signed with the tracker and carried verbatim into each phase spec; omit to let the planner sub-agent draft from specs.md (the human still signs the result)" },
				),
			),
			extraCriteria: Type.Optional(
				Type.Array(Type.Object({ id: Type.String(), text: Type.String(), check: Type.String() }), {
					description: "next: extra criteria the agent adds for this phase (marked origin 'compiled'; may never replace a seed id)",
				}),
			),
			summary: Type.Optional(Type.String({ description: "close: what the phase delivered (+ decisions worth carrying into the capsule)" })),
			confirm: Type.Optional(Type.Boolean({ description: "fail/abandon: the human explicitly ordered this destructive step" })),
		}),
		async execute(_id, p, sig, _on, ctx) {
			const say = (text: string, details: Record<string, unknown> = {}, isError = false) => ({ content: [{ type: "text" as const, text }], details, isError });
			const lr = state.longRun;

			if (p.action === "init") {
				if (state.longRun) return say(`a longrun is already active in this session: "${state.longRun.slug}" — finish/abandon it first`, {}, true);
				if (!p.title?.trim()) return say("init requires title", {}, true);
				const slug = slugifyTitle(p.title);
				if (loadTracker(ctx.cwd, slug)) return say(`tracker "${slug}" already exists — use resume/plan/status for it`, {}, true);
				if (!isGitRepo(ctx.cwd)) return say("longrun requires a git repo (checkpoints/reset/apply-back are git-native) — this project is not one", {}, true);
				const dir = longrunDir(ctx.cwd, slug);
				mkdirSync(join(dir, "phases"), { recursive: true });
				writeFileSync(join(dir, "specs.md"), p.specsMd?.trim() ? p.specsMd : `# ${p.title}\n\n${p.intent ?? ""}\n`);
				const t: Tracker = { version: 1, slug, title: p.title, intent: p.intent ?? "", worktreeBranch: longrunBranch(slug), status: "planning", phases: [], updatedAt: Date.now() };
				saveTracker(ctx.cwd, t);
				learn(ctx, `longrun ${slug}: init (specs.md written)`);
				return say(`🏗 longrun "${slug}" initialized at .zense/long-running/${slug}/ (specs.md written, tracker planning)\nnext: zense_longrun plan with the phase list (specs.md is amendable until the tracker is signed)`);
			}

			// every other action resolves a tracker from slug (param → active session longrun)
			const slug = p.slug ?? (p.action === "resume" ? undefined : state.longRun?.slug);

			if (p.action === "plan") {
				if (!slug) return say("plan requires slug", {}, true);
				const t0 = loadTracker(ctx.cwd, slug);
				if (!t0) return say(`no tracker "${slug}" — run zense_longrun init first`, {}, true);
				if (t0.status !== "planning") return say(`tracker "${slug}" is ${t0.status} — plan edits need a re-signed new version (amend = zense_longrun plan again after resetting status manually via the human)`, {}, true);
				// no explicit phases → the planner sub-agent drafts them from specs.md (the human
				// signs the RESULT — the model never bypasses the tracker signature)
				let planInput = p.phases;
				if (!planInput?.length) {
					let specsMd = "";
					try { specsMd = readFileSync(join(longrunDir(ctx.cwd, t0.slug), "specs.md"), "utf8"); } catch { /* best-effort */ }
					const t0time = Date.now();
					const run = await launchSubagent(ctx, "planner", buildLongrunPlannerPrompt(t0.title, t0.intent, specsMd), undefined, sig);
					if (sig?.aborted) return say("⏸ plan cancelled (Esc) — do not retry on your own", {}, true);
					if (!run.ok) return say(`planner sub-agent failed: ${run.output}\nalternative: call plan with an explicit phases list`, {}, true);
					const parsed = parseLongrunPlan(run.output);
					if (!parsed.ok)
						return say(`planner output invalid: ${parsed.error}\nalternative: call plan with an explicit phases list (the raw draft is logged via /zense agents)`, {}, true);
					planInput = parsed.phases;
					learn(ctx, `longrun ${t0.slug}: planner drafted ${planInput.length} phases (${Date.now() - t0time}ms)`);
				}
				const phases: TrackerPhase[] = planInput.map((ph, i) => ({
					id: ph.id?.trim() || `p${i + 1}`,
					title: ph.title,
					intent: ph.intent,
					scope: ph.scope,
					constraints: ph.constraints ?? [],
					criteria: ph.criteria,
					status: "pending",
				}));
				const t: Tracker = { ...t0, phases, updatedAt: Date.now() };
				const errors = validateTracker(t);
				if (errors.length) return say(`⛔ tracker invalid:\n${errors.map((e) => `- ${e}`).join("\n")}`, { errors }, true);
				saveTracker(ctx.cwd, t); // write tracker.md first — the signer reads the full plan
				let signed = false;
				if (ctx.hasUI) {
					const choice = await ctx.ui.select(
						`🔏 Sign longrun tracker "${t.slug}" v${t.version}? ${phases.length} phase(s): ${phases.map((x) => x.id).join(", ")} — one signature covers all phases (full plan: .zense/long-running/${t.slug}/tracker.md)`,
						[
							"🔏 Sign — start the longrun (phases run under this signature; review gate at every phase end)",
							"✏️ Not yet (amend the plan first)",
						],
					);
					signed = !!choice && choice.startsWith("🔏");
				}
				if (!signed)
					return say(`tracker "${t.slug}" saved unsigned (planning) — sign later: rerun plan, or /zense longrun sign ${t.slug}`, { signed });
				t.approvedAt = Date.now();
				t.status = "active";
				saveTracker(ctx.cwd, t);
				appendSpecsLog(ctx.cwd, t.slug, `tracker v${t.version} signed (${phases.length} phases: ${phases.map((x) => x.id).join(", ")})`);
				state.longRun = { slug: t.slug, trackerVersion: t.version };
				// the ONE worktree for the whole set exists from this moment (ADR-004)
				const ens = ensureLongrunWorktree(ctx.cwd, t.slug, t.worktreeBranch);
				if (ens) {
					state.worktree = ens.wt;
					state.worktreeLeaveNotified = false;
				}
				learn(ctx, `longrun ${t.slug}: tracker v${t.version} signed${ens ? `, worktree ${t.worktreeBranch}` : " (⚠ worktree unavailable)"}`);
				persist();
				return say(`🔏 tracker "${t.slug}" v${t.version} SIGNED — ${phases.length} phase(s) · worktree ${t.worktreeBranch}${ens ? "" : " (⚠ could not attach — next will try again)"}\nphases auto-run under this signature; start: zense_longrun next`, { signed: true, phases: phases.map((x) => x.id) });
			}

			if (p.action === "next") {
				if (!state.longRun) return say("no active longrun in this session — resume one first (zense_longrun resume)", {}, true);
				const t = loadTracker(ctx.cwd, state.longRun.slug);
				if (!t) return say(`tracker "${state.longRun.slug}" vanished from disk — human check: .zense/long-running/`, {}, true);
				if (t.status !== "active") return say(`tracker "${t.slug}" is ${t.status}`, {}, true);
				if (state.spec?.approved) return say(`phase "${state.longRun.activePhase ?? "?"}" already has an active signed spec (v${state.spec.version}) — finish it (eval→review→close) or reject it with zense_longrun fail`, {}, true);
				// final-apply retry: everything checkpointed, last attempt hit the dirty-main guard
				if (state.longRun.awaitingFinalApply) {
					if (!allPhasesDone(t)) return say("internal: awaitingFinalApply with pending phases — reconcile manually", {}, true);
					const rec = await longrunReconcile(ctx, t, undefined);
					if (!rec.ok) return say(rec.text!, {}, true);
					// the phase cycle was already closed — rebuild the minimal spec view for a retry
					if (!state.spec) {
						const disk = loadSpecFromDisk(ctx.cwd);
						if (disk) state.spec = disk;
						else return say("retry needs the last phase's spec on disk (.zense/spec.json) — missing; human: apply manually via git merge --squash", {}, true);
					}
					const r = longrunApplyFinal(ctx, t);
					if (r.ok) resetLongrunPhaseCycle(t.slug, t.version);
					return say(r.text, {}, !r.ok);
				}
				const phase = nextPendingPhase(t);
				if (!phase) return say(`all phases of "${t.slug}" are done — finish the final review in main (git diff --cached), commit, then /zense accept`, {});
				const lastCheckpoint = [...t.phases].reverse().find((x) => x.checkpoint)?.checkpoint;
				const rec = await longrunReconcile(ctx, t, lastCheckpoint);
				if (!rec.ok) return say(rec.text!, {}, true);
				if (!rec.wt) return say("internal: reconcile ok but no worktree", {}, true);
				if (rec.ok && rec.wt && reconcileLongrunWorktree(rec.wt.root, t.worktreeBranch).dirty.length)
					state.trajectoryFlags.push(`longrun ${t.slug}: phase ${phase.id} started with uncommitted leftovers in the worktree`);
				const headSha = gitOk(["rev-parse", "HEAD"], rec.wt.root);
				if (!headSha.ok) return say("could not read the longrun branch HEAD (git broken?)", {}, true);
				const draft = compilePhaseSpec(t, phase, p.extraCriteria ?? []);
				const dropped = droppedSeedIds(phase.criteria, draft.criteria);
				if (dropped.length) return say(`⛔ seed criteria would be dropped: ${dropped.join(", ")} — the tracker signature forbids that`, {}, true);
				const r = await commitSpec(ctx, draft, "set", { sign: "auto", provenance: draft.provenance, baselineOverride: headSha.out.trim() });
				phase.status = "active";
				phase.baseline = headSha.out.trim();
				saveTracker(ctx.cwd, t);
				appendSpecsLog(ctx.cwd, t.slug, `phase ${phase.id} "${phase.title}" activated (baseline ${headSha.out.trim().slice(0, 12)})`);
				state.longRun = { slug: t.slug, trackerVersion: t.version, activePhase: phase.id };
				persist();
				const capsule = buildContextCapsule(ctx.cwd, t, phase);
				return say(
					`${capsule}\n\n✅ phase spec v${r.version} auto-approved (provenance tracker:${t.slug}@v${t.version}) — implement within scope: ${phase.scope.join(", ")}\n` +
						`when done: zense_eval → zense_review → the human closes (zense_longrun close) or rejects (zense_longrun fail)`,
					{ phase: phase.id, specVersion: r.version, capsule: true },
				);
			}

			if (p.action === "close") {
				if (!lr) return say("no active longrun in this session", {}, true);
				const t = loadTracker(ctx.cwd, lr.slug);
				if (!t) return say(`tracker "${lr.slug}" not found on disk`, {}, true);
				if (lr.awaitingFinalApply) {
					if (!state.spec) {
						const disk = loadSpecFromDisk(ctx.cwd);
						if (disk) state.spec = disk;
					}
					const r = longrunApplyFinal(ctx, t);
					if (r.ok) resetLongrunPhaseCycle(t.slug, t.version);
					return say(r.text, {}, !r.ok);
				}
				if (state.phase !== "review" || !state.spec)
					return say(`⛔ close needs an eval-PASSED phase (phase=${state.phase}) — run zense_eval (+zense_review) first; the human closes only after review`, {}, true);
				const phase = lr.activePhase ? findPhase(t, lr.activePhase) : undefined;
				if (!phase) return say(`no active phase recorded for longrun "${t.slug}" (state/disk mismatch — human check tracker.json)`, {}, true);
				if (!state.worktree) return say("no worktree attached (session restarted?) — run zense_longrun resume first", {}, true);
				const rec = await longrunReconcile(ctx, t, undefined); // dirty is EXPECTED here (uncommitted phase work) — only branch/divergence matter
				if (!rec.ok) return say(rec.text!, {}, true);
				const ck = checkpointCommit(rec.wt!.root, `longrun(${t.slug}): ${phase.id} ${phase.title}`);
				if (!ck.ok) return say(`❌ checkpoint commit failed: ${ck.msg}`, {}, true);
				const files = gitOk(["diff", "--name-only", `${phase.baseline ?? "HEAD"}..HEAD`, "--", ".", NOT_ZENSE], rec.wt!.root);
				const filesChanged = files.ok ? files.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
				phase.status = "done";
				phase.checkpoint = ck.sha;
				phase.specVersion = state.spec.version;
				phase.summaryPath = writePhaseSummary(ctx.cwd, t, phase, p.summary ?? "", filesChanged);
				saveTracker(ctx.cwd, t);
				appendSpecsLog(ctx.cwd, t.slug, `phase ${phase.id} accepted → checkpoint ${ck.sha?.slice(0, 12)} (${filesChanged.length} files)`);
				state.escalations.push({ kind: "accepted", detail: `longrun ${t.slug} phase ${phase.id} accepted (checkpoint ${ck.sha?.slice(0, 12)})`, at: Date.now() });
				learn(ctx, `longrun ${t.slug}: phase ${phase.id} closed → checkpoint ${ck.sha?.slice(0, 12)}`);
				const done = allPhasesDone(t);
				if (done) {
					const r = longrunApplyFinal(ctx, t);
					if (!r.ok) return say(`✅ phase ${phase.id} closed (checkpoint ${ck.sha?.slice(0, 12)}) — but the final apply needs attention:\n${r.text}`, {}, true);
					// keep state.phase = "review" + pendingApply → the standard /zense accept flow marks the tracker done
					const slugKeep = t.slug, ver = t.version;
					resetLongrunPhaseCycle(slugKeep, ver);
					state.phase = "review"; // pendingApply exists → review/accept flow continues from here
					persist();
					return say(`✅ final phase ${phase.id} closed (checkpoint ${ck.sha?.slice(0, 12)})\n${r.text}`, { trackerComplete: true });
				}
				const nextP = nextPendingPhase(t)!;
				resetLongrunPhaseCycle(t.slug, t.version);
				state.contextBulletin = `[zense] longrun ${t.slug}: phase ${phase.id} closed (checkpoint ${ck.sha?.slice(0, 12)}) — ${nextP.id} "${nextP.title}" is next (zense_longrun next). Consider /compact to drop this phase's context — the capsule carries forward only what's needed`;
				persist();
				updateWidget(ctx);
				return say(
					`✅ phase ${phase.id} accepted — checkpoint ${ck.sha?.slice(0, 12)} on ${t.worktreeBranch} (${filesChanged.length} file(s))\nsummary: ${phase.summaryPath}\nnext: ${nextP.id} "${nextP.title}" → zense_longrun next · recommended: /compact first (clean context; the capsule re-orients)`,
				{ closed: phase.id, checkpoint: ck.sha, next: nextP.id },
				);
			}

			if (p.action === "fail") {
				if (!lr?.activePhase) return say("no active phase to fail", {}, true);
				const t = loadTracker(ctx.cwd, lr.slug);
				if (!t) return say(`tracker "${lr.slug}" not found on disk`, {}, true);
				const phase = findPhase(t, lr.activePhase);
				if (!phase) return say(`phase "${lr.activePhase}" not found in tracker`, {}, true);
				if (p.confirm !== true) {
					if (!ctx.hasUI) return say("fail destroys the phase's uncommitted+committed-since-baseline work (reset --hard) — pass confirm:true only when the human explicitly ordered it", {}, true);
					const ok = await ctx.ui.select(
						`⚠️ fail phase ${phase.id} "${phase.title}"? git reset --hard back to baseline ${phase.baseline?.slice(0, 12) ?? "?"} — this phase's work in the longrun worktree is destroyed (earlier checkpoints are safe)`,
						["🗑 Yes — reject this phase's work (reset --hard)", "✋ Cancel"],
					);
					if (!ok?.startsWith("🗑")) return say("fail cancelled", {});
				}
				if (!state.worktree || !phase.baseline) return say("missing worktree or phase baseline — cannot reset safely", {}, true);
				const rr = resetToCheckpoint(state.worktree.root, phase.baseline);
				if (!rr.ok) return say(`❌ reset failed: ${rr.msg}`, {}, true);
				phase.status = "pending";
				phase.baseline = undefined;
				saveTracker(ctx.cwd, t);
				appendSpecsLog(ctx.cwd, t.slug, `phase ${phase.id} REJECTED — reset --hard to baseline`);
				state.escalations.push({ kind: "discarded", detail: `longrun ${t.slug} phase ${phase.id} rejected (reset --hard)`, at: Date.now() });
				learn(ctx, `longrun ${t.slug}: phase ${phase.id} failed/rejected → ${rr.msg}`);
				resetLongrunPhaseCycle(t.slug, t.version);
				persist();
				updateWidget(ctx);
				return say(`🗑 phase ${phase.id} rejected — ${rr.msg}; the phase is pending again. Restart with a fresh approach: zense_longrun next`, { failed: phase.id });
			}

			if (p.action === "status") {
				const trackers = discoverLongrunTrackers(ctx.cwd).filter((t) => t.status !== "done");
				if (!trackers.length && !state.longRun) return say("no long-running requirements found (.zense/long-running/)", {});
				const active = state.longRun ? loadTracker(ctx.cwd, state.longRun.slug) : null;
				const lines = trackers.map(trackerSummaryLines);
				return say(
					`🏗 long-running requirements:\n${lines.map((l) => `  ${l}`).join("\n") || "  (none)"}` +
						(active ? `\n\nsession-active: ${state.longRun!.slug} — activePhase: ${state.longRun!.activePhase ?? "(between phases)"} · spec: ${state.spec ? `v${state.spec.version}` : "—"} · cycle phase: ${state.phase}${state.longRun!.awaitingFinalApply ? " · ⏳ awaiting final apply retry" : ""}` : "") +
						(active ? `\n(full tracker: .zense/long-running/${active.slug}/tracker.md)` : ""),
					{ trackers: trackers.map((t) => t.slug) },
				);
			}

			if (p.action === "resume") {
				let trackers = discoverLongrunTrackers(ctx.cwd).filter((t) => t.status === "active");
				let t = p.slug ? trackers.find((x) => x.slug === p.slug) : trackers.length === 1 ? trackers[0] : undefined;
				if (p.slug && !t) {
					const raw = loadTracker(ctx.cwd, p.slug);
					if (raw?.status === "done" || raw?.status === "abandoned") return say(`tracker "${p.slug}" is ${raw.status} — nothing to resume`, {}, true);
					if (!raw) return say(`no tracker "${p.slug}" on disk`, {}, true);
					t = raw;
				}
				if (!t && trackers.length) {
					if (!ctx.hasUI)
						return say(`multiple resumable longruns — pick one:\n${trackers.map(trackerSummaryLines).join("\n")}\nzense_longrun resume slug=<name>`, {}, true);
					const pick = await ctx.ui.select(`resume which long-running requirement?`, trackers.map((x) => `${x.slug} — "${x.title}" (${x.phases.filter((ph) => ph.status === "done").length}/${x.phases.length} done)`));
					if (!pick) return say("resume cancelled", {});
					t = trackers.find((x) => pick.startsWith(x.slug));
				}
				if (!t) return say("no resumable longrun (nothing active in .zense/long-running/) — start one with zense_longrun init", {}, true);
				state.longRun = { slug: t.slug, trackerVersion: t.version };
				const activePh = t.phases.find((x) => x.status === "active");
				state.longRun.activePhase = activePh?.id;
				const lastCheckpoint = [...t.phases].reverse().find((x) => x.checkpoint)?.checkpoint;
				const rec = await longrunReconcile(ctx, t, lastCheckpoint);
				if (!rec.ok) return say(rec.text!, {}, true);
				persist();
				if (!activePh) {
					return say(`🔁 longrun "${t.slug}" resumed at a phase boundary (${t.phases.filter((x) => x.status === "done").length}/${t.phases.length} done) — worktree ${t.worktreeBranch} reattached\ncontinue: zense_longrun next`, { resumed: t.slug });
				}
				// mid-phase resume: the phase's signed spec should be the latest .zense/spec.json —
				// adopt it ONLY when it provably belongs to this phase (title prefix match); otherwise
				// the human picks (adopt anyway vs restart the phase cleanly)
				const disk = loadSpecFromDisk(ctx.cwd);
				const belongs = !!disk && disk.approved && disk.title.startsWith(`longrun(${t.slug}) ${activePh.id}`);
				let adopt = belongs;
				if (!belongs && ctx.hasUI) {
					const pick = await ctx.ui.select(
						`longrun "${t.slug}" was mid-phase ${activePh.id} "${activePh.title}" — but the on-disk spec ${disk ? `("${disk.title}")` : "is missing"} doesn't match this phase`,
						[
							...(disk?.approved ? [`adopt the disk spec anyway and continue phase ${activePh.id}`] : []),
							`restart phase ${activePh.id} cleanly (reset --hard to baseline ${activePh.baseline?.slice(0, 12) ?? "?"} — destroys this phase's work)`,
							"cancel resume",
						],
					);
					if (!pick || pick.startsWith("cancel")) return say("resume cancelled", {});
					if (pick.startsWith("restart")) {
						if (state.worktree && activePh.baseline) resetToCheckpoint(state.worktree.root, activePh.baseline);
						activePh.status = "pending";
						activePh.baseline = undefined;
						saveTracker(ctx.cwd, t);
						resetLongrunPhaseCycle(t.slug, t.version);
						persist();
						return say(`🔁 resumed — phase ${activePh.id} reset to pending. continue: zense_longrun next`, { resumed: t.slug });
					}
					adopt = true;
				}
				if (!adopt || !disk)
					return say(`🔁 longrun "${t.slug}" reattached (branch ${t.worktreeBranch}, mid-phase ${activePh.id}) — but its phase spec could not be restored from disk (${disk ? "unsigned/mismatch" : "missing"}) and there's no UI to choose; run zense_longrun fail to restart the phase, or sign issues aside call zense_longrun next only after resolving`, {}, true);
				state.spec = disk;
				const arch = findSpecArchivePaths(ctx.cwd, disk.version);
				if (arch.json) state.specJsonPath = arch.json;
				if (arch.md) state.specMdPath = arch.md;
				state.phase = "implementation";
				state.baselineHead = activePh.baseline;
				persist();
				updateWidget(ctx);
				return say(
					`🔁 longrun "${t.slug}" resumed mid-phase ${activePh.id} "${activePh.title}" — spec v${disk.version} adopted, branch ${t.worktreeBranch}\n\n${buildContextCapsule(ctx.cwd, t, activePh)}`,
					{ resumed: t.slug, midPhase: true },
				);
			}

			if (p.action === "abandon") {
				const target = p.slug ?? state.longRun?.slug;
				if (!target) return say("abandon requires a slug (or an active longrun)", {}, true);
				const t = loadTracker(ctx.cwd, target);
				if (!t) return say(`no tracker "${target}"`, {}, true);
				if (t.status === "done") return say(`tracker "${target}" is done — nothing to abandon (its merge is already in main history)`, {}, true);
				if (p.confirm !== true) {
					if (!ctx.hasUI) return say("abandon destroys the longrun worktree + branch (all phase work not yet merged) — pass confirm:true only on an explicit human order", {}, true);
					const ok = await ctx.ui.select(
						`⚠️ abandon longrun "${t.slug}"? the worktree ${t.worktreeBranch} (including checkpoints) is REMOVED — the whole set's work is destroyed. main is untouched by construction (nothing ever staged)`,
						["🗑 Yes — destroy the worktree and abandon the requirement", "✋ Cancel"],
					);
					if (!ok?.startsWith("🗑")) return say("abandon cancelled", {});
				}
				if (state.pendingApply && state.longRun?.slug === t.slug)
					return say(`the final apply of "${t.slug}" is already staged in main — discard it first (zense_discard), then abandon`, {}, true);
				const ab = abandonLongrunWorktree(ctx.cwd, t);
				if (!ab.ok) return say(`❌ ${ab.msg}`, {}, true);
				t.status = "abandoned";
				saveTracker(ctx.cwd, t);
				appendSpecsLog(ctx.cwd, t.slug, `ABANDONED — worktree+branch removed, main untouched`);
				learn(ctx, `longrun ${t.slug}: abandoned (worktree ${t.worktreeBranch} removed)`);
				if (state.longRun?.slug === t.slug) {
					resetLongrunPhaseCycle(t.slug, t.version);
					state.longRun = undefined;
					state.worktree = null;
				}
				persist();
				updateWidget(ctx);
				return say(`🗑 longrun "${t.slug}" abandoned — worktree + branch removed; main was never touched. tracker kept as status=abandoned for the record`, { abandoned: t.slug });
			}

			return say(`unknown action: ${p.action}`, {}, true);
		},
	});

	// ----- zense_ask: the harness picker as a general agent tool — any phase, not just the
	// requirements clarify loop (a design decision the human should pick gets a real picker
	// instead of a "1. a 2. b 3. c" plain-text list)

	pi.registerTool({
		name: "zense_ask",
		label: "Zense Ask Human",
		description:
			"Ask the human decision-critical questions through the harness multiple-choice picker (search-filtered TUI with an 'Other (type your own)' free-text option). Callable in ANY phase — prefer this over dumping a '1. a 2. b 3. c' numbered list as chat text whenever the human should pick a design decision. In non-UI (RPC/print) sessions it returns guidance to ask in plain text instead — it never hangs.",
		promptSnippet: "Ask the human questions with a multiple-choice picker any time a design decision needs a human pick",
		promptGuidelines: [
			"Use zense_ask whenever the human should choose between options (design decisions, direction changes, ambiguous next steps) — it renders a pickable/searchable TUI instead of a long numbered chat list.",
			"Attach 2–6 plausible choices per question; the human can also pick 'Other (type your own)' to answer freely. Esc = that question is skipped (reported as such — never infer an answer from a skip).",
			"Keep it to the few decision-critical questions (max 5 per call); this is an interactive check-in, not batch form-filling.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String(),
					choices: Type.Optional(Type.Array(Type.String(), { description: "pickable options (2–6 work best); omit for a plain free-text answer" })),
				}),
				{ description: "questions asked in order, each with its own picker (max 5)" },
			),
		}),
		async execute(_id, p, _s, _o, ctx) {
			const qs = asAskQuestions(p.questions);
			if (!qs?.length)
				return { content: [{ type: "text", text: "zense_ask: no usable question — pass at least one non-empty question text" }], details: {}, isError: true };
			// no UI → never await a picker: graceful non-error guidance (RPC/print must not hang)
			if (!ctx.hasUI) return { content: [{ type: "text", text: ASK_NO_UI_TEXT }], details: { noUi: true } };
			const answers: AskAnswer[] = [];
			for (const q of qs)
				answers.push({ question: q.question, answer: await askClarifyQuestion(ctx as ExtensionContext, q) }); // Esc/skip resolves undefined per question — never aborts the rest
			learn(ctx as ExtensionContext, `zense_ask: ${qs.length} question(s), ${answers.filter((a) => a.answer === undefined).length} skipped`);
			return { content: [{ type: "text", text: formatAskAnswers(answers) }], details: { answers } };
		},
	});

	// Review-packet card in the transcript.
	pi.registerEntryRenderer("zense-review-packet", (entry, { expanded }, theme) => {
		const d = entry.data as any;
		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg("accent", theme.bold("📋 Review packet"))));
		for (const line of String(d.tlDr).split("\n").slice(0, 6)) box.addChild(new Text(theme.fg("customMessageText", line)));
		box.addChild(new Text(theme.fg("warning", `trajectory flags: ${d.trajectory?.length ?? 0} · escalations: ${d.escalations?.length ?? 0}`)));
		if (expanded) box.addChild(new Text(theme.fg("dim", JSON.stringify(d, null, 2).slice(0, 2000))));
		return box;
	});

	// ----- Phase 6: memory/learning log

	const learn = (ctx: ExtensionContext, note: string) => {
		mkdirSync(zenseDir(ctx.cwd), { recursive: true });
		appendFileSync(join(zenseDir(ctx.cwd), "memory.jsonl"), JSON.stringify({ at: Date.now(), phase: state.phase, note }) + "\n");
	};


	// ----- human gates: commands

	// Shortcut options considered: ctrl+letter is all reserved by pi (docs/keybindings.md —
	// undo occupies ctrl+-); alt+letter is broken on macOS where Option sends a literal char
	// instead of an Escape prefix (unpressable) → ctrl+_ (payload 0x1F): clearly supported by
	// pi-tui keys.js and clashes with no pi default binding (fallback: /zense agents)
	pi.registerShortcut(Key.ctrl("_"), {
		description: "Zense: watch sub-agent runs live (live tail)",
		handler: (ctx) => openAgentsViewer(ctx),
	});

	// runExtConfig: shared ext-config logic per role — used by both /zense ext-config <role>
// (legacy arg, backward compat) and the per-role commands /zense:ext-config:<role>
// (autocompletes straight from the command name — pi's API supplies only the current
// word's prefix, making positional completion impossible)
	const runExtConfig = async (ctx: ExtensionContext, role: string, action?: string, vals: string[] = []): Promise<void> => {
		const exts = (await listInstalledExtensions(ctx.cwd)).filter((e) => e.enabled);
		const cur = new Set(subagentExtIncludes(role, ctx.cwd));
		const apply = (includes: string[]) => {
			const { globalSeeded } = writeSubagentExtIncludes(ctx.cwd, role, includes);
			ctx.ui.notify(
				`✅ ${role}: will load ${includes.length}/${exts.length} extensions${includes.length ? "" : " (bare boot)"} — saved to local .zense/config.json${globalSeeded ? " (+ first-time global seed ~/.pi/agent/zense/config.json)" : ""} · takes effect on the next sub-agent run`,
				"info",
			);
		};
		if (ctx.mode === "tui" && !action) {
			const includes = await extConfigDialog(
				ctx,
				role,
				exts.map((e) => ({ path: e.path, label: `${extDisplayLabel(e)} · ${e.source}`, checked: cur.has(e.path) })),
			);
			if (includes === null) return ctx.ui.notify("cancelled — config unchanged", "info");
			apply(includes);
			return;
		}
		// text actions (non-TUI or an explicit action) — on/off takes a 1-based index (from the
		// list below) or a path substring
		if (action === "all") apply(exts.map((e) => e.path));
		else if (action === "none" || action === "default") apply([]);
		else if (action === "on" || action === "off") {
			const target = vals.join(" ").trim();
			if (!target) return ctx.ui.notify(`missing target — /zense ext-config-show ${role} ${action} <index|path>`, "warning");
			const asNum = Number(target);
			const hit =
				Number.isInteger(asNum) && asNum >= 1 && asNum <= exts.length ? exts[asNum - 1].path : exts.find((e) => e.path.includes(target))?.path;
			if (!hit) return ctx.ui.notify(`extension "${target}" not found — see the list with /zense ext-config-show ${role} (no action)`, "warning");
			const next = new Set(cur);
			if (action === "on") next.add(hit);
			else next.delete(hit);
			apply([...next]);
		} else if (!action) {
			ctx.ui.notify(
				[
					`installed (enabled) extensions — ${role} loads ${cur.size}/${exts.length}:`,
					...exts.map((e, i) => `  ${i + 1}. ${cur.has(e.path) ? "[x]" : "[ ]"} ${e.path}`),
					`toggle: /zense ext-config ${role} on|off <index|path> · all = load everything · none = load nothing (default)`,
				].join("\n"),
				"info",
			);
		} else {
			return ctx.ui.notify(`unknown action: "${action}" — no action (TUI=checkbox / non-TUI=list) | all | none | on|off <index|path>`, "warning");
		}
	};

	/** /zense distill — condense memory.jsonl into one lesson set + clear specs/ and
	 *  subagents/ logs. Safety order (never reshuffle): count the impact → confirm y/n →
	 *  distiller sub-agent (read-only) → strict output validation → only then overwrite
	 *  memory + delete history. Any failure aborts without deleting anything. */
	const runDistill = async (ctx: ExtensionContext): Promise<void> => {
		const zd = zenseDir(ctx.cwd);
		const memPath = join(zd, "memory.jsonl");
		const impact = distillImpact(ctx.cwd);
		if (!impact.memoryLines)
			return ctx.ui.notify("📚 memory is empty — nothing to distill (per the rule no lessons = no deletion, specs/subagents stay untouched)", "info");
		// hard guard: the content is embedded whole into the prompt — over the ceiling, an
		// explicit abort beats silently distilling from partial history
		if (impact.memoryBytes > MAX_DISTILL_MEMORY_BYTES)
			return ctx.ui.notify(`⚠ memory.jsonl is ${fmtBytes(impact.memoryBytes)} — over the ${fmtBytes(MAX_DISTILL_MEMORY_BYTES)} ceiling for embedding whole into a prompt; trim/filter it yourself first, then distill (nothing has been touched)`, "warning");
		let memoryContent: string;
		try {
			memoryContent = readFileSync(memPath, "utf8");
		} catch (e) {
			return ctx.ui.notify(`⚠ can't read memory.jsonl: ${String(e).slice(0, 120)} — aborted, nothing touched`, "warning");
		}
		const running = state.subagentRuns.filter((r) => r.status === "running").map((r) => r.role);
		const detail = [
			`memory.jsonl lessons : ${impact.memoryLines} lines (${fmtBytes(impact.memoryBytes)}) → distilled into one set and rewritten (same format)`,
			`specs archive        : ${impact.specFiles} file(s) (${fmtBytes(impact.specBytes)}) → deleted entirely`,
			`subagent logs        : ${impact.logFiles} file(s) (${fmtBytes(impact.logBytes)}) → deleted entirely`,
			"untouched            : adr/ · config.json · models.json · spec.json · spec.md",
			"",
			"⚠ deletion is unrecoverable (no archive) — if the sub-agent fails to distill, it aborts and deletes nothing",
			...(running.length ? [`⚠ sub-agent(s) still running: ${running.join(", ")} — their logs will be deleted mid-run; better to wait for them`] : []),
		].join("\n");
		const ok = await ctx.ui.confirm("🧹 /zense distill — confirm distilling memory + deleting history?", detail);
		if (!ok) return ctx.ui.notify("distill cancelled — no files changed", "info");
		ctx.ui.notify(`🧪 distilling ${impact.memoryLines} lessons… (distiller sub-agent, read-only)`, "info");
		const logPath = subagentLogPath(ctx.cwd, "distiller");
		const mainModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		// always runs in the main cwd (not the worktree — its memory is a checkout-time copy),
		// hence a direct runSubagent call, not launchSubagent
		const r = await runSubagent("distiller", distillTaskPrompt(memoryContent, impact.memoryLines), ctx.cwd, subagentTimeout("distiller", ctx.cwd), undefined, logPath, resolveModelPattern(ctx.cwd, "distiller", mainModel), SUBAGENT_EXCLUDE_TOOLS.distiller, await subagentStripFlagsAsync("distiller", ctx.cwd));
		if (!r.ok) {
			learn(ctx, `distill aborted: distiller sub-agent failed — ${r.output.split("\n")[0].slice(0, 160)}`);
			ctx.ui.notify(`⚠ distiller failed — aborted; nothing deleted/overwritten (log: ${relative(ctx.cwd, logPath)})`, "warning");
			return;
		}
		const parsed = parseDistilledLessons(r.output);
		if (!parsed.ok) {
			learn(ctx, `distill aborted: distiller output invalid (${parsed.error})`);
			ctx.ui.notify(`⚠ distiller output is invalid: ${parsed.error} — aborted; nothing deleted/overwritten (log: ${relative(ctx.cwd, logPath)})`, "warning");
			return;
		}
		// atomic: tmp+rename — a mid-write crash can't corrupt the original; a failed write
		// aborts before the deletion phase (the "any failure deletes nothing" promise)
		try {
			replaceFileAtomic(memPath, buildDistilledMemory(parsed.lessons));
		} catch (e) {
			learn(ctx, `distill aborted: overwriting memory.jsonl failed (${String(e).slice(0, 120)})`);
			ctx.ui.notify(`⚠ overwriting memory.jsonl failed (${String(e).slice(0, 120)}) — aborted; specs/logs not deleted, the original file is intact`, "warning");
			return;
		}
		const specsN = clearDirFiles(join(zd, "specs"));
		const logsN = clearDirFiles(join(zd, "subagents"), new Set([basename(logPath)])); // keep the latest distiller log for audit
		learn(ctx, `distilled memory: ${impact.memoryLines} → ${parsed.lessons.length} lessons; cleared specs ×${specsN}, logs ×${logsN}`);
		ctx.ui.notify(`✅ distill done — memory ${impact.memoryLines} lines → ${parsed.lessons.length} lessons · deleted ${specsN} spec file(s) · ${logsN} log file(s) (distiller log kept)`, "info");
	};

	/** 🔁 /zense resume — explicit adoption of an on-disk cycle into a FRESH session
	 *  (appendEntry restore covers same-session resumes; a genuinely new session starts empty
	 *  and spec/worktree/pendingApply pointers would otherwise be lost). Human decision
	 *  (2026-09-20): no auto-adopt — a session that doesn't resume abandons the old cycle
	 *  (files stay untouched on disk; clean up an abandoned worktree with git worktree remove). */
	const resumeZense = (ctx: ExtensionContext): void => {
		if (state.spec)
			return ctx.ui.notify(
				`nothing to resume — this session already owns spec v${state.spec.version} (${state.spec.approved ? "signed" : "unsigned"})`,
				"warning",
			);
		const disc = discoverResumeState(ctx.cwd);
		if (!disc)
			return ctx.ui.notify(
				"nothing to resume — no valid .zense/spec.json on disk (no spec was ever committed here, or the file is corrupt)",
				"info",
			);
		const disk = disc.spec;
		state.spec = disk;
		state.phase = disk.approved ? "implementation" : "requirements"; // unsigned spec resumes with the gate closed — sign via /zense approve
		state.specJsonPath = disc.specJsonPath;
		state.specMdPath = disc.specMdPath;
		// worktree rewire — found → redirect resumes; gone → work continues in main (never a failure)
		let wtLine: string;
		if (disc.worktree) {
			state.worktree = disc.worktree;
			state.worktreeLeaveNotified = true; // this notify already carries the "applied on eval PASS" info
			wtLine =
				`🌳 worktree rewired: ${disc.worktree.root}\n  branch ${disc.worktree.branch} — tool calls are redirected here; applied as staged changes on eval PASS` +
				(disc.worktreeExactVersion === false ? `\n  ⚠ branch predates spec v${disk.version} (reused worktree across a version bump) — verify it holds the right in-progress work` : "");
			learn(ctx, `resume: worktree rewired ${disc.worktree.branch} @ ${disc.worktree.root}`);
		} else {
			wtLine = "no matching worktree found — working directly in main";
		}
		// pendingApply restore — eval PASS staged the change in main, then the human reopened a
		// session to review/commit: without the pointer /zense accept|discard would be blind
		let paLine = "";
		if (disc.pendingApply) {
			state.pendingApply = disc.pendingApply;
			learn(ctx, `resume: pendingApply restored (${disc.pendingApply.paths.length} staged path(s))`);
			paLine = `\n⏳ pending apply restored: ${disc.pendingApply.paths.length} file(s) staged awaiting a commit — git commit -F .zense/pending-apply.msg · /zense accept · or /zense discard`;
		}
		learn(ctx, `resumed spec v${disk.version} from disk (approved=${disk.approved})`);
		persist();
		updateWidget(ctx);
		ctx.ui.notify(
			`🔁 resumed spec v${disk.version}${disk.approved ? " (signed — implementation gate open)" : " (unsigned — gate closed; sign via /zense approve)"}: ${disk.title}\n${wtLine}${paLine}`,
			"info",
		);
	};

	pi.registerCommand("zense", {
		description: "Zense harness (zense = human signature/sign): status | resume | approve | accept | discard | agents | gate on|off | memory | distill | models | ext-config-show",
		getArgumentCompletions: (prefix) =>
			// offer only real /zense subcommands — roles (requirements/grader/reviewer) stay out
			// (they have dedicated /zense:ext-config:<role> commands), and actions (all/none/
			// on/off) are second-level args of ext-config-show which pi can't positionally
			// separate → including them would conjure phantom subcommands at position 1
			["status", "resume", "approve", "accept", "agents", "discard", "distill", "gate", "memory", "models", "ext-config-show", "longrun"]
				.filter((s) => s.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			if (sub === "status") {
				const disk = state.spec ? null : loadSpecFromDisk(ctx.cwd);
				ctx.ui.notify(
					`phase=${state.phase} spec=${state.spec ? `v${state.spec.version} approved=${state.spec.approved}` : "—"}\n` +
						(disk ? `📄 on-disk spec found: v${disk.version} ${disk.approved ? "(signed)" : "(unsigned)"} — /zense resume to continue it, or ignore to abandon\n` : "") +
						(state.worktree ? `worktree: ${state.worktree.dir}\n  branch ${state.worktree.branch} (active — applied as staged changes on eval PASS, never auto-committed)\n` : `worktree: (none — working in main)\n`) +
						`turns=${state.turnsUsed} tokens=${state.tokensUsed}\n` +
						(state.pendingApply
							? `⏳ pending apply: spec v${state.pendingApply.specVersion} — ${state.pendingApply.paths.length} file(s) staged awaiting a commit (from ${state.pendingApply.branch})\n  commit: git commit -F .zense/pending-apply.msg · accept after committing: /zense accept · roll back: /zense discard (reverse patch)\n`
							: "") +
						`trajectory flags:\n${state.trajectoryFlags.join("\n") || "(none)"}\nescalations:\n${state.escalations.map((e) => `${e.kind}: ${e.detail}`).join("\n") || "(none)"}`,
					"info",
				);
			} else if (sub === "resume") {
				resumeZense(ctx);
			} else if (sub === "approve") {
				if (!state.spec)
				return ctx.ui.notify(
					"No spec to approve: no spec has been committed into the system — approve works only on a spec the agent registered via the zense_spec tool in this session; a spec presented as chat text registers nothing. Next step: have the agent call zense_spec (recommended: action=compile_spec), then sign from the dialog that appears.",
					"warning",
				);
				// wake the agent to continue after a /zense approve signing — signing from a slash
				// command happens while the agent is idle, so no new turn starts on its own (unlike
				// signing inside a tool dialog mid-stream) → sendUserMessage is required
				const kickoff = `Zense: spec v${state.spec.version} has been signed — the implementation gate is open\nstart implementing per the spec (read .zense/spec.md; never write outside its scope)`;
				const nudgeAgent = () => {
					try { pi.sendUserMessage(kickoff); return; } catch { /* agent is streaming — fall back to followUp */ }
					try { pi.sendUserMessage(kickoff, { deliverAs: "followUp" }); } catch { /* non-fatal: the user can nudge manually */ }
				};
				if (ctx.mode === "tui") {
					const choice = await specSignDialog(ctx, state.spec, `Sign & approve spec v${state.spec.version}: ${state.spec.title}?`, [
						{ value: "sign", label: "🔏 Sign & approve — open the implementation gate", description: "a human signature = the agent may start implementing" },
						{ value: "cancel", label: "Cancel (not signing yet)", description: "the spec stays pending — approve again anytime" },
					]);
					if (choice === "sign" && approveCurrentSpec(ctx)) nudgeAgent();
				} else {
					const ok = await ctx.ui.confirm("🔏 Sign & approve the spec?", `${state.spec.title} v${state.spec.version}\nIntent: ${state.spec.intent.slice(0, 300)}\n(full text at .zense/spec.md)`);
					if (ok && approveCurrentSpec(ctx)) nudgeAgent();
				}
			} else if (sub === "gate") {
				state.gateEnabled = rest[0] !== "off";
				persist();
				ctx.ui.notify(`Gate ${state.gateEnabled ? "ON" : "OFF"}`, state.gateEnabled ? "info" : "warning");
			} else if (sub === "discard") {
				// roll back the pending applied change (reverse patch) — the official undo path for
				// an unhappy human review
				if (!state.pendingApply) return ctx.ui.notify("no pending apply to discard (the change was already committed, or never applied)", "info");
				const dr = discardPendingApply(ctx.cwd);
				if (!dr.ok) {
					escalate("need-decision", `discard: ${dr.msg}`, ctx);
					return ctx.ui.notify(`⚠ discard failed: ${dr.msg}`, "warning");
				}
				const v = state.pendingApply.specVersion;
				state.pendingApply = undefined;
				learn(ctx, `spec v${v} discarded after review (reverse-applied)`);
				state.contextBulletin = buildDiscardBulletin(v); // command path (human-typed) — the agent learns via the next turn's system prompt
				resetCycleState(state);
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`✅ ${dr.msg} — spec v${v} has been rolled back out of main`, "info");
			} else if (sub === "accept") {
				// pendingApply's accept side (discard's counterpart): "/zense accept commit" =
				// human wants the harness to commit for them
				if (!state.pendingApply) return ctx.ui.notify("no pending apply to accept (already committed/accepted, or never applied)", "info");
				let commitIfStaged = rest[0] === "commit";
				if (!commitIfStaged && !gitOk(["diff", "--cached", "--quiet"], ctx.cwd).ok) {
					// staged leftovers = the human hasn't committed — offer to commit on their behalf
					// (soft, never auto-commits)
					const ok =
						ctx.mode === "tui" &&
						(await ctx.ui.confirm(
							`✅ accepting spec v${state.pendingApply.specVersion} — but staged changes are still pending (not yet committed)`,
							"have the harness commit them with .zense/pending-apply.msg, then accept? (hooks run normally)\nchoosing No cancels: commit yourself, then /zense accept again",
						));
					if (!ok)
						return ctx.ui.notify(
							"not committed yet — commit yourself with `git commit -F .zense/pending-apply.msg`, then /zense accept; or let the harness do it: /zense accept commit",
							"info",
						);
					commitIfStaged = true;
				}
				const r = acceptPending(ctx, commitIfStaged, true);
				ctx.ui.notify(r.text, r.ok ? "info" : "warning");
			} else if (sub === "longrun") {
			// long-running mode (ADR-004) from the keyboard — mirrors zense_longrun's actions for
			// the human: status=list, resume=pick by name, sign=a saved-but-unsigned tracker,
			// abandon=destroy the set's worktree. Agent-side lives in the zense_longrun tool.
			const [action, target] = rest;
			if (action === "status" || action === "list" || !action) {
				const trackers = discoverLongrunTrackers(ctx.cwd).filter((t) => t.status !== "done");
				ctx.ui.notify(
					trackers.length
						? `🏗 long-running requirements:\n${trackers
								.map(
									(t) =>
										`  ${t.status === "active" ? "▶" : "○"} ${t.slug} — "${t.title}" [v${t.version} ${t.status}] ${t.phases.filter((ph) => ph.status === "done").length}/${t.phases.length} phases done` +
										(state.longRun?.slug === t.slug ? "  ← session-active" : ""),
								)
								.join("\n")}\n\nresume: /zense longrun resume — agent: zense_longrun status`
						: "no long-running requirements (.zense/long-running/) — the agent starts one with zense_longrun init",
					"info",
				);
			} else if (action === "resume") {
				const trackers = discoverLongrunTrackers(ctx.cwd).filter((t) => t.status === "active");
				let t = target ? trackers.find((x) => x.slug === target) : trackers.length === 1 ? trackers[0] : undefined;
				if (!t && trackers.length && ctx.mode === "tui") {
					const pick = await ctx.ui.select("resume which long-running requirement?", trackers.map((x) => `${x.slug} — "${x.title}" (${x.phases.filter((ph) => ph.status === "done").length}/${x.phases.length} done)`));
					if (pick) t = trackers.find((x) => pick.startsWith(x.slug));
				}
				if (!t)
					return ctx.ui.notify(trackers.length ? `pick one: /zense longrun resume <slug>\n${trackers.map((x) => `  ${x.slug}`).join("\n")}` : "no active longrun to resume", "warning");
				state.longRun = { slug: t.slug, trackerVersion: t.version, ...(t.phases.find((x) => x.status === "active") ? { activePhase: t.phases.find((x) => x.status === "active")!.id } : {}) };
				persist();
				updateWidget(ctx);
				// same idle-agent nudge as /zense approve: a slash command starts no turn
				const kick = `Zense: the human resumed longrun "${t.slug}" — continue it now: reconcile + activate the next/current phase with the zense_longrun tool (action=resume slug=${t.slug}, which verifies the worktree), then proceed`;
				try { pi.sendUserMessage(kick); } catch { try { pi.sendUserMessage(kick, { deliverAs: "followUp" }); } catch { /* non-fatal */ } }
				ctx.ui.notify(`🔁 resuming longrun "${t.slug}"…`, "info");
			} else if (action === "sign") {
				const t = target ? loadTracker(ctx.cwd, target) : undefined;
				if (!t) return ctx.ui.notify("usage: /zense longrun sign <slug>", "warning");
				if (t.status !== "planning") return ctx.ui.notify(`tracker "${t.slug}" is ${t.status} — sign applies only to a saved-but-unsigned plan`, "warning");
				const ok = await ctx.ui.confirm(`🔏 Sign longrun tracker "${t.slug}" v${t.version}?`, `${t.phases.length} phase(s): ${t.phases.map((x) => x.id).join(", ")} — one signature covers all phases\n(full plan: .zense/long-running/${t.slug}/tracker.md)`);
				if (!ok) return ctx.ui.notify("not signed", "info");
				t.approvedAt = Date.now();
				t.status = "active";
				saveTracker(ctx.cwd, t);
				state.longRun = { slug: t.slug, trackerVersion: t.version };
				const ens = ensureLongrunWorktree(ctx.cwd, t.slug, t.worktreeBranch);
				if (ens) {
					state.worktree = ens.wt;
					state.worktreeLeaveNotified = false;
				}
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`🔏 tracker "${t.slug}" v${t.version} signed — tell the agent to continue (zense_longrun next)`, "info");
			} else if (action === "abandon") {
				ctx.ui.notify(`use the agent: ask it to run zense_longrun abandon slug=${target ?? "<slug>"} — it enforces the pendingApply guard and confirm flow`, "info");
			} else {
				ctx.ui.notify("usage: /zense longrun status|resume [slug]|sign <slug>|abandon <slug>", "info");
			}
		} else if (sub === "agents") {
				await openAgentsViewer(ctx);
			} else if (sub === "memory") {
				if (rest[0] === "json") {
					// raw JSONL tail
					const f = join(zenseDir(ctx.cwd), "memory.jsonl");
					ctx.ui.notify(existsSync(f) ? readFileSync(f, "utf8").slice(-2000) : "(empty)", "info");
				} else {
					const lines = memorySummaryLines(ctx.cwd);
					ctx.ui.notify(
						lines.length ? [...lines, "(raw: /zense memory json)"].join("\n") : "📚 memory is empty — lessons accumulate on every escalation/flag/eval/sub-agent failure",
						"info",
					);
				}
			} else if (sub === "distill") {
				await runDistill(ctx);
			} else if (sub === "models") {
				// view/set sub-agent models per role (.zense/models.json)
				const cfgPath = join(zenseDir(ctx.cwd), "models.json");
				const cfg = readModelsConfig(ctx.cwd);
				const mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no active model)";
				const roles = ["requirements", "planner", "grader", "reviewer", "distiller"];
				if (ctx.mode !== "tui") {
					// non-TUI (rpc/print): show a summary for manual editing, as before
					const lines = [
						`🧪 sub-agent models — config: ${existsSync(cfgPath) ? relative(ctx.cwd, cfgPath) : "(no .zense/models.json — every role uses the main model)"}`,
						`main agent: ${mainModel}`,
						...roles.map((r) => `  ${r}: ${cfg[r] ? cfg[r] + " (from config)" : mainModel + " (fallback)"}`),
						"edit by creating .zense/models.json, e.g. { \"grader\": \"openai/gpt-4o-mini\" } — or open the TUI and use /zense models for an interactive picker",
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				// TUI: interactive picker — pick a role → pick a model from the catalogue →
				// models.json gets written
				const role = await zensePick(
					ctx,
					"🧪 pick the sub-agent role to set a model for",
					roles.map((r) => ({
						value: r,
						label: r,
						description: cfg[r] ? `${cfg[r]} (from config)` : `${mainModel} (fallback)`,
					})),
					`main agent: ${mainModel}`,
				);
				if (!role) return;
				const choices = availableModelChoices(ctx);
				const sel = await zensePick(
					ctx,
					`🧪 pick a model for role "${role}"`,
					[
						{ value: "__default__", label: "↩️ use the main model (remove override)", description: `falls back to ${mainModel}` },
						{ value: "__custom__", label: "✏️ type a pattern yourself", description: "e.g. openai/gpt-4o-mini or sonnet:high" },
						...choices.map((c) => ({ value: c.pattern, label: c.label, description: c.description })),
					],
					choices.length ? `${choices.length} models from the catalogue` : "catalogue empty — pick 'type a pattern yourself'",
				);
				if (!sel) return;
				if (sel === "__default__") {
					writeModelsConfig(ctx.cwd, role, null);
					ctx.ui.notify(`✅ ${role}: override removed — the next sub-agent run falls back to the main model (${mainModel})`, "info");
					return;
				}
				let pattern = sel;
				if (sel === "__custom__") {
					const typed = (await ctx.ui.input(`model pattern for "${role}":`, "provider/model-id"))?.trim();
					if (!typed) return ctx.ui.notify("cancelled — model unchanged", "info");
					pattern = typed;
				}
				writeModelsConfig(ctx.cwd, role, pattern);
				ctx.ui.notify(`✅ ${role}: ${pattern} — wrote ${relative(ctx.cwd, cfgPath)} (takes effect on the next sub-agent run)`, "info");
			} else if (sub === "ext-config-show" || sub === "ext-config") {
				// ext-config-show (new name; ext-config kept as alias): no role → combined view of
				// all roles; with a role → delegate to runExtConfig (the main path is the per-role
				// commands /zense:ext-config:<role>)
				const roles = ["requirements", "planner", "grader", "reviewer", "distiller"];
				const [role, action, ...vals] = rest;
				if (!role || !roles.includes(role)) {
					ctx.ui.notify(
						[
							"🧩 sub-agent extension loading (per role) — default: bare boot, no extensions · tick to opt specific ones back in",
							...roles.map((r) => {
								const inc = subagentExtIncludes(r, ctx.cwd);
								return `  ${r}: ${inc.length ? `loads ${inc.length}` : "bare boot (no extensions)"}`;
							}),
							`persist: local ${join(zenseDir(ctx.cwd), "config.json")} · global ${join(zenseGlobalConfigDir(), "config.json")} (first-time seed + fallback)`,
							"configure: /zense:ext-config:grader | :requirements | :reviewer (TUI = instant checkboxes) or /zense ext-config-show <role> all|none|on|off <index|path>",
						].join("\n"),
						"info",
					);
					return;
				}
				await runExtConfig(ctx, role, action, vals);
			} else {
				ctx.ui.notify("usage: /zense status|resume|approve|accept [commit]|discard|agents|gate on|off|memory|distill|models|ext-config-show|longrun status|longrun resume|longrun sign", "info");
			}
		},
	});

	// per-role ext-config commands (v8): autocomplete straight from the command name, no role
	// arg to type (pi's getArgumentCompletions supplies only the current word's prefix — same
	// pattern as skill commands)
	for (const role of ["requirements", "planner", "grader", "reviewer", "distiller"] as const)
		pi.registerCommand(`zense:ext-config:${role}`, {
			description: `which extensions sub-agent "${role}" loads (default: bare boot — opt in by ticking; saved to local .zense + first-time global seed)`,
			handler: async (_args, ctx) => runExtConfig(ctx as ExtensionContext, role),
		});
}


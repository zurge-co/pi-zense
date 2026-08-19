/**
 * sdlc-harness — AI-driven SDLC harness for pi, per PLAN.md.
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
 *   P1 Requirements : sdlc_spec tool → append-only archive .pi/sdlc/specs/
 *                     <timestamp>-v{n}-<slug>.{json,md} (never overwritten) +
 *                     .pi/sdlc/spec.{json,md} as always-latest copies
 *   P2 Design       : sdlc_adr tool → .pi/sdlc/adr/NNN-*.md (deny rules checked live)
 *   P3 Implementation: specification gate + escalation
 *   P4 Dual eval    : sdlc_eval (output eval vs criteria) + trajectory heuristics
 *   P5 Review/Deploy: sdlc_review builds a review-packet card (exception-based)
 *   P6 Maintenance  : memory.jsonl learning log; incidents feed new criteria
 */
import { execFile } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ----------------------------------------------------------------------------- types

interface Criterion { id: string; text: string; check: string; verified?: boolean }
interface Spec {
	version: number;
	title: string;
	intent: string;
	scope: string[];           // path globs the agent may touch
	constraints: string[];
	criteria: Criterion[];
	specDebt: string[];        // unverifiable items → forced human review
	approved: boolean;
	approvedAt?: number;
}
interface State {
	phase: "requirements" | "design" | "implementation" | "eval" | "review" | "maintenance";
	spec?: Spec;
	turnsUsed: number;
	tokensUsed: number;
	escalations: { kind: string; detail: string; at: number }[];
	trajectoryFlags: string[];
	gateEnabled: boolean;
	subagentRuns: { role: string; ok: boolean; summary: string; at: number }[];
}

const sdlcDir = (cwd: string) => join(cwd, ".pi", "sdlc");

const freshState = (): State => ({
	phase: "requirements",
	turnsUsed: 0,
	tokensUsed: 0,
	escalations: [],
	trajectoryFlags: [],
	gateEnabled: true,
	subagentRuns: [],
});

// ----------------------------------------------------------------------------- sub-agent runner

/** Spawn an isolated pi sub-agent (print mode) with a clean context. */
function runSubagent(
	role: string,
	task: string,
	cwd: string,
	timeoutMs = 240_000,
): Promise<{ ok: boolean; output: string }> {
	return new Promise((res) => {
		execFile(
			"env",
			["PI_SDLC_SUBAGENT=1", "pi", "--mode", "print", "--no-session", task],
			{ cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) res({ ok: false, output: (stderr || String(err)).slice(0, 4000) });
				else res({ ok: true, output: stdout.slice(-16_000) });
			},
		);
	});
}

// ----------------------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	// Sub-agent invocations must not re-enter the harness.
	if (process.env.PI_SDLC_SUBAGENT === "1") return;

	let state = freshState();

	// ----- persistence (appendEntry restores across reloads/resumes)
	const persist = () => pi.appendEntry("sdlc-state", state);
	const readdirAdrs = (cwd: string): string[] => {
		const dir = join(sdlcDir(cwd), "adr");
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter((f) => f.endsWith(".md"));
	};
	const adrText = (cwd: string) =>
		readdirAdrs(cwd)
			.map((f) => readFileSync(join(sdlcDir(cwd), "adr", f), "utf8"))
			.join("\n---\n")
			.slice(0, 12_000);

	pi.on("session_start", async (_ev, ctx) => {
		for (const e of ctx.sessionManager.getEntries())
			if (e.type === "custom" && e.customType === "sdlc-state")
				state = { ...freshState(), ...(e.data as State) };
		updateWidget(ctx);
	});

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const s = state.spec;
		ctx.ui.setWidget("sdlc", [
			`SDLC ▸ ${state.phase.toUpperCase()} · spec: ${s ? (s.approved ? "✅v" + s.version : "⏳unapproved") : "—"}` +
				` · turns ${state.turnsUsed} · tok ${Math.round(state.tokensUsed / 1000)}k` +
				(state.trajectoryFlags.length ? ` · ⚠ ${state.trajectoryFlags.length} traj-flags` : "") +
				(state.escalations.length ? ` · 🚨 ${state.escalations.length}` : ""),
		]);
	};

	// ----- Phase 1 gate: no implementation on unapproved spec (hard enforcement)

	pi.on("tool_call", async (ev, ctx) => {
		if (!state.gateEnabled) return;
		const isWrite = ev.toolName === "write" || ev.toolName === "edit";
		if (!isWrite) return;

		if (state.phase === "requirements" || !state.spec?.approved) {
			const ok = ctx.hasUI
				? await ctx.ui.confirm(
						"SDLC gate: spec not approved",
						`Block ${ev.toolName}? Approve the spec first (/sdlc approve) or override.`,
				  )
				: false;
			if (!ok) {
				escalate("need-permission", `write blocked: spec unapproved`, ctx);
				return { block: true, reason: "Spec gate: approve the spec via /sdlc approve before implementation." };
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

		// Design-constraint checker: ADR "DENY:" rules block matching writes/commands.
		const adr = adrText(ctx.cwd);
		for (const line of adr.split("\n")) {
			const m = line.match(/^DENY:\s*(.+?)\s*→?\s*(.*)$/i);
			if (m && (target ?? "").includes(m[1]))
				return { block: true, reason: `ADR constraint: ${m[1]} denied (${m[2] || "see ADR"})` };
		}
	});

	// ----- Phase 3: turn/token usage meter

	pi.on("turn_end", async (ev, ctx) => {
		state.turnsUsed++;
		state.tokensUsed += ev.message?.usage?.totalTokens ?? 0;
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

		persist();
	});

	const flag = (msg: string, ctx: ExtensionContext) => {
		if (!state.trajectoryFlags.includes(msg)) {
			state.trajectoryFlags.push(msg);
			ctx.ui.notify(`⚠ trajectory-eval: ${msg}`, "warning");
		}
	};

	const escalate = (kind: string, detail: string, ctx: ExtensionContext) => {
		state.escalations.push({ kind, detail, at: Date.now() });
		persist();
		updateWidget(ctx);
	};

	// ----- tools exposed to the agent ("phase sub-agents" via pi.registerTool)

	pi.registerTool({
		name: "sdlc_spec",
		label: "SDLC Spec",
		description:
			"Phase 1 (Requirements): compile conversation requirements into a structured, versioned spec artifact with machine-checkable acceptance criteria. Human approval is required before implementation.",
		promptSnippet: "Compile/approve the structured spec: intent, scope, criteria, spec-debt",
		promptGuidelines: [
			"Use sdlc_spec before any implementation to write the spec; list unverifiable requirements under specDebt.",
			"Use sdlc_spec with action=compile_spec to delegate drafting to the requirements sub-agent.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("set"), Type.Literal("compile_spec")] as const),
			intent: Type.Optional(Type.String({ description: "What the user wants and why" })),
			scope: Type.Optional(Type.Array(Type.String(), { description: "Path prefixes the agent may modify" })),
			constraints: Type.Optional(Type.Array(Type.String())),
			criteria: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						text: Type.String(),
						check: Type.String({ description: "How eval verifies it: bash probe, path exists, manual" }),
					}),
				),
			),
			specDebt: Type.Optional(Type.Array(Type.String(), { description: "Unverifiable → forced human review" })),
			title: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _sig, _on, ctx) {
			if (params.action === "compile_spec") {
				const draft = await runSubagent(
					"requirements",
					`You are the REQUIREMENTS sub-agent. Produce a JSON spec {title,intent,scope[],constraints[],criteria[{id,text,check}],specDebt[]} from this request; criteria[.check] must be machine-checkable where possible. Output ONLY JSON.\n\nRequest: ${params.intent}`,
					ctx.cwd,
				);
				state.subagentRuns.push({ role: "requirements", ok: draft.ok, summary: draft.output.slice(0, 300), at: Date.now() });
				persist();
				return { content: [{ type: "text", text: draft.ok ? draft.output : `sub-agent failed: ${draft.output}` }], details: draft };
			}
			const version = (state.spec?.version ?? 0) + 1;
			state.spec = {
				version,
				title: params.title ?? "untitled",
				intent: params.intent ?? "",
				scope: params.scope ?? [],
				constraints: params.constraints ?? [],
				criteria: params.criteria ?? [],
				specDebt: params.specDebt ?? [],
				approved: false,
			};
			// Specs are append-only: every version gets a unique timestamped file in
			// .pi/sdlc/specs/ so any past spec can be re-read. spec.{json,md} stay as
			// always-latest convenience copies.
			mkdirSync(sdlcDir(ctx.cwd), { recursive: true });
			const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); // YYYY-MM-DD-HH-mm-ss
			const slug =
				(state.spec.title ?? "untitled").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
				"untitled";
			const specDir = join(sdlcDir(ctx.cwd), "specs");
			mkdirSync(specDir, { recursive: true });
			const jsonPath = join(specDir, `${stamp}-v${version}-${slug}.json`);
			const mdPath = join(specDir, `${stamp}-v${version}-${slug}.md`);
			writeFileSync(jsonPath, JSON.stringify(state.spec, null, 2));
			writeFileSync(mdPath, renderSpecMd(state.spec));
			copyFileSync(jsonPath, join(sdlcDir(ctx.cwd), "spec.json"));
			copyFileSync(mdPath, join(sdlcDir(ctx.cwd), "spec.md"));
			persist();
			updateWidget(ctx);
			return {
				content: [{ type: "text", text: `Spec v${version} archived at ${mdPath} (latest copies: .pi/sdlc/spec.{json,md}). NOT approved — user must run /sdlc approve.` }],
				details: { version },
			};
		},
	});

	pi.registerTool({
		name: "sdlc_adr",
		label: "SDLC ADR",
		description:
			"Phase 2 (Design): record an Architecture Decision Record. One-way-door decisions need human approval (/sdlc adr-approve N). ADRs are re-read before every implementation run and DENY rules are enforced live.",
		promptSnippet: "Record an architecture decision (ADR) with status and optional DENY rules",
		parameters: Type.Object({
			title: Type.String(),
			decision: Type.String(),
			consequences: Type.String(),
			irreversible: Type.Boolean({ description: "One-way door → human approval gate" }),
			denyRules: Type.Optional(Type.Array(Type.String(), { description: "Path substrings forbidden by this decision" })),
		}),
		async execute(_id, p, _s, _o, ctx) {
			const dir = join(sdlcDir(ctx.cwd), "adr");
			mkdirSync(dir, { recursive: true });
			const n = String(readdirAdrs(ctx.cwd).length + 1).padStart(3, "0");
			const file = join(dir, `${n}-${p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`);
			writeFileSync(
				file,
				`# ADR-${n}: ${p.title}\nstatus: ${p.irreversible ? "proposed (NEEDS HUMAN APPROVAL)" : "accepted"}\ndate: ${new Date().toISOString()}\n\n## Decision\n${p.decision}\n\n## Consequences\n${p.consequences}\n` +
					(p.denyRules ?? []).map((d) => `DENY: ${d}\n`).join(""),
			);
			persist();
			return { content: [{ type: "text", text: `ADR-${n} recorded at ${file}${p.irreversible ? " — pending human approval" : ""}` }] };
		},
	});

	pi.registerTool({
		name: "sdlc_eval",
		label: "SDLC Eval",
		description:
			"Phase 4: dual evaluation — output eval grades the artifact against approved spec criteria (delegated to the grader sub-agent); trajectory flags are attached. Spec-debt items become forced human review.",
		parameters: Type.Object({ note: Type.Optional(Type.String()) }),
		async execute(_id, _p, _s, onUpdate, ctx) {
			if (!state.spec) return { content: [{ type: "text", text: "No spec yet." }], details: {}, isError: true };
			onUpdate?.({ content: [{ type: "text", text: "running grader sub-agent…" }] });
			const grade = await runSubagent(
				"grader",
				`You are the OUTPUT-EVAL grader. For each acceptance criterion, judge PASS/FAIL with evidence (run checks with tools if useful). Also look for reward hacking. Criteria:\n${state.spec.criteria
					.map((c) => `- ${c.id}: ${c.text} (check: ${c.check})`)
					.join("\n")}\nOutput a verdict table then OVERALL: PASS|FAIL.`,
				ctx.cwd,
			);
			state.subagentRuns.push({ role: "grader", ok: grade.ok, summary: grade.output.slice(0, 300), at: Date.now() });
			const report = `${grade.output}\n\n## Trajectory flags\n${state.trajectoryFlags.join("\n") || "(none)"}\n\n## Spec debt (needs human)\n${state.spec.specDebt.join("\n") || "(none)"}`;
			state.phase = "review";
			persist(); updateWidget(ctx);
			return { content: [{ type: "text", text: report }], details: { ok: grade.ok, trajectory: state.trajectoryFlags } };
		},
	});

	pi.registerTool({
		name: "sdlc_review",
		label: "SDLC Review Packet",
		description: "Phase 5: build the exception-based review packet (TL;DR first, evidence linked, anomalies highlighted).",
		parameters: Type.Object({}),
		async execute(_id, _p, _s, _o, ctx) {
			const reviewer = await runSubagent(
				"reviewer",
				`You are the REVIEWER sub-agent. Produce an incident-report-style review packet: TL;DR (3 lines max), intent vs implementation, risk areas, rollback plan. Intent: ${state.spec?.intent}. Do NOT dump raw diffs; summarize.`,
				ctx.cwd,
			);
			const packet = {
				tlDr: reviewer.output.slice(0, 900),
				trajectory: state.trajectoryFlags,
				specDebt: state.spec?.specDebt ?? [],
				escalations: state.escalations,
			};
			pi.appendEntry("sdlc-review-packet", packet);
			learn(ctx, `review packet: flags=${packet.trajectory.length}, escalations=${packet.escalations.length}`);
			return { content: [{ type: "text", text: packet.tlDr }], details: packet };
		},
	});

	// Review-packet card in the transcript.
	pi.registerEntryRenderer("sdlc-review-packet", (entry, { expanded }, theme) => {
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
		mkdirSync(sdlcDir(ctx.cwd), { recursive: true });
		appendFileSync(join(sdlcDir(ctx.cwd), "memory.jsonl"), JSON.stringify({ at: Date.now(), phase: state.phase, note }) + "\n");
	};

	// ----- human gates: commands

	pi.registerCommand("sdlc", {
		description: "SDLC harness: status | approve | gate on|off | memory",
		getArgumentCompletions: (prefix) =>
			["status", "approve", "gate", "memory"].filter((s) => s.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			if (sub === "status") {
				ctx.ui.notify(
					`phase=${state.phase} spec=${state.spec ? `v${state.spec.version} approved=${state.spec.approved}` : "—"}\n` +
						`turns=${state.turnsUsed} tokens=${state.tokensUsed}\n` +
						`trajectory flags:\n${state.trajectoryFlags.join("\n") || "(none)"}\nescalations:\n${state.escalations.map((e) => `${e.kind}: ${e.detail}`).join("\n") || "(none)"}`,
					"info",
				);
			} else if (sub === "approve") {
				if (!state.spec) return ctx.ui.notify("No spec to approve.", "warning");
				const ok = await ctx.ui.confirm("Approve spec?", `${state.spec.title} v${state.spec.version}\nIntent: ${state.spec.intent.slice(0, 300)}`);
				if (ok) {
					state.spec.approved = true;
					state.spec.approvedAt = Date.now();
					state.phase = "implementation";
					persist(); updateWidget(ctx);
					ctx.ui.notify(`Spec v${state.spec.version} approved — implementation gate open.`, "info");
				}
			} else if (sub === "gate") {
				state.gateEnabled = rest[0] !== "off";
				persist();
				ctx.ui.notify(`Gate ${state.gateEnabled ? "ON" : "OFF"}`, state.gateEnabled ? "info" : "warning");
			} else if (sub === "memory") {
				const f = join(sdlcDir(ctx.cwd), "memory.jsonl");
				ctx.ui.notify(existsSync(f) ? readFileSync(f, "utf8").slice(-2000) : "(empty)", "info");
			} else {
				ctx.ui.notify("usage: /sdlc status|approve|gate on|off|memory", "info");
			}
		},
	});

	function renderSpecMd(s: Spec): string {
		return `# Spec v${s.version}: ${s.title}\napproved: ${s.approved}\n\n## Intent\n${s.intent}\n\n## Scope\n${s.scope.map((x) => `- ${x}`).join("\n")}\n\n## Constraints\n${s.constraints.map((x) => `- ${x}`).join("\n")}\n\n## Acceptance criteria\n${s.criteria.map((c) => `- [ ] ${c.id}: ${c.text} *(check: ${c.check})*`).join("\n")}\n\n## Spec debt (human-verified only)\n${s.specDebt.map((x) => `- ${x}`).join("\n")}\n`;
	}
}

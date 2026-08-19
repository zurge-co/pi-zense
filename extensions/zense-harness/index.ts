/**
 * zense-harness — AI-driven SDLC harness for pi, per PLAN.md.
 *
 * ชื่อ "zense" (เซ็น) พ้องเสียงกับ sign — สื่อว่าทุกครั้งที่สั่ง agent ทำงาน
 * จะมีลายเซ็นของมนุษย์กำกับอยู่เสมอ (spec approval = ลายเซ็นฝั่ง input,
 * review packet = การอนุมัติฝั่ง output)
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
 *   P1 Requirements : zense_spec tool → append-only archive .pi/zense/specs/
 *                     <timestamp>-v{n}-<slug>.{json,md} (never overwritten) +
 *                     .pi/zense/spec.{json,md} as always-latest copies
 *   P2 Design       : zense_adr tool → .pi/zense/adr/NNN-*.md (deny rules checked live)
 *   P3 Implementation: specification gate + escalation
 *   P4 Dual eval    : zense_eval (output eval vs criteria) + trajectory heuristics
 *   P5 Review/Deploy: zense_review builds a review-packet card (exception-based)
 *   P6 Maintenance  : memory.jsonl learning log; incidents feed new criteria
 */
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { Type } from "typebox";
import { Box, Container, Key, Markdown, matchesKey, SelectList, Spacer, Text, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

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
	subagentRuns: SubagentRun[];
}
interface SubagentRun {
	role: string;
	ok: boolean;
	summary: string;
	at: number;
	startedAt?: number;
	logPath?: string;            // .pi/zense/subagents/<stamp>-<role>.log — เขียน live ระหว่างรัน
	status?: "running" | "done" | "failed";
}

const zenseDir = (cwd: string) => join(cwd, ".pi", "zense");

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

/** Humanize token counts: 999000→"999k", 1_000_000→"1.0M". */
export const fmtTok = (n: number): string =>
	n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;

const subagentLogPath = (cwd: string, role: string): string => {
	const dir = join(zenseDir(cwd), "subagents");
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	return join(dir, `${stamp}-${role}.log`);
};

/**
 * Spawn an isolated pi sub-agent (print mode) with a clean context.
 * stdio ignores stdin — ปล่อย stdin pipe ค้างไว้จะทำให้ pi print mode รอ EOF จนหมดเวลา
 * (bug เดิม: execFile ค้างเงียบๆ จนโดน SIGTERM). stdout/stderr stream เขียน log live
 * ทุก chunk เพื่อให้ user tail ดูระหว่างรันได้ (/zense agents หรือ ctrl+shift+a).
 */
function runSubagent(
	role: string,
	task: string,
	cwd: string,
	timeoutMs = 240_000,
	onChunk?: (chunk: string) => void,
	logPath: string = subagentLogPath(cwd, role),
): Promise<{ ok: boolean; output: string; logPath: string }> {
	const relLog = relative(cwd, logPath);
	return new Promise((res) => {
		writeFileSync(logPath, `$ pi --mode print --no-session <task ${task.length} chars>\n--- live output (${role}) ---\n`);
		const child = spawn("env", ["PI_ZENSE_SUBAGENT=1", "pi", "--mode", "print", "--no-session", task], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		const append = (chunk: string) => {
			out = (out + chunk).slice(-1_000_000);
			appendFileSync(logPath, chunk);
			onChunk?.(chunk);
		};
		child.stdout?.on("data", (d) => append(String(d)));
		child.stderr?.on("data", (d) => append(String(d)));
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			appendFileSync(logPath, `\n[spawn error] ${err.message}\n`);
			res({ ok: false, output: `sub-agent spawn error: ${err.message} (log: ${relLog})`, logPath });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const timedOut = signal === "SIGTERM";
			appendFileSync(logPath, `\n--- exited code=${code} signal=${signal} ---\n`);
			if (code === 0 && !signal) res({ ok: true, output: out.slice(-16_000), logPath });
			else
				res({
					ok: false,
					output:
						`sub-agent exited code=${code} signal=${signal}${timedOut ? ` (TIMEOUT ${timeoutMs / 1000}s)` : ""}\n` +
						`last output:\n${out.slice(-4_000)}\n(full log: ${relLog})`,
					logPath,
				});
		});
	});
}

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

	pi.on("session_start", async (_ev, ctx) => {
		for (const e of ctx.sessionManager.getEntries())
			if (e.type === "custom" && e.customType === "zense-state")
				state = { ...freshState(), ...(e.data as State) };
		updateWidget(ctx);
	});

	const activeRun = (): SubagentRun | undefined => {
		for (let i = state.subagentRuns.length - 1; i >= 0; i--) if (state.subagentRuns[i].status === "running") return state.subagentRuns[i];
		return undefined;
	};

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const s = state.spec;
		const run = activeRun();
		ctx.ui.setWidget("zense", [
			`ZENSE ▸ ${state.phase.toUpperCase()} · spec: ${s ? (s.approved ? "✅v" + s.version : "⏳unapproved") : "—"}` +
				` · turns ${state.turnsUsed} · tok ${fmtTok(state.tokensUsed)}` +
				(run ? ` · 🧪 ${run.role} ▶ ${Math.round((Date.now() - (run.startedAt ?? run.at)) / 1000)}s (ctrl+shift+a ดูสด)` : "") +
				(state.trajectoryFlags.length ? ` · ⚠ ${state.trajectoryFlags.length} traj-flags` : "") +
				(state.escalations.length ? ` · 🚨 ${state.escalations.length}` : ""),
		]);
	};

	/** launch wrapper: ลงทะเบียน run (widget แสดงสด) + เขียน log live ทุก chunk */
	const launchSubagent = async (
		ctx: ExtensionContext,
		role: string,
		task: string,
		onChunk?: (chunk: string) => void,
	): Promise<{ ok: boolean; output: string; logPath: string }> => {
		const logPath = subagentLogPath(ctx.cwd, role);
		const run: SubagentRun = { role, ok: false, summary: "", at: Date.now(), startedAt: Date.now(), logPath, status: "running" };
		state.subagentRuns.push(run);
		updateWidget(ctx);
		const tick = setInterval(() => updateWidget(ctx), 2_000); // elapsed วิ่งใน widget
		try {
			const r = await runSubagent(role, task, ctx.cwd, 240_000, onChunk, logPath);
			run.ok = r.ok;
			run.summary = r.output.slice(0, 300);
			run.status = r.ok ? "done" : "failed";
			return r;
		} finally {
			clearInterval(tick);
			persist();
			updateWidget(ctx);
		}
	};

	// ----- Phase 1 gate: no implementation on unapproved spec (hard enforcement)

	pi.on("tool_call", async (ev, ctx) => {
		if (!state.gateEnabled) return;
		const isWrite = ev.toolName === "write" || ev.toolName === "edit";
		if (!isWrite) return;

		if (state.phase === "requirements" || !state.spec?.approved) {
			if (!ctx.hasUI) {
				escalate("need-permission", "write blocked: spec unsigned (no UI)", ctx);
				return { block: true, reason: "Zense gate: spec ยังไม่ได้เซ็น — ให้ user เซ็นผ่าน dialog ครั้งต่อไปหรือ /zense approve ก่อน" };
			}
			// ลายเซ็นอยู่ที่ dialog นี่เอง — เลือกเซ็นแล้วทำงานต่อได้ทันที ไม่ต้อง /zense approve ย้ำ
			// (TUI: โชว์ spec เต็มใน dialog ก่อนเซ็น; RPC: fallback เป็น select ธรรมดา)
			const s = state.spec;
			let choice: string | null | undefined;
			if (s && ctx.mode === "tui") {
				choice = await specSignDialog(ctx, s, `Zense gate: ${ev.toolName} จะเขียนโค้ดทั้งที่ spec v${s.version} ยังไม่ได้เซ็น — อ่านก่อนเซ็น`, [
					{ value: "sign", label: "🔏 เซ็นอนุมัติ spec แล้วทำงานต่อ", description: "เซ็น = เปิด gate, ปล่อย write นี่ผ่านทันที" },
					{ value: "override", label: "⚠️ อนุญาตรอบนี้รอบเดียว (override โดยไม่เซ็น)", description: "จะติด trajectory flag" },
					{ value: "block", label: "⛔ บล็อกไว้ก่อน", description: "ให้ agent รอเซ็น / compile spec ใหม่" },
				]);
			} else {
				choice = await ctx.ui.select(
					`Zense gate: ${ev.toolName} จะเขียนโค้ดทั้งที่ spec ยังไม่ได้เซ็น${s ? ` (v${s.version}: ${s.title} — อ่านเต็มที่ .pi/zense/spec.md)` : " (ยังไม่มี spec)"}`,
					[
						...(s ? ["🔏 เซ็นอนุมัติ spec แล้วทำงานต่อ"] : []),
						"⚠️ อนุญาตรอบนี้รอบเดียว (override โดยไม่เซ็น)",
						"⛔ บล็อกไว้ก่อน (ให้ agent compile spec/รอเซ็น)",
					],
				);
			}
			if (choice === "sign" || choice?.startsWith("🔏")) approveCurrentSpec(ctx); // เซ็น = เปิด gate, ทำงานต่อเลย
			else if (choice === "override" || choice?.startsWith("⚠️")) {
				state.trajectoryFlags.push(`unsigned override: ${ev.toolName}`);
				ctx.ui.notify("⚠ override โดยไม่เซ็น spec — เพิ่ม trajectory flag", "warning");
			} else {
				escalate("need-permission", "write blocked: spec unsigned", ctx);
				return { block: true, reason: "Zense gate: spec ยังไม่ได้เซ็น — เลือก 🔏 เซ็นจาก dialog ครั้งหน้า หรือให้ user รัน /zense approve" };
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

	// ----- spec presentation: dialog ต้องโชว์ spec เต็มๆ ให้อ่านก่อนตัดสินใจเซ็น
	// (ScrollView ของ pi-tui ต้องการ layout integration เลย scroll เองด้วย PgUp/PgDn + slice)

	const specSignDialog = (ctx: ExtensionContext, spec: Spec, question: string, items: SelectItem[]): Promise<string | null> =>
		ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const title = new Text(theme.fg("accent", theme.bold(`🔏 ${question}`)), 1, 0);
			const hint = new Text(theme.fg("warning", "อ่าน spec ข้างล่างให้ครบก่อนตัดสินใจเซ็น"), 1, 0);
			const md = new Markdown(renderSpecMd(spec), 0, 0, {
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
			const selectList = new SelectList(items, items.length, {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			let lines: string[] = [];
			let cachedWidth = -1;
			let offset = 0;
			const bodyRows = () => Math.max(4, Math.min(24, tui.terminal.rows - 14));
			const maxOffset = () => Math.max(0, lines.length - bodyRows());

			return {
				render: (w: number) => {
					if (w !== cachedWidth) {
						cachedWidth = w;
						lines = md.render(Math.max(20, w - 6));
					}
					offset = Math.max(0, Math.min(offset, maxOffset()));
					const h = bodyRows();
					const out: string[] = [];
					out.push(...border.render(w), ...title.render(w), ...hint.render(w));
					const slice = lines.slice(offset, offset + h);
					for (const ln of slice) out.push("  " + ln);
					for (let i = slice.length; i < h; i++) out.push(""); // รักษาความสูง dialog ให้นิ่ง
					const range =
						lines.length > h
							? `— spec lines ${offset + 1}-${Math.min(offset + h, lines.length)}/${lines.length} — PgUp/PgDn เลื่อน —`
							: `— spec ครบทุกบรรทัด (${lines.length} lines) —`;
					out.push(...new Text(theme.fg("dim", range), 1, 0).render(w));
					out.push(...selectList.render(w));
					out.push(...new Text(theme.fg("dim", "↑↓ เลือก • Enter ยืนยัน • Esc ตัดสินใจทีหลัง"), 1, 0).render(w));
					out.push(...border.render(w));
					return out;
				},
				invalidate: () => {
					cachedWidth = -1;
				},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.pageDown)) offset = Math.min(maxOffset(), offset + bodyRows());
					else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - bodyRows());
					else selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

	// ----- live sub-agent observability: ดู output สดระหว่างรัน (กันลังเลว่าค้างหรือเปล่า)

	const tailViewer = (ctx: ExtensionContext, run: SubagentRun): Promise<null> =>
		ctx.ui.custom<null>((tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const tick = setInterval(() => tui.requestRender(), 1_000); // auto-refresh ทุก 1s
			return {
				render: (w: number) => {
					const rows = Math.max(4, tui.terminal.rows - 9);
					const lines =
						run.logPath && existsSync(run.logPath)
							? readFileSync(run.logPath, "utf8").split("\n").slice(-rows)
							: ["(waiting for output…)"];
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
					for (const ln of lines) out.push("  " + truncateToWidth(ln, Math.max(1, w - 4)));
					out.push(...new Text(theme.fg("dim", "auto refresh 1s • Esc ปิด (sub-agent ยังรันต่อ)"), 1, 0).render(w));
					out.push(...border.render(w));
					return out;
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done(null);
				},
				dispose: () => clearInterval(tick),
			};
		});

	const runLabel = (r: SubagentRun) =>
		`${r.status === "running" ? "▶" : r.ok ? "✅" : "❌"} ${r.role} @ ${new Date(r.startedAt ?? r.at).toLocaleTimeString()}`;

	const openAgentsViewer = async (ctx: ExtensionContext): Promise<void> => {
		const runs = state.subagentRuns;
		if (!runs.length) {
			ctx.ui.notify("ยังไม่มี sub-agent run ในเซสชันนี้", "info");
			return;
		}
		const recent = runs.slice(-15).map((r, i) => ({ run: r, idx: runs.length - Math.min(runs.length, 15) + i })).reverse(); // ใหม่สุดขึ้นบน
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				recent.map(({ run: r }) => `${runLabel(r)}  log: ${r.logPath ? relative(ctx.cwd, r.logPath) : "—"}`).join("\n"),
				"info",
			);
			return;
		}
		const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("🧪 Zense sub-agent runs (เลือกเพื่อดู live tail)")), 1, 0));
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
				render: (w: number) => container.render(w),
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

	/** 🔏 ลายเซ็น spec — helper เดียวใช้ร่วมกันโดย zense_spec dialog, gate dialog และ /zense approve */
	const approveCurrentSpec = (ctx: ExtensionContext) => {
		if (!state.spec) return false;
		state.spec.approved = true;
		state.spec.approvedAt = Date.now();
		state.phase = "implementation";
		persist();
		updateWidget(ctx);
		ctx.ui.notify(`🔏 Spec v${state.spec.version} signed — implementation gate open.`, "info");
		return true;
	};

	// ----- tools exposed to the agent ("phase sub-agents" via pi.registerTool)

	pi.registerTool({
		name: "zense_spec",
		label: "Zense Spec",
		description:
			"Phase 1 (Requirements): compile conversation requirements into a structured, versioned spec artifact with machine-checkable acceptance criteria. Human approval is required before implementation.",
		promptSnippet: "Compile/approve the structured spec: intent, scope, criteria, spec-debt",
		promptGuidelines: [
			"Use zense_spec before any implementation to write the spec; list unverifiable requirements under specDebt.",
			"Use zense_spec with action=compile_spec to delegate drafting to the requirements sub-agent.",
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
				const draft = await launchSubagent(
					ctx,
					"requirements",
					`You are the REQUIREMENTS sub-agent. Produce a JSON spec {title,intent,scope[],constraints[],criteria[{id,text,check}],specDebt[]} from this request; criteria[.check] must be machine-checkable where possible. Output ONLY JSON.\n\nRequest: ${params.intent}`,
				);
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
			// .pi/zense/specs/ so any past spec can be re-read. spec.{json,md} stay as
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
			// ช่วงเวลาเซ็น (zense/sign): ถามอนุมัติทันทีตอน spec ถูกนำเสนอ
			// spec ถูก archive ลงไฟล์ก่อนแล้ว — dialog โชว์เนื้อ spec เต็มให้อ่านก่อนเซ็น (TUI)
			let signed = false;
			if (ctx.hasUI && ctx.mode === "tui") {
				const choice = await specSignDialog(ctx, state.spec, `เซ็น Spec v${version}: ${state.spec.title}?`, [
					{ value: "sign", label: "🔏 เซ็นอนุมัติ — เปิด implementation gate", description: "ลายเซ็นมนุษย์ = agent เริ่ม implement ได้" },
					{ value: "later", label: "✏️ ยังไม่เซ็น (จะแก้ spec ก่อน)", description: "เซ็นทีหลังได้ด้วย /zense approve" },
				]);
				signed = choice === "sign";
				if (signed) approveCurrentSpec(ctx);
			} else if (ctx.hasUI) {
				const choice = await ctx.ui.select(
					`🔏 เซ็น Spec v${version}: ${state.spec.title}? (อ่านเต็มที่ .pi/zense/spec.md)`,
					[
						"🔏 เซ็นอนุมัติ — เปิด implementation gate",
						"✏️ ยังไม่เซ็น (จะแก้ spec ก่อน / เซ็นทีหลังด้วย /zense approve)",
					],
				);
				signed = !!choice && choice.startsWith("🔏");
				if (signed) approveCurrentSpec(ctx);
			}
			persist();
			updateWidget(ctx);
			const verb = signed ? "SIGNED 🔏 — ลายเซ็นมนุษย์ครบแล้ว, implementation gate open" : "NOT approved — เซ็นทีหลังด้วย /zense approve";
			return {
				content: [{ type: "text", text: `Spec v${version} archived at ${mdPath} (latest copies: .pi/zense/spec.{json,md}). ${verb}.` }],
				details: { version, approved: signed },
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
			return { content: [{ type: "text", text: `ADR-${n} recorded at ${file}${p.irreversible ? " — pending human approval" : ""}` }] };
		},
	});

	pi.registerTool({
		name: "zense_eval",
		label: "Zense Eval",
		description:
			"Phase 4: dual evaluation — output eval grades the artifact against approved spec criteria (delegated to the grader sub-agent); trajectory flags are attached. Spec-debt items become forced human review.",
		parameters: Type.Object({ note: Type.Optional(Type.String()) }),
		async execute(_id, _p, _s, onUpdate, ctx) {
			if (!state.spec) return { content: [{ type: "text", text: "No spec yet." }], details: {}, isError: true };
			onUpdate?.({ content: [{ type: "text", text: "running grader sub-agent…" }], details: {} });
			// stream output ของ grader เข้า transcript สดๆ (throttled) — user เห็นมันทำงานจริง ไม่ต้องเดาว่าค้างไหม
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
			const grade = await launchSubagent(
				ctx,
				"grader",
				`You are the OUTPUT-EVAL grader. For each acceptance criterion, judge PASS/FAIL with evidence (run checks with tools if useful). Also look for reward hacking. Criteria:\n${state.spec.criteria
					.map((c) => `- ${c.id}: ${c.text} (check: ${c.check})`)
					.join("\n")}\nOutput a verdict table then OVERALL: PASS|FAIL.`,
				streamTail,
			);
			const report = `${grade.output}\n\n## Trajectory flags\n${state.trajectoryFlags.join("\n") || "(none)"}\n\n## Spec debt (needs human)\n${state.spec.specDebt.join("\n") || "(none)"}`;
			state.phase = "review";
			persist(); updateWidget(ctx);
			return { content: [{ type: "text", text: report }], details: { ok: grade.ok, trajectory: state.trajectoryFlags } };
		},
	});

	pi.registerTool({
		name: "zense_review",
		label: "Zense Review Packet",
		description: "Phase 5: build the exception-based review packet (TL;DR first, evidence linked, anomalies highlighted).",
		parameters: Type.Object({}),
		async execute(_id, _p, _s, _o, ctx) {
			const reviewer = await launchSubagent(
				ctx,
				"reviewer",
				`You are the REVIEWER sub-agent. Produce an incident-report-style review packet: TL;DR (3 lines max), intent vs implementation, risk areas, rollback plan. Intent: ${state.spec?.intent}. Do NOT dump raw diffs; summarize.`,
			);
			const packet = {
				tlDr: reviewer.output.slice(0, 900),
				trajectory: state.trajectoryFlags,
				specDebt: state.spec?.specDebt ?? [],
				escalations: state.escalations,
			};
			pi.appendEntry("zense-review-packet", packet);
			learn(ctx, `review packet: flags=${packet.trajectory.length}, escalations=${packet.escalations.length}`);
			return { content: [{ type: "text", text: packet.tlDr }], details: packet };
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

	pi.registerShortcut("ctrl+shift+a", {
		description: "Zense: ดู sub-agent runs สดๆ (live tail)",
		handler: (ctx) => openAgentsViewer(ctx),
	});

	pi.registerCommand("zense", {
		description: "Zense harness (เซ็น = ลายเซ็นมนุษย์/sign): status | approve | agents | gate on|off | memory",
		getArgumentCompletions: (prefix) =>
			["status", "approve", "agents", "gate", "memory"].filter((s) => s.startsWith(prefix)).map((value) => ({ value, label: value })),
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
				if (ctx.mode === "tui") {
					const choice = await specSignDialog(ctx, state.spec, `เซ็น approve spec v${state.spec.version}: ${state.spec.title}?`, [
						{ value: "sign", label: "🔏 เซ็นอนุมัติ — เปิด implementation gate", description: "ลายเซ็นมนุษย์ = agent เริ่ม implement ได้" },
						{ value: "cancel", label: "ยกเลิก (ยังไม่เซ็น)", description: "spec ยังค้างไว้ — approve ใหม่ได้ทุกเมื่อ" },
					]);
					if (choice === "sign") approveCurrentSpec(ctx);
				} else {
					const ok = await ctx.ui.confirm("🔏 เซ็น approve spec?", `${state.spec.title} v${state.spec.version}\nIntent: ${state.spec.intent.slice(0, 300)}\n(อ่านเต็มที่ .pi/zense/spec.md)`);
					if (ok) approveCurrentSpec(ctx);
				}
			} else if (sub === "gate") {
				state.gateEnabled = rest[0] !== "off";
				persist();
				ctx.ui.notify(`Gate ${state.gateEnabled ? "ON" : "OFF"}`, state.gateEnabled ? "info" : "warning");
			} else if (sub === "agents") {
				await openAgentsViewer(ctx);
			} else if (sub === "memory") {
				const f = join(zenseDir(ctx.cwd), "memory.jsonl");
				ctx.ui.notify(existsSync(f) ? readFileSync(f, "utf8").slice(-2000) : "(empty)", "info");
			} else {
				ctx.ui.notify("usage: /zense status|approve|agents|gate on|off|memory", "info");
			}
		},
	});

	function renderSpecMd(s: Spec): string {
		return `# Spec v${s.version}: ${s.title}\napproved: ${s.approved}\n\n## Intent\n${s.intent}\n\n## Scope\n${s.scope.map((x) => `- ${x}`).join("\n")}\n\n## Constraints\n${s.constraints.map((x) => `- ${x}`).join("\n")}\n\n## Acceptance criteria\n${s.criteria.map((c) => `- [ ] ${c.id}: ${c.text} *(check: ${c.check})*`).join("\n")}\n\n## Spec debt (human-verified only)\n${s.specDebt.map((x) => `- ${x}`).join("\n")}\n`;
	}
}

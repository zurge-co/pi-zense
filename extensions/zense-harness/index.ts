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
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
	lastCompileLessons?: number;    // จำนวนบทเรียนจาก memory ที่ feed เข้า compile_spec ล่าสุด
	specMdPath?: string;            // path ของ archive spec .md ของเวอร์ชันปัจจุบัน (zense_eval append ผลลัพธ์ที่นี่)
	specJsonPath?: string;          // path ของ archive spec .json ของเวอร์ชันปัจจุบัน
	worktree?: Worktree | null;     // active worktree ของ session (null = ทำงานใน main ตามปกติ)
	worktreeLeaveNotified?: boolean; // dedupe notify “unmerged worktree” 1 ครั้ง/การสร้าง
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
/** Active per-session worktree: redirect ทุก tool call ของ main agent เข้าไปทำงานในนี้
 *  (ผ่านการ mutate event.input) จนกว่า eval PASS จะ merge กลับเข้า main; กัน 2 session เขียนทับกัน */
interface Worktree {
	root: string;               // absolute path ของ worktree (nested ใต้ <repo>/.pi/zense/worktree/)
	branch: string;             // zense/impl/v<N>-<stamp>
	dir: string;                // === root (เก็บซ้ำเพื่อ semantic clarity ตอน worktree remove)
}

const zenseDir = (cwd: string) => join(cwd, ".pi", "zense");

/** shell-quote แบบ single-quote สำหรับ path ที่อาจมี space/special char */
const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Remap path ที่ agent ขอ (relative ต่อ session cwd = main repo) ไปเป็น path ใต้ worktree root
 * โดย relative structure เดิม. path นอก repo (เช่น pi docs ใน node_modules) และ path ใต้
 * .pi/zense/ (harness state ที่ต้องอยู่ใน main) คืนค่าเดิม — ไม่ redirect.
 * Pure function → unit-test ได้ (export เผื่อ test ใช้โดยตรง).
 */
export const rewritePathForWorktree = (cwd: string, wtRoot: string, path: string): string => {
	if (!path) return path;
	const abs = resolve(cwd, path);
	const rel = relative(cwd, abs).split(sep).join("/");
	if (!rel || rel.startsWith("..")) return path;           // นอก repo → ไม่ redirect
	if (rel === ".pi/zense" || rel.startsWith(".pi/zense/")) return path; // harness state อยู่ main
	return join(wtRoot, rel);
};

/** นำหน้า bash command ด้วย `cd <wtRoot> &&` เพื่อให้รันใน worktree (path มี space ก็ quote) */
export const buildWorktreeCommand = (cmd: string, wtRoot: string): string =>
	`cd ${shellQuote(wtRoot)} && ${cmd}`;

// ----- git worktree helpers (module scope — export เพื่อ integration-test ใน temp git repo ได้)

/** git runner ที่ไม่ throw — คืน {ok,out,err} ให้ caller ตัดสินใจ (สำหรับ best-effort worktree ops) */
export const gitOk = (args: string[], cwd: string): { ok: boolean; out: string; err: string } => {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, out: out.toString(), err: "" };
	} catch (e: any) {
		const err = (e?.stderr?.toString?.() ?? e?.message ?? String(e)).split("\n")[0];
		return { ok: false, out: "", err };
	}
};

/** สร้าง git worktree ของ session นี้ที่ spec approval (phase → implementation).
 *  worktree อยู่ใต้ <repo>/.pi/zense/worktree/ (nested ใน main working tree — git รองรับ)
 *  เพื่อให้ state ของ zense รวมอยู่ใน workspace ที่เดียว ไม่รก parent dir. best-effort:
 *  ล้มเหลว (ไม่ใช่ git repo / ชื่อซ้ำ) → คืน null (caller degrade กลับทำงานใน main ตามปกติ ไม่พัง). */
export const createWorktree = (cwd: string, spec: Spec): Worktree | null => {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const branch = `zense/impl/v${spec.version}-${stamp}`;
	const wtParent = join(zenseDir(cwd), "worktree");
	const wtRoot = join(wtParent, `${basename(cwd)}-wt-${stamp}`);
	mkdirSync(wtParent, { recursive: true });
	if (gitOk(["worktree", "add", wtRoot, "-b", branch], cwd).ok !== true) return null;
	excludeFromGitStatus(cwd, wtParent);
	// copy current spec + memory เข้า worktree ให้ bash-based read ในนั่นเห็น state ปัจจุบัน (ไม่ใช่ตอน checkout)
	const wtZense = join(wtRoot, ".pi", "zense");
	mkdirSync(wtZense, { recursive: true });
	for (const f of ["spec.json", "spec.md", "memory.jsonl"]) {
		const src = join(zenseDir(cwd), f);
		if (existsSync(src)) copyFileSync(src, join(wtZense, f));
	}
	return { root: wtRoot, branch, dir: wtRoot };
};

/** cursor ใต้ repo ที่ zense สร้าง (เช่น .pi/zense/worktree/) ไม่ควรโผล่ใน git status ของ main —
 *  best-effort append ลง .git/info/exclude (local-only ไม่แตะไฟล์ tracked ของผู้ใช้). ล้มเหลว → ข้ามเงียบๆ */
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

/** merge worktree branch กลับเข้า main (auto-commit ใน worktree ก่อน, แล้ว git merge --no-ff).
 *  conflict (เช่นอีก session merge ชน) → ไม่ force, คืน {ok:false,conflict:true} ให้ caller escalate.
 *  success → cleanup worktree + branch ด้วย */
export const mergeWorktreeBack = (cwd: string, spec: Spec, wt: Worktree): { ok: boolean; conflict?: boolean; msg: string } => {
	// 1. stage changes ใน worktree (ยกเว้น .pi/zense) แล้ว commit ถ้ามี — รวม untracked files ด้วย
	//    (git diff --quiet HEAD ไม่เห็น untracked → ต้อง add ก่อนแล้วเช็ค --cached)
	gitOk(["add", "-A", "--", ".", ":!.pi/zense"], wt.root);
	if (!gitOk(["diff", "--cached", "--quiet"], wt.root).ok) {
		gitOk(["commit", "-m", `zense: impl v${spec.version} (eval PASS)`, "--no-verify"], wt.root);
	}
	// 2. merge เข้า main (main อาจมี uncommitted .pi/zense/ — disjoint กับ source changes → git อนุญาต)
	if (!gitOk(["merge", "--no-ff", wt.branch, "-m", `zense: merge impl v${spec.version} (eval PASS)`], cwd).ok) {
		gitOk(["merge", "--abort"], cwd);
		return { ok: false, conflict: true, msg: `merge conflict — แก้ด้วยมือ: cd ${wt.root} แล้ว resolve/commit ใน branch ${wt.branch}; จากนั้น git merge ${wt.branch}` };
	}
	// 3. cleanup worktree + branch
	gitOk(["worktree", "remove", wt.dir, "--force"], cwd);
	gitOk(["branch", "-D", wt.branch], cwd);
	return { ok: true, msg: `merged ${wt.branch} → main` };
};

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

// ----------------------------------------------------------------------------- ADR deny rules

export interface AdrDenyRule {
	constraint: string;
	reason?: string;
	raw: string;
}

const DENY_PREFIX = "DENY:";
const DENY_REASON_SEPARATOR = "→";

/**
 * Parse one canonical ADR line without any ambiguous regex capture.
 * Grammar: `DENY: <constraint>` optionally followed by `→ <reason>`.
 * The old optional-arrow regex could match only the first character as the
 * constraint and treat the rest as a reason, so this parser intentionally
 * uses one explicit `indexOf("→")` split instead.
 */
export const parseAdrDenyLine = (line: string): AdrDenyRule | undefined => {
	const trimmed = line.trim();
	if (trimmed.slice(0, DENY_PREFIX.length).toUpperCase() !== DENY_PREFIX) return undefined;

	const body = trimmed.slice(DENY_PREFIX.length).trim();
	if (!body) return undefined; // Never let an empty constraint match every path.

	const reasonAt = body.indexOf(DENY_REASON_SEPARATOR);
	const constraint = (reasonAt === -1 ? body : body.slice(0, reasonAt)).trim();
	if (!constraint) return undefined;
	const reason = reasonAt === -1 ? undefined : body.slice(reasonAt + DENY_REASON_SEPARATOR.length).trim();
	return { constraint, ...(reason ? { reason } : {}), raw: trimmed };
};

export const parseAdrDenyRules = (adr: string): AdrDenyRule[] =>
	adr.split(/\r?\n/)
		.map(parseAdrDenyLine)
		.filter((rule): rule is AdrDenyRule => rule !== undefined);

export const firstAdrDenyViolation = (target: string | undefined, adr: string): string | undefined => {
	if (!target) return undefined;
	for (const rule of parseAdrDenyRules(adr))
		if (target.includes(rule.constraint))
			return `ADR constraint: ${rule.constraint} denied (${rule.reason ?? "see ADR"})`;
	return undefined;
};

const subagentLogPath = (cwd: string, role: string): string => {
	const dir = join(zenseDir(cwd), "subagents");
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	return join(dir, `${stamp}-${role}.log`);
};

/**
 * Spawn an isolated pi sub-agent (--mode json) with a clean context.
 * stdio ignores stdin — ปล่อย stdin pipe ค้างไว้จะทำให้ pi รอ EOF จนหมดเวลา
 * (bug เดิม: execFile ค้างเงียบๆ จนโดน SIGTERM). ใช้ --mode json ไม่ใช่ print เพราะ print mode
 * buffer stdout ทั้งก้อนแล้วปล่อยทีเดียวตอนจบ (ทดลองแล้ว: chunk เดียวก่อน close — log ดูเหมือนค้าง
 * จนงานเสร็จ) ส่วน json mode เป็น JSONL event stream ที่ไหลตั้งแต่ต้น → parse event เป็น text
 * เขียน log live ทุก chunk เพื่อให้ user tail ดูระหว่างรันได้ (/zense agents หรือ alt+z).
 */
function runSubagent(
	role: string,
	task: string,
	cwd: string,
	timeoutMs = 240_000,
	onChunk?: (chunk: string) => void,
	logPath: string = subagentLogPath(cwd, role),
	modelPattern?: string,           // pi --model pattern (เช่น "anthropic/claude-sonnet") — undefined = ปล่อย pi ใช้ default
): Promise<{ ok: boolean; output: string; logPath: string }> {
	const relLog = relative(cwd, logPath);
	return new Promise((res) => {
		// argv: --model <pattern> (ถ้ามี) แทรกก่อน task เพื่อบังคับ model ของ sub-agent ตาม role
		const argv = ["PI_ZENSE_SUBAGENT=1", "pi", "--mode", "json", "--no-session"];
		if (modelPattern) { argv.push("--model", modelPattern); }
		argv.push(task);
		writeFileSync(logPath, `$ pi --mode json --no-session${modelPattern ? ` --model ${modelPattern}` : ""} <task ${task.length} chars>\n--- live output (${role}) ---\n`);
		const child = spawn("env", argv, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let finalText = ""; // assistant text ล่าสุดจาก message_end — ใช้เป็น output ตอนสำเร็จ แทน tail ของ raw stdout
		const append = (chunk: string) => {
			out = (out + chunk).slice(-1_000_000);
			appendFileSync(logPath, chunk);
			onChunk?.(chunk);
		};
		// JSONL parser: stdout เป็น event-per-line แต่ chunk อาจตัดกลางบรรทัด → buffer แยกด้วย \n
		// event ที่ parse ไม่ได้ (noise/ERROR ก่อน session เริ่ม) append ดิบไว้เหมือนเดิม ไม่ให้หาย
		let lineBuf = "";
		const fmtArgs = (args: unknown): string => {
			try {
				const s = JSON.stringify(args);
				return s.length > 120 ? `${s.slice(0, 117)}…` : s;
			} catch {
				return "";
			}
		};
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let ev: { type?: string; [k: string]: unknown };
			try {
				ev = JSON.parse(line);
			} catch {
				append(`${line}\n`);
				return;
			}
			switch (ev.type) {
				case "session":
					append(`[session ${(ev as { id?: string }).id ?? "?"}]\n`);
					break;
				case "tool_execution_start": {
					const t = ev as { toolName?: string; args?: unknown };
					append(`\n⚙ ${t.toolName} ${fmtArgs(t.args)}\n`);
					break;
				}
				case "tool_execution_end": {
					const t = ev as { toolName?: string; isError?: boolean };
					if (t.isError) append(`✗ ${t.toolName} failed\n`);
					break;
				}
				case "message_update": {
					// stream delta — เขียนเฉพาะ text (ข้าม thinking/toolcall delta เพื่อให้ log อ่านง่าย)
					const a = (ev as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
					if (a?.type === "text_delta" && typeof a.delta === "string") append(a.delta);
					break;
				}
				case "message_end": {
					// จับ final assistant text (เฉพาะ content type text — ข้าม thinking) ไว้เป็น output ตอนสำเร็จ
					const msg = (ev as { assistantMessageEvent?: { role?: string; content?: { type?: string; text?: string }[] } }).assistantMessageEvent;
					if (msg?.role === "assistant" && Array.isArray(msg.content)) {
						const text = msg.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
						if (text.trim()) {
							finalText = text;
							append("\n"); // คั่นบรรทัดหลังจบข้อความ assistant
						}
					}
					break;
				}
				default:
					break;
			}
		};
		child.stdout?.on("data", (d) => {
			lineBuf += String(d);
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		child.stderr?.on("data", (d) => append(String(d)));
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			appendFileSync(logPath, `\n[spawn error] ${err.message}\n`);
			res({ ok: false, output: `sub-agent spawn error: ${err.message} (log: ${relLog})`, logPath });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (lineBuf.trim()) handleLine(lineBuf); // flush บรรทัดค้างท้าย stream
			const timedOut = signal === "SIGTERM";
			appendFileSync(logPath, `\n--- exited code=${code} signal=${signal} ---\n`);
			if (code === 0 && !signal) res({ ok: true, output: (finalText || out).slice(-16_000), logPath });
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

// ----------------------------------------------------------------------------- memory summary (module scope — export เพื่อ unit-test ได้)

export interface MemoryAgg {
	total: number;
	flags: Map<string, number>;
	esc: Map<string, number>;
	evals: string[];
	subFails: Map<string, number>;
	misc: number;
}

/** note format conventions (parse targets): "escalation: <kind>: <detail>",
 *  "flag: <msg>", "signed spec vN", "sub-agent failed: <role>", "eval: spec vN → ... verdict=X" */
export const aggregateMemory = (cwd: string): MemoryAgg => {
	const agg: MemoryAgg = { total: 0, flags: new Map(), esc: new Map(), evals: [], subFails: new Map(), misc: 0 };
	const f = join(zenseDir(cwd), "memory.jsonl");
	if (!existsSync(f)) return agg;
	const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
	for (const line of readFileSync(f, "utf8").split("\n")) {
		if (!line.trim()) continue;
		agg.total++;
		let note = line;
		try {
			note = String(JSON.parse(line).note ?? line);
		} catch {
			/* tolerate non-JSON lines */
		}
		let m: RegExpMatchArray | null;
		if ((m = note.match(/^escalation: ([\w-]+):/))) bump(agg.esc, m[1]);
		else if (note.startsWith("flag: ")) bump(agg.flags, note.slice(6).slice(0, 60));
		else if ((m = note.match(/^eval: (.*)/))) agg.evals.push(m[1].slice(0, 60));
		else if ((m = note.match(/^sub-agent failed: (\w+)/))) bump(agg.subFails, m[1]);
		else agg.misc++;
	}
	return agg;
};

export const topEntries = (m: Map<string, number>, n: number): string =>
	[...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k} ×${c}`).join(", ");

/** สรุปแบบกลุ่ม — ใช้ทั้งโชว์ใน /zense memory และ feed เข้า requirements sub-agent */
export const memorySummaryLines = (cwd: string): string[] => {
	const agg = aggregateMemory(cwd);
	if (!agg.total) return [];
	return [
		`📚 Zense memory — ${agg.total} lessons`,
		`▸ top recurring flags : ${topEntries(agg.flags, 5) || "(none)"}`,
		`▸ escalations         : ${topEntries(agg.esc, 5) || "(none)"}`,
		`▸ eval history        : ${agg.evals.join(" | ") || "(none)"}`,
		`▸ sub-agent failures  : ${topEntries(agg.subFails, 5) || "(none)"}`,
		...(agg.misc ? [`▸ other notes         : ${agg.misc}`] : []),
	];
};

// ----------------------------------------------------------------------------- sub-agent model config (per-role)

/**
 * อ่าน .pi/zense/models.json — map role → pi --model pattern (เช่น "anthropic/claude-sonnet",
 * "openai/gpt-4o-mini", "sonnet:high"). ไม่มีไฟล์/parse ไม่ได้ → {} (ใช้ model ของ agent หลักแทน).
 */
export const readModelsConfig = (cwd: string): Record<string, string> => {
	const f = join(zenseDir(cwd), "models.json");
	if (!existsSync(f)) return {};
	try {
		const raw = JSON.parse(readFileSync(f, "utf8"));
		if (raw && typeof raw === "object") {
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v.trim()) out[k] = v.trim();
			return out;
		}
	} catch {
		/* tolerate malformed config — fall back to main-agent model */
	}
	return {};
};

/**
 * Resolve model pattern สำหรับ role ตามลำดับ: .pi/zense/models.json[role] →
 * ctx.model (provider/id ของ agent หลัก) → undefined (ปล่อย pi ใช้ default).
 * undefined จะทำให้ runSubagent ไม่ส่ง --model ไป
 */
export const resolveModelPattern = (cwd: string, role: string, mainModel?: { provider: string; id: string }): string | undefined => {
	const cfg = readModelsConfig(cwd);
	const configured = cfg[role];
	if (configured) return configured;
	if (mainModel) return `${mainModel.provider}/${mainModel.id}`;
	return undefined;
};

/**
 * เขียน/ลบ model override ของ role หนึ่งใน .pi/zense/models.json — สร้าง dir ให้ถ้ายังไม่มี,
 * คง key อื่นของไฟล์เดิมไว้ (อ่าน raw เอง เพราะ readModelsConfig ตัดค่าที่ไม่ใช่ string ทิ้ง)
 */
export const writeModelsConfig = (cwd: string, role: string, pattern: string | null): void => {
	const dir = zenseDir(cwd);
	mkdirSync(dir, { recursive: true });
	const f = join(dir, "models.json");
	let cfg: Record<string, unknown> = {};
	if (existsSync(f)) {
		try {
			const raw = JSON.parse(readFileSync(f, "utf8"));
			if (raw && typeof raw === "object") cfg = raw as Record<string, unknown>;
		} catch {
			/* malformed เดิม — เริ่มจาก {} ใหม่ */
		}
	}
	if (pattern && pattern.trim()) cfg[role] = pattern.trim();
	else delete cfg[role];
	writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
};

/**
 * รายการ model ที่เลือกได้สำหรับ picker: scopedModels ของ session ก่อน (mirror ของ /model picker)
 * ถ้าไม่มี scoping ค่อย fallback เป็น catalogue ทั้งหมดจาก modelRegistry.getAvailable()
 */
const availableModelChoices = (ctx: ExtensionContext): { pattern: string; label: string; description: string }[] => {
	try {
		if (ctx.scopedModels?.length) {
			return ctx.scopedModels.map((s) => {
				const base = `${s.model.provider}/${s.model.id}`;
				const pattern = s.thinkingLevel ? `${base}:${s.thinkingLevel}` : base;
				return {
					pattern,
					label: pattern,
					description: s.thinkingLevel ? `${s.model.name} (scoped, thinking pinned)` : `${s.model.name} (scoped)`,
				};
			});
		}
		return ctx.modelRegistry.getAvailable().map((m) => ({
			pattern: `${m.provider}/${m.id}`,
			label: `${m.provider}/${m.id}`,
			description: m.name,
		}));
	} catch {
		return [];
	}
};

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

	// ----- git worktree helpers (per-session isolation: redirect ทุก tool call ของ main
	//       agent เข้า worktree จนกว่า eval PASS จะ merge กลับ — กัน 2 session เขียนทับกัน)
	// (git helpers gitOk/createWorktree/mergeWorktreeBack อยู่ที่ module scope เพื่อ export ให้ test ได้)

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
				(run ? ` · 🧪 ${run.role} ▶ ${Math.round((Date.now() - (run.startedAt ?? run.at)) / 1000)}s (alt+z ดูสด)` : "") +
				(state.worktree ? ` · 🌳 ${basename(state.worktree.root)}` : "") +
				(state.trajectoryFlags.length ? ` · ⚠ ${state.trajectoryFlags.length} traj-flags` : "") +
				(state.escalations.length ? ` · 🚨 ${state.escalations.length}` : ""),
		]);
	};

	/** redirect tool call ของ main agent เข้า worktree (mutate event.input) — ทำให้ agent
	 *  ทำงานใน worktree โดยไม่รู้ตัว. sub-agent เป็นคนละ process จึงไม่ถูกตัวนี้ (และใช้ cwd ของมันเอง). */
	const applyRedirect = (ev: any, ctx: ExtensionContext) => {
		const wt = state.worktree;
		if (!wt) return;
		if (ev.toolName === "write" || ev.toolName === "edit" || ev.toolName === "read") {
			const p = (ev.input as { path?: string })?.path;
			if (typeof p === "string") ev.input.path = rewritePathForWorktree(ctx.cwd, wt.root, p);
		} else if (ev.toolName === "bash") {
			const c = (ev.input as { command?: string })?.command;
			if (typeof c === "string") ev.input.command = buildWorktreeCommand(c, wt.root);
		}
	};

	/** launch wrapper: ลงทะเบียน run (widget แสดงสด) + เขียน log live ทุก chunk
	 *  model ของ sub-agent: resolve ตาม role จาก .pi/zense/models.json, ถ้าไม่มี entry ใช้ model
	 *  ปัจจุบันของ agent หลัก (ctx.model), ถ้าไม่มีอีก ปล่อย pi ใช้ default (ไม่ส่ง --model) */
	const launchSubagent = async (
		ctx: ExtensionContext,
		role: string,
		task: string,
		onChunk?: (chunk: string) => void,
	): Promise<{ ok: boolean; output: string; logPath: string }> => {
		const logPath = subagentLogPath(ctx.cwd, role);
		const mainModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		const modelPattern = resolveModelPattern(ctx.cwd, role, mainModel);
		const run: SubagentRun = { role, ok: false, summary: "", at: Date.now(), startedAt: Date.now(), logPath, status: "running" };
		state.subagentRuns.push(run);
		updateWidget(ctx);
		const tick = setInterval(() => updateWidget(ctx), 2_000); // elapsed วิ่งใน widget
		try {
			// ใช้ worktree root เป็น cwd ถ้ามี worktree active → grader/reviewer รัน/เทสใน worktree (โค้ดที่แก้จริง)
			const subCwd = state.worktree?.root ?? ctx.cwd;
			const r = await runSubagent(role, task, subCwd, 240_000, onChunk, logPath, modelPattern);
			run.ok = r.ok;
			run.summary = r.output.slice(0, 300);
			run.status = r.ok ? "done" : "failed";
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
		// gate ปิด → ข้าม gate/scope/ADR แต่ยัง redirect เข้า worktree (ถ้า active)
		if (!state.gateEnabled) { applyRedirect(ev, ctx); return; }
		const isWrite = ev.toolName === "write" || ev.toolName === "edit";
		// read/bash: ไม่ผ่าน gate/scope (write-only) — แค่ redirect ถ้ามี worktree แล้วจบ
		if (!isWrite) { applyRedirect(ev, ctx); return; }

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
				learn(ctx, `flag: unsigned override: ${ev.toolName}`);
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


		// Design-constraint checker: complete ADR "DENY:" constraints block matching write targets.
		const adrViolation = firstAdrDenyViolation(target, adrText(ctx.cwd));
		if (adrViolation) return { block: true, reason: adrViolation };
		// redirect write นี้เข้า worktree ที่ท้ายสุด (หลัง scope/ADR ที่ใช้ path เดิมของ main)
		applyRedirect(ev, ctx);
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

		// worktree ยัง active ตอน agent run จบ (eval ยังไม่ PASS) → แจ้ง 1 ครั้ง/การสร้าง (dedupe) ให้มนุษย์รู้ว่ามี worktree ค้างอยู่
		if (state.worktree && !state.worktreeLeaveNotified) {
			state.worktreeLeaveNotified = true;
			ctx.ui.notify(`🌳 worktree ค้างอยู่ (ยังไม่ merge): ${state.worktree.dir}\nbranch ${state.worktree.branch} — จะ merge อัตโนมัติเมื่อ eval PASS (หรือ merge ด้วยมือ: git merge ${state.worktree.branch})`, "info");
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

	// ----- spec presentation: dialog ต้องโชว์ spec เต็มๆ ให้อ่านก่อนตัดสินใจเซ็น
	// (ScrollView ของ pi-tui ต้องการ layout integration เลย scroll เองด้วย offset + slice)

	const specSignDialog = (ctx: ExtensionContext, spec: Spec, question: string, items: SelectItem[]): Promise<string | null> =>
		ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const title = new Text(theme.fg("accent", theme.bold(`🔏 ${question}`)), 1, 0);
			const hint = new Text(
				theme.fg(
					"warning",
					`อ่าน spec ข้างล่างให้ครบก่อนตัดสินใจเซ็น` +
						(state.lastCompileLessons ? ` · 📚 fed ${state.lastCompileLessons} lessons from memory ตอน compile` : ""),
				),
				1,
				0,
			);
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
			// ความสูงเนื้อ spec: ยกเลิก cap ที่ 24 ให้ใช้พื้นที่ terminal ได้เต็มที่ (reserve 12 บรรทัด
			// สำหรับ border/title/hint/range/selectList/bottomHint) — อ่าน spec ได้ยาวขึ้นโดยไม่ต้องเลื่อนบ่อย
			const bodyRows = () => Math.max(4, tui.terminal.rows - 12);
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
							? `— spec lines ${offset + 1}-${Math.min(offset + h, lines.length)}/${lines.length} — เลื่อน: Ctrl+D/U (ครึ่งหน้า), Ctrl+F/B (เต็มหน้า) —`
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
					// ใช้เฉพาะ ctrl+letter แบบ less/vim — control char ตัวเดียว กดได้แน่ๆ ทุก terminal ทั้ง mac/windows
					// (shift+↑/↓ โดน terminal ยึดไป scroll เอง, ctrl+↑/↓ ชน Mission Control บน mac,
					//  PgUp/PgDn บน mac ต้องกด fn — เลยตัดทิ้งหมด)
					//   Ctrl+D/U = ครึ่งหน้า, Ctrl+F/B = เต็มหน้า (forward/back) — ↑/↓ ปล่อยให้ SelectList เลือกตัวเลือก
					if (matchesKey(data, Key.ctrl("d")))
						offset = Math.min(maxOffset(), offset + Math.max(1, bodyRows() >> 1));
					else if (matchesKey(data, Key.ctrl("u")))
						offset = Math.max(0, offset - Math.max(1, bodyRows() >> 1));
					else if (matchesKey(data, Key.ctrl("f"))) offset = Math.min(maxOffset(), offset + bodyRows());
					else if (matchesKey(data, Key.ctrl("b"))) offset = Math.max(0, offset - bodyRows());
					else selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

	// ----- picker กลางของ zense: title + search filter + SelectList (ใช้ซ้ำได้ทั้งเลือก role/model)

	const zensePick = (ctx: ExtensionContext, title: string, items: SelectItem[], hint = ""): Promise<string | null> =>
		ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
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
				render: (w: number) => [
					...border.render(w),
					...new Text(theme.fg("accent", theme.bold(title)), 1, 0).render(w),
					...new Text(theme.fg("dim", `filter: ${filter || "(พิมพ์เพื่อคัดกรอง)"}${hint ? ` • ${hint}` : ""}`), 1, 0).render(w),
					...selectList.render(w),
					...new Text(theme.fg("dim", "↑↓ เลือก • Enter ยืนยัน • Esc ยกเลิก • พิมพ์ = filter"), 1, 0).render(w),
					...border.render(w),
				],
				invalidate: () => {
					selectList.invalidate();
				},
				handleInput: (data: string) => {
					// ปุ่มนำทาง/ยืนยัน/ยกเลิกส่งให้ SelectList — ตัวอักษร printable เข้า search filter แทน
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
		// auto worktree-per-session: สร้าง worktree ของ session นี้ตอนเริ่ม implementation
		// (ก่อนหน้านี้ไม่มี source write เพราะ gate กั้น) → redirect ทุก tool call เข้า worktree จนกว่า eval PASS
		const wt = createWorktree(ctx.cwd, state.spec);
		if (wt) {
			state.worktree = wt;
			state.worktreeLeaveNotified = false;
			learn(ctx, `worktree created: ${wt.branch} @ ${wt.root}`);
		} else {
			ctx.ui.notify(`🌳 worktree สร้างไม่ได้ — ทำงานใน main ตามปกติ (ไม่มี isolation ระหว่าง session)`, "warning");
		}
		learn(ctx, `signed spec v${state.spec.version}`);
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
				// Layer 3 (learning loop): ป้อนบทเรียนสะสมจาก memory.jsonl เข้า prompt
				// ให้ spec ใหม่สะท้อน incident เก่า เช่น scope เคยกว้างเกิน/เคย override บ่อย
				const lessons = memorySummaryLines(ctx.cwd);
				state.lastCompileLessons = lessons.length ? aggregateMemory(ctx.cwd).total : 0;
				const draft = await launchSubagent(
					ctx,
					"requirements",
					`You are the REQUIREMENTS sub-agent. Produce a JSON spec {title,intent,scope[],constraints[],criteria[{id,text,check}],specDebt[]} from this request; criteria[.check] must be machine-checkable where possible. Output ONLY JSON.` +
						(lessons.length
							? `\n\nPast lessons from this project's memory (reflect relevant ones in scope/constraints/criteria when they apply):\n${lessons.join("\n")}`
							: "") +
						`\n\nRequest: ${params.intent}`,
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
			state.specMdPath = mdPath;     // zense_eval จะ append ผลการประเมินท้ายไฟล์นี้
			state.specJsonPath = jsonPath;
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
				`You are the OUTPUT-EVAL grader. For each acceptance criterion, judge PASS/FAIL with evidence (run checks with tools if useful). Also look for reward hacking.\n` +
					`Criteria:\n${state.spec.criteria.map((c) => `- ${c.id}: ${c.text} (check: ${c.check})`).join("\n")}\n\n` +
					`Output STRICTLY in this format (one line per criterion, then a final OVERALL line):\n` +
					`<id>: PASS: <one-line evidence>\n` +
					`<id>: FAIL: <one-line evidence>\n` +
					`…\n` +
					`OVERALL: PASS|FAIL\n` +
					`Do NOT add extra commentary. Each criterion line must start with its id followed by ': PASS:' or ': FAIL:'. The last line must be exactly 'OVERALL: PASS' or 'OVERALL: FAIL'.`,
				streamTail,
			);
			// parser แม่น per-criteria: iterate id ที่อยู่ใน state.spec.criteria แล้ว regex ดึง verdict ของ id นั้น
			// (ผูกกับ id จริง → กัน false positive จากบรรทัดอื่น) + overall verdict แยก
			const perCriteria: Record<string, "PASS" | "FAIL"> = {};
			const failedCriteria: string[] = [];
			for (const c of state.spec.criteria) {
				const m = grade.output.match(new RegExp(`^\\s*${c.id}:\\s*(PASS|FAIL)`, "im"));
				if (m) {
					const v = m[1].toUpperCase() as "PASS" | "FAIL";
					perCriteria[c.id] = v;
					if (v === "FAIL") failedCriteria.push(c.id);
				}
			}
			const verdict = grade.output.match(/^\s*OVERALL:\s*(PASS|FAIL)/im)?.[1]?.toUpperCase() ?? "unknown";
			learn(ctx, `eval: spec v${state.spec.version} → grader.ok=${grade.ok} verdict=${verdict} failed=[${failedCriteria.join(",")}]`);
			// บันทึกผล eval ลง spec .md (archive + latest copy) เป็น section ใหม่ท้ายไฟล์ (append-only, ไม่เขียนทับเนื้อเดิม)
			const evalTs = new Date().toISOString();
			const evalSection =
				`\n\n## Eval ${evalTs}\nverdict: **${verdict}** (grader.ok=${grade.ok})\n` +
				`per-criteria:\n${state.spec.criteria.map((c) => `- ${c.id}: ${perCriteria[c.id] ?? "?"}${perCriteria[c.id] === "FAIL" ? " — FAIL" : ""}`).join("\n")}\n` +
				(failedCriteria.length ? `failed: ${failedCriteria.join(", ")}\n` : "") +
				`\ngrader output:\n${grade.output.slice(-4_000)}\n`;
			if (state.specMdPath && existsSync(state.specMdPath)) appendFileSync(state.specMdPath, evalSection);
			const latestMd = join(zenseDir(ctx.cwd), "spec.md");
			if (existsSync(latestMd)) appendFileSync(latestMd, evalSection);
			if (verdict === "FAIL") {
				// วงจร FAIL → ส่งกลับแก้: phase กลับ implementation, escalation need-fix, return isError สั่งแก้+eval ใหม่
				state.phase = "implementation";
				state.escalations.push({ kind: "need-fix", detail: `criteria failed: ${failedCriteria.join(",") || "grader FAIL"}`, at: Date.now() });
				persist(); updateWidget(ctx);
				const fixMsg =
					`❌ Eval FAIL — กลับไปแก้แล้วเรียก zense_eval ใหม่ (ห้ามไป review จนกว่าจะ PASS)\n` +
					`criteria ที่ไม่ผ่าน: ${failedCriteria.length ? failedCriteria.join(", ") : "(overall FAIL — ดู grader output)"}\n\n` +
					`${grade.output}\n\n## Trajectory flags\n${state.trajectoryFlags.join("\n") || "(none)"}\n\n## Spec debt (needs human)\n${state.spec.specDebt.join("\n") || "(none)"}`;
				return { content: [{ type: "text", text: fixMsg }], details: { ok: grade.ok, verdict, failedCriteria, trajectory: state.trajectoryFlags }, isError: true };
			}
			// PASS (หรือ unknown → ปฏิบัติเหมือน PASS เพื่อไม่บล็อก เพราะไม่แน่ใจ): เดินไป review
			// ต้องสั่งขั้นต่อไป explicit ในข้อความที่คืนให้ agent (เหมือน FAIL branch) —
			// ถ้าไม่เขียนบอก agent จะถือว่างานจบแล้วตอบ user ทันที ทำให้ reviewer ไม่ถูกเรียกเลย
			const report =
				`${grade.output}\n\n## Trajectory flags\n${state.trajectoryFlags.join("\n") || "(none)"}\n\n## Spec debt (needs human)\n${state.spec.specDebt.join("\n") || "(none)"}` +
				`\n\n✅ Eval PASS — ขั้นต่อไป (บังคับ): เรียก \`zense_review\` ทันทีเพื่อให้ reviewer sub-agent สร้าง review packet` +
				` — ห้ามสรุป/ตอบ user จบงานก่อนจนกว่าจะเรียก zense_review แล้ว`;
			// auto merge-back: เมื่อ eval PASS งาน verified สมบูรณ์ → merge worktree กลับเข้า main (auto-commit + git merge --no-ff)
			if (state.worktree) {
				const mr = mergeWorktreeBack(ctx.cwd, state.spec, state.worktree);
				if (!mr.ok) {
					escalate("need-decision", `worktree merge: ${mr.msg}`, ctx);
					ctx.ui.notify(`⚠ ${mr.msg}`, "warning"); // เก็บ worktree ไว้ — reviewer ยังอ่าน worktree ได้
				} else {
					learn(ctx, `worktree merged: ${mr.msg}`);
					state.worktree = null;
					ctx.ui.notify(`🌳 worktree merged → main`, "info");
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
		async execute(_id, _p, _s, _o, ctx) {
			// guard ลำดับ phase: review ต้องมาหลัง eval PASS เท่านั้น (phase ถูก set เป็น "review" ใน zense_eval)
			if (state.phase !== "review")
				return {
					content: [{ type: "text", text: `⛔ ยัง review ไม่ได้ — phase ปัจจุบันคือ "${state.phase}" (ต้อง eval PASS ก่อน)\nไปเรียก \`zense_eval\` ก่อน แล้วค่อยกลับมาเรียก zense_review` }],
					details: { phase: state.phase },
					isError: true,
				};
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

	// alt+z — pi รุ่นใหม่เอา ctrl+r ไปใช้กับ app.session.rename แล้ว (shortcut conflict ตอนโหลด) และ
	// ctrl+letter อื่นก็โดนจองหมด (b/f/a/e/d/w/u/k/j/y/c/z/g/v/p/l/t/o/x/s/n) — ctrl+s/ctrl+q เสี่ยง XON/XOFF อีก
	// เลยหนีมาใช้ alt+letter: alt+b/f/d/y ถูกใช้ใน editor แต่ alt+z ว่าง (fallback: /zense agents)
	pi.registerShortcut("alt+z", {
		description: "Zense: ดู sub-agent runs สดๆ (live tail)",
		handler: (ctx) => openAgentsViewer(ctx),
	});

	pi.registerCommand("zense", {
		description: "Zense harness (เซ็น = ลายเซ็นมนุษย์/sign): status | approve | agents | gate on|off | memory | models",
		getArgumentCompletions: (prefix) =>
			["status", "approve", "agents", "gate", "memory", "models"].filter((s) => s.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			if (sub === "status") {
				ctx.ui.notify(
					`phase=${state.phase} spec=${state.spec ? `v${state.spec.version} approved=${state.spec.approved}` : "—"}\n` +
						(state.worktree ? `worktree: ${state.worktree.dir}\n  branch ${state.worktree.branch} (active — merge อัตโนมัติเมื่อ eval PASS)\n` : `worktree: (none — ทำงานใน main)\n`) +
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
				if (rest[0] === "json") {
					// raw JSONL tail (ดิบ)
					const f = join(zenseDir(ctx.cwd), "memory.jsonl");
					ctx.ui.notify(existsSync(f) ? readFileSync(f, "utf8").slice(-2000) : "(empty)", "info");
				} else {
					const lines = memorySummaryLines(ctx.cwd);
					ctx.ui.notify(
						lines.length ? [...lines, "(raw: /zense memory json)"].join("\n") : "📚 memory ยังว่าง — บทเรียนจะสะสมเองทุก escalation/flag/eval/sub-agent fail",
						"info",
					);
				}
			} else if (sub === "models") {
				// ดู/ตั้ง model ของ sub-agent แยกตาม role (.pi/zense/models.json)
				const cfgPath = join(zenseDir(ctx.cwd), "models.json");
				const cfg = readModelsConfig(ctx.cwd);
				const mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no active model)";
				const roles = ["requirements", "grader", "reviewer"];
				if (ctx.mode !== "tui") {
					// non-TUI (rpc/print): แสดง summary ให้แก้เองเหมือนเดิม
					const lines = [
						`🧪 sub-agent models — config: ${existsSync(cfgPath) ? relative(ctx.cwd, cfgPath) : "(no .pi/zense/models.json — ทุก role ใช้ model หลัก)"}`,
						`agent หลัก: ${mainModel}`,
						...roles.map((r) => `  ${r}: ${cfg[r] ? cfg[r] + " (จาก config)" : mainModel + " (fallback)"}`),
						"แก้ไขโดยสร้าง .pi/zense/models.json เช่น { \"grader\": \"openai/gpt-4o-mini\" } — หรือเปิด TUI แล้ว /zense models เพื่อเลือกแบบ interactive",
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				// TUI: interactive picker — เลือก role → เลือก model จาก catalogue → เขียน models.json ให้เลย
				const role = await zensePick(
					ctx,
					"🧪 เลือก role ของ sub-agent ที่จะตั้ง model",
					roles.map((r) => ({
						value: r,
						label: r,
						description: cfg[r] ? `${cfg[r]} (จาก config)` : `${mainModel} (fallback)`,
					})),
					`agent หลัก: ${mainModel}`,
				);
				if (!role) return;
				const choices = availableModelChoices(ctx);
				const sel = await zensePick(
					ctx,
					`🧪 เลือก model สำหรับ role "${role}"`,
					[
						{ value: "__default__", label: "↩️ ใช้ model หลัก (ลบ override)", description: `กลับไป fallback เป็น ${mainModel}` },
						{ value: "__custom__", label: "✏️ พิมพ์ pattern เอง", description: "เช่น openai/gpt-4o-mini หรือ sonnet:high" },
						...choices.map((c) => ({ value: c.pattern, label: c.label, description: c.description })),
					],
					choices.length ? `${choices.length} models จาก catalogue` : "catalogue ว่าง — เลือก 'พิมพ์ pattern เอง'",
				);
				if (!sel) return;
				if (sel === "__default__") {
					writeModelsConfig(ctx.cwd, role, null);
					ctx.ui.notify(`✅ ${role}: ลบ override แล้ว — sub-agent run ถัดไปจะ fallback เป็น model หลัก (${mainModel})`, "info");
					return;
				}
				let pattern = sel;
				if (sel === "__custom__") {
					const typed = (await ctx.ui.input(`model pattern สำหรับ "${role}":`, "provider/model-id"))?.trim();
					if (!typed) return ctx.ui.notify("ยกเลิก — ไม่ได้เปลี่ยน model", "info");
					pattern = typed;
				}
				writeModelsConfig(ctx.cwd, role, pattern);
				ctx.ui.notify(`✅ ${role}: ${pattern} — เขียน ${relative(ctx.cwd, cfgPath)} แล้ว (มีผล sub-agent run ถัดไปทันที)`, "info");
			} else {
				ctx.ui.notify("usage: /zense status|approve|agents|gate on|off|memory|models", "info");
			}
		},
	});

	function renderSpecMd(s: Spec): string {
		return `# Spec v${s.version}: ${s.title}\napproved: ${s.approved}\n\n## Intent\n${s.intent}\n\n## Scope\n${s.scope.map((x) => `- ${x}`).join("\n")}\n\n## Constraints\n${s.constraints.map((x) => `- ${x}`).join("\n")}\n\n## Acceptance criteria\n${s.criteria.map((c) => `- [ ] ${c.id}: ${c.text} *(check: ${c.check})*`).join("\n")}\n\n## Spec debt (human-verified only)\n${s.specDebt.map((x) => `- ${x}`).join("\n")}\n`;
	}
}

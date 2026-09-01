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
 *   P1 Requirements : zense_spec tool → append-only archive .zense/specs/
 *                     <timestamp>-v{n}-<slug>.{json,md} (never overwritten) +
 *                     .zense/spec.{json,md} as always-latest copies
 *   P2 Design       : zense_adr tool → .zense/adr/NNN-*.md (deny rules checked live)
 *   P3 Implementation: specification gate + escalation
 *   P4 Dual eval    : zense_eval (output eval vs criteria) + trajectory heuristics
 *   P5 Review/Deploy: zense_review builds a review-packet card (exception-based)
 *   P6 Maintenance  : memory.jsonl learning log; incidents feed new criteria
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Box, Container, Key, Markdown, matchesKey, SelectList, Spacer, Text, truncateToWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// ----------------------------------------------------------------------------- types

interface Criterion { id: string; text: string; check: string; verified?: boolean }
interface Spec {
	version: number;
	title: string;
	intent: string;
	approach?: string[];       // แนวทางการทำงาน (presentational — โชว์ตอน sign dialog ให้คนเซ็นเห็น shape ของงาน; optional เพราะ persisted spec เก่าไม่มี field นี้)
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
	specSource?: "set" | "compile"; // spec ปัจจุบันมาจาก agent เขียนเอง (set) หรือ sub-agent (compile) — ใช้ telemetry H
	lastEval?: { verdict: string; perCriteria: Record<string, string>; failedIds: string[]; probes: ProbeResult[]; at: number; specVersion?: number; head?: string }; // W2: evidence ล่าสุดจาก zense_eval → เป็น input ของ reviewer (specVersion+head ผูกกับรอบปัจจุบัน กัน evidence เก่าหลุดไปถึง reviewer)
	baselineHead?: string;      // HEAD ของ main repo ตอน spec approval — ใช้ scope git evidence (log/diff เฉพาะตั้งแต่ baseline ของรอบนี้ ไม่ใช่ทั้งประวัติ)
	evalOverrideFails?: { specVersion: number; ids: string[]; count: number }; // anti-loop: FAIL ที่มาจาก probe override ล้วน ซ้ำ ids เดิมกับ spec เวอร์ชันเดิม → DEADLOCK escalate แทนวน "กลับไปแก้" ไม่จบ
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
	logPath?: string;            // .zense/subagents/<stamp>-<role>.log — เขียน live ระหว่างรัน
	model?: string;              // model ที่ sub-agent รันจริง ('provider/id' จาก JSONL events) — เทียบกับ .zense/models.json เพื่อดัก pi fallback เงียบๆ
	status?: "running" | "done" | "failed";
}
/** Active per-session worktree: redirect ทุก tool call ของ main agent เข้าไปทำงานในนี้
 *  (ผ่านการ mutate event.input) จนกว่า eval PASS จะ merge กลับเข้า main; กัน 2 session เขียนทับกัน */
interface Worktree {
	root: string;               // absolute path ของ worktree (nested ใต้ <repo>/.zense/worktree/)
	branch: string;             // zense/impl/v<N>-<stamp>
	dir: string;                // === root (เก็บซ้ำเพื่อ semantic clarity ตอน worktree remove)
	baseline?: string;          // HEAD ของ main ก่อนสร้าง branch — กลายเป็น git-evidence baseline ของรอบนี้
}

const zenseDir = (cwd: string) => join(cwd, ".zense");

/**
 * merge "tuiMode": "fullscreen" เข้า settings.json — เฉพาะตอนที่ key ยังไม่มีเท่านั้น (ผู้ใช้ยังไม่เคยเลือก)
 * public extension API ของ pi ไม่มี tuiMode setter (SettingsManager.setTuiMode ไม่ถูก expose ให้ extension)
 * เลยต้องเขียนไฟล์ตรงๆ — pure function แยกออกจาก fs เพื่อ unit-test ได้โดยไม่แตะไฟล์จริงของผู้ใช้
 * คืน null = ไฟล์เดิม parse ไม่ได้/ไม่ใช่ object → ห้ามเขียนทับเด็ดขาด (กัน clobber การตั้งค่าของผู้ใช้)
 * changed=false = user ตั้ง tuiMode เองแล้ว (แม้แต่ "regular") → respect ทันที ไม่แตะต้อง
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

/** shell-quote แบบ single-quote สำหรับ path ที่อาจมี space/special char */
const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Remap path ที่ agent ขอ (relative ต่อ session cwd = main repo) ไปเป็น path ใต้ worktree root
 * โดย relative structure เดิม. path นอก repo (เช่น pi docs ใน node_modules) และ path ใต้
 * .zense/ (harness state ที่ต้องอยู่ใน main) คืนค่าเดิม — ไม่ redirect.
 * Pure function → unit-test ได้ (export เผื่อ test ใช้โดยตรง).
 */
export const rewritePathForWorktree = (cwd: string, wtRoot: string, path: string): string => {
	if (!path) return path;
	const abs = resolve(cwd, path);
	const rel = relative(cwd, abs).split(sep).join("/");
	if (!rel || rel.startsWith("..")) return path;           // นอก repo → ไม่ redirect
	if (rel === ".zense" || rel.startsWith(".zense/")) return path; // harness state อยู่ main
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
 *  worktree อยู่ใต้ <repo>/.zense/worktree/ (nested ใน main working tree — git รองรับ)
 *  เพื่อให้ state ของ zense รวมอยู่ใน workspace ที่เดียว ไม่รก parent dir. best-effort:
 *  ล้มเหลว (ไม่ใช่ git repo / ชื่อซ้ำ) → คืน null (caller degrade กลับทำงานใน main ตามปกติ ไม่พัง). */
/** worktree เดิมเอามาใช้ต่อได้ไหม: มี record และ root ยังอยู่บนดิสก์ (user อาจลบ worktree ทิ้งเอง
 *  ระหว่าง session → false = สร้างใหม่). กันเคส bump spec version แล้วเซ็นใหม่กลาง implement:
 *  เดิมสร้าง worktree เปล่าจาก main ทุกครั้ง → งานที่ implement ค้างไว้ใน worktree เก่ากลายเป็น orphan
 *  (eval รอบถัดไปรันกับ worktree เปล่าแล้ว FAIL ทั้งที่ทำเสร็จแล้ว — เจอจริงรอบ v3→v4) */
export const canReuseWorktree = (wt: Worktree | null | undefined): boolean => !!wt && existsSync(wt.root);

export const createWorktree = (cwd: string, spec: Spec): Worktree | null => {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const branch = `zense/impl/v${spec.version}-${stamp}`;
	const wtParent = join(zenseDir(cwd), "worktree");
	const wtRoot = join(wtParent, `${basename(cwd)}-wt-${stamp}`);
	mkdirSync(wtParent, { recursive: true });
	const head = gitOk(["rev-parse", "HEAD"], cwd); // baseline ของรอบ = main HEAD ก่อน branch (ก่อน worktree add เสมอ)
	if (gitOk(["worktree", "add", wtRoot, "-b", branch], cwd).ok !== true) return null;
	excludeFromGitStatus(cwd, wtParent);
	// copy current spec + memory เข้า worktree ให้ bash-based read ในนั่นเห็น state ปัจจุบัน (ไม่ใช่ตอน checkout)
	const wtZense = join(wtRoot, ".zense");
	mkdirSync(wtZense, { recursive: true });
	for (const f of ["spec.json", "spec.md", "memory.jsonl"]) {
		const src = join(zenseDir(cwd), f);
		if (existsSync(src)) copyFileSync(src, join(wtZense, f));
	}
	return { root: wtRoot, branch, dir: wtRoot, ...(head.ok ? { baseline: head.out.trim() } : {}) };
};

/** cursor ใต้ repo ที่ zense สร้าง (เช่น .zense/worktree/) ไม่ควรโผล่ใน git status ของ main —
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
	// 1. stage changes ใน worktree (ยกเว้น .zense) แล้ว commit ถ้ามี — รวม untracked files ด้วย
	//    (git diff --quiet HEAD ไม่เห็น untracked → ต้อง add ก่อนแล้วเช็ค --cached)
	gitOk(["add", "-A", "--", ".", ":!.zense"], wt.root);
	if (!gitOk(["diff", "--cached", "--quiet"], wt.root).ok) {
		gitOk(["commit", "-m", `zense: impl v${spec.version} (eval PASS)`, "--no-verify"], wt.root);
	}
	// 2. merge เข้า main (main อาจมี uncommitted .zense/ — disjoint กับ source changes → git อนุญาต)
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

// ----------------------------------------------------------------------------- requirements draft parsing (module scope — export เพื่อ unit-test ได้)

export interface SpecDraft {
	title: string;
	intent: string;
	approach: string[];
	scope: string[];
	constraints: string[];
	criteria: Criterion[];
	specDebt: string[];
}

export type DraftParse =
	| { kind: "spec"; draft: SpecDraft }
	| { kind: "clarify"; questions: string[] }
	| { kind: "error"; error: string };

const asStringArray = (v: unknown): string[] | undefined =>
	Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;

/**
 * ดึง JSON object เดียวออกจาก output ของ sub-agent — ทนได้ทั้ง JSON ดิบ, ```json fence
 * และข้อความคั่นรอบ (ลอง first-'{' ถึง last-'}') เพราะ model ชอบแถม prose ทั้งที่สั่งห้าม;
 * ถ้า parse ตรงๆ ตัวเดียวจะพลาดบ่อยโดยไม่จำเป็น
 */
export const extractJsonObject = (text: string): unknown => {
	const candidates: string[] = [text.trim()];
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) candidates.push(fence[1].trim());
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
	for (const c of candidates) {
		try {
			return JSON.parse(c);
		} catch {
			/* ลอง candidate ถัดไป */
		}
	}
	return undefined;
};

/**
 * A: parse + validate draft ของ requirements sub-agent ตาม contract:
 *   - spec shape    → {title,intent,approach,scope,constraints,criteria[{id,text,check}],specDebt}
 *   - clarify shape (F) → {"questions": [...]} (ขอถามกลับแทนการเดา) — ถือเป็น clarify เฉพาะตอนที่ยังไม่มี criteria
 *   - อื่นๆ        → error พร้อมข้อความบอกว่าพังตรงไหน (ใช้เป็น feedback ตอน retry รอบ 2)
 * ผิดรูปเล็กน้อยจะถูก normalize (criteria id หาย → auto c1..n, array หาย → []) แต่
 * criteria ว่าง / item ไม่มี text/check ถือว่า invalid เพราะทำให้ spec ไม่มีฟัน
 */
export const parseSpecDraft = (text: string): DraftParse => {
	const raw = extractJsonObject(text);
	if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw))
		return { kind: "error", error: "output ไม่ใช่ JSON object (หา JSON ที่ parse ได้ไม่เจอ — สั่ง output ONLY JSON ไว้)" };
	const o = raw as Record<string, unknown>;
	const qs = asStringArray(o.questions);
	if (qs?.length && o.criteria === undefined) return { kind: "clarify", questions: qs.slice(0, 5) };
	if (!Array.isArray(o.criteria) || o.criteria.length === 0)
		return { kind: "error", error: "criteria ต้องเป็น array ที่มีอย่างน้อย 1 รายการ (แต่ละอันต้องมี check เป็นคำสั่งที่รันได้จริง)" };
	const criteria: Criterion[] = [];
	for (let i = 0; i < o.criteria.length; i++) {
		const c = o.criteria[i] as Record<string, unknown> | null;
		if (!c || typeof c !== "object") return { kind: "error", error: `criteria[${i}] ไม่ใช่ object` };
		const ctext = typeof c.text === "string" ? c.text.trim() : "";
		const check = typeof c.check === "string" ? c.check.trim() : "";
		if (!ctext) return { kind: "error", error: `criteria[${i}].text ว่างหรือไม่ใช่ string` };
		if (!check) return { kind: "error", error: `criteria[${i}].check ว่างหรือไม่ใช่ string` };
		criteria.push({ id: typeof c.id === "string" && c.id.trim() ? c.id.trim() : `c${i + 1}`, text: ctext, check });
	}
	return {
		kind: "spec",
		draft: {
			title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : "untitled",
			intent: typeof o.intent === "string" ? o.intent : "",
			approach: asStringArray(o.approach) ?? [],
			scope: asStringArray(o.scope) ?? [],
			constraints: asStringArray(o.constraints) ?? [],
			criteria,
			specDebt: asStringArray(o.specDebt) ?? [],
		},
	};
};

/**
 * heuristic "check นี้ harness/grader รันอัตโนมัติได้จริงไหม": ผ่านถ้ามี command token ที่รู้จัก,
 * backtick-quoted command, '$'-prompt หรือ pattern path-exists; เจอคำว่า manual/ดูด้วยตา = ไม่ผ่านทันที
 * — quality gate (G) ใช้ผลัก criterion ที่เช็คไม่ได้จริงลง specDebt (forced human review)
 * เจตนาคือหลวมฝั่งผ่าน (false negative ดีกว่า false positive: ทุกอย่างที่ไม่แน่ใจต้องไป specDebt)
 */
export const isMachineCheckable = (check: string): boolean => {
	const s = check.toLowerCase();
	if (/\bmanual(ly)?\b|by eye|visually|eyeball|ask (the )?human|ดูด้วยตา|ตรวจด้วยมือ/.test(s)) return false;
	if (/path exists|file exists|exists:/.test(s)) return true;
	if (/`[^`]+`/.test(check) || /^\s*\$/.test(check)) return true;
	return /\b(npm|pnpm|yarn|bun|npx|node|deno|pytest|python3?|pip|cargo|go|make|just|mvn|gradle|dotnet|composer|php|ruby|bundle|bash|sh|zsh|curl|wget|git|grep|rg|ls|cat|head|tail|find|test|diff|cmp|wc|jq|yq|stat|tsc|vitest|jest|mocha|uv|turbo|docker)\b/i.test(check);
};

const tokenSet = (s: string): Set<string> =>
	new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));

export const jaccard = (a: Set<string>, b: Set<string>): number => {
	if (!a.size || !b.size) return 0;
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	return inter / (a.size + b.size - inter);
};

/** G: กัน spec ซ้ำ — scan archive .zense/specs/*.json (ล่าสุด 20 อัน) เทียบ token ของ
 *  title+intent; Jaccard ≥ 0.5 ถือว่า "คล้าย" (threshold หลวมพอจับ paraphrase แต่ไม่ชนงานต่างกัน) */
export const findSimilarSpec = (cwd: string, draft: SpecDraft): { file: string; title: string; score: number } | null => {
	const dir = join(zenseDir(cwd), "specs");
	if (!existsSync(dir)) return null;
	const mine = tokenSet(`${draft.title} ${draft.intent}`);
	let best: { file: string; title: string; score: number } | null = null;
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).slice(-20)) {
		try {
			const old = JSON.parse(readFileSync(join(dir, f), "utf8")) as { title?: string; intent?: string };
			const score = jaccard(mine, tokenSet(`${old.title ?? ""} ${old.intent ?? ""}`));
			if (score >= 0.5 && (!best || score > best.score)) best = { file: f, title: old.title ?? "?", score };
		} catch {
			/* ข้ามไฟล์เสียใน archive */
		}
	}
	return best;
};

/**
 * G: quality gate ฝั่ง harness — sub-agent เก่งเรื่องดราฟต์ แต่ harness ต้องเป็นคนสงสัยแทนมนุษย์:
 * scope ว่าง / check ตรวจอัตโนมัติไม่ได้ / ซ้ำ spec เก่า → บังคับลง specDebt (forced human review ตอน eval/review)
 * คืน draft ใหม่ (ไม่ mutate ของเดิม) พร้อม notes สั้นๆ ว่าเพิ่มอะไรบ้าง (ใช้ทั้ง telemetry H และแจ้งใน tool result)
 */
export const applyQualityGate = (cwd: string, draft: SpecDraft): { draft: SpecDraft; notes: string[] } => {
	const notes: string[] = [];
	const extraDebt: string[] = [];
	if (!draft.scope.length) {
		extraDebt.push("quality-gate: scope ไม่ได้ระบุ — ทุก write จะผ่าน scope check หมด; ควรระบุ path prefix ที่ agent แก้ได้");
		notes.push("empty-scope");
	}
	// W3: scope typo = gate ไร้ฟันเงียบๆ — prefix ที่ไม่มี path จริงจะไม่ match write ไหนเลย ทั้งที่คิดว่าคุมอยู่
	for (const s of draft.scope) {
		const prefix = s.replace(/\*+$/, "").replace(/\/+$/, "");
		if (prefix && !existsSync(join(cwd, prefix))) {
			extraDebt.push(`quality-gate: scope \"${s}\" ไม่ match path จริงใน repo — ตรวจการสะกด/โครงสร้างจริงก่อนเซ็น`);
			notes.push(`scope-missing:${s.slice(0, 30)}`);
		}
	}
	for (const c of draft.criteria) {
		const ph = hasUnsubstitutedPlaceholder(c.check);
		if (ph) {
			extraDebt.push(`quality-gate: ${c.id} มี placeholder ที่ไม่ได้ substitute ใน check ("${ph}") — ต้องแก้ check ก่อนเซ็น`);
			notes.push(`placeholder:${c.id}`);
		} else if (!isMachineCheckable(c.check)) {
			extraDebt.push(`quality-gate: ${c.id} มี check ที่ตรวจอัตโนมัติไม่ได้ ("${c.check.slice(0, 80)}") — ต้อง verify ด้วยมนุษย์`);
			notes.push(`manual-check:${c.id}`);
		}
	}
	const similar = findSimilarSpec(cwd, draft);
	if (similar) {
		extraDebt.push(`quality-gate: intent คล้าย spec เก่า "${similar.title}" (${similar.file}, similarity=${similar.score.toFixed(2)}) — ยืนยันก่อนเซ็นว่าไม่ซ้ำซ้อน`);
		notes.push(`similar:${similar.file}`);
	}
	return { draft: { ...draft, specDebt: [...draft.specDebt, ...extraDebt] }, notes };
};

// ----------------------------------------------------------------------------- sub-agent argv (module scope — export เพื่อ unit-test ได้)

/** C: role ที่หน้าที่คือ "อ่าน/ร่าง" ไม่ใช่ "แก้โค้ด" — ล็อก read-only ผ่าน --exclude-tools
 *  (defense-in-depth: prompt สั่งห้ามแก้แค่ชั้นเดียวโดนละเมิดได้ แต่ tools ที่ไม่มีเรียกไม่ได้เลย)
 *  ยังเหลือ read+bash ไว้ เพราะ D ต้องการให้มันสำรวจ repo และลองรัน check command จริงก่อนดราฟต์ */
// W2: grader/reviewer ก็ read-only — หน้าที่คือตัดสิน/รายงาน ไม่ใช่แก้โค้ด (subprocess ไม่ผ่าน gate
// และไม่โดน agent_end heuristics ของ main agent → ปล่อย write ไว้ = grader แก้ test ให้ผ่านเองได้เงียบๆ)
export const SUBAGENT_EXCLUDE_TOOLS: Record<string, string[]> = {
	requirements: ["write", "edit"],
	grader: ["write", "edit"],
	reviewer: ["write", "edit"],
};

/** argv ของ pi sub-agent ตัวเดียวที่ runSubagent ใช้ — แยกออกมาเพื่อ test ได้ว่า flag ถูกต้อง */
/** model ที่ sub-agent รันจริง (จาก JSONL events, รูป 'provider/id') ตรง pattern ที่ config ไว้ใน models.json ไหม —
 *  match กรณี: exact (case-insensitive) หรือ pattern = usedModel + ':<thinking-level>' (suffix ที่ pi ตัดออกตอน resolve) */
export const modelMatchesPattern = (usedModel: string, pattern: string): boolean => {
	const used = usedModel.trim().toLowerCase();
	const pat = pattern.trim().toLowerCase();
	return used.length > 0 && (pat === used || pat.startsWith(`${used}:`));
};

export const buildSubagentArgv = (task: string, modelPattern?: string, excludeTools?: string[]): string[] => {
	// argv: --exclude-tools ก่อน --model ก่อน task; ไม่ใส่ -- นำหน้า task (คงพฤติกรรมเดิมของไฟล์นี้)
	const argv = ["PI_ZENSE_SUBAGENT=1", "pi", "--mode", "json", "--no-session"];
	if (excludeTools?.length) argv.push("--exclude-tools", excludeTools.join(","));
	if (modelPattern) argv.push("--model", modelPattern);
	argv.push(task);
	return argv;
};

/** D: prompt ของ requirements sub-agent — บังคับ explore ก่อนดราฟต์ (grounding: criteria[].check
 *  ต้องเป็นคำสั่งที่มีอยู่และรันได้จริงใน repo นี้ ไม่ใช่เดา) + clarify contract (F) + output JSON เดียว
 *  (module scope + export: อยู่ข้าง parser ของมันเอง เวลาเปลี่ยน contract จะได้เห็นคู่กัน) */
export const buildRequirementsPrompt = (intent: string, lessons: string[], facts?: string[], exemplar?: string | null): string =>
	`You are the REQUIREMENTS sub-agent for a spec-gated SDLC harness. Your single JSON output becomes the machine-checked contract for the main agent's implementation, so every criterion must be grounded in THIS repository's reality — never guess.

` +
	`Step 1 — EXPLORE (read-only, mandatory before drafting): read README*, package.json / other manifests, test configs, CI configs and the relevant source layout. Actually RUN the candidate test/lint/build commands you plan to reference, so every check you write is proven to work here. You have NO write/edit tools — do not attempt to modify anything.

` +
	`Step 2 — DRAFT exactly ONE JSON object:
{"title": string, "intent": string, "approach": string[], "scope": string[], "constraints": string[], "criteria": [{"id": string, "text": string, "check": string}], "specDebt": string[]}
Rules:
- scope: the minimal list of path prefixes the main agent may modify.
- approach: 3–7 short bullets describing the planned work — main steps, which files will be created or modified, and expected outcomes — grounded in your Step 1 exploration (no guessing). This is presentational info shown to the human signer so they can see what will actually happen; it is NOT a machine-checked criterion.
- criteria: few and atomic. Each "check" MUST be an executable command verified in Step 1 (e.g. "npm test"), "path exists: <p>", or a compound of those joined with "&&" (e.g. "path exists: src/a.ts && npm test"). Anything you cannot verify by running a command belongs in specDebt instead (it becomes forced human review).
- Output ONLY the JSON object — no markdown fences, no commentary.

` +
	`Step 3 — CLARIFY INSTEAD OF GUESSING: if the request is ambiguous enough that a wrong guess would be costly, do NOT draft yet. Output exactly {"questions": ["short question", "…max 5…"]}. A human will answer and you will be re-run with the answers.` +
	// W3: exemplar (few-shot จาก spec ที่เคย signed) + facts (context priming ที่ harness เก็บเอง)
	// แทรกก่อน lessons — หลักฐานจาก repo ตัวเองสำคัญกว่าบทเรียนกว้างๆ ทั้งคู่ optional เพื่อ backward compat
	(exemplar ? `\n\nA previously SIGNED spec from this repo (style/format exemplar — do NOT copy its content):\n${exemplar}` : "") +
	(facts?.length ? `\n\nRepository facts gathered by the harness (verified — trust these over your own assumptions):\n${facts.join("\n")}` : "") +
	(lessons.length
		? `\n\nPast lessons from this project's memory (reflect relevant ones in scope/constraints/criteria when they apply):\n${lessons.join("\n")}`
		: "") +
	`\n\nRequest: ${intent}`;

// ----------------------------------------------------------------------------- eval/review evidence helpers (module scope — export เพื่อ unit-test ได้)

/**
 * W3: context priming — harness เก็บข้อเท็จจริงถูกๆ ของ repo ให้ requirements sub-agent เอง
 * (D เดิมพึ่ง "สั่งให้ model explore" ล้วนๆ — model ขี้เกียจรอบเดียว criteria ก็ลอยทั้งชุด)
 * ทุกส่วน best-effort: อ่านไม่ได้/ไม่มีไฟล์ → ข้ามเงียบๆ ไม่ให้ compile พังเพราะ repo หน้าตาแปลก
 */
export const gatherRepoFacts = (cwd: string): string[] => {
	const facts: string[] = [];
	try {
		if (existsSync(join(cwd, "package.json"))) {
			const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: string; scripts?: Record<string, string> };
			if (pkg.name) facts.push(`package: ${pkg.name}`);
			const scripts = pkg.scripts ? Object.entries(pkg.scripts).map(([k, v]) => `${k}="${v}"`).join(", ") : "";
			if (scripts) facts.push(`scripts: ${scripts.slice(0, 600)}`);
		}
	} catch {
		/* tolerate malformed package.json */
	}
	for (const f of ["AGENTS.md", "README.md", "README"]) {
		try {
			if (existsSync(join(cwd, f))) {
				const head = readFileSync(join(cwd, f), "utf8").split("\n").slice(0, 12).join("\n").trim();
				if (head) {
					facts.push(`${f} (head): ${head.slice(0, 400)}`);
					break;
				}
			}
		} catch {
			/* skip */
		}
	}
	try {
		const top = readdirSync(cwd, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
			.map((e) => e.name)
			.slice(0, 12);
		if (top.length) facts.push(`top-level dirs: ${top.join(", ")}`);
	} catch {
		/* skip */
	}
	const configs = ["tsconfig.json", "vitest.config.ts", "vitest.config.mts", "jest.config.js", "jest.config.ts", ".mocharc.json"].filter((f) => existsSync(join(cwd, f)));
	if (configs.length) facts.push(`configs present: ${configs.join(", ")}`);
	return facts.map((f) => `- ${f}`);
};

/**
 * W3: few-shot จาก spec จริงของ repo — ดึงฉบับล่าสุดที่เคย signed (approved) จาก archive
 * เป็นตัวอย่าง style/format ที่เคยผ่าน gate ของโปรเจกต์นี้ (ตัด criteria เหลือ 3 อัน ไม่ให้ prompt บวม)
 * ชื่อไฟล์ archive ขึ้นต้นด้วย timestamp → sort desc แล้วไล่ไฟล์แรกที่ approved=true
 */
export const loadSpecExemplar = (cwd: string): string | null => {
	const dir = join(zenseDir(cwd), "specs");
	if (!existsSync(dir)) return null;
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 10)) {
		try {
			const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as Spec;
			if (!s.approved || !s.criteria?.length) continue;
			return JSON.stringify({
				title: s.title,
				intent: s.intent.slice(0, 200),
				approach: (s.approach ?? []).slice(0, 3),
				scope: s.scope,
				criteria: s.criteria.slice(0, 3),
				specDebt: s.specDebt.slice(0, 2),
			});
		} catch {
			/* ข้ามไฟล์เสียใน archive */
		}
	}
	return null;
};

/** W2: สรุปสถานะ git ของ working dir ที่กำลัง eval/review (worktree หรือ main) — best-effort:
 *  ไม่ใช่ repo/คำสั่งล้มเหลว → เว้นส่วนนั้นไป. grader ใช้ดู diff จับ reward hacking,
 *  reviewer ใช้เป็น evidence pack. จำกัดความยาวทุกส่วนกัน prompt บวม */
export const gitChangeSummary = (cwd: string, baseline?: string): string => {
	const parts: string[] = [];
	if (baseline) {
		// ground เฉพาะรอบปัจจุบัน: log/diff เทียบ baseline ตอน spec approval — commit เก่าก่อนรอบนี้ไม่ปนเข้า evidence
		const log = gitOk(["log", "--oneline", `${baseline}..HEAD`], cwd);
		if (log.ok && log.out.trim()) parts.push(`commits since baseline ${baseline.slice(0, 8)}:\n${log.out.trim()}`);
	} else {
		const log = gitOk(["log", "--oneline", "-8"], cwd);
		if (log.ok && log.out.trim()) parts.push(`recent commits:\n${log.out.trim()}`);
	}
	const status = gitOk(["status", "--porcelain"], cwd);
	if (status.ok && status.out.trim()) parts.push(`changed/untracked files:\n${status.out.trim().split("\n").slice(0, 30).join("\n")}`);
	const diff = gitOk(baseline ? ["diff", baseline, "--stat"] : ["diff", "HEAD", "--stat"], cwd);
	if (diff.ok && diff.out.trim()) parts.push(`diffstat vs ${baseline ? `baseline ${baseline.slice(0, 8)}` : "HEAD"}:\n${diff.out.trim().split("\n").slice(-25).join("\n")}`);
	return parts.join("\n\n").slice(0, 4_000);
};

export interface ProbeResult {
	id: string;
	status: "pass" | "fail" | "skipped"; // skipped = check ไม่ runnable (manual → human review; ไม่บังคับผ่าน/ไม่ผ่าน)
	exitCode?: number;
	detail: string; // stdout/stderr tail หรือเหตุผลที่ skip
}

const PROBE_TIMEOUT_MS = 30_000; // กัน check ค้าง (server รอ port ฯลฯ) ลาก eval ไปด้วย

/** usage/syntax/environment errors = เครื่องมือรันคำสั่งเช็คไม่ได้เพราะตัวคำสั่งเองเสีย (arg เกิน /
 *  flag ไม่รู้จัก / parse พัง) — ไม่ใช่หลักฐานว่า artifact ผิด. เช็คที่ "รันแล้วไม่ตรง" จริง
 *  (grep ไม่เจอ, test false, diff แตกต่าง) ล้วน exit 1 แบบเงียบๆ หรือพิมพ์ diff ออก stdout
 *  → ไม่โดน regex นี้ ยังเป็น fail เต็มตัว. ตั้งใจไม่ใส่ "No such file": `cat missing-file`
 *  = artifact หายของจริง ต้อง fail. เคสเจอจริง: "expected at most two arguments… unexpected: +, grep",
 *  "test: too many arguments" → probe ตายทั้งที่ artifact ถูก → ถูก probe-primacy ทับ FAIL เงียบๆ ลูปไม่จบ */
const PROBE_USAGE_ERROR_RE =
	/too many arguments|usage:|unexpected (argument|token|operator|flag)|expected (exactly|at (most|least)) \w+ argument|accepts \d+ arg|unrecognized |unknown (flag|command|shorthand|option)|invalid (option|argument|flag)|illegal option|bad option|syntax error/i;

/** ตัดสินว่า shell probe ที่พังคือ "คำสั่งเสียฝั่งเครื่องมือ" (ตัดสิน artifact ไม่ได้) หรือ fail จริง */
const isProbeCommandError = (exitCode: number | undefined, detail: string): boolean =>
	exitCode === 126 || exitCode === 127 || PROBE_USAGE_ERROR_RE.test(detail);

/** placeholder ที่ไม่ได้ substitute ใน check — token รูป <word> หรือ {word}
 *  (spec author เผลอเขียน check เป็น template เช่น "path exists: src/<module>/x", "grep -q foo {file}"
 *  → รันแล้ว No such file / exit 1 เงียบ → ถูก probe primacy ทับ FAIL ทั้งที่คำสั่งเสีย เจอจริง)
 *  ยกเว้น ${VAR} (shell variable — lookbehind (?<!\$)) — ไม่ใช่ placeholder */
const PLACEHOLDER_TOKEN_RE = /<[A-Za-z][A-Za-z0-9_-]*>|(?<!\$)\{[A-Za-z][A-Za-z0-9_-]*\}/;
export const hasUnsubstitutedPlaceholder = (check: string): string | null => {
	const m = check.match(PLACEHOLDER_TOKEN_RE);
	return m ? m[0] : null;
};

type CheckSegment = { kind: "exists"; path: string } | { kind: "shell"; command: string };

const PATH_EXISTS_SEG_RE = /^\s*(?:path|file)\s+exists:\s*(.+?)\s*$/i;

/** แยก compound check ("path exists: a && npm test") ที่หัว "&&" ออกเป็น segment — คืน null ถ้า
 *  ไม่มี segment แบบ path-exists เลย (check ล้วน shell อาจมี "&&" ใน string literal เช่น
 *  grep -q "a && b" → split มั่วแล้วคำสั่งพัง เลยคงพฤติกรรม sh -c ทั้งก้อนไว้เหมือนเดิม) */
const splitCompoundCheck = (check: string): CheckSegment[] | null => {
	const parsed: CheckSegment[] = check.split(/\s*&&\s*/).map((seg) => {
		const m = seg.match(PATH_EXISTS_SEG_RE);
		return m ? { kind: "exists", path: m[1] } : { kind: "shell", command: seg.trim() };
	});
	return parsed.some((s) => s.kind === "exists") ? parsed : null;
};

/** รัน shell command เดียวใน cwd — คืน pass/exitCode/detail(stdout|stderr tail); exitCode undefined เมื่อ timeout/สัญญาณฆ่า
 *  cmdErr=true เมื่อตัวคำสั่งเองเสีย (usage/syntax/command-not-found) — caller ต้องไม่นับเป็น artifact fail */
/** strip leading shell-runner prefix ("bash: "/"sh:"/"shell:"/"zsh:", case-insensitive) จาก check —
 *  มนุษย์/LLM มักเขียน check เป็น "bash: npm test" ซึ่ง sh -c ทั้งก้อนแล้วพัง (sh: bash:: command not found,
 *  exit 127 → skipped เสีย machine verification ทุกรอบ); strip เฉพาะต้น command ครั้งเดียว ไม่แตะกลางสตริง */
export const normalizeShellCommand = (check: string): string => check.replace(/^\s*(?:bash|sh|shell|zsh):\s*/i, "");

const runShellSegment = (command: string, cwd: string, timeoutMs: number): { pass: boolean; exitCode?: number; detail: string; cmdErr?: boolean } => {
	// normalize ก่อนรัน — detail ต้องสะท้อนคำสั่งที่ execute จริง (ตัวถัดไปนับจากนี้คือ stripped command)
	command = normalizeShellCommand(command);
	try {
		const out = execFileSync("sh", ["-c", command], { cwd, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { pass: true, exitCode: 0, detail: (out || "").trim().split("\n").slice(-3).join("\n").slice(-300) || "(exit 0, no output)" };
	} catch (e: unknown) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		const code = typeof err.status === "number" ? err.status : -1;
		const tail = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().split("\n").slice(-3).join("\n").slice(-300);
		const exitCode = code >= 0 ? code : undefined;
		const detail = tail || `exit=${code}`;
		return { pass: false, ...(exitCode !== undefined ? { exitCode } : {}), detail, ...(isProbeCommandError(exitCode, detail) ? { cmdErr: true } : {}) };
	}
};

/**
 * W3 (probe-first grading): harness รัน criteria[].check ด้วยตัวเองก่อนส่ง grader —
 * grader ไม่ต้องเดาว่าคำสั่งรันแล้วได้อะไร และ probe เป็นหลักฐานแข็งที่ทับ verdict ของ grader ได้
 * (probe fail ⇒ criterion FAIL ไม่ว่า grader จะว่าอย่างไร — ดู zense_eval)
 * ยกเว้นคำสั่งเช็คเสียฝั่งเครื่องมือเอง (usage/syntax error — ดู isProbeCommandError) → skipped:
 * ไม่ใช่หลักฐานว่า artifact ผิด ปล่อย grader ตัดสินจากหลักฐานอื่น + ฝากมนุษย์ตรวจ ไม่บังคับ FAIL ลูปไม่จบ
 * รองรับ 3 รูปแบบ: "path exists: <p>" resolve ใน process เลย / เช่นเดียวกันกับ segment ของ compound
 * ("path exists: a && npm test" — ทุก segment ต้องผ่าน) / check ล้วน shell ที่ isMachineCheckable → sh -c ทั้งก้อน
 */
export const runCheckProbes = (cwd: string, criteria: Criterion[], timeoutMs = PROBE_TIMEOUT_MS): ProbeResult[] =>
	criteria.map((c) => {
		// placeholder ที่ไม่ได้ substitute → คำสั่งเสียฝั่ง spec (ครอบทุก branch: path-exists/compound/shell)
		// ห้ามไหลเป็น fail (probe primacy จะทับ grader → ลูปไม่จบ) — skipped พร้อมบอกทางแก้
		const ph = hasUnsubstitutedPlaceholder(c.check);
		if (ph)
			return {
				id: c.id,
				status: "skipped" as const,
				detail: `unsubstituted placeholder "${ph}" in check (→ fix spec via zense_spec, human review)`,
			};
		const segs = splitCompoundCheck(c.check);
		if (segs?.every((s) => s.kind === "exists")) {
			// path-exists ล้วน — resolve ใน process (single-path คงพฤติกรรมเดิมเป๊ะทั้ง status และ detail)
			const missing: string[] = [];
			for (const s of segs) if (s.kind === "exists" && !existsSync(resolve(cwd, s.path))) missing.push(s.path);
			const ok = !missing.length;
			return {
				id: c.id,
				status: ok ? ("pass" as const) : ("fail" as const),
				detail: ok ? `exists: ${segs.map((s) => s.path).join(", ")}` : `not found: ${missing.join(", ")}`,
			};
		}
		if (segs) {
			// compound ปน shell: ทุก segment ต้องรันได้จริง — มี shell segment ที่เครื่องมือตัดสินไม่ได้แม้แต่อันเดียว
			// ก็ไม่เดารัน (อาจพังหรือ dangerous เพราะ split ผิด semantics) → skipped ให้มนุษย์ตรวจเองทั้ง criterion
			const unrunnable = segs.find((s) => s.kind === "shell" && !isMachineCheckable(s.command));
			if (unrunnable && unrunnable.kind === "shell")
				return { id: c.id, status: "skipped" as const, detail: `segment not machine-runnable: ${unrunnable.command.slice(0, 80)} (→ human review)` };
			const details: string[] = [];
			for (const s of segs) {
				if (s.kind === "exists") {
					if (!existsSync(resolve(cwd, s.path)))
						return { id: c.id, status: "fail" as const, detail: [...details, `not found: ${s.path}`].join("; ").slice(-600) };
					details.push(`exists: ${s.path}`);
				} else {
					const r = runShellSegment(s.command, cwd, timeoutMs);
					details.push(r.detail);
					if (!r.pass)
						return {
							id: c.id,
							// segment นี้คำสั่งเสีย → ตัดสิน artifact ไม่ได้ทั้ง criterion (แม้ segment ก่อนหน้าจะผ่าน)
							status: (r.cmdErr ? "skipped" : "fail") as "skipped" | "fail",
							...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
							detail: (r.cmdErr ? `probe command error (not artifact failure, → human review): ` : "") + details.join("; ").slice(-600),
						};
				}
			}
			return { id: c.id, status: "pass" as const, exitCode: 0, detail: details.join("; ").slice(-600) };
		}
		// shell-only check (อาจมี "&&" ใน literal) — พฤติกรรมเดิม: sh -c ทั้งก้อน / skip ถ้ารันอัตโนมัติไม่ได้
		if (!isMachineCheckable(c.check)) return { id: c.id, status: "skipped" as const, detail: "not machine-runnable (→ human review)" };
		const r = runShellSegment(c.check, cwd, timeoutMs);
		return {
			id: c.id,
			status: r.pass ? ("pass" as const) : r.cmdErr ? ("skipped" as const) : ("fail" as const),
			...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
			detail: r.cmdErr ? `probe command error (not artifact failure, → human review): ${r.detail}` : r.detail,
		};
	});

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface GradeParse {
	perCriteria: Record<string, "PASS" | "FAIL">;
	evidence: Record<string, string>;
	failedIds: string[];
	missingIds: string[];      // criterion ที่ grader ไม่ได้ออก verdict — coverage โปร่ง (เดิมถูกเมินเงียบๆ)
	passNoEvidence: string[];  // PASS แต่ไม่มีหลักฐานต่อท้าย — ปิดช่อง "ตอบมั่วแบบมั่นใจ"
	overall: "PASS" | "FAIL" | null;
}

/**
 * W2: parse verdict ของ grader แบบเข้มกว่าเดิม — contract:
 *   <id>: PASS: <evidence> / <id>: FAIL: <evidence> ... บรรทัดสุดท้าย OVERALL: PASS|FAIL
 * เดิมมีรู 3 จุดที่ทำให้ "output พัง = ผ่านฟรี": id ที่ regex ไม่เจอถูกเมิน (coverage ไม่ครบ),
 * OVERALL หาย → verdict unknown ไหลเป็น PASS, PASS ไม่ต้องมีหลักฐาน — pure เพื่อ unit-test ตรงๆ
 */
export const parseGraderOutput = (output: string, criteria: Criterion[]): GradeParse => {
	const perCriteria: Record<string, "PASS" | "FAIL"> = {};
	const evidence: Record<string, string> = {};
	for (const c of criteria) {
		// NB: ใช้ [ \t] ไม่ใช่ \s หลัง verdict — \s กินขึ้นบรรทัดใหม่ทำให้ evidence ลากไปเอาบรรทัดถัดไป
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

/** W2/W3: prompt ของ grader — evidence-anchored contract + probe results (harness รันเอง = ground truth)
 *  + diff จริง + reward-hacking checklist + แจ้งชัดว่า read-only — pure builder เพื่อ test/reuse */
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

const REVIEW_SECTIONS = ["TL;DR", "Intent vs Implementation", "Risks", "Rollback", "Human actions"] as const;

export interface PacketParse {
	ok: boolean;
	missing: string[];
	tldr: string;
}

/** W2: validate reviewer packet ตาม schema ตายตัว — ตอนเก่า slice ดิบ 900 ตัวอักษร
 *  packet ที่ไม่มี TL;DR เลยก็ผ่านเงียบๆ. ok เมื่อครบทุก section; missing ใช้เป็น feedback ตอน retry */
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

/** eval evidence นี้เป็นของรอบปัจจุบันหรือไม่ — stale เมื่อ spec version เปลี่ยน หรือ tree ที่ eval ไม่ตรง tree ที่กำลัง review
 *  (ใช้ tree SHA ไม่ใช่ commit SHA โดยตั้งใจ: merge-back --no-ff หลัง eval PASS ให้ tree เดิมเป๊ะ → ไม่ทำให้รอบปกติ stale ปลอม)
 *  current ไม่ส่งมา (legacy callsite) → ไม่เช็ค เพื่อ backward compat */
export const isLastEvalStale = (
	lastEval: { specVersion?: number; head?: string } | undefined,
	current: { specVersion?: number; head?: string } | undefined,
): boolean => {
	if (!lastEval || !current) return false;
	if (current.specVersion !== undefined && lastEval.specVersion !== current.specVersion) return true;
	if (current.head !== undefined && lastEval.head !== current.head) return true;
	return false;
};

/** W2: evidence pack ของ reviewer — packet ต้อง facts-grounded ไม่ใช่เดาจาก intent
 *  (เหตุการณ์จริงก่อนอัปเกรด: packet เขียน \"To be implemented\" ทั้งที่งานเสร็จแล้ว เพราะ prompt มีแค่ intent บรรทัดเดียว)
 *  evidence ต้องเป็นของรอบปัจจุบันเท่านั้น: git summary ถูก scope ด้วย baseline ที่ caller + lastEval ที่ไม่ตรง
 *  spec version/tree ตอน review (freshness) ถูกตัดทิ้งพร้อมคำเตือน — reviewer ห้ามตัดสินจาก evidence เก่า */
export const buildReviewerPrompt = (
	intent: string,
	lastEval: { verdict?: string; perCriteria?: Record<string, string>; failedIds?: string[]; probes?: ProbeResult[]; specVersion?: number; head?: string } | undefined,
	flags: string[],
	specDebt: string[],
	escalations: { kind: string; detail: string }[],
	gitSummary: string,
	feedback: string,
	freshness?: { specVersion?: number; head?: string }, // spec version + tree SHA (HEAD^{tree}) ของ tree ที่กำลัง review
): string => {
	const stale = isLastEvalStale(lastEval, freshness);
	const ev = stale ? undefined : lastEval;
	return `You are the REVIEWER sub-agent. The work is DONE and already machine-graded — ground every statement in the evidence below; never write \"to be implemented\".\n\n` +
	`Evidence:\n- Intent: ${intent}\n- Eval verdict: ${ev?.verdict ?? "(no eval record)"}` +
	(stale ? `\n- ⚠️ STALE eval evidence withheld: the stored zense_eval result belongs to an older spec version (v${lastEval?.specVersion ?? "?"}) or tree (${lastEval?.head?.slice(0, 8) ?? "?"}) — re-run zense_eval before trusting any eval verdict.` : "") +
	(ev?.perCriteria && Object.keys(ev.perCriteria).length
		? `\n- Per-criteria verdicts: ${Object.entries(ev.perCriteria).map(([id, v]) => `${id}=${v}`).join(", ")}`
		: "") +
	(ev?.probes?.length ? `\n- Probe results (harness-executed): ${ev.probes.map((p) => `${p.id}:${p.status}`).join(", ")}` : "") +
	`\n- Trajectory flags: ${flags.length ? flags.join(" | ") : "(none)"}` +
	`\n- Spec debt (human-verified): ${specDebt.length ? specDebt.join(" | ") : "(none)"}` +
	`\n- Escalations: ${escalations.length ? escalations.map((e) => `${e.kind}: ${e.detail.slice(0, 80)}`).join(" | ") : "(none)"}` +
	(gitSummary ? `\n- Git evidence:\n${gitSummary}` : "") +
	`\n\nProduce an incident-report-style review packet with EXACTLY these section headers (one per line):\n` +
	`## TL;DR\n(max 3 lines — the 90-second answer for a human deciding whether to deploy)\n` +
	`## Intent vs Implementation\n## Risks\n(name up to 3 spots the human MUST eyeball, as file:line where possible)\n` +
	`## Rollback\n(concrete commands, e.g. git revert <hash> / files to restore — no vague advice)\n` +
	`## Human actions\n(follow-ups only a human can do: spec debt, unanswered questions)\n` +
	`Do NOT dump raw diffs; summarize. No commentary outside the sections.` +
	(feedback ? `\n\nSYSTEM FEEDBACK: previous packet was missing sections: ${feedback}. Output the full packet with all headers.` : "");
};

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
	excludeTools?: string[],         // C: role read-only (requirements) → ["write","edit"] (ดู SUBAGENT_EXCLUDE_TOOLS)
): Promise<{ ok: boolean; output: string; logPath: string; usedModel?: string }> {
	const relLog = relative(cwd, logPath);
	return new Promise((res) => {
		const argv = buildSubagentArgv(task, modelPattern, excludeTools);
		writeFileSync(logPath, `$ pi --mode json --no-session${excludeTools?.length ? ` --exclude-tools ${excludeTools.join(",")}` : ""}${modelPattern ? ` --model ${modelPattern}` : ""} <task ${task.length} chars>\n--- live output (${role}) ---\n`);
		const child = spawn("env", argv, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let usedModel: string | undefined; // 'provider/id' ของ assistant message แรก — ใช้เทียบ model ที่ config ไว้
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
					// json mode แนบ message บน top-level field (pi dist/modes/json-event.js — เฉพาะ update events เท่านั้น
					// ที่ถูกห่อเป็น assistantMessageEvent; โค้ดเดิมอ่านผิด field ทำให้ finalText/usedModel ไม่เคยถูกจับ
					// → output หล่นเป็น raw tail ที่มี tool-noise ปน = สาเหตุ compile_spec parse draft ไม่เจอบางรอบ)
					type JsonMsg = { role?: string; provider?: string; model?: string; content?: { type?: string; text?: string }[] };
					const boxed = ev as { message?: JsonMsg; assistantMessageEvent?: JsonMsg };
					const msg = boxed.message ?? boxed.assistantMessageEvent;
					if (!usedModel && msg?.role === "assistant" && typeof msg.provider === "string" && typeof msg.model === "string")
						usedModel = `${msg.provider}/${msg.model}`;
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
			appendFileSync(logPath, `--- used model: ${usedModel ?? "(not captured from events)"} ---\n`);
			const modelInfo = usedModel !== undefined ? { usedModel } : {};
			if (code === 0 && !signal) res({ ok: true, output: (finalText || out).slice(-16_000), logPath, ...modelInfo });
			else
				res({
					ok: false,
					output:
						`sub-agent exited code=${code} signal=${signal}${timedOut ? ` (TIMEOUT ${timeoutMs / 1000}s)` : ""}\n` +
						`last output:\n${out.slice(-4_000)}\n(full log: ${relLog})`,
					logPath,
					...modelInfo,
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
 * อ่าน .zense/models.json — map role → pi --model pattern (เช่น "anthropic/claude-sonnet",
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
 * Resolve model pattern สำหรับ role ตามลำดับ: .zense/models.json[role] →
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
 * เขียน/ลบ model override ของ role หนึ่งใน .zense/models.json — สร้าง dir ให้ถ้ายังไม่มี,
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

	/** fullscreen default ให้คนติดตั้ง pi-zense โดยไม่ต้อง setup เอง: ตั้งครั้งเดียวต่อ file-ตอน key ยังว่าง
	 *  interactive TUI เท่านั้น (sub-agent bail ตั้งแต่ต้น factory ด้วย PI_ZENSE_SUBAGENT แล้ว) — best-effort,
	 *  ห้ามให้ startup ของ harness พังเพราะเขียน settings ไม่ได้ */
	const ensureFullscreenDefault = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		try {
			const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
			const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
			const merged = applyFullscreenDefault(raw);
			if (!merged || !merged.changed) return; // null=ไฟล์เดิมเสีย (ข้าม), !changed=user เลือกเองแล้ว (respect)
			mkdirSync(dirname(settingsPath), { recursive: true });
			writeFileSync(settingsPath, merged.text);
			learn(ctx, "fullscreen default: tuiMode=fullscreen (install default — มีผล pi ครั้งถัดไป)");
			ctx.ui.notify(
				"🖥 zense: ตั้ง fullscreen TUI mode เป็น default ใน ~/.pi/agent/settings.json แล้ว — มีผล pi ครั้งถัดไป (สลับ session นี้ทันที: /settings → TUI mode; ไม่ต้องการ: เปลี่ยนค่า tuiMode ในไฟล์เดียวกัน)",
				"info",
			);
		} catch {
			/* best-effort */
		}
	};

	pi.on("session_start", async (_ev, ctx) => {
		ensureFullscreenDefault(ctx);
		for (const e of ctx.sessionManager.getEntries())
			if (e.type === "custom" && e.customType === "zense-state")
				state = { ...freshState(), ...(e.data as State) };
		lastWidget = undefined; // pi ล้าง widget ตอน session switch/reload → ต้องส่งใหม่แม้ข้อความเดิม
		updateWidget(ctx);
	});

	const activeRun = (): SubagentRun | undefined => {
		for (let i = state.subagentRuns.length - 1; i >= 0; i--) if (state.subagentRuns[i].status === "running") return state.subagentRuns[i];
		return undefined;
	};

	/** cache ข้อความ widget ล่าสุดที่ส่งจริง — setWidget สร้าง Text/Container ใหม่ทุกครั้ง
	 *  แม้เนื้อหาเหมือนเดิม ทำให้ dock ใต้ transcript relayout ซ้ำๆ ตอน sub-agent รัน (tick 2s
	 *  + hook ต่างๆ เรียก updateWidget ถี่) → view กระตุก/เด้ง. dedupe ที่ระดับ string:
	 *  ส่ง setWidget เฉพาะตอนข้อความเปลี่ยนจริงเท่านั้น (fields ยังครบเหมือนเดิม ไม่ truncate). */
	let lastWidget: string | undefined;

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const s = state.spec;
		const run = activeRun();
		const line =
			`ZENSE ▸ ${state.phase.toUpperCase()} · spec: ${s ? (s.approved ? "✅v" + s.version : "⏳unapproved") : "—"}` +
			` · turns ${state.turnsUsed} · tok ${fmtTok(state.tokensUsed)}` +
			(run ? ` · 🧪 ${run.role} ▶ ${Math.round((Date.now() - (run.startedAt ?? run.at)) / 1000)}s (alt+z ดูสด)` : "") +
			(state.worktree ? ` · 🌳 ${basename(state.worktree.root)}` : "") +
			(state.trajectoryFlags.length ? ` · ⚠ ${state.trajectoryFlags.length} traj-flags` : "") +
			(state.escalations.length ? ` · 🚨 ${state.escalations.length}` : "");
		if (line === lastWidget) return; // เนื้อหาเดิม → ไม่ rebuild component (กัน dock relayout)
		lastWidget = line;
		ctx.ui.setWidget("zense", [line]);
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
	 *  model ของ sub-agent: resolve ตาม role จาก .zense/models.json, ถ้าไม่มี entry ใช้ model
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
			// C: role ถูกล็อก read-only (SUBAGENT_EXCLUDE_TOOLS) → sub-agent ร่าง spec/อ่าน repo ได้แต่แก้โค้ดไม่ได้
			const r = await runSubagent(role, task, subCwd, 240_000, onChunk, logPath, modelPattern, SUBAGENT_EXCLUDE_TOOLS[role]);
			run.ok = r.ok;
			run.summary = r.output.slice(0, 300);
			run.status = r.ok ? "done" : "failed";
			if (r.usedModel) run.model = r.usedModel;
			// verify model ที่รันจริงตรง config — pi fallback ไป default เงียบๆ ได้เมื่อ pattern resolve ไม่ได้
			// (provider/id ไม่รู้จัก → ไม่มี error, หล่นไป saved default = มักเป็น model ของ agent หลัก)
			if (modelPattern && r.usedModel && !modelMatchesPattern(r.usedModel, modelPattern)) {
				learn(ctx, `sub-agent model mismatch: ${role} requested ${modelPattern} but ran ${r.usedModel}`);
				ctx.ui.notify(`⚠ sub-agent model mismatch: ${role} — config ขอ "${modelPattern}" แต่รันจริง "${r.usedModel}" (pi fallback? ตรวจ .zense/models.json / /zense models)`, "warning");
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
		// gate ปิด → ข้าม gate/scope/ADR แต่ยัง redirect เข้า worktree (ถ้า active)
		if (!state.gateEnabled) { applyRedirect(ev, ctx); return; }
		const isWrite = ev.toolName === "write" || ev.toolName === "edit";
		// read/bash: ไม่ผ่าน gate/scope (write-only) — แค่ redirect ถ้ามี worktree แล้วจบ
		if (!isWrite) { applyRedirect(ev, ctx); return; }

		if (state.phase === "requirements" || !state.spec?.approved) {
			if (!ctx.hasUI) {
				escalate("need-permission", "write blocked: spec unsigned (no UI)", ctx);
				// no-spec = approve ใช้ไม่ได้ตั้งแต่ต้น → สั่ง agent commit spec ก่อน อย่าชี้ไป /zense approve
				return { block: true, reason: state.spec
					? "Zense gate: spec ยังไม่ได้เซ็น — ให้ user เซ็นผ่าน dialog ครั้งต่อไปหรือ /zense approve ก่อน"
					: "Zense gate: ยังไม่มี spec ในระบบเลย — เรียก zense_spec (แนะนำ action=compile_spec) เพื่อ commit spec ก่อน แล้ว user จะเซ็นจาก dialog ทันที; spec ในแชทไม่ถือว่ามี spec" };
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
					`Zense gate: ${ev.toolName} จะเขียนโค้ดทั้งที่ spec ยังไม่ได้เซ็น${s ? ` (v${s.version}: ${s.title} — อ่านเต็มที่ .zense/spec.md)` : " (ยังไม่มี spec)"}`,
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
				// H: spec ที่ compile จาก sub-agent แล้วยังถูก override โดยไม่เซ็น = สัญญาณคุณภาพ draft
				//    → log เด่นๆ เป็น lesson ให้ compile รอบหน้า reflect (loop H ปิดตรงนี้)
				if (state.specSource === "compile" && state.spec)
					learn(ctx, `flag: compiled spec v${state.spec.version} overridden unsigned (${ev.toolName})`);
				ctx.ui.notify("⚠ override โดยไม่เซ็น spec — เพิ่ม trajectory flag", "warning");
			} else {
				escalate("need-permission", "write blocked: spec unsigned", ctx);
				return { block: true, reason: state.spec
					? "Zense gate: spec ยังไม่ได้เซ็น — เลือก 🔏 เซ็นจาก dialog ครั้งหน้า หรือให้ user รัน /zense approve"
					: "Zense gate: ยังไม่มี spec ในระบบเลย — เรียก zense_spec (แนะนำ action=compile_spec) เพื่อ commit spec ก่อน แล้ว user จะเซ็นจาก dialog ทันที; การวาง spec ในแชทไม่ทำให้ approve อะไรได้" };
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

	// dialogs ของ zense render เป็น overlay ลอยทับ transcript แทนการ render inline ก่อเต็มจอ —
	// ปิดแล้วกลับไปเห็น context เดิมทันที (กไก่ pi: ctx.ui.custom({ overlay: true, overlayOptions }))
	const OVERLAY_LG = { overlay: true, overlayOptions: { width: "92%", minWidth: 60, maxHeight: "85%" } } as const; // spec sign dialog (ต้องอ่าน spec ยาว)
	const OVERLAY_MD = { overlay: true, overlayOptions: { width: "80%", minWidth: 56, maxHeight: "80%" } } as const; // pickers กลาง
	const OVERLAY_XL = { overlay: true, overlayOptions: { width: "95%", minWidth: 60, maxHeight: "90%" } } as const; // live tail

	/** scroll key-map เดียวใช้ร่วมทุก dialog (spec sign / live tail) — ห้าม duplicate ไปคนละชุดเดี๋ยว drift:
	 *  ↑/↓ ทีละบรรทัด, ←/→ ทีละหน้า, g = บนสุด, G = ล่างสุด (printable เดี่ยว กดได้แน่ทุก terminal ไม่ชน fn-key ของ Mac)
	 *  ไม่มี Ctrl chord ตาม spec v3 — เลือกชุดสั้นสุดที่ทำงานตรงกันทั้งสอง dialog */
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
			let lines: string[] = [];
			let cachedWidth = -1;
			let offset = 0;
			// ความสูงเนื้อ spec: ใช้พื้นที่ terminal ได้เต็ม overlay (85% ของ rows ตาม OVERLAY_LG)
			// reserve 9 บรรทัดสำหรับ border/title/hint/range/option ≤3 บรรทัด/bottomHint — ถ้าเกิน maxHeight
			// ของ overlay จะถูก clip (จูน reserve กับ maxHeight คู่กันเสมอ)
			const bodyRows = () => Math.max(4, Math.floor(tui.terminal.rows * 0.85) - 9);
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
							? `— spec lines ${offset + 1}-${Math.min(offset + h, lines.length)}/${lines.length} —`
							: `— spec ครบทุกบรรทัด (${lines.length} lines) —`;
					out.push(...new Text(theme.fg("dim", range), 1, 0).render(w));
					// action เป็น hotkey ตรง (ไม่ใช่ SelectList) — arrows เลยว่างไว้เลื่อนอ่าน spec:
					//   y = item แรก (🔏 เซ็น) / o = item กลาง (⚠️ override — มีเฉพาะ gate dialog 3 ตัวเลือก) / n,Esc = ตัวสุดท้ายหรือยกเลิก
					out.push(`  ${theme.fg("accent", theme.bold(`[y] ${items[0].label}`))}`);
					if (items.length > 2) out.push(`  ${theme.fg("muted", `[o] ${items[1].label}`)}`);
					const nLabel = (items.length > 2 ? items[2] : items[1])?.label ?? "ตัดสินใจทีหลัง";
					out.push(`  ${theme.fg("muted", `[n] ${nLabel}`)}`);
					out.push(...new Text(theme.fg("dim", "↑↓ เลื่อนทีละบรรทัด • ←→ ทีละหน้า • g บนสุด • G ล่างสุด"), 1, 0).render(w));
					out.push(...border.render(w));
					return out;
				},
				invalidate: () => {
					cachedWidth = -1;
				},
				handleInput: (data: string) => {
					// hotkey ตรงแทน ↑↓+Enter: y เซ็น / o override (gate dialog เท่านั้น) / n,Esc ทีหลัง —
					// ค่าที่ done() ต้องเหมือนเดิมทุก callsite (gate/approve flow อ่าน 'sign'/'override'/null)
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
		}, OVERLAY_LG);

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
		}, OVERLAY_MD);

	// ----- live sub-agent observability: ดู output สดระหว่างรัน (กันลังเลว่าค้างหรือเปล่า)

	const tailViewer = (ctx: ExtensionContext, run: SubagentRun): Promise<null> =>
		ctx.ui.custom<null>((tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const tick = setInterval(() => tui.requestRender(), 1_000); // auto-refresh ทุก 1s
			// wrap log เต็มไฟล์ด้วย wrapTextWithAnsi (รักษา ANSI) แทน truncate — บรรทัดยาวอ่านครบ ไม่โดนตัดเป็น "…"
			// cache ตาม (width,size,mtime) — log ใหญ่จะได้ไม่ wrap ใหม่ทุก frame (refresh 1s)
			let cacheKey = "";
			let wrapped: string[] = [];
			let offset = 0;
			let follow = true; // default ติดท้าย log เหมือนพฤติกรรมเดิม — scroll ขึ้น = pause, ถึงล่างสุด = ตามต่อ
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
					// 90% ของ rows ตาม OVERLAY_XL − 6 บรรทัดหัว/tail/border — กัน clip ตอน render เป็น overlay
					const h = rows();
					if (follow) offset = maxOffset(); // ติดท้ายเสมอจนกว่า user จะเลื่อนขึ้น
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
					for (let i = slice.length; i < h; i++) out.push(""); // ความสูงนิ่งเหมือน spec sign dialog
					const range = follow
						? "▶ tail (ติดตามท้าย log)"
						: `⏸ lines ${offset + 1}-${Math.min(offset + h, lines.length)}/${lines.length} — กด G กลับไปติดตาม`;
					out.push(...new Text(theme.fg("dim", range), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", "auto refresh 1s • ↑↓ เลื่อน • ←→ หน้า • g/G บนสุด/ล่างสุด • Esc ปิด (sub-agent ยังรันต่อ)"), 1, 0).render(w));
					out.push(...border.render(w));
					return out;
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { done(null); return; }
					const act = scrollKeyAction(data);
					if (act === "top") { offset = 0; follow = false; }
					else if (act === "bottom") { follow = true; offset = maxOffset(); }
					else if (act) {
						if (act.dir < 0) follow = false; // เลื่อนขึ้น = หยุดติดตาม
						offset = Math.max(0, Math.min(maxOffset(), offset + act.dir * (act.page ? rows() : 1)));
						if (offset >= maxOffset()) follow = true; // เลื่อนลงถึงล่างสุด = ติดตามต่อ
					}
					tui.requestRender();
				},
				dispose: () => clearInterval(tick),
			};
		}, OVERLAY_XL);

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
		}, OVERLAY_MD);
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
		// git-evidence baseline ของรอบนี้: HEAD ของ main repo ก่อนสร้าง worktree (best-effort — ไม่ใช่ repo ก็ปล่อย undefined)
		{
			const baseRef = gitOk(["rev-parse", "HEAD"], ctx.cwd);
			state.baselineHead = baseRef.ok ? baseRef.out.trim() : undefined;
		}
		// auto worktree-per-session: สร้าง worktree ของ session นี้ตอนเริ่ม implementation
		// (ก่อนหน้านี้ไม่มี source write เพราะ gate กั้น) → redirect ทุก tool call เข้า worktree จนกว่า eval PASS
		// reuse ของเดิมถ้ายังอยู่: เซ็น spec version ใหม่กลาง implement ต้องไม่ทำให้งานค้างใน worktree เก่าหลุด
		// (branch name จะติดเลข version เก่า — cosmetic เท่านั้น merge message ใช้ spec.version ปัจจุบันอยู่แล้ว)
		if (canReuseWorktree(state.worktree)) {
			learn(ctx, `worktree reused: ${state.worktree!.branch} สำหรับ spec v${state.spec.version}`);
		} else {
			const wt = createWorktree(ctx.cwd, state.spec);
			if (wt) {
				state.worktree = wt;
				state.worktreeLeaveNotified = false;
				learn(ctx, `worktree created: ${wt.branch} @ ${wt.root}`);
			} else {
				ctx.ui.notify(`🌳 worktree สร้างไม่ได้ — ทำงานใน main ตามปกติ (ไม่มี isolation ระหว่าง session)`, "warning");
			}
		}
		learn(ctx, `signed spec v${state.spec.version}`);
		persist();
		updateWidget(ctx);
		ctx.ui.notify(`🔏 Spec v${state.spec.version} signed — implementation gate open.`, "info");
		return true;
	};

	/** B: commit spec ในขั้นตอนเดียว — version ใหม่ + archive append-only ลง specs/ + latest copies +
	 *  เด้ง sign dialog ทันที. helper เดียวใช้ร่วมทั้ง action=set (agent เขียนเอง) และ compile_spec
	 *  (sub-agent ดราฟต์) — สองทาง behavior เหมือนกันเป๊ะ ไม่ diverge เวลาแก้ทีหลัง */
	const commitSpec = async (
		ctx: ExtensionContext,
		fields: { title?: string; intent?: string; approach?: string[]; scope?: string[]; constraints?: string[]; criteria?: Criterion[]; specDebt?: string[] },
		source: "set" | "compile",
	): Promise<{ version: number; signed: boolean; mdPath: string }> => {
		const version = (state.spec?.version ?? 0) + 1;
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
		state.specSource = source; // H: จำที่มาของ spec — ใช้ telemetry ตอน gate override
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
				`🔏 เซ็น Spec v${version}: ${state.spec.title}? (อ่านเต็มที่ .zense/spec.md)`,
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
		return { version, signed, mdPath };
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
						check: Type.String({ description: "How eval verifies it: bash probe, path exists, manual" }),
					}),
				),
			),
			specDebt: Type.Optional(Type.Array(Type.String(), { description: "Unverifiable → forced human review" })),
			title: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _sig, _on, ctx) {
			if (params.action === "compile_spec") {
				if (!params.intent?.trim())
					return { content: [{ type: "text", text: "compile_spec ต้องการ intent — ส่งสรุป request ของผู้ใช้มาใน intent แล้วเรียกใหม่" }], details: {}, isError: true };
				const t0 = Date.now();
				// Layer 3 (learning loop): ป้อนบทเรียนสะสมจาก memory.jsonl เข้า prompt เหมือนเดิม
				// ให้ spec ใหม่สะท้อน incident เก่า เช่น scope เคยกว้างเกิน/เคย override บ่อย
				const lessons = memorySummaryLines(ctx.cwd);
				state.lastCompileLessons = lessons.length ? aggregateMemory(ctx.cwd).total : 0;
				// W3: context priming + few-shot exemplar — harness เตรียมหลักฐาน/ตัวอย่างให้เลย
				// ไม่ปล่อยให้ขึ้นกับว่า model จะexploreเองไหม (prompt สั่งได้แค่ชั้นเดียว)
				const facts = gatherRepoFacts(ctx.cwd);
				const exemplar = loadSpecExemplar(ctx.cwd);
				let intent = params.intent.trim();
				let launches = 0;
				let clarifyRounds = 0;      // F: รอบถาม-ตอบกับมนุษย์ (max 2)
				let parseRetried = false;   // A: retry ตอน JSON invalid ได้ 1 ครั้ง
				let clarifyClosed = false;  // คำถามถูกโยนลง specDebt แล้ว — ห้าม clarify ซ้ำ (กันลูปไม่รู้จบ)
				// ลูปเดียวจัดการทั้ง clarify (F) และ parse-retry (A) — budget รวม 4 launches กันลูปพัง
				while (launches < 4) {
					launches++;
					const draft = await launchSubagent(ctx, "requirements", buildRequirementsPrompt(intent, lessons, facts, exemplar));
					if (!draft.ok) return { content: [{ type: "text", text: `sub-agent failed: ${draft.output}` }], details: draft };
					const parsed = parseSpecDraft(draft.output);
					if (parsed.kind === "clarify" && !clarifyClosed && clarifyRounds < 2 && ctx.hasUI) {
						// F: ถามมนุษย์ทีละข้อ (Esc/เว้นว่าง = ข้าม) — คำถามที่ไม่ได้คำตอบโยนลง specDebt แล้วดราฟต์ต่อแบบ conservative
						clarifyRounds++;
						learn(ctx, `spec-draft: clarify round ${clarifyRounds} — ${parsed.questions.length} questions`);
						const answers: string[] = [];
						for (const q of parsed.questions) {
							const a = await ctx.ui.input(`❓ requirements ถาม: ${q}`, "(ตอบสั้นๆ ได้ — Esc/ว่าง = ข้าม)");
							if (a === undefined) break;
							if (a.trim()) answers.push(`- Q: ${q}\n  A: ${a.trim()}`);
						}
						const unanswered = parsed.questions.slice(answers.length);
						if (answers.length) intent += `\n\nHuman clarifications (authoritative — refine the request accordingly):\n${answers.join("\n")}`;
						if (unanswered.length) {
							clarifyClosed = true;
							intent += `\n\nUnanswered clarifying questions — list them in specDebt and proceed with conservative, explicit assumptions:\n${unanswered.map((q) => `- ${q}`).join("\n")}`;
						}
						continue;
					}
					if (parsed.kind === "clarify") {
						// ถามมนุษย์ไม่ได้จริงๆ (ไม่มี UI / ครบรอบ / ถูกข้าม) — โยนคำถามลง specDebt ให้ดราฟต์ต่อแบบ conservative
						clarifyClosed = true;
						learn(ctx, `spec-draft: clarify forfeited (${!ctx.hasUI ? "no UI" : "rounds exhausted"}) — questions → specDebt`);
						intent += `\n\nClarifying questions that could NOT be asked — list them in specDebt and draft the spec with conservative, explicit assumptions:\n${parsed.questions.map((q) => `- ${q}`).join("\n")}`;
						continue;
					}
					if (parsed.kind === "error") {
						// A: retry 1 ครั้งพร้อม feedback ที่เจาะจง — model แก้ output ตาม error ได้แม่นกว่าสั่งซ้ำเปล่าๆ
						if (!parseRetried) {
							parseRetried = true;
							learn(ctx, `spec-draft: JSON invalid — retry พร้อม feedback (${parsed.error.slice(0, 120)})`);
							intent += `\n\nSYSTEM FEEDBACK: your previous output failed validation: ${parsed.error}. Return ONLY the corrected JSON object under the same rules — no fences, no commentary.`;
							continue;
						}
						learn(ctx, `spec-draft: JSON invalid after retry — คืน raw draft ให้ agent หลักจัดการเอง (legacy path)`);
						return { content: [{ type: "text", text: `draft validation failed (${parsed.error}) — raw output:\n${draft.output}` }], details: draft };
					}
					// G: quality gate ฝั่ง harness ก่อน commit (scope ว่าง / check รันไม่ได้ / ซ้ำของเก่า → specDebt)
					const gated = applyQualityGate(ctx.cwd, parsed.draft);
					if (gated.notes.length) learn(ctx, `spec-draft: quality-gate → ${gated.notes.join(", ")}`);
					// B: parse ผ่าน → commit + เด้ง sign dialog ในขั้นตอนเดียว (ตัด round-trip action=set)
					const r = await commitSpec(ctx, gated.draft, "compile");
					// H: telemetry สรุป 1 บรรทัดต่อ compile — loop เรียนรู้เองได้ว่าช้าไหม/ถามกี่รอบ/gate เจออะไร
					learn(ctx, `spec-compile: v${r.version} launches=${launches} clarify=${clarifyRounds} gate=[${gated.notes.join(",")}] ${Date.now() - t0}ms signed=${r.signed}`);
					const verb = r.signed
						? "SIGNED 🔏 — ลายเซ็นมนุษย์ครบแล้ว, implementation gate open"
						: "NOT approved — เซ็นทีหลังด้วย /zense approve";
					return {
						content: [{ type: "text", text: `Spec v${r.version} compiled by requirements sub-agent → committed one-step, archived at ${r.mdPath} (latest copies: .zense/spec.{json,md}). ${verb}.${clarifyRounds ? ` clarify rounds: ${clarifyRounds}.` : ""}${gated.notes.length ? ` quality-gate: ${gated.notes.join(", ")} (รายละเอียดใน specDebt).` : ""}` }],
						details: { version: r.version, approved: r.signed, clarifyRounds, qualityGate: gated.notes, logPath: draft.logPath },
					};
				}
				return { content: [{ type: "text", text: `compile_spec ใช้ครบ ${launches} launches แล้วยังได้แต่ clarify/error — ระบุ intent ให้ชัดขึ้นแล้วเรียกใหม่` }], details: {}, isError: true };
			}
			// action=set: agent เขียน spec เองแล้ว commit — commitSpec เดียวกับ compile (B) → behavior เหมือนกันเป๊ะ
			const r = await commitSpec(ctx, params, "set");
			const verb = r.signed
				? "SIGNED 🔏 — ลายเซ็นมนุษย์ครบแล้ว, implementation gate open"
				: "NOT approved — เซ็นทีหลังด้วย /zense approve";
			return {
				content: [{ type: "text", text: `Spec v${r.version} archived at ${r.mdPath} (latest copies: .zense/spec.{json,md}). ${verb}.` }],
				details: { version: r.version, approved: r.signed },
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
			onUpdate?.({ content: [{ type: "text", text: "running probes + grader sub-agent…" }], details: {} });
			// W3: probes — harness รัน criteria[].check เองก่อน (deterministic) เป็น ground truth ให้ grader
			// และทับ verdict ทีหลัง (probe primacy). รันใน worktree ถ้ามี (โค้ดที่แก้จริง) ไม่งั้น main
			const evalRoot = state.worktree?.root ?? ctx.cwd;
			const probes = runCheckProbes(evalRoot, state.spec.criteria);
			const probeSummary = probes.map((p) => `${p.id}:${p.status}`).join(",");
			learn(ctx, `eval-probes: spec v${state.spec.version} → ${probeSummary}`);
			const diffSummary = gitChangeSummary(evalRoot, state.baselineHead);
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
			// W2: retry loop (budget 3 launches) — output ผิด contract (ครบทุก id ไหม / มี OVERALL ไหม /
			// PASS ทุกอันมี evidence ไหม) → ส่ง feedback เจาะจงกลับให้แก้ตัว แทน parse ครั้งเดียวแล้วเมินส่วนที่หาย
			// (bug เก่าที่เจอตอน refactor: regex per-criteria เดิมเขียน `\b` ใน template literal → ถูก materialize
			//  เป็น backspace byte ในไฟล์เลย → parse ไม่เคยเจอ verdict รายตัวมาก่อน ระบบพึ่ง OVERALL บรรทัดเดียว!)
			let parsed: GradeParse | null = null;
			let grade: { ok: boolean; output: string; logPath: string } = { ok: false, output: "(not launched)", logPath: "" };
			let feedback = "";
			for (let launch = 0; launch < 3; launch++) {
				grade = await launchSubagent(ctx, "grader", buildGraderPrompt(state.spec, probes, diffSummary, feedback), streamTail);
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
			// W2 (G): inconclusive — เดิม "unknown ไหลเป็น PASS เงียบๆ" (= merge เข้า main ฟรี) → ตอนนี้ escalate
			// ให้มนุษย์ตัดสินแทน พร้อม probe results (หลักฐานแข็งที่มีแน่ๆ) และทางออกที่ไม่ตัน loop (eval ซ้ำได้)
			if (!grade.ok || !parsed || !parsed.overall) {
				const reason = !grade.ok ? "grader sub-agent failed" : "grader output invalid after retries";
				escalate("need-decision", `eval inconclusive: ${reason} — มนุษย์ตัดสินจาก probes เองหรือสั่ง eval ใหม่`, ctx);
				learn(ctx, `eval: spec v${state.spec.version} → inconclusive (${reason})`);
				persist(); updateWidget(ctx);
				return {
					content: [{ type: "text", text: `⚠️ Eval INCONCLUSIVE — ${reason}\nprobes (harness-executed, authoritative): ${probeSummary}\n${grade.output.slice(-3_000)}\n\nตัดสินไม่ได้อย่างน่าเชื่อถือ: ให้มนุษย์ดู probe results ข้างบนแล้วตัดสินเอง (escalation need-decision ถูกบันทึกแล้ว — /zense status) หรือสั่งเรียก zense_eval อีกครั้ง` }],
					details: { inconclusive: true, reason, probes },
					isError: true,
				};
			}
			// W3: probe primacy — probe fail = criterion FAIL ทับ verdict ของ grader
			// (probe คือสิ่งที่ harness รันเอง; grader ให้ PASS ทั้งที่ probe แดง = เชื่อไม่ได้/โดนหลอก)
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
			// section เดียวใช้ร่วมทั้ง FAIL/PASS/deadlock — แสดงหลักฐานที่ harness รันเองเสมอ
			// (เดิม tool result มีแต่ output ดิบของ grader ที่อาจโดน probe primacy ทับแล้ว → header ขัดกับ body, agent เดาสาเหตุ FAIL ผิด)
			const probeSection =
				`\n\n## Probes (harness-executed, authoritative)\n` +
				probes
					.map((p) => `- ${p.id}: ${p.status}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ""} — ${p.detail.split("\n")[0].slice(0, 200)}`)
					.join("\n");
			learn(ctx, `eval: spec v${state.spec.version} → grader.ok=${grade.ok} verdict=${verdict} judged=${Object.keys(parsed.perCriteria).length}/${state.spec.criteria.length} failed=[${failedCriteria.join(",")}]${probeOverrides.length ? ` probeOverrides=[${probeOverrides.join(",")}]` : ""}`);
			// W2: เก็บ evidence ไว้เป็น input ของ reviewer (zense_review สร้าง evidence pack จาก lastEval)
			// ผูก evidence กับรอบปัจจุบัน: specVersion + tree SHA ของ tree ที่ eval (HEAD^{tree} — ตั้งใจใช้ tree ไม่ใช่ commit SHA
		// เพราะ merge-back --no-ff ให้ tree เดิมเป๊ะ ไม่ควรทำให้รอบปกติกลายเป็น stale; reviewer จะเช็คซ้ำตอน review)
		const evalTree = gitOk(["rev-parse", "HEAD^{tree}"], evalRoot);
		state.lastEval = {
			verdict, perCriteria: parsed.perCriteria, failedIds: failedCriteria, probes, at: Date.now(),
			specVersion: state.spec.version,
			...(evalTree.ok ? { head: evalTree.out.trim() } : {}),
		};
			// บันทึกผล eval ลง spec .md (archive + latest copy) เป็น section ใหม่ท้ายไฟล์ (append-only, ไม่เขียนทับเนื้อเดิม)
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
				// วงจร FAIL → ส่งกลับแก้: phase กลับ implementation, escalation need-fix, return isError สั่งแก้+eval ใหม่
				state.phase = "implementation";
				// anti-loop guard: FAIL ที่เกิดจาก probe override ล้วน (grader ให้ PASS หมดแต่ harness probe แดง) ซ้ำด้วย id set
				// เดิมบน spec เวอร์ชันเดิม — agent แก้ต่อไม่ได้แล้ว (artifact ถูกตามผู้ตัดสิน แต่ check แดงซ้ำอาจมาจาก check เสีย)
				// → DEADLOCK escalate ให้มนุษย์ตัดสิน แทนส่ง "กลับไปแก้" วนไม่จบ (เคสจริง: c2-c6 override ซ้ำทุกรอบ)
				const soleOverride = failedCriteria.length > 0 && probeOverrides.length === failedCriteria.length;
				const overrideKey = [...probeOverrides].sort().join(",");
				const prevOvf = state.evalOverrideFails;
				const sameOvf = !!(prevOvf && prevOvf.specVersion === state.spec.version && [...prevOvf.ids].sort().join(",") === overrideKey);
				if (soleOverride) {
					if (sameOvf && prevOvf && prevOvf.count >= 1) {
						escalate("need-decision", `eval deadlock: probes and grader irreconcilably disagree [${overrideKey}] (spec v${state.spec.version}) — probe fail ซ้ำแต่ grader PASS หมด`, ctx);
						state.evalOverrideFails = { specVersion: state.spec.version, ids: [...probeOverrides], count: prevOvf.count + 1 };
						persist(); updateWidget(ctx);
						return {
							content: [{ type: "text", text:
								`⚠️ Eval DEADLOCK — probes and grader irreconcilably disagree (spec v${state.spec.version}; escalation need-decision ถูกบันทึกแล้ว — /zense status)\n` +
								`harness probes fail [${overrideKey}] ซ้ำ แต่ grader ให้ PASS พร้อมหลักฐานทั้งหมด — วน "กลับไปแก้" ไม่ได้ผล (ถ้า artifact ถูกแล้วจะไม่มีอะไรให้แก้)${probeSection}\n\n` +
								`มนุษย์ตัดสิน: ถ้า check command ใน spec เสีย (placeholder/path ผิด) → re-spec ด้วย zense_spec เวอร์ชันใหม่แล้วเซ็นใหม่; ถ้า artifact ผิดจริง → บอกสิ่งที่ต้องแก้โดยตรง` }],
							details: { deadlock: true, verdict, failedCriteria, probes, trajectory: state.trajectoryFlags },
							isError: true,
						};
					}
					state.evalOverrideFails = { specVersion: state.spec.version, ids: [...probeOverrides], count: sameOvf && prevOvf ? prevOvf.count + 1 : 1 };
				}
				state.escalations.push({ kind: "need-fix", detail: `criteria failed: ${failedCriteria.join(",") || "grader FAIL"}`, at: Date.now() });
				persist(); updateWidget(ctx);
				const fixMsg =
					`❌ Eval FAIL — กลับไปแก้แล้วเรียก zense_eval ใหม่ (ห้ามไป review จนกว่าจะ PASS)\n` +
					`criteria ที่ไม่ผ่าน: ${failedCriteria.length ? failedCriteria.join(", ") : "(overall FAIL — ดู grader output)"}\n` +
					(probeOverrides.length
						? `⚠ probe override → FAIL [${probeOverrides.join(", ")}]: harness รัน check เองแล้วไม่ผ่านทั้งที่ grader ให้ PASS — สาเหตุได้ 2 ทาง: (1) artifact ผิดจริง → อ่าน probe detail ด้านล่างแล้วแก้; (2) check command ใน spec เสีย (placeholder/path ผิด — แก้ artifact ยังไงก็ไม่ผ่าน) → เรียก zense_spec เวอร์ชันใหม่แก้ check แล้วเซ็นใหม่\n`
						: "\n") +
					`${grade.output}${probeSection}\n\n## Trajectory flags\n${state.trajectoryFlags.join("\n") || "(none)"}\n\n## Spec debt (needs human)\n${state.spec.specDebt.join("\n") || "(none)"}`;
				return { content: [{ type: "text", text: fixMsg }], details: { ok: grade.ok, verdict, failedCriteria, probes, trajectory: state.trajectoryFlags }, isError: true };
			}
			// PASS: เดินไป review (unknown เป็นไปไม่ได้แล้ว — inconclusive ถูกดักไป escalate ก่อนหน้านี้)
			// ต้องสั่งขั้นต่อไป explicit ในข้อความที่คืนให้ agent (เหมือน FAIL branch) —
			// ถ้าไม่เขียนบอก agent จะถือว่างานจบแล้วตอบ user ทันที ทำให้ reviewer ไม่ถูกเรียกเลย
			delete state.evalOverrideFails; // anti-loop guard: รอบจบสมบูรณ์ → ล้างตัวนับ
			const report =
				`${grade.output}${probeSection}\n\n## Trajectory flags\n${state.trajectoryFlags.join("\n") || "(none)"}\n\n## Spec debt (needs human)\n${state.spec.specDebt.join("\n") || "(none)"}` +
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
					// reviewer จะอ่าน main หลัง merge — repin lastEval.head เป็น tree ของ merge commit (เนื้อ tree เหมือนที่ eval)
					const mergedTree = gitOk(["rev-parse", "HEAD^{tree}"], ctx.cwd);
					if (mergedTree.ok && state.lastEval) state.lastEval.head = mergedTree.out.trim();
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
			// W2: evidence pack — ส่ง lastEval (verdicts+probes), flags, specDebt, escalations, git summary
			// ให้ reviewer ด้วย (เดิมมีแค่ intent บรรทัดเดียว → packet เดา/เลื่อยลอย เช่นเขียน "To be implemented" ทั้งที่งานเสร็จแล้ว)
			// evidence ต้องเป็นของรอบปัจจุบันเท่านั้น: git summary scope ด้วย baseline ตอน spec approval + lastEval ที่ไม่ตรง
			// spec version/tree ปัจจุบันถูกตัดออกจาก prompt (ดู isLastEvalStale ใน buildReviewerPrompt) แทนที่จะหลุดไปให้ตัดสินจากของเก่า
			const reviewRoot = state.worktree?.root ?? ctx.cwd;
			const headNow = gitOk(["rev-parse", "HEAD^{tree}"], reviewRoot);
			const freshness = { specVersion: state.spec?.version, ...(headNow.ok ? { head: headNow.out.trim() } : {}) };
			if (isLastEvalStale(state.lastEval, freshness))
				learn(ctx, `review: lastEval stale (spec v${state.lastEval?.specVersion ?? "?"} ≠ v${freshness.specVersion ?? "?"} หรือ tree เปลี่ยนหลัง eval) — ตัด eval evidence เก่าออกจาก reviewer prompt`);
			let packetFeedback = "";
			const packetInput = (): string =>
				buildReviewerPrompt(state.spec?.intent ?? "(no spec)", state.lastEval, state.trajectoryFlags, state.spec?.specDebt ?? [], state.escalations,
					gitChangeSummary(reviewRoot, state.baselineHead), packetFeedback, freshness);
			let reviewer = await launchSubagent(ctx, "reviewer", packetInput());
			let packetParse = parseReviewerPacket(reviewer.output);
			// A (schema): section ไม่ครบ → retry 1 ครั้งพร้อม feedback (แทน slice ดิบ 900 ตัวอักษรที่ผ่านทุกกรณี)
			if (reviewer.ok && !packetParse.ok) {
				learn(ctx, `reviewer: packet missing sections [${packetParse.missing.join(",")}] — retry`);
				packetFeedback = packetParse.missing.join(", ");
				reviewer = await launchSubagent(ctx, "reviewer", packetInput());
				packetParse = parseReviewerPacket(reviewer.output);
			}
			const packet = {
				tlDr: packetParse.ok && packetParse.tldr ? packetParse.tldr : reviewer.output.slice(0, 900),
				trajectory: state.trajectoryFlags,
				specDebt: state.spec?.specDebt ?? [],
				escalations: state.escalations,
			};
			pi.appendEntry("zense-review-packet", packet);
			learn(ctx, `review packet: flags=${packet.trajectory.length}, escalations=${packet.escalations.length}, sections-ok=${packetParse.ok}${packetParse.missing.length ? ` missing=[${packetParse.missing.join(",")}]` : ""}`);
			return { content: [{ type: "text", text: reviewer.ok ? reviewer.output.slice(0, 2_000) : `reviewer failed: ${reviewer.output}` }], details: packet };
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
				if (!state.spec)
				return ctx.ui.notify(
					"No spec to approve: ยังไม่มี spec ที่ commit เข้าระบบ — approve ใช้ได้เฉพาะ spec ที่ agent เรียก zense_spec (tool) ในเซสชันนี้เท่านั้น; spec ที่ถูก present เป็น chat text registers nothing. ขั้นถัดไป: ให้ agent เรียก zense_spec (แนะนำ action=compile_spec) แล้ว sign จาก dialog ที่เด้งขึ้น", 
					"warning",
				);
				if (ctx.mode === "tui") {
					const choice = await specSignDialog(ctx, state.spec, `เซ็น approve spec v${state.spec.version}: ${state.spec.title}?`, [
						{ value: "sign", label: "🔏 เซ็นอนุมัติ — เปิด implementation gate", description: "ลายเซ็นมนุษย์ = agent เริ่ม implement ได้" },
						{ value: "cancel", label: "ยกเลิก (ยังไม่เซ็น)", description: "spec ยังค้างไว้ — approve ใหม่ได้ทุกเมื่อ" },
					]);
					if (choice === "sign") approveCurrentSpec(ctx);
				} else {
					const ok = await ctx.ui.confirm("🔏 เซ็น approve spec?", `${state.spec.title} v${state.spec.version}\nIntent: ${state.spec.intent.slice(0, 300)}\n(อ่านเต็มที่ .zense/spec.md)`);
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
				// ดู/ตั้ง model ของ sub-agent แยกตาม role (.zense/models.json)
				const cfgPath = join(zenseDir(ctx.cwd), "models.json");
				const cfg = readModelsConfig(ctx.cwd);
				const mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no active model)";
				const roles = ["requirements", "grader", "reviewer"];
				if (ctx.mode !== "tui") {
					// non-TUI (rpc/print): แสดง summary ให้แก้เองเหมือนเดิม
					const lines = [
						`🧪 sub-agent models — config: ${existsSync(cfgPath) ? relative(ctx.cwd, cfgPath) : "(no .zense/models.json — ทุก role ใช้ model หลัก)"}`,
						`agent หลัก: ${mainModel}`,
						...roles.map((r) => `  ${r}: ${cfg[r] ? cfg[r] + " (จาก config)" : mainModel + " (fallback)"}`),
						"แก้ไขโดยสร้าง .zense/models.json เช่น { \"grader\": \"openai/gpt-4o-mini\" } — หรือเปิด TUI แล้ว /zense models เพื่อเลือกแบบ interactive",
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
		return `# Spec v${s.version}: ${s.title}\napproved: ${s.approved}\n\n## Intent\n${s.intent}\n\n${s.approach?.length ? "## Approach\n" + s.approach.map((x) => `- ${x}`).join("\n") + "\n\n" : ""}## Scope\n${s.scope.map((x) => `- ${x}`).join("\n")}\n\n## Constraints\n${s.constraints.map((x) => `- ${x}`).join("\n")}\n\n## Acceptance criteria\n${s.criteria.map((c) => `- [ ] ${c.id}: ${c.text} *(check: ${c.check})*`).join("\n")}\n\n## Spec debt (human-verified only)\n${s.specDebt.map((x) => `- ${x}`).join("\n")}\n`;
	}
}

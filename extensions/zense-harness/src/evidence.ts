// zense-harness module: eval evidence — toolchain probe, gathered repo facts, git change summary, criteria check probes + commit-time check lint (moved verbatim from index.ts — see AGENTS.md map)

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { zenseDir, type Criterion, type Spec } from "./types.ts";
import { gitOk } from "./worktree.ts";
import { isMachineCheckable } from "./spec-draft.ts";

// ----------------------------------------------------------------------------- eval/review evidence helpers (module scope — exported for unit tests)

/** C (2026-09-02): harness-side toolchain probe — real logs showed requirements sub-agents
 *  burning several rounds firing `command -v` one tool at a time (deno cargo go make just mvn
 *  …) until the timeout. The harness probes once (single execSync, 5s timeout) and hands the
 *  result over as a fact — the sub-agent spends no tool calls on probing. */
export const TOOLCHAIN_PROBE = [
	"node", "npm", "pnpm", "bun", "deno", "python3", "pip3", "uv", "cargo", "go", "make", "just",
	"mvn", "gradle", "dotnet", "composer", "php", "ruby", "docker", "kubectl", "git",
];
export const probeToolchain = (tools: readonly string[] = TOOLCHAIN_PROBE, env = process.env): string[] => {
	try {
		// the trailing `; true` is required: if the last listed tool is missing from PATH the loop
		// exits 1 → execSync throws and catch returns [] always (the default TOOLCHAIN_PROBE once
		// survived only because git happened to be last)
		const out = execSync(`for t in ${tools.join(" ")}; do command -v "$t" >/dev/null 2>&1 && printf '%s\\n' "$t"; done; true`, {
			encoding: "utf8",
			timeout: 5_000,
			env,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out ? out.split("\n").filter(Boolean) : [];
	} catch {
		return []; // probe failure/timeout → works fine without facts (best-effort like the rest of gatherRepoFacts)
	}
};

/**
 * W3: context priming — the harness gathers verified repo facts for the requirements
 * sub-agent (plain D relied solely on "tell the model to explore" — one lazy round and a
 * whole criteria set floats). Every part is best-effort: unreadable/missing files are skipped
 * silently so an odd-looking repo can't break compile.
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
	// C: one manifest per ecosystem — tells the sub-agent which ecosystem this repo is
	// (cargo/go/deno/python/...), incl. repos without package.json (cargo/go) that once made the
	// sub-agent guess wrong and waste time probing
	const manifestNames = ["deno.json", "deno.jsonc", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts"];
	const manifests = manifestNames.filter((f) => existsSync(join(cwd, f)));
	try {
		manifests.push(...readdirSync(cwd).filter((f) => f.endsWith(".csproj")));
	} catch {
		/* skip */
	}
	if (manifests.length) facts.push(`ecosystem manifests present (trust this — do not re-scan): ${manifests.join(", ")}`);
	// C: toolchain found on PATH — one fact, done, instead of the sub-agent probing one by one until the timeout
	const tools = probeToolchain();
	if (tools.length) facts.push(`toolchain on PATH (verified — do NOT re-probe one-by-one): ${tools.join(", ")}`);
	return facts.map((f) => `- ${f}`);
};

/**
 * W3: few-shot from this repo's real specs — pull the newest previously signed (approved)
 * spec from the archive as a style/format exemplar that already passed this project's gate
 * (criteria trimmed to 3, keeps the prompt lean). Archive filenames start with a timestamp →
 * sort descending and take the first approved=true.
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
			/* skip corrupt archive files */
		}
	}
	return null;
};

/** W2: git snapshot of the working dir being evaluated/reviewed (worktree or main) —
 *  best-effort: not a repo / command failure → that section is omitted. The grader uses it to
 *  spot reward hacking, the reviewer as an evidence pack. Every section is length-capped. */
export const gitChangeSummary = (cwd: string, baseline?: string): string => {
	const parts: string[] = [];
	if (baseline) {
		// ground only the current round: log/diff vs the baseline at spec approval — older commits never leak into evidence
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
	status: "pass" | "fail" | "skipped"; // skipped = check not runnable (manual → human review; not forced pass/fail)
	exitCode?: number;
	detail: string; // stdout/stderr tail, or the reason it was skipped
}

const PROBE_TIMEOUT_MS = 30_000; // keeps a hanging check (server waiting on a port, …) from dragging eval down with it

/** usage/syntax/environment errors = the harness couldn't run the check because the command
 *  itself is broken (too many args / unknown flag / parse failure) — not evidence that the
 *  artifact is wrong. Checks that genuinely "ran and didn't match" (grep not found, test
 *  false, diff differs) exit 1 quietly or print a diff → they dodge this regex and stay full
 *  fails. "No such file" intentionally absent: `cat missing-file` = a genuinely missing
 *  artifact, must fail. Real cases: "expected at most two arguments… unexpected: +, grep",
 *  "test: too many arguments" → probe died on a correct artifact and probe-primacy then
 *  stamped FAIL over it forever. */
const PROBE_USAGE_ERROR_RE =
	/too many arguments|usage:|unexpected (argument|token|operator|flag)|expected (exactly|at (most|least)) \w+ argument|accepts \d+ arg|unrecognized |unknown (flag|command|shorthand|option)|invalid (option|argument|flag)|illegal option|bad option|syntax error/i;

/** Is a broken shell probe a "broken command on the harness side" (can't judge the artifact)
 *  or a genuine fail? */
const isProbeCommandError = (exitCode: number | undefined, detail: string): boolean =>
	exitCode === 126 || exitCode === 127 || PROBE_USAGE_ERROR_RE.test(detail);

/** Unsubstituted placeholders in a check — <word> or {word} tokens
 *  (a spec author left the check as a template, e.g. "path exists: src/<module>/x",
 *  "grep -q foo {file}" → runs as No such file / quiet exit 1 → probe primacy stamps FAIL on
 *  a broken command; seen for real). ${VAR} is excepted (shell variable — lookbehind
 *  (?<!\$)) — not a placeholder. */
const PLACEHOLDER_TOKEN_RE = /<[A-Za-z][A-Za-z0-9_-]*>|(?<!\$)\{[A-Za-z][A-Za-z0-9_-]*\}/;
export const hasUnsubstitutedPlaceholder = (check: string): string | null => {
	const m = check.match(PLACEHOLDER_TOKEN_RE);
	return m ? m[0] : null;
};

/** The single format contract for criteria[].check — one source of truth used by both the
 *  requirements prompt (buildRequirementsPrompt quotes it into the rules) and the zense_spec
 *  tool schema (action=set authors checks by hand). Goal: the agent generates probes the
 *  harness (sh -c) can actually run on the first attempt, instead of breaking at eval and
 *  looping spec fixes. */
export const CHECK_FORMAT_CONTRACT =
	"Check format contract (the harness executes this verbatim at eval — a broken command wastes whole eval rounds): each check runs under POSIX sh via `sh -c` with cwd=repo root; exit 0 = pass, non-zero = fail. Allowed forms ONLY: (1) a single-line runnable shell command (e.g. \"npm test\", \"npx tsc --noEmit\", \"grep -q foo src/a.ts\"); (2) \"path exists: <relative-path>\"; (3) a one-level compound of those joined with \" && \" (e.g. \"path exists: src/a.ts && npm test\"). BANNED (sh will not run them and the check dies for infra reasons): globstar ** (e.g. apps/**/dev.yaml — use find/rg or spell the path out), brace expansion, [[ ]], process substitution and other bashisms, && / || inside string literals, and unsubstituted placeholders like <module> or {file}. Every path/token must exist in the repo TODAY and you must have actually run each candidate command (Step 1) and seen it execute — it need not pass yet, but it must not die with command-not-found/usage/syntax errors. Anything you cannot verify by running belongs in specDebt, not in criteria.";

type CheckSegment = { kind: "exists"; path: string } | { kind: "shell"; command: string };

const PATH_EXISTS_SEG_RE = /^\s*(?:path|file)\s+exists:\s*(.+?)\s*$/i;

/** Split a compound check ("path exists: a && npm test") at top-level "&&" into segments —
 *  null when no path-exists segment exists (a pure-shell check may contain "&&" inside a
 *  string literal, e.g. grep -q "a && b" → a naive split would break the command, so the
 *  whole sh -c behavior is preserved). */
const splitCompoundCheck = (check: string): CheckSegment[] | null => {
	const parsed: CheckSegment[] = check.split(/\s*&&\s*/).map((seg) => {
		const m = seg.match(PATH_EXISTS_SEG_RE);
		return m ? { kind: "exists", path: m[1] } : { kind: "shell", command: seg.trim() };
	});
	return parsed.some((s) => s.kind === "exists") ? parsed : null;
};

/** Strip a leading shell-runner prefix ("bash: "/"sh:"/"shell:"/"zsh:", case-insensitive)
 *  from a check — humans/LLMs often write "bash: npm test", which when run via sh -c dies
 *  (sh: bash:: command not found, exit 127 → skipped, losing machine verification every
 *  round). Strips once at command start; never touches the middle. */
export const normalizeShellCommand = (check: string): string => check.replace(/^\s*(?:bash|sh|shell|zsh):\s*/i, "");

const runShellSegment = (command: string, cwd: string, timeoutMs: number): { pass: boolean; exitCode?: number; detail: string; cmdErr?: boolean } => {
	// normalize before running — detail must reflect the actually executed (stripped) command
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
 * W3 (probe-first grading): the harness runs criteria[].check itself before the grader sees
 * anything — the grader no longer guesses what a command returns, and probes are hard
 * evidence that can override a grader verdict (probe fail ⇒ criterion FAIL no matter what
 * the grader says — see zense_eval).
 * Exception: a check command broken on the harness side (usage/syntax error — see
 * isProbeCommandError) → skipped: not evidence of artifact failure, the grader judges from
 * other evidence + the human reviews; no forced FAIL loop.
 * Supports 3 shapes: "path exists: <p>" resolved in-process / the same per segment of a
 * compound ("path exists: a && npm test" — every segment must pass) / pure shell checks that
 * are machine-checkable → whole via sh -c.
 */
export const runCheckProbes = (cwd: string, criteria: Criterion[], timeoutMs = PROBE_TIMEOUT_MS): ProbeResult[] =>
	criteria.map((c) => {
		// unsubstituted placeholder → spec-side broken command (covers every branch: path-exists/
		// compound/shell); must never flow into fail (probe primacy would override the grader →
		// endless loop) — skipped with a fix hint
		const ph = hasUnsubstitutedPlaceholder(c.check);
		if (ph)
			return {
				id: c.id,
				status: "skipped" as const,
				detail: `unsubstituted placeholder "${ph}" in check (→ fix spec via zense_spec, human review)`,
			};
		const segs = splitCompoundCheck(c.check);
		if (segs?.every((s) => s.kind === "exists")) {
			// pure path-exists — resolve in-process (single-path keeps identical status & detail)
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
			// compound with shell: every segment must actually be runnable — a single shell segment
			// the harness can't judge means don't blindly run it (may break or be dangerous because
			// the split missed the semantics) → skip the whole criterion for human review
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
							// this segment's command is broken → the whole criterion can't judge the artifact (even if earlier segments passed)
							status: (r.cmdErr ? "skipped" : "fail") as "skipped" | "fail",
							...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
							detail: (r.cmdErr ? `probe command error (not artifact failure, → human review): ` : "") + details.join("; ").slice(-600),
						};
				}
			}
			return { id: c.id, status: "pass" as const, exitCode: 0, detail: details.join("; ").slice(-600) };
		}
		// shell-only check (may contain "&&" inside literals) — as before: whole via sh -c / skip when not auto-runnable
		if (!isMachineCheckable(c.check)) return { id: c.id, status: "skipped" as const, detail: "not machine-runnable (→ human review)" };
		const r = runShellSegment(c.check, cwd, timeoutMs);
		return {
			id: c.id,
			status: r.pass ? ("pass" as const) : r.cmdErr ? ("skipped" as const) : ("fail" as const),
			...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
			detail: r.cmdErr ? `probe command error (not artifact failure, → human review): ${r.detail}` : r.detail,
		};
	});

const CHECK_LINT_TIMEOUT_MS = 10_000; // commit-time lint must be fast — hard-capped at PROBE_TIMEOUT_MS (30s)

/** Deterministic commit-time check lint (W: stops broken probe commands from reaching eval
 *  and looping spec fixes): runs each check once via runCheckProbes verbatim (cwd=repo root,
 *  short timeout) → lint sees exactly what eval will see.
 *  Classification: only `skipped` is spec-side broken (placeholder / not machine-runnable /
 *  cmdErr 126–127 usage-syntax — the artifact can't be judged at all → fix the check) →
 *  returns broken ids + explanatory notes; pass/fail = artifact-side (incl. failing because
 *  the work isn't implemented yet, or slow-command timeouts) → no warning, normal pre-signing.
 *  Doesn't change runCheckProbes/probe-primacy semantics — it's only a pre-signing warning
 *  layer. */
export const lintSpecChecks = (cwd: string, criteria: Criterion[], timeoutMs = CHECK_LINT_TIMEOUT_MS): { broken: string[]; notes: string[] } => {
	const results = runCheckProbes(cwd, criteria, Math.min(timeoutMs, PROBE_TIMEOUT_MS));
	const broken: string[] = [];
	const notes: string[] = [];
	for (const r of results) {
		if (r.status !== "skipped") continue;
		broken.push(r.id);
		notes.push(`check-lint: ${r.id} uses a check the probe can't run (${r.detail.slice(0, 120)}) — fix the check in the spec so it actually runs (fix the check, not the artifact), or move it to specDebt`);
	}
	return { broken, notes };
};

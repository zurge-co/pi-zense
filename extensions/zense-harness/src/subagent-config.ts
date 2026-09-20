// zense-harness module: per-role sub-agent argv: exclude tools, strip flags, timeouts, ext includes, provider-missing diagnosis, requirements prompt (moved verbatim from index.ts — see AGENTS.md map)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { zenseDir } from "./types.ts";
import { CHECK_FORMAT_CONTRACT } from "./evidence.ts";

// ----------------------------------------------------------------------------- sub-agent argv (module scope — exported for unit tests)

/** C: roles whose job is "read/draft", not "edit code", are locked read-only via
 *  --exclude-tools (defense-in-depth: a prompt-level ban is one disobedience away from a
 *  write; an absent tool cannot be called at all). read+bash stay because the role must
 *  explore the repo and dry-run check commands before drafting.
 * W2: grader/reviewer are read-only too — they judge/report, never fix code (subprocesses
 * bypass the gate and the main agent's agent_end heuristics → leaving write available would
 * let a grader silently edit tests until they pass). */
export const SUBAGENT_EXCLUDE_TOOLS: Record<string, string[]> = {
	requirements: ["write", "edit"],
	// planner explores the repo lightly / thinks — read-only like requirements
	planner: ["write", "edit"],
	grader: ["write", "edit"],
	reviewer: ["write", "edit"],
	// distiller reads only memory.jsonl and returns JSON — no writes/commands at all (the harness rewrites the file itself after validation)
	distiller: ["write", "edit", "bash"],
};

/** M (2026-09-08): per-role boot strip flags — every sub-agent launch otherwise pays pi's full
 *  system prompt again (skills/prompt templates/themes/extensions all load as in a normal
 *  session) even though each role has one fixed job: grader/reviewer judge purely from prompt
 *  evidence → fully bare boot; requirements must explore the target repo (its
 *  skills/extensions may carry needed context) → strip only themes/prompt-templates.
 *  --no-extensions is safe because the harness bails itself inside sub-agents via
 *  PI_ZENSE_SUBAGENT=1 — only the user's other extensions are switched off; zense stays. */
export const SUBAGENT_STRIP_FLAGS: Record<string, string[]> = {
	requirements: ["--no-themes", "--no-prompt-templates"],
	// planner, like requirements: may need repo skills/extensions context while decomposing
	planner: ["--no-themes", "--no-prompt-templates"],
	grader: ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"],
	reviewer: ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"],
	distiller: ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"],
};

/** B (2026-09-02): per-role timeout — real logs (.zense/subagents/) showed requirements/grader
 *  being killed at exactly 240s in every file (repo exploration + check runs need longer).
 *  No env override (removed 2026-09-02 by user decision: env is a knob the agent can't
 *  inspect at runtime). The agent-visible knob is .zense/config.json key subagentTimeoutMs
 *  {"<role>": ms, "default": ms}, read live at every launch (no cache) so an agent edit
 *  takes effect on the next launch without a restart. Pass cwd first, then fallbackCwd:
 *  a worktree has no .zense of its own (gitignored) → fall back to the main repo. */
export const SUBAGENT_TIMEOUT_MS: Record<string, number> = {
	requirements: 600_000,
	// planner only reads the intent + skims the layout before decomposing — much lighter than requirements
	planner: 300_000,
	grader: 600_000,
	reviewer: 480_000,
	distiller: 300_000,
	default: 300_000,
};
export const subagentTimeout = (role: string, cwd?: string, fallbackCwd?: string): number => {
	for (const dir of [cwd, fallbackCwd]) {
		if (!dir) continue;
		try {
			const cfgPath = join(zenseDir(dir), "config.json");
			if (!existsSync(cfgPath)) continue;
			const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { subagentTimeoutMs?: Record<string, number> };
			const v = cfg.subagentTimeoutMs?.[role] ?? cfg.subagentTimeoutMs?.default;
			if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
		} catch {
			/* corrupt/unreadable config → try the next dir, fall back to the built-in map */
		}
	}
	return SUBAGENT_TIMEOUT_MS[role] ?? SUBAGENT_TIMEOUT_MS.default;
};

/** ext-config (2026-09-08, v7): per-role extension loading for sub-agents — DEFAULT = unload
 *  everything (uniform bare boot for all roles; user rationale: extensions with gates/hangs
 *  must not block subprocesses). The user opts extensions back in via /zense ext-config
 *  (opt-in — expected ones like the provider @aliou/pi-synthetic get ticked explicitly).
 *  The include list persists at two levels: LOCAL <repo>/.zense/config.json (key
 *  subagentExtInclude — repo-specific) + GLOBAL ~/.pi/agent/zense/config.json (seeded once on
 *  first save, never overwritten).
 *  Resolution chain: local (cwd → fallbackCwd inside a worktree) → global → built-in ([]). */
export const zenseGlobalConfigDir = (): string => join(homedir(), ".pi", "agent", "zense");

export interface InstalledExtension {
	path: string;   // real extension file path (passed via -e; also the identity for exclusion)
	enabled: boolean;
	source: string; // package/origin (shown in the UI so the user knows where it came from)
	scope: string;  // user | project | temporary
}

/** UI label: bare basenames collide (multi-entry-point packages like pi-synthetic have
 *  6× index.ts — looks like a duplicated list when they're different files)
 *  '.../node_modules/@aliou/pi-synthetic/extensions/provider/index.ts' → 'provider/index.ts';
 *  fallback = basename when no package dir is found. */
export const extDisplayLabel = (ext: InstalledExtension): string => {
	const segs = ext.path.split(/[\\/]/).filter(Boolean);
	const pkgTail = ext.source.replace(/^npm:/, "").split("/").filter(Boolean).pop() ?? "";
	const idx = pkgTail ? segs.lastIndexOf(pkgTail) : -1;
	const rel = idx >= 0 ? segs.slice(idx + 1) : segs.slice(-1);
	if (rel[0] === "extensions") rel.shift();
	return rel.join("/");
};

/** Enumerate the extensions pi would actually load — uses DefaultPackageManager/
 *  SettingsManager (the same mechanism as `pi config` in core, so discovery never drifts);
 *  onMissing=skip (a config UI must never trigger installs). agentDir injectable for tmp-dir
 *  tests; failure → [] (degrades to bare boot). */
export const listInstalledExtensions = async (cwd: string, agentDir = getAgentDir()): Promise<InstalledExtension[]> => {
	try {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager });
		const resolved = await pm.resolve(async () => "skip");
		return resolved.extensions.map((e) => ({ path: e.path, enabled: e.enabled, source: e.metadata.source, scope: e.metadata.scope }));
	} catch {
		return [];
	}
};

const readExtIncludesFrom = (cfgPath: string, role: string): string[] | undefined => {
	try {
		if (!existsSync(cfgPath)) return undefined;
		const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { subagentExtInclude?: Record<string, unknown> };
		const sub = cfg.subagentExtInclude;
		if (!sub || typeof sub !== "object") return undefined;
		const v = sub[role];
		if (!Array.isArray(v)) return undefined;
		return v.filter((p): p is string => typeof p === "string");
	} catch {
		return undefined; // corrupt config counts as absent (the global/built-in chain continues without throwing)
	}
};

/** Role include list per resolution chain: local (cwd→fallbackCwd) → global → built-in []
 *  (bare boot). Read live every time (no cache — a save is visible on the very next run). */
export const subagentExtIncludes = (role: string, cwd?: string, fallbackCwd?: string, globalDir = zenseGlobalConfigDir()): string[] => {
	for (const dir of [cwd, fallbackCwd]) {
		if (!dir) continue;
		const v = readExtIncludesFrom(join(zenseDir(dir), "config.json"), role);
		if (v !== undefined) return v;
	}
	return readExtIncludesFrom(join(globalDir, "config.json"), role) ?? [];
};

/** Write a role's include list — always to LOCAL <cwd>/.zense/config.json (other config keys
 *  preserved) + one-time GLOBAL seeding: when global lacks this role's key, write the same
 *  value; never overwrite (user instruction: "first save also seeds global; skip afterwards").
 *  value=null deletes the local override only, without seeding. Returns globalSeeded for the
 *  handler to surface. */
export const writeSubagentExtIncludes = (cwd: string, role: string, value: string[] | null, globalDir = zenseGlobalConfigDir()): { globalSeeded: boolean } => {
	const writeInto = (cfgPath: string, mutate: (sub: Record<string, unknown>) => void): boolean => {
		try {
			let raw: Record<string, unknown> = {};
			if (existsSync(cfgPath)) raw = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
			const sub = { ...((raw.subagentExtInclude as Record<string, unknown> | undefined) ?? {}) };
			mutate(sub);
			if (Object.keys(sub).length) raw.subagentExtInclude = sub;
			else delete raw.subagentExtInclude;
			mkdirSync(dirname(cfgPath), { recursive: true });
			writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
			return true;
		} catch {
			return false; // unwritable → skip silently (config must never break the pipeline)
		}
	};
	writeInto(join(zenseDir(cwd), "config.json"), (sub) => {
		if (value === null) delete sub[role];
		else sub[role] = value;
	});
	let globalSeeded = false;
	if (value !== null && readExtIncludesFrom(join(globalDir, "config.json"), role) === undefined)
		globalSeeded = writeInto(join(globalDir, "config.json"), (sub) => {
			sub[role] = value;
		});
	return { globalSeeded };
};

/** Final flags for a role: DEFAULT (no include list) = uniform bare boot — roles whose base
 *  already has --no-extensions stay as-is; roles without it (requirements) get it added
 *  (guards against extensions with gates/hangs blocking the subprocess). With an include list
 *  → --no-extensions + '-e <path>' only for paths still installed+enabled (uninstalled ones
 *  are dropped silently to avoid boot errors); enumeration failure → bare boot (safest). */
export const subagentStripFlagsAsync = async (
	role: string,
	cwd?: string,
	fallbackCwd?: string,
	agentDir = getAgentDir(),
	globalDir = zenseGlobalConfigDir(),
): Promise<string[]> => {
	const base = SUBAGENT_STRIP_FLAGS[role] ?? [];
	const include = subagentExtIncludes(role, cwd, fallbackCwd, globalDir);
	if (!include.length && base.includes("--no-extensions")) return base; // already bare — unchanged, no enumeration needed
	const enumCwd = cwd ?? fallbackCwd;
	const valid = include.length && enumCwd ? new Set((await listInstalledExtensions(enumCwd, agentDir)).filter((e) => e.enabled).map((e) => e.path)) : new Set<string>();
	const flags = base.filter((f) => f !== "--no-extensions");
	flags.push("--no-extensions");
	for (const p of include) if (valid.has(p)) flags.push("-e", p);
	return flags;
};

/** Does the sub-agent's actual model (from JSONL events, 'provider/id' form) match a pattern
 *  configured in models.json? Matches exact (case-insensitive) or pattern = usedModel +
 *  ':<thinking-level>' (a suffix pi strips at resolve time). */
export const modelMatchesPattern = (usedModel: string, pattern: string): boolean => {
	const used = usedModel.trim().toLowerCase();
	const pat = pattern.trim().toLowerCase();
	return used.length > 0 && (pat === used || pat.startsWith(`${used}:`));
};

// ---- provider-missing diagnosis (2026-09-17): sub-agents boot bare (--no-extensions), which
// strips the extension providing the main session's provider — which provider is needed is
// only knowable at run time (per-role models.json may differ from the main agent), so
// diagnose post-run: silent fallback shows up as usedModel provider ≠ pattern, or a hard
// error (PROVIDER_MISSING_RX) → auto-heal retry once with '-e <ext>' and persist on success,
// else mark failed with per-role guidance (/zense:ext-config:<role>)

/** Provider portion of a model pattern (before the first '/', lowercase) — a pattern without
 *  '/' (e.g. "sonnet:high") doesn't name a provider. */
export const providerIdOfModelPattern = (pattern: string): string | undefined => {
	const i = pattern.indexOf("/");
	return i > 0 ? pattern.slice(0, i).trim().toLowerCase() : undefined;
};

/** 'provider/id' (from usedModel) → lowercase provider; undefined when absent/no '/' */
export const usedProviderOf = (usedModel?: string): string | undefined => {
	if (!usedModel) return undefined;
	const i = usedModel.indexOf("/");
	return i > 0 ? usedModel.slice(0, i).toLowerCase() : undefined;
};

/** Providers pi has built-in (not from extensions) — a mismatch on these means a wrong model
 *  id / missing auth, not a provider lost to bare boot → skip the heal, use the normal warning
 *  path. The list only gates auto-heal; a false entry merely skips a retry. */
export const BUILTIN_PROVIDER_IDS = new Set([
	"anthropic", "openai", "openai-codex", "google", "google-vertex", "google-antigravity", "google-gemini-cli",
	"amazon-bedrock", "azure-openai-responses", "openrouter", "groq", "mistral", "xai", "cerebras", "zai",
	"opencode", "opencode-go", "kimi-coding", "minimax", "minimax-cn", "huggingface", "deepseek",
]);

/** pi stderr/output when a --model pattern can't resolve (bare boot doesn't know the
 *  provider) — the hard-fail signal of provider-missing (silent fallback is the other); a
 *  false positive here costs only one wasted retry. */
export const PROVIDER_MISSING_RX = /no models found matching|model .{0,60}\bnot available|unknown (model|provider)|no api key found for/i;

/** Provider-extension lookup result: real extension path + short UI label (extDisplayLabel) */
export interface ProviderExtHit {
	path: string;
	label: string;
}

const defaultExtSourceReader = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8").slice(0, 400_000);
	} catch {
		return undefined; // unreadable = no match (silently skipped like the rest of ext-config)
	}
};

/** Find the installed+enabled extension likely providing providerId — heuristic: file contains
 *  both "registerProvider" and the provider id (case-insensitive); scoring: '/provider/' path
 *  segment (+2, e.g. pi-synthetic → extensions/provider/index.ts among 6 entry-points) /
 *  id literal 'id: "<pid>"' (+1). A top-score tie = ambiguous → undefined (better plain
 *  guidance than a wrong guess). Reader injectable for tests. */
export const findProviderExtension = (
	providerId: string,
	exts: InstalledExtension[],
	read: (path: string) => string | undefined = defaultExtSourceReader,
): ProviderExtHit | undefined => {
	const pid = providerId.toLowerCase();
	const scored: { ext: InstalledExtension; score: number }[] = [];
	for (const ext of exts) {
		if (!ext.enabled) continue;
		const content = read(ext.path)?.toLowerCase();
		if (!content) continue;
		if (!content.includes("registerprovider") || !content.includes(pid)) continue;
		let score = 0;
		if (/\/provider\//.test(ext.path.replace(/\\/g, "/"))) score += 2;
		if (content.includes(`id: "${pid}"`) || content.includes(`id: '${pid}'`)) score += 1;
		scored.push({ ext, score });
	}
	if (!scored.length) return undefined;
	const max = Math.max(...scored.map((s) => s.score));
	const top = scored.filter((s) => s.score === max);
	if (top.length !== 1) return undefined; // ambiguous — don't guess
	return { path: top[0].ext.path, label: extDisplayLabel(top[0].ext) };
};

/** Merge a path into an include list (idempotent — a present path returns the same array
 *  identity so callers can compare with ===). */
export const mergeExtInclude = (current: string[], path: string): string[] => (current.includes(path) ? current : [...current, path]);

/** Decides whether a run hit provider-missing from bare boot — pure (unit-testable);
 *  undefined = no (no pattern, built-in provider — a mismatch there means wrong model id /
 *  missing auth — or a normal run); kind: provider-mismatch = silent fallback (usedModel has
 *  a different provider than the pattern) / hard-missing = run died with a model error. */
export const diagnoseProviderMissing = (
	modelPattern: string | undefined,
	r: { ok: boolean; output: string; usedModel?: string },
): { kind: "provider-mismatch" | "hard-missing"; patternProvider: string } | undefined => {
	if (!modelPattern) return undefined;
	const patternProvider = providerIdOfModelPattern(modelPattern);
	if (!patternProvider || BUILTIN_PROVIDER_IDS.has(patternProvider)) return undefined;
	if (r.usedModel) {
		const usedProv = usedProviderOf(r.usedModel);
		// final condition: coincidentally matching patterns (e.g. provider-less 'model:level') must not enter the heal
		if (usedProv !== patternProvider && !modelMatchesPattern(r.usedModel, modelPattern)) return { kind: "provider-mismatch", patternProvider };
		return undefined;
	}
	if (!r.ok && PROVIDER_MISSING_RX.test(r.output)) return { kind: "hard-missing", patternProvider };
	return undefined;
};

/** Guidance text when a diagnosed provider-missing can't be auto-healed — points at the
 *  per-role command of the role that actually failed (never generic "ext-config": the role
 *  using this provider may not be the main agent — models.json is per-role). */
export const buildProviderMissingGuidance = (
	role: string,
	providerId: string,
	opts: { hit?: ProviderExtHit; alreadyIncluded?: boolean; autoRetried?: boolean } = {},
): string => {
	const lines = [
		`provider "${providerId}" is unavailable in the sub-agent (${role}) — sub-agents boot with --no-extensions, so the extension providing the main session's provider is never loaded`,
	];
	if (opts.autoRetried && opts.hit) lines.push(`auto-included "${opts.hit.label}" but the provider is still unavailable — configure it yourself:`);
	if (opts.hit && !opts.alreadyIncluded) {
		lines.push(`fix: /zense:ext-config:${role} and tick "${opts.hit.label}"`);
		lines.push(`or: /zense ext-config-show ${role} on ${opts.hit.path}`);
		lines.push(`if it still falls back after inclusion → suspect auth: pi login ${providerId} or set the provider's API-key env var`);
	} else if (opts.hit && opts.alreadyIncluded) {
		lines.push(`extension "${opts.hit.label}" is already included for this role but the provider is still unavailable — suspect auth: pi login ${providerId} or set the provider's API-key env var (review the list with /zense ext-config-show ${role})`);
	} else {
		lines.push(`no extension providing "${providerId}" found among installed extensions — install that provider extension first, or change this role's model with /zense models`);
	}
	return lines.join("\n");
};

export const buildSubagentArgv = (task: string, modelPattern?: string, excludeTools?: string[], role?: string, stripFlags?: string[]): string[] => {
	// argv: strip flags (per-role), then --exclude-tools, then --model, then task; no leading --
	// before task (preserves existing behavior). M: strip flags from SUBAGENT_STRIP_FLAGS per
	// role — previously every launch loaded skills/templates/themes/extensions in full.
	// ext-config: the caller (runSubagent) resolves via subagentStripFlags() — this param wins
	// over the built-in map.
	const flags = stripFlags ?? (role ? SUBAGENT_STRIP_FLAGS[role] : undefined);
	const argv = ["PI_ZENSE_SUBAGENT=1", "pi", "--mode", "json", "--no-session"];
	if (flags?.length) argv.push(...flags);
	if (excludeTools?.length) argv.push("--exclude-tools", excludeTools.join(","));
	if (modelPattern) argv.push("--model", modelPattern);
	argv.push(task);
	return argv;
};

/** D: requirements-sub-agent prompt — forces exploration before drafting (grounding:
 *  criteria[].check must be a command that exists and actually runs in THIS repo, never a
 *  guess) + clarify contract (F) + single-JSON output. Kept next to its parser (module scope
 *  + export) so contract changes stay visible as a pair. */
export const buildRequirementsPrompt = (intent: string, lessons: string[], facts?: string[], exemplar?: string | null, timeoutMs = 300_000): string =>
	`You are the REQUIREMENTS sub-agent for a spec-gated SDLC harness. Your single JSON output becomes the machine-checked contract for the main agent's implementation, so every criterion must be grounded in THIS repository's reality — never guess.

` +
	`Step 1 — EXPLORE (read-only, mandatory before drafting): read README*, package.json / other manifests, test configs, CI configs and the relevant source layout. Actually RUN the candidate test/lint/build commands you plan to reference, so every check you write is proven to work here. You have NO write/edit tools — do not attempt to modify anything. You run under a HARD wall-clock limit of about ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes — be economical: never probe toolchains or test commands one-by-one; if the harness-provided facts below already list them, trust the list and move on, otherwise batch ALL probes into ONE bash loop. Never re-run commands the facts already answered, and never run anything likely to exceed ~30s more than once (full test suites, builds, installs): if a candidate check is slow, find a faster equivalent — and if none exists, push that verification into specDebt instead of burning your budget.

` +
	`Step 2 — DRAFT exactly ONE JSON object:
{"title": string, "intent": string, "approach": string[], "scope": string[], "constraints": string[], "criteria": [{"id": string, "text": string, "check": string}], "specDebt": string[]}
Rules:
- scope: the minimal list of path prefixes the main agent may modify.
- approach: 3–7 short bullets describing the planned work — main steps, which files will be created or modified, and expected outcomes — grounded in your Step 1 exploration (no guessing). This is presentational info shown to the human signer so they can see what will actually happen; it is NOT a machine-checked criterion.
- criteria: few and atomic. Each "check" MUST obey this contract:
  ${CHECK_FORMAT_CONTRACT}
  Good checks: "npm test" · "path exists: src/a.ts" · "path exists: src/a.ts && npm test"
  Bad checks (never write these — they die for infra reasons at eval): "ls apps/**/dev.yaml" (sh does not expand **) · "[[ -f src/a.ts ]]" (bashism) · "grep -q x {file}" (unsubstituted placeholder) · "path exists: src/<module>/x" (placeholder). Anything you cannot verify by running a command belongs in specDebt instead (it becomes forced human review).
- Output ONLY the JSON object — no markdown fences, no commentary.

` +
	`Step 3 — CLARIFY INSTEAD OF GUESSING (grilling loop): if the request is ambiguous enough that a wrong guess would be costly, do NOT draft yet. You get multiple rounds — each round you are re-run with ALL previous answers appended to the Request — so ask only the 1–2 most decision-critical questions per round instead of dumping every doubt at once. Output exactly {"questions": ["short question", "…max 5…"]}; when a question has a few plausible answers, attach them as choices so the human can pick quickly (they can also type their own): {"questions": [{"question": "…", "choices": ["option A", "option B"]}]} — the two shapes may be mixed in one array.` +
	// W3: exemplar (few-shot from a previously signed spec) + facts (harness-collected context
	// priming) go before the lessons — evidence from the repo itself beats generic lessons;
	// both optional for backward compat
	(exemplar ? `\n\nA previously SIGNED spec from this repo (style/format exemplar — do NOT copy its content):\n${exemplar}` : "") +
	(facts?.length ? `\n\nRepository facts gathered by the harness (verified — trust these over your own assumptions):\n${facts.join("\n")}` : "") +
	(lessons.length
		? `\n\nPast lessons from this project's memory (reflect relevant ones in scope/constraints/criteria when they apply):\n${lessons.join("\n")}`
		: "") +
	`\n\nRequest: ${intent}`;

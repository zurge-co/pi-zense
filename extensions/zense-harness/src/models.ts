// zense-harness module: per-role model config (.zense/models.json), model picker choices, panelize UI helper (moved verbatim from index.ts — see AGENTS.md map)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { zenseDir } from "./types.ts";

// ----------------------------------------------------------------------------- sub-agent model config (per-role)

/**
 * Read .zense/models.json — role → pi --model pattern map (e.g. "anthropic/claude-sonnet",
 * "openai/gpt-4o-mini", "sonnet:high"). Missing/unparseable → {} (the main agent's model
 * is used instead).
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
 * Resolve the model pattern for a role, in order: .zense/models.json[role] → ctx.model
 * (the main agent's provider/id) → undefined (let pi use its default).
 * undefined means runSubagent sends no --model.
 */
export const resolveModelPattern = (cwd: string, role: string, mainModel?: { provider: string; id: string }): string | undefined => {
	const cfg = readModelsConfig(cwd);
	const configured = cfg[role];
	if (configured) return configured;
	if (mainModel) return `${mainModel.provider}/${mainModel.id}`;
	return undefined;
};

/**
 * Write/remove one role's model override in .zense/models.json — creates the dir as needed,
 * preserves the file's other keys (reads the raw file itself because readModelsConfig drops
 * non-string values).
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
			/* previously malformed — start from a fresh {} */
		}
	}
	if (pattern && pattern.trim()) cfg[role] = pattern.trim();
	else delete cfg[role];
	writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
};

/**
 * Model choices for the picker: the session's scopedModels first (mirror of the /model
 * picker); without scoping, fall back to the full modelRegistry.getAvailable() catalogue.
 */
export const availableModelChoices = (ctx: ExtensionContext): { pattern: string; label: string; description: string }[] => {
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

/** panelize(theme, lines, w): makes a dialog "float" over the transcript: pads every line to
 *  full width w (measured with visibleWidth — ANSI escapes take no screen) and backgrounds it
 *  with theme.bg("selectedBg") — the same token pi's user-message bubble uses, so it follows
 *  dark/light themes automatically (never hardcode ANSI/hex). theme.bg() resets only SGR 49
 *  (bg), leaving in-line fg colors intact. The theme param is structural — a fake theme.bg is
 *  injectable in unit tests without importing the Theme class. */
//  generic over the color param — the real Theme is (color: ThemeBg) => string, unassignable
//  to (color: string) by contravariance; "selectedBg" is a ThemeBg member so the cast is safe
//  (test fakes passing plain strings still work)
export const panelize = <T extends string>(theme: { bg: (color: T, text: string) => string }, lines: string[], w: number): string[] =>
	lines.map((ln) => theme.bg("selectedBg" as T, ln + " ".repeat(Math.max(0, w - visibleWidth(ln)))));

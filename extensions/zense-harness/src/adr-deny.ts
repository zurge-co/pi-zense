// zense-harness module: ADR DENY: line parsing + path violation messages (moved verbatim from index.ts — see AGENTS.md map)



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

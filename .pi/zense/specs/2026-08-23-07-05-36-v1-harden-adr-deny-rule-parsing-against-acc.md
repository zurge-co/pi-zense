# Spec v1: Harden ADR DENY-rule parsing against accidental substring blocking
approved: false

## Intent
Fix the ADR DENY-rule parser so each rule is always treated as one complete constraint rather than being split per character, eliminate regex ambiguity as the root cause, keep existing ADR grammar compatible, and add durable regression tests so this bug class cannot silently return.

## Scope
- extensions/zense-harness/index.ts
- test/**
- package.json

## Constraints
- Do not change the canonical on-disk ADR grammar: `DENY: <constraint>` with optional `→ <reason>` remains valid.
- Parse rules deterministically without a non-greedy capture group or optional arrow capture that can collapse to one character.
- Trim whitespace around the constraint and reason while preserving internal characters; an empty constraint, empty line, or non-DENY line must never block anything.
- Continue to support case-insensitive `DENY:` prefixes, CRLF line endings, and a first `→` separator; any later arrows remain part of the reason.
- Preserve the blocking behavior as a complete-string `includes()` match and the reason format `ADR constraint: <constraint> denied (<reason|see ADR>)`.
- No new runtime dependencies and no change to unrelated harness behavior.
- Factor parsing/matching into exported pure helpers covered by permanent node:test regression tests and use those helpers from the live tool-call checker.

## Acceptance criteria
- [ ] C1: `DENY: node_modules/` parses as the complete constraint `node_modules/` with no reason. *(check: node --no-warnings --test test/index.test.mjs exits 0 and has a matching named assertion)*
- [ ] C2: `DENY: api/legacy → avoid legacy mutation` parses constraint and reason separately, with whitespace trimmed. *(check: node --no-warnings --test test/index.test.mjs exits 0 and has a matching named assertion)*
- [ ] C3: Regression: the constraint tokenizer never derives `n` from `node_modules/` or `a` from `activity === "terminal" ? ()`; consequently `src/index.ts` and `src/launch.ts` are not blocked by one-character accidental matches. *(check: node --no-warnings --test test/adr-deny.test.mjs exits 0)*
- [ ] C4: Targets containing the full constraint, including nested paths such as `src/x/node_modules/index.js`, are blocked with the established message format. *(check: node --no-warnings --test test/index.test.mjs exits 0)*
- [ ] C5: Case-insensitive prefixes, CRLF, no-space forms such as `deny:src/legacy`, non-DENY lines, and blank/empty constraints are handled explicitly in tests. *(check: node --no-warnings --test test/index.test.mjs exits 0)*
- [ ] C6: Only the first arrow acts as the reason separator; arrows later in the reason remain intact. *(check: node --no-warnings --test test/index.test.mjs exits 0)*
- [ ] C7: The live `tool_call` checker no longer matches ADR lines directly with the ambiguous regex and instead calls the shared parsed-rule helper. *(check: grep -q 'firstAdrDenyViolation' extensions/zense-harness/index.ts && ! grep -q '(.+?).*→?' extensions/zense-harness/index.ts)*
- [ ] C8: `zense_adr` remains unchanged in writing `DENY: ${d}\n`, preserving existing ADR files and produced grammar. *(check: grep -q 'DENY: \${d}' extensions/zense-harness/index.ts)*
- [ ] C9: A permanent `npm test` script exists and completes without requiring dependencies absent from the repository. *(check: npm test exits 0)*
- [ ] C10: TypeScript syntax used by the parser is accepted by the Node runtime already supported by this repository when imported through the test suite. *(check: npm test successfully imports ../extensions/zense-harness/index.ts)*

## Spec debt (human-verified only)
- The intentional historical semantics are plain substring matching; path-segment-aware matching would be stricter but is a separate backward-compatibility decision.
- A user may still intentionally enter a one-character constraint; validation cannot distinguish that from malicious intent, but the implementation now guarantees it cannot arise from parsing truncation.
- Node emits a MODULE_TYPELESS_PACKAGE_JSON warning when TypeScript is imported without package `type: module`; tests suppress this warning rather than changing package module semantics.


## Eval 2026-08-23T07:08:45.083Z
verdict: **PASS** (grader.ok=true)
per-criteria:
- C1: ?
- C2: ?
- C3: ?
- C4: ?
- C5: ?
- C6: ?
- C7: ?
- C8: ?
- C9: ?
- C10: ?

grader output:
[session 01a02d72-e093-7a16-81d5-e8a03224e761]




⚙ bash {"command":"ls -la; echo \"---\"; cat package.json 2>/dev/null"}

⚙ bash {"command":"ls -la test/ extensions/zense-harness/ 2>/dev/null"}





⚙ bash {"command":"node --no-warnings --test test/index.test.mjs; echo \"EXIT: $?\""}

⚙ bash {"command":"node --no-warnings --test test/adr-deny.test.mjs; echo \"EXIT: $?\""}

⚙ bash {"command":"npm test 2>&1 | tail -20; echo \"EXIT: ${PIPESTATUS[0]}\""}





⚙ read {"path":"test/index.test.mjs"}

⚙ read {"path":"test/adr-deny.test.mjs"}

⚙ bash {"command":"grep -n 'firstAdrDenyViolation' extensions/zense-harness/index.ts; echo \"---C7a rc?\"; grep -q 'firstAdr…



⚙ bash {"command":"sed -n '520,540p' extensions/zense-harness/index.ts; echo \"===C8===\"; grep -n 'DENY: \\${d}' extensions…


C1: PASS: `test/index.test.mjs` exit 0, "no-reason DENY lines keep the entire constraint intact" asserts constraint "node_modules/" with reason undefined
C2: PASS: exit 0, "REASON separators split exactly once..." asserts constraint "api/legacy" and reason "avoid legacy mutation" (trimmed)
C3: PASS: `test/adr-deny.test.mjs` exit 0, asserts constraints stay "node_modules/" and 'activity === "terminal" ? ()' and src/index.ts, src/launch.ts not blocked
C4: PASS: exit 0, "full constraints block matching nested targets" checks src/x/node_modules/index.js → "ADR constraint: node_modules/ denied (generated dependency)"
C5: PASS: exit 0, "parse handles CRLF, prefixes without spaces..." covers `DenY:src/legacy\r`, non-DENY, `DENY:` blank and whitespace-only lines
C6: PASS: exit 0, "later arrows remain part of the reason" asserts reason "first → keep me"
C7: PASS: line 532 uses `firstAdrDenyViolation(target, ...)`; grep confirms no `(.+?).*→?` ambiguous regex present
C8: PASS: line 949 in zense_adr writes `` `DENY: ${d}\n` `` (grep match)
C9: PASS: `npm test` exits 0 (8 tests pass)
C10: PASS: both test files `import ... from "../extensions/zense-harness/index.ts"` and `npm test` runs them successfully

OVERALL: PASS

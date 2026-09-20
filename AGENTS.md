# AGENTS.md — working effectively in this repo

pi-zense: a spec-gated, human-signed SDLC harness shipped as a **pi extension** (`extensions/zense-harness/`) plus a dark theme (`themes/`). Everything the agent-facing harness does lives in the extension; tests are plain `node:test` files importing it.

## Golden rules for exploration (read code cheaply)

1. **Never read `extensions/zense-harness/index.ts` end-to-end.** It is the ~2,000-line pi wiring (hooks, TUI dialogs, tool/command registrations). The pure helpers you usually want are in `extensions/zense-harness/src/` — one theme per file, each sized to fit in a single read.
2. **Find a symbol by grepping, then read only the owning module:**
   `grep -rn "^export .*<name>" extensions/zense-harness/src extensions/zense-harness/index.ts`
   The module map below tells you where to look first.
3. **Tests import named exports from the entry point** (`../extensions/zense-harness/index.ts`), which re-exports all of `src/` — add new helpers to the right `src/` module and they are importable from `index.ts` automatically.
4. After any edit: `npm run typecheck && npm test` (see Commands). Both are fast — always run them.

## Repo map

| Path | Contents |
| --- | --- |
| `extensions/zense-harness/index.ts` | Extension entry point: `export default function (pi)` factory — session hooks, Phase-gate `tool_call` interceptor, turn/token meters, all TUI dialogs, `zense_*` tools, `/zense` commands. **Tests read this file's source for TDZ/order guards on factory closures (`probeSection`, `evalView`, `commitSpec`, `runDistill`) — keep those closures here, verbatim names.** |
| `extensions/zense-harness/src/` | All module-scope helpers, one theme per file (map below) |
| `test/*.test.mjs` | `node:test` suites; named imports from the entry point; some grep `index.ts` source for regression guards |
| `themes/` | Zense dark theme |
| `scripts/release.sh` | Release script (`npm run release`) |
| `package.json` | Scripts: `typecheck`, `test`; pi package manifest (`pi.extensions`, `pi.themes`) |

## `extensions/zense-harness/src/` module map

| Module | What lives here |
| --- | --- |
| `types.ts` | Core interfaces (`Criterion`, `Spec`, `State`, `SubagentRun`, `Worktree`, `PendingApply`) + `zenseDir`; imported by nearly every module |
| `spec-changes.ts` | Spec v→v+1 diff → change summary lines/groups, spec markdown render, `syncApprovedSpecFiles`, `applyFullscreenDefault` |
| `worktree.ts` | Git worktree isolation: `shellQuote`, path/command rewrite, `gitOk`, worktree create/reuse, `.git/info/exclude` |
| `resume.ts` | `/zense resume` disk discovery: spec load, archive paths, session worktree scan, pendingApply restore, `discoverResumeState` |
| `pending-apply.ts` | ADR-003 apply-back: commit/snapshot messages, `gitAddButZense`, `applyWorktreeBack`, `discardPendingApply`, `acceptPendingApply` |
| `cycle.ts` | Cycle closure: `resetCycleState`, one-shot context bulletins, `freshState` |
| `spec-draft.ts` | Requirements-output parsing: clarify/spec JSON (`parseSpecDraft`), machine-checkable heuristic, quality gate + similar-spec guard |
| `subagent-config.ts` | Per-role sub-agent argv: exclude-tools, strip flags, timeouts, ext includes (`.zense/config.json`), provider-missing diagnosis, `buildRequirementsPrompt` |
| `decompose.ts` | Decompose-then-compile: planner subtasks, `needsDecompose`, draft merge, `compileDecomposed` |
| `esc-guard.ts` | Terminal-input ESC guard so dialogs close without aborting the agent |
| `evidence.ts` | Eval evidence: toolchain probe, gathered repo facts, git change summary, criteria check probes + commit-time `lintSpecChecks` |
| `eval-review.ts` | Grader/reviewer contracts: grader output parse, grader/reviewer prompts, compact eval/review result text, packet validation, hallucination detector |
| `adr-deny.ts` | ADR `DENY:` line parsing + path violation messages (re-read before every impl run) |
| `subagent-runner.ts` | `runSubagent`: spawn `pi --mode json`, stream/kill/timeout, JSONL log under `.zense/subagents/` (+ `fmtTok`) |
| `memory.ts` | `memory.jsonl` summary + `/zense distill`: impact stats, lesson parsing/rewrite, atomic file replace, `distillTaskPrompt` |
| `models.ts` | Per-role model config (`.zense/models.json`), model picker choices, `panelize` dialog helper |

## Commands

- `npm test` — full suite (199 tests, ~8s). Single file: `node --no-warnings --test test/<file>.test.mjs`
- `npm run typecheck` — `tsc --noEmit` over the extension entry (checks all `src/` transitively)

## Conventions

- **Relative imports between TS modules carry explicit `.ts` extensions** (Node type-stripping in tests + jiti in pi both accept this; `typecheck` passes `--allowImportingTsExtensions`).
- **Code-motion discipline:** `src/` modules were extracted verbatim — keep comments/docblocks attached to their symbols, no drive-by reformatting.
- **Comment style:** dense, decision-anchored docblocks ("why", regression dates like `(2026-09-02)`); existing `// ----` section banners are kept — match the surrounding file rather than restyling it.
- The `export default function (pi)` factory stays in `index.ts`; only self-contained pure helpers graduate into `src/` modules.
- `.zense/` is harness state (specs, ADRs, memory, worktrees) — never commit it outside this repo's own dogfooding flow; sub-agents get `PI_ZENSE_SUBAGENT=1` and must not re-enter the harness.

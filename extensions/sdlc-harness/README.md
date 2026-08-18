# sdlc-harness

Pi extension implementing the AI-SDLC loop from `/PLAN.md`:

**spec → criteria → implementation → dual eval → exception review → learn**

One extension implements the harness; **"sub-agents" are isolated `pi -p`
subprocesses** spawned per phase task. This gives each phase task a clean
context window (no pollution from the main trajectory) and returns only the
finished artifact — exactly the harness design plan.md recommends.

## Phase map

| PLAN.md | Mechanism | Artifact |
|---|---|---|
| P1 Requirements — spec is the control surface | `sdlc_spec` tool (or `action:"compile_spec"` → requirements sub-agent) | `.pi/sdlc/spec.json` + `spec.md`, versioned, with machine-checkable criteria and **spec debt** |
| P1 gate — no implementation on unapproved spec | `tool_call` interceptor blocks `write`/`edit` until `/sdlc approve` | hard gate |
| P2 Design — ADRs prevent drift | `sdlc_adr` tool; ADRs re-read per tool call; `DENY: <path>` rules enforced live | `.pi/sdlc/adr/NNN-*.md` |
| P3 Implementation — budgeted autonomy | `turn_end` meter vs `/sdlc budget <turns> <tokens>`; overage ⇒ `ctx.abort()` + escalation | footer widget meter |
| P3 escalation taxonomy | `escalations[]` distinguishes need-permission / need-decision / something-wrong | `/sdlc status` |
| P4 Output eval — spec→eval closed loop | `sdlc_eval` → grader sub-agent judges each criterion PASS/FAIL | verdict text |
| P4 Trajectory eval | `agent_end` heuristics: test files modified/deleted, out-of-scope writes, retry storms, near-budget tokens | `trajectoryFlags` |
| P5 Review — exception-based, incident-report style | `sdlc_review` → reviewer sub-agent builds **review packet** (TL;DR first), rendered in transcript via `registerEntryRenderer` | card + entry |
| P6 Maintenance — learn | every review/escalation logged to `.pi/sdlc/memory.jsonl` | `/sdlc memory` |

## Human attention points (the scarce resource, per PLAN.md)

- **`/sdlc approve`** — the input-side signature on the spec contract.
- **`/sdlc status`** — one-glance: phase, gate, budget, trajectory flags, escalations.
- Forced review items from `specDebt` surface in every eval report.
- Widget above the editor shows live budget consumption.

## Commands

| Command | Effect |
|---|---|
| `/sdlc status` | phase, spec version/approval, budget, flags, escalations |
| `/sdlc approve` | approve current spec (opens implementation gate) |
| `/sdlc budget 25 400000` | max turns / tokens before auto-pause |
| `/sdlc gate off` | disable the spec gate (escape hatch) |
| `/sdlc memory` | tail the learning log |

## Agent-facing tools

`sdlc_spec`, `sdlc_adr`, `sdlc_eval`, `sdlc_review` — each delegates the heavy
reasoning to an isolated sub-agent run of pi itself (guarded by
`PI_SDLC_SUBAGENT=1` so sub-agents don't recurse into the harness).

## State

Persisted in-session via `pi.appendEntry("sdlc-state", …)` (restored on
resume/reload) and on disk under `.pi/sdlc/` (spec.md/json, adr/, memory.jsonl)
so it survives across sessions and is diffable/auditable — the "spec-as-code"
requirement from P1.

# zense-harness

> **zense (เซ็น)** พ้องเสียงกับ *sign* — ทุกงานที่สั่ง agent มีลายเซ็นมนุษย์กำกับ
> (spec approval = ลายเซ็นฝั่ง input, review packet = การอนุมัติฝั่ง output)

Pi extension implementing the AI-SDLC loop from `/PLAN.md`:

**spec → criteria → implementation → dual eval → exception review → learn**

One extension implements the harness; **"sub-agents" are isolated `pi -p`
subprocesses** spawned per phase task. This gives each phase task a clean
context window (no pollution from the main trajectory) and returns only the
finished artifact — exactly the harness design plan.md recommends.

## Phase map

| PLAN.md | Mechanism | Artifact |
|---|---|---|
| P1 Requirements — spec is the control surface | `zense_spec` tool (or `action:"compile_spec"` → requirements sub-agent) | `.pi/zense/spec.json` + `spec.md`, versioned, with machine-checkable criteria and **spec debt** |
| P1 gate — no implementation on unsigned spec | `tool_call` interceptor shows a 3-choice signing dialog: 🔏 sign & continue / ⚠ one-off override (trajectory flag) / ⛔ block; `zense_spec` also prompts to sign right after compiling | hard gate |
| P2 Design — ADRs prevent drift | `zense_adr` tool; ADRs re-read per tool call; `DENY: <path>` rules enforced live | `.pi/zense/adr/NNN-*.md` |
| P3 Implementation — usage meter | `turn_end` counts turns/tokens, surfaced in the widget | footer widget meter |
| P3 escalation taxonomy | `escalations[]` distinguishes need-permission / need-decision / something-wrong | `/zense status` |
| P4 Output eval — spec→eval closed loop | `zense_eval` → grader sub-agent judges each criterion PASS/FAIL | verdict text |
| P4 Trajectory eval | `agent_end` heuristics: test files modified/deleted, out-of-scope writes, retry storms | `trajectoryFlags` |
| P5 Review — exception-based, incident-report style | `zense_review` → reviewer sub-agent builds **review packet** (TL;DR first), rendered in transcript via `registerEntryRenderer` | card + entry |
| P6 Maintenance — learn | every review/escalation logged to `.pi/zense/memory.jsonl` | `/zense memory` |

## Human attention points (the scarce resource, per PLAN.md)

- **🔏 Signing dialog** — the signature happens *inside* the dialog the moment the spec is compiled (or when the gate fires): sign & continue in one shot, no extra command.
- **`/zense approve`** — only for signing later, if you chose "ยังไม่เซ็น" before.
- **`/zense status`** — one-glance: phase, gate, trajectory flags, escalations.
- Forced review items from `specDebt` surface in every eval report.
- Widget above the editor shows live turn/token consumption.

## Commands

| Command | Effect |
|---|---|
| `/zense status` | phase, spec version/approval, flags, escalations |
| `/zense approve` | sign current spec later (usually unnecessary — dialog covers it) |
| `/zense gate off` | disable the spec gate (escape hatch) |
| `/zense memory` | tail the learning log |

## Agent-facing tools

`zense_spec`, `zense_adr`, `zense_eval`, `zense_review` — each delegates the heavy
reasoning to an isolated sub-agent run of pi itself (guarded by
`PI_ZENSE_SUBAGENT=1` so sub-agents don't recurse into the harness).

## State

Persisted in-session via `pi.appendEntry("zense-state", …)` (restored on
resume/reload) and on disk under `.pi/zense/` (spec.md/json, adr/, memory.jsonl)
so it survives across sessions and is diffable/auditable — the "spec-as-code"
requirement from P1.

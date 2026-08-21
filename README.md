# pi-zense

> **Spec-gated, human-signed SDLC harness for pi.** Human attention is the scarcest resource in AI-driven development — pi-zense concentrates it at exactly two gates (spec approval, review) and automates everything between.

`pi-zense` (pi + **zense** / **เซ็น** / sign — ทุกครั้งที่สั่ง agent ทำงาน มีลายเซ็นของมนุษย์กำกับไว้เสมอ) bundles:

1. **`zense-harness`** — implements the AI-SDLC loop โดยมี human signature เป็นแกนกลาง: **spec → criteria → implementation → dual eval → exception review → learn**. Phase tasks are delegated to **isolated pi sub-agents** (`pi -p`, clean context per phase).
2. **`zense` theme** — dark theme built on the Zense design system (green `#00c55a` → lime `#6cdd25` → gold `#facd04` on near-black surfaces).

## Install

```bash
pi install git:github.com/zurge-co/pi-zense        # git
pi install npm:pi-zense                          # npm (when published)
pi -e ./pi-zense                                 # try without installing
```

Enable the theme: `/settings` → theme → `zense`, or set

```json
{ "theme": "zense" }
```

## zense-harness: what the harness does

| Phase (per PLAN.md) | Mechanism | Artifact |
|---|---|---|
| **1. Requirements** — spec is the contract | `zense_spec` tool; `action:"compile_spec"` delegates drafting to the requirements sub-agent | append-only archive `.pi/zense/specs/<timestamp>-v{n}-<slug>.{json,md}` (never overwritten) with machine-checkable criteria & **spec debt**; `.pi/zense/spec.{json,md}` = latest copies |
| **Gate** — never implement on unsigned spec | `tool_call` interceptor stops `write`/`edit` with a **3-choice signing dialog that renders the full spec inline** (Ctrl+D/U/F/B to read before deciding: 🔏 sign & continue / ⚠ one-off override / ⛔ block) | hard gate + dialog signature |
| **2. Design** — ADRs prevent architectural drift | `zense_adr` tool; `DENY: <path>` rules enforced live on every write; irreversible ADRs flagged for human approval | `.pi/zense/adr/NNN-*.md` |
| **3. Implementation** — escalation taxonomy | turn/token usage meter; escalation taxonomy: need-permission / need-decision / something-wrong | live widget meter |
| **4. Dual eval** — output *and* trajectory | `zense_eval` → grader sub-agent judges each criterion PASS/FAIL (closes spec→eval loop); **sub-agent output streams live into the transcript while it runs** — watch it anytime via `ctrl+r` / `/zense agents` (live tail of `.pi/zense/subagents/*.log`); `agent_end` heuristics catch reward hacking: modified test files, out-of-scope writes, retry storms | verdict + trajectory flags |
| **5. Review** — exception-based, not wall-of-diff | `zense_review` → reviewer sub-agent builds an incident-report-style **review packet** rendered as a transcript card (TL;DR first) | review packet card |
| **6. Maintenance** — learn every run | every escalation/flag/signing/eval-verdict/sub-agent-failure appended to `.pi/zense/memory.jsonl`; lessons are **fed back into `compile_spec`** so new specs reflect past incidents | `/zense memory` (grouped summary; `/zense memory json` = raw) |

### Human actions (by design: minimal)

```text
/zense status                 # one-glance: phase, gate, flags, escalations
# gate 1 happens IN the dialog — no command needed
/zense approve                # 🔏 sign later, only if you skipped the dialog
ctrl+r                        # watch sub-agent runs LIVE (grader/reviewer) — or /zense agents
/zense gate on|off            # escape hatch
/zense memory                 # grouped lesson summary (top flags / escalations / eval history); /zense memory json = raw tail
```

Then just tell the agent what to build; the harness gates, evaluates, and hands you a review packet.

## zense theme

Dark theme from the Zense design system: brand gradient green → lime → gold over near-black surfaces (`#0d0d0d` base, `#1a1a1a` panel). No commands — pi auto-discovers it via the package manifest's `pi.themes` entry; pick it in `/settings` → theme.

## Files

```
pi-zense/
├── package.json                  # pi manifest
├── extensions/
│   └── zense-harness/ index.ts, README.md
├── themes/
│   └── zense.json                # Zense design-system dark theme
└── docs/
    └── HUMAN-ACTIONS.md          # คู่มือมุมมองผู้ใช้ (ไทย)
```

Per-project runtime artifacts live under each repo's `.pi/zense/` (append-only `specs/` archive, ADRs, memory) — spec-as-code, diffable and auditable.

## License

MIT

# pi-zense

> **Spec-gated SDLC harness for pi.** Human attention is the scarcest resource in AI-driven development — pi-zense concentrates it at exactly two gates (spec approval, review) and automates everything between.

`pi-zense` (pi + **zense** / ぜんせ / Zen-sense รอบรู้ตลอดวงจร) bundles:

1. **`sdlc-harness`** — implements the AI-SDLC loop: **spec → criteria → implementation → dual eval → exception review → learn**. Phase tasks are delegated to **isolated pi sub-agents** (`pi -p`, clean context per phase).
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

## sdlc-harness: what the harness does

| Phase (per PLAN.md) | Mechanism | Artifact |
|---|---|---|
| **1. Requirements** — spec is the contract | `sdlc_spec` tool; `action:"compile_spec"` delegates drafting to the requirements sub-agent | append-only archive `.pi/sdlc/specs/<timestamp>-v{n}-<slug>.{json,md}` (never overwritten) with machine-checkable criteria & **spec debt**; `.pi/sdlc/spec.{json,md}` = latest copies |
| **Gate** — never implement on unapproved spec | `tool_call` interceptor blocks `write`/`edit` until a human runs `/sdlc approve` | hard gate |
| **2. Design** — ADRs prevent architectural drift | `sdlc_adr` tool; `DENY: <path>` rules enforced live on every write; irreversible ADRs flagged for human approval | `.pi/sdlc/adr/NNN-*.md` |
| **3. Implementation** — escalation taxonomy | turn/token usage meter; escalation taxonomy: need-permission / need-decision / something-wrong | live widget meter |
| **4. Dual eval** — output *and* trajectory | `sdlc_eval` → grader sub-agent judges each criterion PASS/FAIL (closes spec→eval loop); `agent_end` heuristics catch reward hacking: modified test files, out-of-scope writes, retry storms | verdict + trajectory flags |
| **5. Review** — exception-based, not wall-of-diff | `sdlc_review` → reviewer sub-agent builds an incident-report-style **review packet** rendered as a transcript card (TL;DR first) | review packet card |
| **6. Maintenance** — learn every run | escalations/reviews appended to `.pi/sdlc/memory.jsonl`; state persisted via session entries | `/sdlc memory` |

### Human actions (by design: minimal)

```text
/sdlc status                 # one-glance: phase, gate, flags, escalations
/sdlc approve                # 🔏 gate 1 — sign the spec contract
/sdlc gate on|off            # escape hatch
/sdlc memory                 # tail the learning log
```

Then just tell the agent what to build; the harness gates, evaluates, and hands you a review packet.

## zense theme

Dark theme from the Zense design system: brand gradient green → lime → gold over near-black surfaces (`#0d0d0d` base, `#1a1a1a` panel). No commands — pi auto-discovers it via the package manifest's `pi.themes` entry; pick it in `/settings` → theme.

## Files

```
pi-zense/
├── package.json                  # pi manifest
├── extensions/
│   └── sdlc-harness/ index.ts, README.md
├── themes/
│   └── zense.json                # Zense design-system dark theme
└── docs/
    └── HUMAN-ACTIONS.md          # คู่มือมุมมองผู้ใช้ (ไทย)
```

Per-project runtime artifacts live under each repo's `.pi/sdlc/` (append-only `specs/` archive, ADRs, memory) — spec-as-code, diffable and auditable.

## License

MIT

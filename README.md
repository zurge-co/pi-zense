# pi-zense

> **Spec-gated SDLC harness for pi.** Human attention is the scarcest resource in AI-driven development — pi-zense concentrates it at exactly two gates (spec approval, review) and automates everything between.

`pi-zense` (pi + **zense** / ぜんせ / Zen-sense รอบรู้ตลอดวงจร) bundles:

1. **`sdlc-harness`** — implements the AI-SDLC loop: **spec → criteria → implementation → dual eval → exception review → learn**. Phase tasks are delegated to **isolated pi sub-agents** (`pi -p`, clean context per phase).
2. **`thai-terminal` + `thai-looped-night` theme** — Thai-language font setup guide (IBM Plex Sans Thai Looped) and a dark theme tuned for it.

## Install

```bash
pi install git:github.com/zurge-co/pi-zense        # git
pi install npm:pi-zense                          # npm (when published)
pi -e ./pi-zense                                 # try without installing
```

Enable the theme: `/settings` → theme → `thai-looped-night`, or set

```json
{ "theme": "thai-looped-night" }
```

## sdlc-harness: what the harness does

| Phase (per PLAN.md) | Mechanism | Artifact |
|---|---|---|
| **1. Requirements** — spec is the contract | `sdlc_spec` tool; `action:"compile_spec"` delegates drafting to the requirements sub-agent | `.pi/sdlc/spec.{json,md}` versioned, with machine-checkable criteria & **spec debt** |
| **Gate** — never implement on unapproved spec | `tool_call` interceptor blocks `write`/`edit` until a human runs `/sdlc approve` | hard gate |
| **2. Design** — ADRs prevent architectural drift | `sdlc_adr` tool; `DENY: <path>` rules enforced live on every write; irreversible ADRs flagged for human approval | `.pi/sdlc/adr/NNN-*.md` |
| **3. Implementation** — budgeted autonomy | turn/token meter vs `/sdlc budget`; overage ⇒ abort + escalate (escalation taxonomy: need-permission / need-decision / something-wrong) | live widget meter |
| **4. Dual eval** — output *and* trajectory | `sdlc_eval` → grader sub-agent judges each criterion PASS/FAIL (closes spec→eval loop); `agent_end` heuristics catch reward hacking: modified test files, out-of-scope writes, retry storms | verdict + trajectory flags |
| **5. Review** — exception-based, not wall-of-diff | `sdlc_review` → reviewer sub-agent builds an incident-report-style **review packet** rendered as a transcript card (TL;DR first) | review packet card |
| **6. Maintenance** — learn every run | escalations/reviews appended to `.pi/sdlc/memory.jsonl`; state persisted via session entries | `/sdlc memory` |

### Human actions (by design: minimal)

```text
/sdlc status                 # one-glance: phase, gate, budget, flags, escalations
/sdlc approve                # 🔏 gate 1 — sign the spec contract
/sdlc budget 40 800000       # raise autonomy budget (turns tokens)
/sdlc gate on|off            # escape hatch
/sdlc memory                 # tail the learning log
```

Then just tell the agent what to build; the harness gates, budgets, evaluates, and hands you a review packet.

## thai-terminal: font & colors for Thai

- **Font: IBM Plex Sans Thai Looped** — full Thai script, "Looped" style for UI text, IBM Terminal builds with fixed cell widths so spaces/tabs/indentation stay grid-aligned. Strict-mono fallback: Sarasa Term Nerd Font.
- **Commands:** `/terminal-font [ghostty|kitty|wezterm|alacritty|iterm2|vscode]` prints the exact config snippet; `/thai-preview` generates an HTML preview (Thai text, combining-mark stress test, indent ruler, full palette); `/thai-theme` activates the theme for a project.
- Pi is a CLI and cannot set the terminal font itself — the extension guides the one-time terminal config instead.

## Files

```
pi-zense/
├── package.json                  # pi manifest
├── extensions/
│   ├── sdlc-harness/  index.ts, README.md
│   └── thai-terminal/ index.ts, README.md
├── themes/
│   └── thai-looped-night.json    # 51-token dark theme
└── docs/
    └── HUMAN-ACTIONS.md          # คู่มือมุมมองผู้ใช้ (ไทย)
```

Per-project runtime artifacts live under each repo's `.pi/sdlc/` (spec, ADRs, memory) — spec-as-code, diffable and auditable.

## License

MIT

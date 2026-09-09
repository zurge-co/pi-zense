# pi-zense

> **Spec-gated, human-signed SDLC harness for pi.** Human attention is the scarcest resource in AI-driven development — pi-zense concentrates it at exactly two gates: **signing the spec** and **reviewing the result**. Everything in between is automated.

"Zense" is Thai for **"sign"** — every run ships under a human signature.

## What you get

- **Spec as a contract** — a requirements sub-agent drafts machine-checkable acceptance criteria (probed for real, not guessed); nothing gets written to your repo until you 🔏 sign — right in the dialog, full spec rendered inline.
- **Isolated sub-agents per phase** — compile, grade, and review each run in clean `pi -p` contexts; watch them live with `ctrl+_`.
- **Worktree-per-session** — after signing, work happens in an auto-created `git worktree`; open two pi sessions in the same repo and they never clobber each other.
- **Dual eval** — deterministic probes + a grader sub-agent judge every criterion; trajectory heuristics catch reward hacking (test edits, out-of-scope writes, retry storms).
- **Human-in-command merge** — on eval PASS, work is **squashed and applied to `main` staged-but-uncommitted**. You review the staged diff, then `accept` or `discard` — the harness never auto-commits on `main`.
- **Memory that feeds back** — every flag, escalation, and verdict becomes a lesson that shapes the next spec.
- **zense theme** — a dark theme on the Zense design system (green → lime → gold over near-black).

## Install

```bash
pi install git:github.com/zurge-co/pi-zense   # git
pi install npm:pi-zense                       # npm (when published)
pi -e ./pi-zense                              # try without installing
```

Theme (optional): `/settings` → theme → `zense`.

## Quick start

```text
1. Tell the agent what to build       → it compiles a spec with checkable criteria
2. 🔏 Sign in the dialog (gate #1)    → read the spec inline, then sign or send back
3. Let it run                         → widget shows phase/turns/tokens; ctrl+_ to watch sub-agents
4. Review the packet (gate #2)        → TL;DR first, spec-debt and trajectory flags highlighted
5. Commit & `/zense accept` — or `/zense discard` to reverse-apply the patch exactly
```

If the agent tries to write code before the spec is signed, a 3-choice dialog stops it: 🔏 sign & continue / ⚠ one-off override / ⛔ block.

## Human cheat sheet

You only have two real jobs (🔏 sign, 📋 review). Everything else:

| Command | When | What it does |
|---|---|---|
| `/zense approve` | sign later, if you skipped the dialog | sign the current spec |
| `/zense status` | anytime | phase, gate, flags, pending apply |
| `ctrl+_` / `/zense agents` | while sub-agents run | live tail of grader/reviewer runs |
| `/zense accept` | after review & commit | close the pending apply, log post-review edits as lessons |
| `/zense discard` | review says no | reverse-apply the stored patch, restoring exact pre-apply state |
| `/zense gate on\|off` | emergency | toggle the spec gate |
| `/zense memory` | anytime | grouped lesson summary (`json` = raw) |
| `/zense distill` | anytime | compact `.zense`: confirm y/n (impact summary) → read-only distiller sub-agent condenses all of `memory.jsonl` into one lesson set (same JSONL format, parser untouched) → deletes `specs/` + `subagents/` history; never touches `adr/`, configs, or current spec; aborts without deleting if distillation fails |

## Files

```
pi-zense/
├── package.json                  # pi manifest
├── extensions/
│   └── zense-harness/ index.ts, README.md   # the harness (full docs here)
└── themes/
    └── zense.json                # Zense dark theme
```

Per-project runtime artifacts (spec archive, ADRs, memory) live under each repo's `.zense/` — spec-as-code, diffable and auditable.

## License

MIT

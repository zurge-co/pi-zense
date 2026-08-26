# Spec v2: Wave 2+3: trustworthy eval & evidence-grounded review pipeline
approved: false

## Intent
อัปเกรด grader/reviewer/requirements ตาม docs/SUBAGENT-UPGRADES.md — เป้าหมายคือ artifact ที่ส่งต่อกันใน pipeline เป็น machine-readable และเชื่อถือได้มากขึ้น: (1) grader+reviewer ถูกล็อก read-only (ขยาย SUBAGENT_EXCLUDE_TOOLS); (2) grader output ผ่าน parseGraderOutput (evidence-anchored: PASS ต้องมีหลักฐาน, ครบทุก criterion, มี OVERALL) พร้อม retry budget 3 และ inconclusive→escalate need-decision แทน silent PASS; (3) harness รัน acceptance probes ฝั่งตัวเองก่อนส่ง grader (runCheckProbes: คำสั่งจริงผ่าน sh, "path exists" resolve ในตัว) และบังคับ probe primacy — probe fail = criterion FAIL ทับ grader; (4) grader prompt ได้ diff summary + reward-hacking checklist + read-only notice (buildGraderPrompt); (5) reviewer ได้ evidence pack เต็ม (state.lastEval verdicts + probes + gitChangeSummary + flags + specDebt) ผ่าน buildReviewerPrompt พร้อม packet schema (TL;DR/Intent vs Impl/Risks/Rollback/Human actions) + validate ก่อนเก็บ; (6) requirements ได้ context priming (gatherRepoFacts: scripts/README/tree/test runner) + few-shot exemplar จาก spec ที่เคย signed ใน archive (loadSpecExemplar); (7) quality gate เพิ่มกฎ scope ที่ไม่มี path จริง → specDebt; (8) telemetry ลง memory ทุกขั้น (probes, grader coverage, probe overrides, packet sections)

## Scope
- extensions/zense-harness
- test
- package.json
- docs

## Constraints
- ห้ามเปลี่ยน semantics เดิมของ spec signing / gate / worktree merge / ADR / memory note formats ที่ aggregateMemory parse อยู่
- pure functions ใหม่ต้อง module scope + export + มี unit test (pattern เดิมของ test/spec-draft.test.mjs)
- grader retry/inconclusive ต้องไม่ทำให้ loop ตัน: inconclusive คืน isError + escalation ที่อ่านรู้เรื่อง โดย phase เดิมยังกลับมา eval ซ้ำได้
- defer ไว้ (บันทึกใน roadmap doc พร้อมเหตุผล): dual-draft compile, dual-grader agreement, calibration loop, prompts-as-files, per-role thinking defaults, generic launchUntilValid
- คง format output เดิมของ grader ให้ backward compatible กับ criteria เก่า (เพิ่มเติมคือ evidence บังคับ + ครบทุก id)

## Acceptance criteria
- [ ] C1: unit test ใหม่ครอบคลุม parseGraderOutput (missing ids, PASS ไม่มี evidence, overall หาย), runCheckProbes (path exists/pass/fail/skip), parseReviewerPacket, gatherRepoFacts, loadSpecExemplar, scope-missing ใน applyQualityGate และ test เดิมทั้งหมดยังผ่าน *(check: npm test)*
- [ ] C2: grader+reviewer ถูกล็อก read-only ผ่าน SUBAGENT_EXCLUDE_TOOLS *(check: grep -nE '(grader|reviewer):.*"write"' extensions/zense-harness/index.ts)*
- [ ] C3: zense_eval ใช้ runCheckProbes + parseGraderOutput + retry loop + escalate เมื่อ inconclusive + probe override (>=6 จุดอ้างอิง) *(check: grep -cE 'runCheckProbes|parseGraderOutput|inconclusive|lastEval' extensions/zense-harness/index.ts | awk '$1>=6')*
- [ ] C4: zense_review สร้าง prompt ผ่าน buildReviewerPrompt ที่ใส่ evidence (lastEval, git, flags, specDebt) และ validate packet ด้วย parseReviewerPacket *(check: grep -cE 'buildReviewerPrompt|parseReviewerPacket' extensions/zense-harness/index.ts | awk '$1>=4')*
- [ ] C5: requirements ได้ context priming + exemplar: compile_spec เรียก gatherRepoFacts/loadSpecExemplar แล้วส่งเข้า buildRequirementsPrompt *(check: grep -cE 'gatherRepoFacts|loadSpecExemplar' extensions/zense-harness/index.ts | awk '$1>=4')*
- [ ] C6: โมดูล import ได้สะอาดไม่มี type error *(check: node --experimental-strip-types -e "import('./extensions/zense-harness/index.ts').then(()=>console.log('import-ok'))")*

## Spec debt (human-verified only)
- คุณภาพจริงของ grader/reviewer หลัง prompt ใหม่ (anti-reward-hacking, evidence ที่ cite มา) ขึ้นกับ model — verify ด้วยอ่าน .pi/zense/subagents/*-grader.log / *-reviewer.log จากรอบนี้เอง
- inconclusive→need-decision UX ตรวจได้เต็มเมื่อ grader output พังจริง — manual verify ตอนเจอเคส
- context priming/exemplar ทำให้ spec ดีขึ้นจริงไหม วัดได้จาก spec-compile telemetry + ความแม่นของ criteria รอบถัดๆ ไป (ไม่ใช่งานนี้)


## Eval 2026-08-26T06:11:13.539Z
verdict: **PASS** (grader.ok=true)
per-criteria:
- C1: ?
- C2: ?
- C3: ?
- C4: ?
- C5: ?
- C6: ?

grader output:
[session 01a03cb1-1cb8-765e-8a1b-2531a219fd79]




⚙ bash {"command":"ls /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zense-wt-2026-08-26T05-58-16 && echo --- && ls /User…

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zense-wt-2026-08-26T05-58-16 && wc -l extensions/zen…




⚙ bash {"command":"cd /Users/saint/zurge/pi-zense && ls; echo ---; cd /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zens…

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zense-wt-2026-08-26T05-58-16 && grep -n 'parseGrader…




⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zense-wt-2026-08-26T05-58-16 && timeout 300 npm test…

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zense-wt-2026-08-26T05-58-16 && grep -nE '(grader|re…



⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zense-wt-2026-08-26T05-58-16 && npm test 2>&1 | tail…



⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zense-wt-2026-08-26T05-58-16 && grep -n 'test(' test…




⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zense-wt-2026-08-26T05-58-16 && sed -n 1,70p test/ev…

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zense-wt-2026-08-26T05-58-16 && sed -n 1630,1740p ex…




⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zense-wt-2026-08-26T05-58-16 && sed -n 608,650p exte…

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/.pi/zense/worktree/pi-zense-wt-2026-08-26T05-58-16 && node --experimental-…


C1: PASS: test/eval-review.test.mjs has real tests importing actual fns — parseGraderOutput missing ids/OVERALL/PASS-no-evidence, runCheckProbes path-exists pass/fail + run pass/fail + manual skip, parseReviewerPacket, gatherRepoFacts, loadSpecExemplar, applyQualityGate scope-missing; npm test → 41 pass 0 fail
C2: PASS: grep matches index.ts:358-359 `grader: ["write", "edit"]` and `reviewer: ["write", "edit"]` in SUBAGENT_EXCLUDE_TOOLS
C3: PASS: grep count 19 (≥6); zense_eval runs runCheckProbes→ground truth, 3-launch retry loop with feedback, escalates "need-decision" when inconclusive, probe-override forces FAIL (probeOverrides)
C4: PASS: grep count 5 (≥4); buildReviewerPrompt embeds lastEval verdicts/probes + gitSummary + flags + specDebt, zense_review builds it at line ~1771 and validates/validates-retries via parseReviewerPacket
C5: PASS: grep count 4 (≥4); compile_spec calls gatherRepoFacts(ctx.cwd) + loadSpecExemplar(ctx.cwd) (lines 1524-1525) and splices both into buildRequirementsPrompt(intent, lessons, facts, exemplar)
C6: PASS: node --experimental-strip-types import of extensions/zense-harness/index.ts printed "import-ok" with no type errors
OVERALL: PASS

# Spec v1: Interactive models picker in /zense models (TUI)
approved: false

## Intent
ผู้ใช้ต้องการตั้งค่า model ของ sub-agent แยกตาม role ผ่าน TUI โดยตรง ไม่ต้องแก้ .pi/zense/models.json เองด้วยมือ — ลด friction และลดโอกาสพิมพ์ model pattern ผิด

## Scope
- extensions/zense-harness/index.ts

## Constraints
- ไม่แตะ logic ของ runSubagent / resolveModelPattern (ยังคง fallback เดิม: config → ctx.model → pi default)
- ยังรองรับ models.json แบบเดิมที่เขียนเองด้วยมือ
- non-TUI mode ต้องยังใช้งานได้ (fallback เป็น read-only summary เดิม)

## Acceptance criteria
- [ ] tui-role-select: /zense models ใน TUI mode เปิด dialog ให้เลือก role (requirements/grader/reviewer) พร้อม description แสดง model ปัจจุบันของแต่ละ role *(check: grep: index.ts มี ctx.ui.select ใน handler ของ models subcommand)*
- [ ] tui-model-select: เลือก role แล้วมี dialog เลือก model จาก ctx.scopedModels (fallback ctx.modelRegistry.getAvailable()) บวก option 'ใช้ model หลัก (ลบ override)' และ 'พิมพ์ pattern เอง' (ctx.ui.input) *(check: grep: index.ts ใช้ scopedModels หรือ modelRegistry.getAvailable และมี input fallback)*
- [ ] write-config: เมื่อเลือก model ระบบเขียน .pi/zense/models.json (สร้าง dir ถ้ายังไม่มี) และ resolveModelPattern คืนค่า pattern ใหม่ทันที *(check: node -e test: เขียน config แล้ว readModelsConfig/resolveModelPattern อ่านได้)*
- [ ] clear-override: เลือก 'ใช้ model หลัก' จะลบ key ของ role นั้นออกจาก models.json *(check: node -e test: clear แล้ว readModelsConfig ไม่มี key นั้น)*
- [ ] non-tui-fallback: non-TUI mode ยังแสดง summary เดิมผ่าน ctx.ui.notify *(check: grep: notify summary path ยังอยู่)*

## Spec debt (human-verified only)



## Eval 2026-08-21T06:54:19.860Z
verdict: **PASS** (grader.ok=true)
per-criteria:
- tui-role-select: ?
- tui-model-select: ?
- write-config: ?
- clear-override: ?
- non-tui-fallback: ?

grader output:
[session 01a02318-978b-71b1-a2d0-1f159ca94c02]

⚙ bash {"command":"ls /Users/saint/zurge/pi-zense && ls /Users/saint/zurge/pi-zense/index.ts 2>/dev/null; find /Users/saint/…

⚙ read {"path":"/Users/saint/zurge/pi-zense/extensions/zense-harness/index.ts"}

⚙ read {"path":"/Users/saint/zurge/pi-zense/extensions/zense-harness/index.ts","offset":1011}
Now let me run functional tests for write-config and clear-override:
⚙ bash {"command":"cd /Users/saint/zurge/pi-zense && ls node_modules/.bin | head -30; node --version"}

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense && grep -n \"scopedModels\\|modelRegistry.getAvailable\\|ctx.ui.input\\|ct…

⚙ bash {"command":"ls /Users/saint/zurge/pi-zense/node_modules | head; cat /Users/saint/zurge/pi-zense/package.json"}

⚙ write {"path":"/tmp/zense-test/test.ts","content":"import { mkdtempSync, existsSync, readFileSync } from \"node:fs\";\nimpo…

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense && node --experimental-strip-types /tmp/zense-test/test.ts 2>&1 | grep -v …

⚙ bash {"command":"rm -rf /tmp/zense-test"}
tui-role-select: PASS: /zense models TUI branch (line ~1111) opens a SelectList dialog via zensePick listing roles requirements/grader/reviewer with per-role descriptions showing the current model (`cfg[r] (จาก config)` or `${mainModel} (fallback)`); implemented via ctx.ui.custom+SelectList rather than literal ctx.ui.select, but the dialog functionality is fully present.
tui-model-select: PASS: availableModelChoices (lines 334-350) uses ctx.scopedModels with fallback ctx.modelRegistry.getAvailable(); picker list includes '↩️ ใช้ model หลัก (ลบ override)' (__default__) and '✏️ พิมพ์ pattern เอง' (__custom__) which falls back to ctx.ui.input (line 1142).
write-config: PASS: node test — writeModelsConfig created .pi/zense/models.json in a fresh dir (mkdir recursive), readModelsConfig returned {"grader":"openai/gpt-4o-mini"}, and resolveModelPattern returned the new pattern immediately instead of the main-model fallback.
clear-override: PASS: node test — writeModelsConfig(cwd,"grader",null) deleted the grader key; readModelsConfig returned {"reviewer":"sonnet:high"} with grader key gone and the other role's key preserved.
non-tui-fallback: PASS: in /zense models handler, `if (ctx.mode !== "tui")` branch still builds the summary lines and returns via ctx.ui.notify(lines.join("\n"), "info").
OVERALL: PASS

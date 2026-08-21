# Spec v2: ทำให้ reviewer sub-agent ถูกเรียกจริงหลัง eval PASS
approved: false

## Intent
reviewer ไม่เคยถูก spawn เพราะไม่มีอะไรบอก main agent ให้เรียก zense_review หลัง eval PASS (มีไฟล์ log ของ grader อย่างเดียวใน .pi/zense/subagents/) — แก้โดยให้ output ของ zense_eval ตอน PASS สั่ง explicit ว่าต้องเรียก zense_review เป็นขั้นต่อไป (ห้ามจบงานก่อน) เหมือนที่ FAIL branch ทำ และเพิ่ม guard ว่าถ้าเรียก zense_review ก่อน eval ผ่านให้เตือน

## Scope
- extensions/zense-harness/index.ts

## Constraints


## Acceptance criteria
- [ ] c1: PASS branch ของ zense_eval return ข้อความที่สั่ง explicit ให้เรียก zense_review เป็นขั้นต่อไป (ห้ามตอบ user จบงานก่อน) *(check: grep หน้า return report มีคำสั่งเรียก zense_review)*
- [ ] c2: zense_review มี guard: ถ้า state.phase ยังไม่ถึง review (ยังไม่ eval ผ่าน) ให้เตือน/บล็อกพร้อมบอกให้ไป eval ก่อน *(check: grep ใน zense_review execute มีการเช็ก state.phase)*
- [ ] c3: ไม่มี type error ใหม่ (เหลือ 2 errors เดิมที่มีอยู่ก่อน) *(check: npx tsc เทียบกับ baseline 2 errors เดิม)*

## Spec debt (human-verified only)



## Eval 2026-08-21T08:09:27.121Z
verdict: **PASS** (grader.ok=true)
per-criteria:
- c1: ?
- c2: ?
- c3: ?

grader output:
[session 01a0235d-831a-724e-85d4-152299510267]




⚙ bash {"command":"find /Users/saint/zurge/pi-zense -type f -name \"*.ts\" | head -50"}

⚙ bash {"command":"ls /Users/saint/zurge/pi-zense/"}




⚙ bash {"command":"find /Users/saint/zurge/pi-zense/extensions -type f | head -50"}

⚙ read {"path":"/Users/saint/zurge/pi-zense/extensions/zense-harness/index.ts"}




⚙ read {"path":"/Users/saint/zurge/pi-zense/extensions/zense-harness/index.ts","offset":1005}

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense && npx tsc --noEmit 2>&1 | head -50","timeout":60}




⚙ bash {"command":"cd /Users/saint/zurge/pi-zense && cat tsconfig.json 2>/dev/null || echo \"no tsconfig.json\""}

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense && npx tsc -p tsconfig.json --noEmit 2>&1 | tail -30","timeout":60}




⚙ bash {"command":"find /Users/saint/zurge/pi-zense -name \"tsconfig.json\" 2>/dev/null"}

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/extensions/zense-harness && npx tsc --noEmit 2>&1 | tail -30","timeout":60}




⚙ read {"path":"/Users/saint/zurge/pi-zense/package.json"}

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense && cat package.json"}



⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/extensions/zense-harness && npx tsc --noEmit --moduleResolution node --tar…
✗ bash failed



⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/extensions/zense-harness && npx tsc --noEmit --target ES2022 --module ESNe…
✗ bash failed





⚙ bash {"command":"grep -n \"zense_review\" /Users/saint/zurge/pi-zense/extensions/zense-harness/index.ts"}

⚙ bash {"command":"grep -n \"state.phase\" /Users/saint/zurge/pi-zense/extensions/zense-harness/index.ts | grep -i \"review\""}

⚙ bash {"command":"cd /Users/saint/zurge/pi-zense/extensions/zense-harness && npx tsc --noEmit --target ES2022 --module ESNe…


c1: PASS: line 988-989 PASS branch report returns explicit instruction "เรียก \`zense_review\` ทันที… ห้ามสรุปร/ตอบ user จบงานก่อนจนกว่าจะเรียก zense_review แล้ว"
c2: PASS: line 1003 guard `if (state.phase !== "review")` blocks and returns error telling user to call zense_eval first
c3: PASS: tsc shows exactly 2 errors in index.ts (line 499 usage, line 900 missing details) — no new type errors beyond baseline
OVERALL: PASS

# Spec v3: Zense Memory upgrade: full capture + grouped summary + learning loop back to spec
approved: false

## Intent
ตอนนี้ memory.jsonl มีค่าเก็บแค่ review packet ทำให้ Phase 6 "เรียนรู้ทุก run" เป็นเพียง design ต้องครบ 3 ชั้น: (1) passive capture — learn() อัตโนมัติทุกเหตุการณ์สำคัญ (escalation, trajectory flag, เซ็น/override spec, sub-agent fail, eval verdict) (2) /zense memory สรุปเป็นกลุ่มอ่านรู้เรื่อง แทน raw JSON tail (เก็บ /zense memory json ไว้ดูดิบ) (3) learning loop — compile_spec ป้อนบทเรียนจาก memory เข้า prompt ของ requirements sub-agent และ sign dialog แสดงว่า spec ถูก feeds ด้วยบทเรียนกี่ข้อ

## Scope
- extensions/zense-harness/
- README.md
- docs/
- extensions/zense-harness/README.md

## Constraints
- memory.jsonl ยัง append-only JSONL (รูปแบบเดิม {at,phase,note}) ไฟล์เก่าอ่านได้
- รูปแบบ note เป็นเทมเพลตคงที่ (escalation:/flag:/signed/override/sub-agent failed/eval) เพื่อให้ summary parse ได้
- ไม่เปลี่ยน semantics ของ gate/dialog อื่น; lessons ไปอยู่ใน prompt เท่านั้น sub-agent ตัดสินใจเองว่าจะสะท้อนไหม
- เก็บ TS error baseline ไว้ (2 pre-existing นอกขอบเขต) ไม่เพิ่ม error ใหม่

## Acceptance criteria
- [ ] C1: learn() ถูกเรียกจากทุกเหตุการณ์: escalation, trajectory flag, spec signed, unsigned override, sub-agent failed, eval verdict *(check: grep learn(ctx ใน index.ts ครบ ≥6 call sites ตาม list)*
- [ ] C2: /zense memory แสดงสรุปแบบกลุ่ม (top flags, escalations by kind, eval history, sub-agent failures, จำนวนรวม) และ /zense memory json ยังแสดง raw tail *(check: run aggregator กับ fixture memory.jsonl ผ่าน node script ได้ผลสรุปถูกต้อง + grep memory json branch)*
- [ ] C3: zense_spec compile_spec แนบบทเรียนจาก memory เข้า prompt sub-agent เมื่อ memory ไม่ว่าง และ sign dialog มี hint จำนวนบทเรียนที่ถูก feed *(check: grep lessons ใน compile path + specSignDialog hint; fixture ทดสอบ memory ว่าง/ไม่ว่าง)*
- [ ] C4: ไม่มี TS error ใหม่เทียบ baseline 2 errors *(check: tsc /tmp/zense-check error count ≤ 2 หลังแก้)*

## Spec debt (human-verified only)
- การ parse summary ใน /zense memory ต้องดู TUI จริงด้วยตาหลัง reload
- คุณภาพของการสะท้อนบทเรียนใน spec ขึ้นกับ requirements sub-agent — วัดได้แค่สังเกต behavior

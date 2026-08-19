# Spec v2: Zense gate UX: dialog คือลายเซ็น — ไม่ต้องกด /zense approve ย้ำ
approved: false

## Intent
ตอน spec ถูกนำเสนอ dialog ปัจจุบันถามแค่ Block yes/no (คำถามสลับขั้ว) พอกดแล้ว spec ไม่ได้ approve — user ต้องพิมพ์ /zense approve ย้ำอีกครั้ง ต้องการให้ "ช่วงเวลาเซ็น" คือ dialog เดียวจบ: เลือกอนุมัติตรงนั้นเลย spec ก็ approved และทำงานต่อได้ทันที ตามแนวคิด zense(เซ็น)=signature

## Scope
- extensions/zense-harness/
- README.md
- docs/

## Constraints
- fail-safe: print mode (no UI) ต้อง block เหมือนเดิม
- ยังเก็บ /zense approve เป็นทางเลือก manual ไว้
- เก็บ escape hatch: อนุญาตเฉพาะรอบเดียวโดยไม่เซ็น (overrride) + บันทึก trajectory flag

## Acceptance criteria
- [ ] approve-in-spec-tool: zense_spec (action=set) แสดง dialog ให้เซ็นอนุมัติทันทีหลังเขียน spec files — ถ้าเลือกอนุมัติ spec.approved=true และ phase=implementation *(check: grep -q 'ctx.ui.select' extensions/zense-harness/index.ts && grep -A5 'เซ็นอนุมัติ' extensions/zense-harness/index.ts | grep -q 'approved')*
- [ ] gate-3-choice: tool_call gate ใช้ select 3 ทางเลือก (เซ็น+ทำต่อ / override รอบเดียว / block) แทน confirm yes/no เดิม *(check: ! grep -q 'Block ' extensions/zense-harness/index.ts && grep -q 'override' extensions/zense-harness/index.ts)*
- [ ] helper-reuse: มี helper เดียวสำหรับ approve ที่ถูกใช้ร่วมกันโดย zense_spec, gate, และ /zense approve command *(check: grep -cq 'approveCurrentSpec' extensions/zense-harness/index.ts)*
- [ ] docs-sync: docs/README เล่า flow ใหม่: เซ็นจาก dialog ได้เลย /zense approve เป็น optional *(check: grep -qi 'dialog' docs/HUMAN-ACTIONS.md)*

## Spec debt (human-verified only)
- พฤติกรรมจริงของ select dialog ใน TUI ต้องทดสอบ interactive หลัง /reload

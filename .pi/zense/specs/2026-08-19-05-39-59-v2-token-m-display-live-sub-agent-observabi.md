# Spec v2: Token M-display + live sub-agent observability + fix sub-agent launch hang
approved: false

## Intent
สามปัญหา: (1) widget แสดง token เป็น k เสมอ เกิน 1000k แล้วอ่านยาก ต้องขึ้น M (2) sub-agent (grader/reviewer) รันนาน ผู้ใช้ไม่รู้ว่าค้างหรือกำลังทำงาน ต้องการดู live ระหว่างที่มันรัน ไม่ใช่รอจบ (3) sub-agent launch พังเงียบๆ — root cause พบแล้ว: spawn ผ่าน execFile ทิ้ง stdin pipe เปิดไว้ pi print mode รอ stdin EOF เลยค้างจนโดน SIGTERM ตอน timeout (ยืนยันแล้วว่า stdio ignore stdin รันจบใน 3 วินาที)

## Scope
- extensions/zense-harness/
- README.md
- docs/
- extensions/zense-harness/README.md

## Constraints
- ใช้ pi extension API สาธารณะเท่านั้น; shortcut ใช้ ctrl+shift+a (ไม่ชน built-in ตาม keybindings.md)
- sub-agent log ต้องเขียน live ระหว่างรัน (ไม่ใช่เขียนตอนจบ) เพื่อให้ tail ดูได้
- รักษา semantics เดิมของ runSubagent callers พร้อม fallback behavior เมื่อ launch ล้ม
- ไม่แก้ pre-existing TS errors 3 ตัว (usage/details) — เก็บ error set ไว้เท่าเดิมเป็นบรรทัดฐาน

## Acceptance criteria
- [ ] C1: widget แสดง token เมื่อ ≥1,000,000 เป็นรูปแบบ X.XM และต่ำกว่านั้นเป็น k เหมือนเดิม *(check: grep fmt-tokens helper ใน index.ts และ widget ใช้ helper นั้น; unit test ตัวเลข: 999000→'999k', 1_000_000→'1.0M', 2400000→'2.4M')*
- [ ] C2: runSubagent เขียน log live ไป .pi/zense/subagents/<stamp>-<role>.log ระหว่างรัน ด้วย spawn + stdio ignore stdin และ failure message มี signal/exit code/killed *(check: grep spawn/stdio ignore ใน index.ts; รัน sub-agent จริงแล้วไฟล์ log โผล่ทันทีและมีข้อความสะสม)*
- [ ] C3: ระหว่าง zense_eval รัน grader ผู้ใช้เห็น progress สดใน transcript ผ่าน tool onUpdate (throttled tail) และ widget แสดง active run (role + เวลาที่รันมา) *(check: grep onUpdate ใน zense_eval execute + widget แสดง running sub-agent)*
- [ ] C4: เปิดดู sub-agent สดได้ทั้งทางปุ่มลัด ctrl+shift+a และ /zense agents — มี live-tail viewer (auto refresh ~1s, Esc ปิด) *(check: grep registerShortcut ctrl+shift+a และ live tail reader ใน index.ts)*
- [ ] C5: spawn sub-agent จริงจาก node harness เดิมสำเร็จ (ไม่ค้าง) *(check: script node spawn ทดสอบรันจบ <30s ได้ stdout)*
- [ ] C6: ไม่มี TS error ใหม่เมื่อเทียบ baseline 3 errors เดิม *(check: tsc ใน /tmp/zense-check เดิม error count = 3 เหมือนเดิม)*

## Spec debt (human-verified only)
- UX จริงของ viewer/shortcut ใน TUI ต้องเทสด้วยตาหลัง reload extension
- ระยะ throttle ของ onUpdate อาจต้องปรับตามความรู้สึกจริง

# Spec v1: Spec dialog scroll keys สำรอง (PgUp/PgDn กดไม่ได้ในบาง terminal)
approved: false

## Intent
Dialog เซ็น spec บอกให้กด PgUp/PgDn แต่ terminal หลายตัวไม่ส่ง key นี้ ทำให้อ่าน spec ไม่ครบก่อนเซ็น — ต้องมีปุ่มเลื่อนสำรองที่กดได้แน่ๆ ในทุก terminal session

## Scope
- extensions/zense-harness/index.ts

## Constraints
- ไม่แตะ SelectList (ลูกศรขึ้นลง/Enter/Esc ต้องทำงานเหมือนเดิม)
- ต้อง compile TypeScript ผ่าน

## Acceptance criteria
- [ ] c1: เลื่อนลง/ขึ้นทั้งหน้าได้ด้วย Space และ b (แบบ less) นอกเหนือจาก PgUp/PgDn เดิม *(check: รองรับ Space, b, PgUp, PgDn ใน handleInput)*
- [ ] c2: เลื่อนครึ่งหน้าด้วย Ctrl+D / Ctrl+U (แบบ vim/less) *(check: รองรับ ctrl+d, ctrl+u)*
- [ ] c3: กระโดดไปต้น/ท้ายด้วย g / Home / End *(check: รองรับ g, home, end)*
- [ ] c4: ข้อความ hint ใน dialog แสดงปุ่มใหม่ที่กดได้จริง *(check: hint ระบุ Space/b และ Ctrl+D/U)*
- [ ] c5: TypeScript typecheck ไม่มี error *(check: tsc --noEmit ผ่าน)*

## Spec debt (human-verified only)


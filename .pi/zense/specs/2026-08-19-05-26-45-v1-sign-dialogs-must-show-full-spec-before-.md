# Spec v1: Sign dialogs must show full spec before approval
approved: false

## Intent
ตอนนี้ทุกจุดที่ขอลายเซ็น spec (zense_spec dialog, gate dialog ตอน write โดนบล็อก, /zense approve) แสดงแค่ชื่อ spec ในหัวข้อ dialog แล้วบังคับให้กด approve โดยไม่ได้อ่าน — ลายเซ็นจึงไม่มีนัย ต้องเปลี่ยนให้ dialog แสดง spec เต็มฉบับ (intent, scope, constraints, criteria, specDebt) อ่านครบและเลื่อนดูได้ ก่อนเลือกเซ็น/ไม่เซ็น

## Scope
- extensions/zense-harness/

## Constraints
- ไม่เปลี่ยน semantics ของ gate (เซ็น=เปิด gate, override=trajectory flag, esc/ไม่เลือก=บล็อกตามเดิม)
- ใช้เฉพาะ pi extension API สาธารณะ (ctx.ui.custom ใน TUI mode; fallback เป็น select/confirm เดิมใน RPC/print mode)
- spec ต้องถูก archive ลง .pi/zense/specs/ ก่อน dialog เด้ง เพื่อให้อ่านจากไฟล์ได้เสมอ

## Acceptance criteria
- [ ] C1: ทั้ง 3 จุดเซ็น (zense_spec execute, write-gate dialog, /zense approve) ใน TUI mode แสดง dialog ที่ render spec เต็มฉบับผ่าน renderSpecMd ก่อนเลือก *(check: grep 'specSignDialog' extensions/zense-harness/index.ts — ต้องมี call site 3 แห่งและ helper render ผ่าน Markdown(renderSpecMd(spec)))*
- [ ] C2: dialog เลื่อนอ่าน spec ได้ (PgUp/PgDn) และมี key legend *(check: grep pageDown/pageUp ใน index.ts handleInput ของ dialog)*
- [ ] C3: โค้ด compile ผ่าน (TypeScript ไม่มี error ใหม่) *(check: npx tsc --noEmit หรือเทียบเท่าใน extensions/zense-harness)*
- [ ] C4: RPC/print mode ไม่ล้ม: fallback ใช้ select/confirm/paths เดิมเมื่อ ctx.mode !== 'tui' *(check: grep ctx.mode === "tui" guard ครอบ ctx.ui.custom)*

## Spec debt (human-verified only)
- การ render จริงใน TUI (layout, scrollbar indication) ต้องให้คนเทสด้วยตา ไม่มี automated UI test

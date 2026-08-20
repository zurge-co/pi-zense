# Spec v1: Spec dialog scroll keys + ความสูง
approved: false

## Intent
ตอนอ่าน spec ใน specSignDialog เลื่อนขึ้นลงยากเพราะ PgUp/PgDn บน macOS ต้องกด fn+ลูกศร และ terminal บางตัวจับไป scroll เอง อยากให้มี key+arrow (Shift/Ctrl + ลูกศร) เป็นทางเลือกที่กดได้แน่ๆ ทุก session และอยากให้เนื้อ spec ใน dialog สูงกว่าเดิม (ตอนนี้ cap ที่ 24 บรรทัด) เพื่ออ่านได้ยาวขึ้นโดยไม่ต้องเลื่อนบ่อย

## Scope
- extensions/zense-harness/

## Constraints
- plain ↑/↓ ต้องยังใช้เลือกตัวเลือกเซ็นใน SelectList ได้ (ห้ามแย่ง)
- คีย์เดิม (Space/b/PgUp/PgDn/Ctrl+D/Ctrl+U/g/Home/End) ต้องยังทำงานเหมือนเดิม
- เปลี่ยนเฉพาะ specSignDialog ใน zense-harness/index.ts ห้ามกระทบ tailViewer หรือ dialog อื่น

## Acceptance criteria
- [ ] C1: specSignDialog รับ Shift+↑ เลื่อนขึ้น 1 บรรทัด และ Shift+↓ เลื่อนลง 1 บรรทัด (offset เปลี่ยน ±1 โดย clamp ที่ [0, maxOffset]) *(check: rg 'Key.shift\("up"\)|Key.shift\("down"\)' extensions/zense-harness/index.ts พบทั้งคู่ และ logic ใช้ offset - 1 / offset + 1)*
- [ ] C2: specSignDialog รับ Ctrl+↑ เลื่อนขึ้นครึ่งหน้า และ Ctrl+↓ เลื่อนลงครึ่งหน้า (เท่ากับ Ctrl+U/Ctrl+D ที่มีอยู่แล้ว) *(check: rg 'Key.ctrl\("up"\)|Key.ctrl\("down"\)' extensions/zense-harness/index.ts พบทั้งคู่)*
- [ ] C3: plain ↑/↓ ยังถูกส่งให้ SelectList (ไม่ถูก intercept) เพื่อเลือกตัวเลือกเซ็นได้ *(check: ตรวว่าไม่มี matchesKey(data, Key.up)/Key.down ในบล็อก scroll — else สุดท้ายยังเรียก selectList.handleInput(data))*
- [ ] C4: ความสูงเนื้อ spec (bodyRows) ไม่ถูก cap ที่ 24 อีก และใช้พื้นที่ terminal ได้มากขึ้น *(check: rg 'Math.min\(24' extensions/zense-harness/index.ts ในบรรทัด bodyRows หายไป; bodyRows ใช้ tui.terminal.rows - ตัวเลข reserve)*
- [ ] C5: ข้อความ range/hint ใน dialog อัปเดตให้บอกปุ่มใหม่ (Shift+↑/↓, Ctrl+↑/↓) *(check: rg 'Shift|Ctrl' ในบรรทัด range ของ specSignDialog พบ)*
- [ ] C6: TypeScript compile ผ่าน ไม่มี type error ใหม่ *(check: npx tsc --noEmit (หรือ build command ของโปรเจกต์) ผ่าน)*

## Spec debt (human-verified only)
- ปุ่ม Shift+arrow/Ctrl+arrow อาจถูก terminal บางตัว (เช่น Terminal.app เก่า) ไม่ส่ง modifier เข้ามา ต้อง verify บนเครื่อง user จริง

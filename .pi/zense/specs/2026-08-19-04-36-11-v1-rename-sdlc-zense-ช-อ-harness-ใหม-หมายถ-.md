# Spec v1: Rename sdlc → zense (ชื่อ harness ใหม่ หมายถึง เซ็น = ลายเซ็นมนุษย์)
approved: false

## Intent
เปลี่ยนคำเรียก harness เดิม "sdlc" เป็น "zense" (อ่านว่า เซ็น พ้องเสียง sign) — สื่อว่าทุกครั้งที่สั่ง agent ทำงาน จะมี human sign (ลายเซ็น) กำกับไว้ ครอบคลุมชื่อ tool, คำสั่ง slash, โฟลเดอร์ extension, state directory, env var, widget label และเอกสารทั้งหมด

## Scope
- extensions/
- README.md
- docs/
- package.json
- .pi/

## Constraints
- เก็บคำว่า SDLC ไว้เฉพาะเมื่ออ้างถึงแนวคิด software development lifecycle ทั่วไป (ไม่ใช่ชื่อ harness)
- behavior เดิมทั้งหมดต้องทำงานเหมือนเดิม เปลี่ยนแค่ naming
- ย้าย .pi/sdlc/ → .pi/zense/ ของ repo นี้ด้วย

## Acceptance criteria
- [ ] renamed-identifiers: tool names เป็น zense_spec/zense_adr/zense_eval/zense_review และ command เป็น /zense *(check: grep -q '"zense_spec"\|name: "zense_spec"' extensions/zense-harness/index.ts 2>/dev/null || grep -q 'zense_spec' extensions/zense-harness/index.ts)*
- [ ] no-sdlc-identifier: ไม่มี identifier/string 'sdlc' (ตัวพิมพ์เล็ก) เหลือในซอร์สและ docs (ยกเว้น .git/) *(check: ! grep -ri 'sdlc' extensions docs README.md package.json)*
- [ ] dir-renamed: extension dir เป็น extensions/zense-harness และ runtime dir .pi/zense/ *(check: test -d extensions/zense-harness && test -d .pi/zense && ! test -d extensions/sdlc-harness && ! test -d .pi/sdlc)*
- [ ] docs-updated: README.md, docs/HUMAN-ACTIONS.md และ extension README อธิบาย zense (= เซ็น, human signature) *(check: grep -q 'zense' README.md && grep -q 'zense' docs/HUMAN-ACTIONS.md && grep -q '/zense' docs/HUMAN-ACTIONS.md)*
- [ ] typescheck: index.ts compile ผ่านด้วย tsc (ถ้ามี tsconfig/dev deps) *(check: manual)*

## Spec debt (human-verified only)
- พฤติกรรม interactive ของ /zense commands ใน TUI ต้องทดสอบจริงหลัง /reload

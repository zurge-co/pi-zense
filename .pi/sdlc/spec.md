# Spec v1: Harden sdlc-harness: validate /sdlc args, never crash pi
approved: false

## Intent
ผู้ใช้รายงานว่า /sdlc commands ต่างๆ error/crash pi — ต้องการให้ทุก subcommand validate parameters และแสดง usage แทนที่จะพัง: (1) แก้ agent_end handler ที่อ่าน m.toolCalls/m.details.isError ผิด shape ของ pi, (2) ใช้ StringEnum แทน Type.Union/Type.Literal (รองรับ Google API), (3) tool sdlc_spec/sdlc_adr/sdlc_eval validate params ที่ runtime แล้ว throw descriptive error แทน undefined crash, (4) ครอบ event handlers ด้วย try/catch เพราะ tool_call handler ที่ throw จะ block tool ทุกตัว (fail-safe) ทำให้ดูเหมือน pi crash, (5) ทำ /sdlc adr-approve N ให้มีจริงตามที่ description ของ sdlc_adr อ้างถึง

## Scope
- extensions/sdlc-harness/
- package.json

## Constraints
- ต้องไม่เปลี่ยนพฤติกรรม gate โดยเจตนา (spec ต้อง approve ก่อน implement เหมือนเดิม)
- ทุก event handler ต้อง fail-safe: harness bug ห้าม crash pi หรือ block tool ทั้งหมดถาวร
- validation error ต้อง throw Error ที่อ่านรู้เรื่อง (pi จะ mark isError ให้ LLM เห็น) ห้ามปล่อย undefined access

## Acceptance criteria
- [ ] loads-clean: extension โหลดได้ไม่มี syntax/type error ร้ายแรง (node --check ผ่าน jiti-compatible syntax) *(check: npx tsc --noEmit หรือ node syntax check ผ่าน)*
- [ ] stringenum: sdlc_spec ใช้ StringEnum จาก @earendil-works/pi-ai แทน Type.Union/Type.Literal *(check: grep -q 'StringEnum' extensions/sdlc-harness/index.ts && ! grep -q 'Type.Literal("set")' extensions/sdlc-harness/index.ts)*
- [ ] agent-end-shape: agent_end อ่าน toolCall จาก m.content blocks และ toolResult.isError แบบ top-level *(check: grep -q 'type === "toolCall"' extensions/sdlc-harness/index.ts && grep -q 'm?.isError' extensions/sdlc-harness/index.ts)*
- [ ] cmd-validation: /sdlc gate รับเฉพาะ on|off, มี subcommand adr และ adr-approve <N> *(check: grep -q 'adr-approve' extensions/sdlc-harness/index.ts && grep -q 'Number.isFinite' extensions/sdlc-harness/index.ts)*
- [ ] no-crash-handlers: ทุก pi.on handler ถูกครอบ safe()/try-catch และ tool gate fail-open พร้อม warning แทนที่จะ block ถาวรเมื่อ harness มี bug *(check: grep -cq 'safe(ctx' extensions/sdlc-harness/index.ts)*

## Spec debt (human-verified only)
- พฤติกรรมจริงของ /sdlc approve/gate ใน TUI ตรวจไม่ได้จากที่นี่ — ต้อง user ทดสอบ interactive หลัง /reload
- sub-agent spawn ต้องการ pi binary บน PATH — ถ้าไม่พบจะ fail อย่างสุภาพแต่ยังไม่มี fallback

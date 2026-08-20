# Spec v1: Sub-agent spawn: เปลี่ยนเป็น --mode json เพื่อ live-stream log
approved: false

## Intent
ตอนนี้ runSubagent spawn `pi --mode print --no-session` ซึ่ง buffer stdout ทั้งหมดและปล่อยทีเดียวตอนจบ ทำให้ subagent log ไม่แสดงจนกว่างานจะเสร็จ แม้โค้ดจะ appendFileSync ทุก chunk ก็ตาม (ทดลองแล้ว: chunk เดียวตอน 2.9s ก่อน close) เปลี่ยนไปใช้ `--mode json` (JSONL event stream) ที่ stream จริงตั้งแต่ต้น แล้ว parse events เป็น log ที่อ่านง่าย เพื่อให้ user tail ดู subagent ทำงาน live ได้

## Scope
- /Users/saint/zurge/pi-zense/extensions/zense-harness/

## Constraints


## Acceptance criteria
- [ ] C1: runSubagent spawn pi ด้วย `--mode json --no-session` (ไม่ใช่ --mode print) *(check: rg '"--mode", "json"' extensions/zense-harness/index.ts พบ)*
- [ ] C2: log file ได้รับ content แบบ incremental ระหว่าง subagent ยังทำงาน (text_delta / tool events ถูก append ทันทีที่ chunk มาถึง ไม่รอ process จบ) *(check: ทดลอง spawn task ที่ใช้เวลานานแล้วตรวจว่า log file โตขึ้นก่อน process close)*
- [ ] C3: log เป็น human-readable — แปลง JSONL events เป็นบรรทัด text (text delta ต่อกัน, tool_execution_start/end เป็นบรรทัดสรุป) ไม่ใช่ JSON ดิบทั้งก้อน *(check: ตรว parser logic ใน runSubagent + ตรวจ log จริงจากการรัน)*
- [ ] C4: output ที่คืนค่า (res.ok=true) มาจาก assistant text สุดท้าย (message_end/agent_end) ไม่ใช่ tail ของ raw stdout ที่มี JSON ปน *(check: ตรว logic รวม finalText ใน runSubagent)*
- [ ] C5: stderr และ stdout ที่ parse JSONL ไม่ได้ (เช่น error ก่อน session เริ่ม) ยังถูกเก็บลง log แบบเดิม ไม่หาย *(check: ตรว fallback path ใน runSubagent)*
- [ ] C6: TypeScript compile ผ่าน ไม่มี type error ใหม่ *(check: npx tsc --noEmit หรือ build command ของโปรเจกต์ผ่าน)*

## Spec debt (human-verified only)


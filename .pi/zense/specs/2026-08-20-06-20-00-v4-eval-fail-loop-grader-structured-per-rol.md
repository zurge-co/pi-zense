# Spec v4: Eval FAIL loop + grader structured + per-role sub-agent model config
approved: false

## Intent
สามปัญหาใน zense_eval/runSubagent ที่ต้องแก้: (1) ตอนนี้ grader บอก FAIL แล้ว harness ปล่อยผ่านไป review เลย ไม่วนกลับแก้ — อยากให้ FAIL ส่งกลับเป็น implementation phase พร้อมสั่งให้แก้แล้ว eval ใหม่ และบันทึกผล eval ลง spec .md; (2) grader output เป็น free-form text ทำให้ parser ดึง per-criteria PASS/FAIL ไม่แม่น — อยากให้ grader ส่ง output แบบ structured (บรรทัดต่อ criterion `Cx: PASS|FAIL: <evidence>` + บรรทัด `OVERALL: PASS|FAIL`) แล้ว parser ดึง per-criteria verdict แม่นยำผูกกับ criterion id จริง; (3) sub-agent ทุก role ใช้ model เดียวกับ agent หลักเสมอ ไม่มีทางตั้ง model ย่อยแยกตาม role — อยากให้ config model ของแต่ละ role (requirements/grader/reviewer) แยกได้ผ่าน .pi/zense/models.json และถ้าไม่ได้ config ใช้ตัวเดียวกับ agent หลัก (ctx.model)

## Scope
- extensions/zense-harness/

## Constraints
- spec archive เดิมเป็น append-only — ผล eval ต้อง append เป็น section ใหม่ท้ายไฟล์ ห้ามแก้บรรทัดเดิม
- PASS ต้องยังเดินไป phase=review เหมือนเดิม
- การตัดสินใจ phase ต้องใช้ verdict จาก OVERALL ที่ parse แม่น ไม่ใช่ grade.ok (subprocess exit)
- learn() memory, trajectory flags, report ยังคง return กลับเหมือนเดิม
- grader prompt ต้องระบุ format ของ output ชัดเจน (per-criteria บรรทัด + OVERALL) และ parser ต้อง tolerant ต่อ whitespace/ตัวพิมพ์เล็กใหญ่ แต่ strict ต่อรูปแบบหลัก
- parser ดึง per-criteria verdict ต้องผูกกับ criterion id ที่อยู่ใน state.spec.criteria ไม่ใช่ดึงบรรทัดอะไรก็ตั้ง
- ถ้าไม่มี .pi/zense/models.json หรือไม่มี entry ของ role นั้น → ใช้ model ปัจจุบันของ agent หลัก (ctx.model สร้างเป็น pattern provider/id) ห้ามใช้ global default ที่อาจไม่ใช่ model ที่ user เลือก
- runSubagent ต้องส่ง --model <pattern> ให้ pi เสมอ (มี config หรือไม่) เพื่อบังคับ model ที่จะใช้ — ยกเว้น ctx.model undefined ให้ข้าม --model ไป (ปล่อย pi ใช้ default)
- config model เป็น optional ห้ามพังการทำงานเดิมถ้าไม่มีไฟล์ config
- กระทบเฉพาะ zense_eval + State (เพิ่ม specMdPath/specJsonPath) + zense_spec (เก็บ path) + runSubagent (รับ modelPattern) + launchSubagent (resolve model ตาม role จาก config) + grader prompt — ห้ามแตะ tool/phase อื่น

## Acceptance criteria
- [ ] C1: grader prompt สั่งให้ output แบบ structured: บรรทัดต่อ criterion รูปแบบ `<id>: PASS|FAIL: <evidence>` และบรรทัดสุดท้าย `OVERALL: PASS|FAIL` *(check: rg 'PASS\|FAIL|OVERALL' ใน grader prompt string ของ zense_eval พบ format spec ชัดเจน)*
- [ ] C2: parser ดึง per-criteria verdict แม่นยำ: สำหรับทุก c.id ใน state.spec.criteria ให้หาบรรทัดที่ตรง `^<id>:\s*(PASS|FAIL)` (case-insensitive) และเก็บผลเป็น map {id → PASS|FAIL} + failedCriteria[] — ไม่ดึงบรรทัดที่ id ไม่ตรงกับ criteria ที่มี *(check: rg ใน zense_eval พบ logic ที่ iterate state.spec.criteria แล้ว regex ดึง verdict ของ id นั้น และเก็บ failedCriteria)*
- [ ] C3: overall verdict มาจากการ parse บรรทัด `OVERALL: PASS|FAIL` (แม่น) และมี fallback = 'unknown' ถ้าหาไม่ได้ *(check: rg 'OVERALL:\\s*\(PASS\|FAIL\)' ใน zense_eval พบ และมี ?? 'unknown')*
- [ ] C4: เมื่อ overall verdict = FAIL: state.phase กลับเป็น "implementation" (ไม่ใช่ review) และเพิ่ม escalation {kind:"need-fix", detail: <รายการ criteria id ที่ fail>} เข้า state.escalations *(check: rg 'need-fix|phase = "implementation"' ในบล็อก verdict FAIL พบ)*
- [ ] C5: เมื่อ verdict = FAIL: return content มี isError=true และข้อความสั่งชัดว่ากลับไปแก้ criteria ที่ fail แล้วเรียก zense_eval ใหม่ พร้อม list id ที่ fail *(check: rg 'isError.*true|FAIL|eval ใหม่|กลับไปแก้' ใน return path ของ verdict FAIL พบ และมีการ list id ที่ fail)*
- [ ] C6: เมื่อ verdict = PASS: state.phase = "review" และ return report ปกติ (ไม่ isError) *(check: rg 'phase = "review"' อยู่ในบรรทัด PASS และไม่มี isError ใน path นั้น)*
- [ ] C7: details ของ zense_eval return มีฟิลด์ verdict ("PASS"|"FAIL"|"unknown") และ failedCriteria (array ของ id ที่ fail) *(check: rg 'verdict|failedCriteria' ใน details object ของ return พบ)*
- [ ] C8: ผล eval (verdict + per-criteria results + สรุป grader output) ถูก append เป็น section ใหม่ (เช่น `## Eval <timestamp>`) ต่อท้าย spec.md (latest copy) และไฟล์ archive .md ของเวอร์ชันนั้น โดยเนื้อ spec ต้นฉบับไม่ถูกเขียนทับ *(check: rg '## Eval|appendFileSync' ใน zense_eval พบ และใช้ appendFileSync ไม่ใช่ writeFileSync ทั้งไฟล์)*
- [ ] C9: state เก็บ path ของ spec md/json ปัจจุบัน (specMdPath/specJsonPath หรือเทียบเท่า) เพื่อให้ zense_eval หาไฟล์ที่จะ append ได้ถูกเวอร์ชัน *(check: rg 'specMdPath|specJsonPath' ใน State interface และ zense_spec execute พบ และ zense_eval ใช้ค่านั้น)*
- [ ] C10: runSubagent รับ parameter modelPattern (string|undefined) และถ้ามีจะส่ง `--model <pattern>` ให้ pi (แทรกใน argv ก่อน task) *(check: rg '--model|modelPattern' ใน runSubagent พบ และ argv มีการใส่ --model เมื่อ modelPattern มีค่า)*
- [ ] C11: มี config reader อ่าน .pi/zense/models.json (map role→model pattern string) แล้ว launchSubagent resolve model pattern ตาม role ถ้าไม่มี entry ใช้ ctx.model (สร้างเป็น provider/id pattern) ถ้า ctx.model undefined ด้วย ไม่ส่ง --model *(check: rg 'models.json|readModelsConfig|resolveModelPattern' พบ และมี fallback เป็น ctx.model.provider/id)*
- [ ] C12: config model เป็น optional: ถ้าไม่มี .pi/zense/models.json หรือไม่มี entry ของ role การทำงานยังปกติ (ไม่ throw ไม่พัง) และใช้ model ของ agent หลัก *(check: ตรว logic มี guard existsSync/try-catch และไม่มี path ที่ throw เมื่อไฟล์/entry ไม่อยู่)*
- [ ] C13: widget หรือ /zense status แสดง model ที่แต่ละ role จะใช้ (หรืออย่างน้อย /zense models ดู/แก้ config ได้) เพื่อ user รู้ว่า config มีผล *(check: rg '/zense models|models.json|subagent models' ใน command handler หรือ widget พบ หรือมี command ใหม่)*
- [ ] C14: TypeScript compile ไม่เพิ่ม type error ใหม่ (error เดิม 2 ตัวที่มีอยู่ก่อนยังพอได้) *(check: npx tsc -p tsconfig ผ่าน โดยจำนวน error ไม่มากกว่าต้นฉบับ (2 ตัว))*

## Spec debt (human-verified only)
- structured format ยังเป็น text ไม่ใช่ JSON — grader อาจเบี่ยน format บ้าง ต้อง verify กับ grader จริง; ถ้ายังไม่แม่นพออาจต้องเปลี่ยนเป็น JSON output
- การ append eval section ลง archive .md เปลี่ยนไฟล์ append-only แต่เป็นการเพิ่มท้าย — ต้อง verify ว่าไม่ทำลายประวัติเดิม
- model pattern ที่ user ใส่ใน models.json อาจไม่ตรงกับ model ที่มีจริง (typo) — pi จะ fail ตอน spawn ต้อง verify บนเครื่อง user; อาจต้อง validate กับ ctx.modelRegistry.getAvailable() ในอนาคต

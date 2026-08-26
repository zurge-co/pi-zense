# Sub-agent upgrade roadmap

> วิเคราะห์เมื่อ 2026-08-26 หลัง merge `zense: impl v1` (upgrade requirements pipeline A–H)
> เอกสารนี้คือ input สำหรับ compile spec รอบถัดไป — หยิบ "Wave" ที่ต้องการไปทำ spec ได้เลย
> ตำแหน่งโค้ดอ้างอิง: `extensions/zense-harness/index.ts`

## Context: สิ่งที่ทำไปแล้ว (requirements sub-agent)

A) parse+validate JSON draft + retry 1 ครั้งพร้อม feedback (`parseSpecDraft`) ·
B) `commitSpec` one-step (archive + sign dialog) ใช้ร่วมทั้ง set/compile ·
C) read-only lock `--exclude-tools write,edit` ผ่าน `SUBAGENT_EXCLUDE_TOOLS` (role-keyed map) ·
D) prompt explore-repo-first (`buildRequirementsPrompt`) + clarify contract ·
F) clarify mode ถามมนุษย์ผ่าน UI (max 2 รอบ) คำถามค้าง → specDebt ·
G) quality gate (`applyQualityGate`: empty-scope / manual-check / similar-spec → specDebt) ·
H) telemetry ลง memory.jsonl ทุกจุด

**จุดต่อขยายที่ได้ฟรี**: `SUBAGENT_EXCLUDE_TOOLS` extend ตาม role ได้ทันที · retry-loop/budget pattern ยกไปใช้ซ้ำได้ · pure functions + node:test pattern ตั้งไว้ใน `test/spec-draft.test.mjs`

---

## Wave 2 — pattern เดียวกัน map ไป grader/reviewer (แผนที่วิเคราะห์ไว้ใน session)

### Grader (`zense_eval`) — น้ำหนักมากสุด

| แผน | รายละเอียด | เหตุผล |
|---|---|---|
| **C ขยาย** | `SUBAGENT_EXCLUDE_TOOLS.grader = ["write","edit"]` (1 บรรทัด + test) | **รูรั่ว integrity ใหญ่สุด**: sub-agent เป็น subprocess — tool calls ไม่ผ่าน gate และไม่โดน `agent_end` heuristics → grader แก้ test ให้ผ่านแล้วตอบ PASS ได้เงียบๆ ตรงข้ามหน้าที่ "look for reward hacking" (ข้อจำกัด: bash ยังเขียนไฟล์ได้ = defense-in-depth ไม่ใช่ sandbox สมบูรณ์ → prompt ต้องสั่ง "temp file ทำใน tmp เท่านั้น" ด้วย) |
| **A** | extract `parseGraderOutput` (pure, export, unit-test): validate ทุก criterion ถูก judge, มี OVERALL, retry 1 ครั้งพร้อม feedback ราย id ที่ขาด | ปัจจุบัน criteria ที่ regex ไม่เจอ = ไม่นับ และ verdict `unknown → ปฏิบัติเหมือน PASS` → **grader output พัง = ผ่านฟรี → merge เข้า main อัตโนมัติ** อันตรายกว่า requirements เยอะ |
| **G** | หลัง retry ยัง unknown/missing ids → escalate `need-decision` (มนุษย์ตัดสิน) แทนฝืน PASS เงียบๆ; เปลี่ยนทีละขั้น (retry → escalate ครั้งแรก → ค่อย hard-fail) กัน escalate ถี่จนรำคาญ | เปลี่ยน loop semantics ต้องค่อยเป็นค่อยไป |
| **D** | prompt feed `git diff` ของงานจริง + สั่งเทียบ scope + เช็ค test ไม่ถูก weaken (diff-aware reward-hacking) | ตอนนี้ prompt มีแค่ criteria text — grader เดาจากคำพูด agent แทน evidence |
| **H** | telemetry: `grader: judged X/Y, unknown→…` ลง memory | loop เห็นว่า criteria จาก compile มัก grade ไม่ครบไหม → reflect กลับ requirements |
| B, F | — | grader ไม่ commit artifact และไม่ควร clarify (ตัดสินด้วย evidence ที่มี) |

### Reviewer (`zense_review`)

| แผน | รายละเอียด | เหตุผล |
|---|---|---|
| **C ขยาย** | `SUBAGENT_EXCLUDE_TOOLS.reviewer = ["write","edit"]` | ไม่มีเหตุผลที่ reviewer ต้องแก้โค้ด |
| **D** | ⭐ ใหญ่สุดของตัวนี้: prompt ตอนนี้มีแค่ `intent` บรรทัดเดียว → feed criteria verdicts, trajectory flags, specDebt, `git log --oneline` + `git diff --stat` ของงาน | เห็นผลจริงแล้ว: packet รอบล่าสุดเขียน "To be implemented" ทั้งที่ของเสร็จแล้ว — เพราะมันเดาจาก intent ล้วนๆ |
| **A** | validate ว่า packet มี TL;DR จริง แทน `slice(0,900)` ดิบๆ | ราคาถูก |
| B, F, G | — | ไม่เกี่ยวกับหน้าที่ |

### ข้อควรระวัง (จากการวิเคราะห์)

- unknown→need-decision ของ grader: ค่อยๆ เข้ม (retry → escalate → hard-fail) ไม่ hard-fail ทันที
- read-only ทำให้ criteria ที่ต้องสร้าง fixture ใช้ bash ผ่าน tmp แทน — ต้องเขียนใน prompt
- grader retry + reviewer context เพิ่ม ≈ โทเคน phase 4–5 ขึ้น ~2 เท่า (คุ้มกับ eval ที่เชื่อถือได้)

---

## Wave 3 — การปรับปรุงเฉพาะตัว (ทำให้เก่งในงานของตัวเอง ไม่จำเป็นต้องเหมือนกัน)

### Requirements — เป้าหมายคือ "criteria ที่ ground กับ repo จริงและ format ตรงทุกครั้ง"

1. **Context priming (deterministic)** — harness gather ข้อเท็จจริงถูกๆ เองก่อน (package.json scripts, README head, top-level tree, test runner ที่เจอ, tsconfig) inject เข้า prompt · ประหยัด exploration tokens และกัน model ขี้เกียจ explore — เพราะ D ปัจจุบันพึ่ง model ทำตามสั่งล้วนๆ
2. **Few-shot จาก spec เก่าของ repo ตัวเอง** — `findSimilarSpec` มีอยู่แล้ว ใช้ย้อนดึง spec ที่เคย signed สำเร็จ 1–2 ฉบับเป็นตัวอย่าง style (criteria ที่ผ่าน gate จริง) → format compliance + consistency สูงขึ้น
3. **Acceptance probes เป็นไฟล์จริง** — ให้เขียน `.pi/zense/probes/<criterion-id>.sh` ที่ `zense_eval` re-run ได้ deterministically ทุกครั้ง แทนที่ grader จะ interpret `check` ใหม่ทุกรอบ → criteria เป็น executable ของจริง ไม่ใช่ข้อความ
4. **Scope typo check** — quality gate เพิ่มอีก 1 กฎ: scope path ที่ไม่ match ไฟล์/โฟลเดอร์จริงเลย → specDebt (scope พิมพ์ผิด = gate ไร้ฟันเงียบๆ)
5. (ใหญ่) **Dual-draft** — compile 2 model คู่ขนานแล้ว grader เลือก/merge — models.json per-role มีพร้อมแล้ว

### Grader — เป้าหมายคือ "verdict ที่เชื่อถือได้และจับโกงได้จริง"

1. **Evidence-anchored PASS** — contract ใหม่: ทุก PASS ต้องมีคำสั่งที่รัน + exit code/`output snippet` · `parseGraderOutput` ตี FAIL ทันทีถ้า PASS ไม่มี evidence (ปิดช่อง "ตอบมั่วแบบมั่นใจ")
2. **Probe-first grading** — ถ้า spec มี probes (จาก Wave 3 requirements) grader รัน probe ก่อน เหลือแค่ตัดสินสิ่งที่ probe ครอบไม่ถึง → verdict ส่วนใหญ่กลายเป็น deterministic
3. **Dual-grader agreement** — grade ซ้ำด้วย model อื่น (models.json `grader2`) แล้วนับเฉพาะที่ตรงกัน; ไม่ตรง → `need-decision` · คือ "dual eval" ของจริงตามชื่อ phase 4
4. **Reward-hacking checklist ตายตัว** — diff-aware: นอก scope ไหม / test ถูกแก้-ลบ-อ่อนลงไหม / assertion หายไหม — auto-FAIL criteria ที่เกี่ยวถ้าเจอ (ตอนนี้มี heuristic ฝั่ง main agent แต่ grader เองไม่ได้เช็ค diff)
5. **Calibration loop** — incident ที่เคย eval PASS แล้วโดน review เถียบ/มนุษย์ override ทีหลัง ถูก feed กลับเข้า prompt เป็น "false-PASS ที่เคยเกิด" ปิด learning loop ของ eval เอง (ตอนนี้ loop ปิดเฉพาะ spec)

### Reviewer — เป้าหมายคือ "packet ที่มนุษย์อ่าน 90 วิแล้วตัดสินใจ deploy ได้"

1. **Evidence pack จาก harness** — ส่ง git log/diffstat/criteria verdicts/flags/specDebt เข้า prompt (packet จะ facts-grounded แทนการเดา — เหตุการณ์จริง: packet ล่าสุดเขียน "To be implemented")
2. **Packet schema + validation** — บังคับ section {TL;DR ≤3 บรรทัด, Intent vs Impl, Risks, Rollback plan, Human actions} แล้ว validate แทน slice ดิบ
3. **Exception-first rendering** — สั่งเลือก "3 จุดที่คน review ต้องดูด้วยตา" พร้อม `file:line` ที่กระโดดไปดูได้ เพราะ human attention คือทรัพยากรที่จำกัดที่สุดของระบบนี้ (สอดคล้องกับหลัก exception-based ของ PLAN)
4. **Rollback plan เชิงกล** — ให้ระบุ `git revert <merge-hash>` / ไฟล์ที่แตะเป็นรายการ ไม่ใช่คำแนะนำลอยๆ

### Infra ร่วม (รองรับทุก role)

- **Role system-prompt files** — ย้ายนโยบาย role (read-only, temp-file ใน tmp, output contract) จากการต่อ string ในโค้ด ไปเป็น `.pi/zense/prompts/<role>.md` แล้ว spawn ด้วย `--append-system-prompt` · แก้ policy โดยไม่แตะโค้ด + version control ได้
- **Per-role thinking level** — models.json รองรับ `:high` อยู่แล้ว อาจ default grader=high (accuracy สำคัญ) requirements=medium
- **Generic parse-retry helper** — เมื่อมี parser ตัวที่สอง (`parseGraderOutput`) ค่อยถอด retry-loop ออกเป็น `launchUntilValid()` ร่วม — อย่างeneric เร็วเกิน (rule of three)

---

## ลำดับที่แนะนำ

1. **Wave 2 grader: C + A** (ถูก, ปิดรู PASS-ฟรีและรูแก้ test เอง) — ครึ่งวัน
2. **Wave 2 reviewer: C + D evidence pack** — กระทบ packet quality ทันที
3. **Wave 3 grader: evidence-anchored PASS + reward-hacking checklist** — หัวใจของ dual eval
4. **Wave 3 requirements: context priming + probes** — ต่อยอดจาก D ที่ทำไป
5. ที่เหลือ (dual-grader, dual-draft, prompts-as-files) ตามความจำเป็นจาก memory lessons

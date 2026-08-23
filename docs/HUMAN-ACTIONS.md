# คู่มือผู้ใช้ pi-zense — มุม action ของ human

แนวทางหลัก: **human attention คือทรัพยากรที่หายากที่สุด** คุณจึงมีหน้าที่แค่ 2 ประตูหลัก
(🔏 เซ็น spec กับ review packet) บวกกับตอบ escalation เมื่อ harness เรียกเท่านั้น
**การเซ็นทำจาก dialog ได้เลยในจังหวะเดียว — ไม่ต้องพิมพ์ /zense approve ย้ำภายหลัง**

## 0. Setup ครั้งเดียว

```bash
pi -l install git:github.com/zurge-co/pi-zense   # ติดตั้งใน workspace (หรือลบ -l เพื่อ global)
pi                                                # เปิด session — extension/theme โหลดอัตโนมัติ
```

ดู widget เหนือ editor — ถ้าเห็น `ZENSE ▸ REQUIREMENTS · spec: —` แปลว่าพร้อมใช้งาน

## 1. Requirements — พิมพ์สิ่งที่ต้องการ แล้ว approve spec

พิมพ์ requirement ปกติ เช่น:

> สร้าง REST API สำหรับ todo list ด้วย Express, ต้องมี unit test ครบทุก endpoint

ถ้า agent พยายามเขียนโค้ดทันที gate จะเด้ง dialog 3 ทางเลือกทันที (ดูด้านล่าง) — ปกติให้บอก agent ว่า
"compile spec ก่อน" มันจะเรียก requirements sub-agent มาเขียน `.pi/zense/spec.json` ให้

**📍 หน้าที่คุณ (gate #1) — ลายเซ็นของคุณอยู่ที่ dialog:**
1. เมื่อ spec compile เสร็จ dialog จะเด้งขึ้นมา **พร้อม spec เต็มฉบับให้อ่านใน dialog นั้นเลย** (Ctrl+D/U เลื่อนครึ่งหน้า, Ctrl+F/B เต็มหน้า ถ้ายาว มีตัวเลขบอกว่าอ่านถึงบรรทัดไหน) แล้วจึงเลือก:
   - **🔏 เซ็นอนุมัติ** — spec.approved + เปิด implementation gate ทันที จบในจังหวะเดียว
   - **✏️ ยังไม่เซ็น** — ออกไปแก้ spec ก่อน: `Esc` ปิด dialog, เปิด `.pi/zense/spec.md` แก้เอง, สั่ง agent ปรับ criteria
2. dialog เซ็นทุกจุด (ตอน compile เสร็จ / gate เด้งตอน write / `/zense approve`) โชว์เนื้อ spec แบบเดียวกัน — อ่านครบก่อนเซ็นเสมอ ไม่ต้องเปิดไฟล์แยก (แต่ทุก version ยังถูกเก็บถาวรไม่ทับกันใน `.pi/zense/specs/…-<slug>.md`)
3. ถ้าเลือก "ยังไม่เซ็น" ไว้ก่อน ค่อยเซ็นทีหลังได้ที่ `/zense approve`

ถ้า dialog เด้งตอน agent กำลังจะเขียนโค้ดทั้งที่ยังไม่เซ็น มันจะโชว์ spec เต็มให้อ่านก่อน (Ctrl+D/U เลื่อนครึ่งหน้า, Ctrl+F/B เต็มหน้า) แล้วมี 3 ทางเลือก:
- **🔏 เซ็นอนุมัติ spec แล้วทำงานต่อ** — เซ็น + ปล่อย write นั้นผ่านเลย
- **⚠️ อนุญาตรอบนี้รอบเดียว** — override โดยไม่เซ็น (ถูกบันทึกเป็น trajectory flag)
- **⛔ Block ไว้** — ให้ agent หยุด/compile spec ก่อน

สิ่งที่ต้องเช็คตอน approve:
- แต่ละ `criteria` มี `check` ที่ตรวจได้จริง (bash probe / path exists) หรือไม่
- `specDebt` — ข้อที่ agent ตรวจให้ไม่ได้ (เช่น "UX ต้องดูดี") จะถูกบังคับให้คุณ review ภายหลัง

## 2. Design — เข้ามาเฉพาะ "one-way door"

Agent เขียน ADR ลง `.pi/zense/adr/` เองรายการที่ `status: proposed (NEEDS HUMAN APPROVAL)`
(ตัดสินใจย้อนไม่ได้ เช่น เลือก database / API contract) คือจุดที่คุณต้องอ่านและเปลี่ยนเป็น
`accepted` หรือสั่งแก้ — ส่วน `DENY: <path>` rules ใน ADR จะถูก enforce กับ agent อัตโนมัติ

## 3. Implementation — แทบไม่ต้องทำอะไร

เฝ้า widget: `ZENSE ▸ IMPLEMENTATION · spec: ✅v1 · 🌳 pi-zense-wt-… · turns 12 · tok 1.2M` (token ≥ 1 ล้านแสดงเป็น M)

**🌳 ทันทีที่คุณเซ็น spec** harness สร้าง `git worktree` ของ session นี้ให้เอง (branch `zense/impl/v1-…` worktree อยู่ใต้ `<repo>/.pi/zense/worktree/` ใน workspace เดียวกัน — main repo สะอาดเพราะ harness เพิ่ม path เข้า `.git/info/exclude` ให้เอง) แล้ว redirect ทุก `write`/`edit`/`read`/`bash` ของ agent เข้าไปทำงานในนั้นโดย agent ไม่รู้ตัว — ดังนั้น**เปิด pi 2 session ใน repo เดียวกันได้โดยไม่เขียนทับกัน** แต่ละ session มี worktree ของตัวเอง grader/reviewer ก็รันใน worktree ด้วยเลยเทสโค้ดที่แก้จริง ไม่ต้องจัดการอะไรเอง

ตอน agent spawn sub-agent (grader/reviewer) widget จะขึ้น `🧪 grader ▶ 12s` — อยากดูสดว่ามันทำอะไรอยู่
(ไม่ค้าง?) กด **alt+z** หรือพิมพ์ `/zense agents` แล้วเลือก run → live tail อัปเดตเองทุก 1 วิ
(grep ไฟล์ .pi/zense/subagents/*.log เองก็ได้ — เขียน live ระหว่างรัน) กด Esc ปิด viewer งานยังรันต่อ

**📍 คุณจะถูกเรียกกลับมาเมื่อ:**
- ⚠ trajectory flag เด้ง (out-of-scope write / แก้ไฟล์ test) → ตรวจนัดเดียว

## 4. Eval — สั่ง agent `run eval`

grader sub-agent เช็คผลงานเทียบทุก criterion — output ของมัน stream เข้า transcript สดๆ ระหว่างรัน

**🌳 พอ eval PASS** harness auto-commit งานใน worktree แล้ว `git merge --no-ff` กลับเข้า `main` ให้เอง แล้ว cleanup worktree — ไม่ต้อง merge เอง ถ้าอีก session ไป merge ของตัวเองชนก่อนจะเกิด conflict → harness **escalate** (`need-decision`) แล้วเก็บ worktree ไว้ให้คุณ resolve ด้วยมือ (ไม่ clobber เงียบ) ถ้า eval **FAIL** เก็บ worktree ไว้แก้ต่อ ถ้าคุณปิด session ก่อน eval PASS เก็บ worktree ไว้ให้ merge ด้วยมือ (`git merge zense/impl/…`) — harness ไม่ auto-merge งานที่ยังไม่ verified
(ดูย้อนหลังได้ที่ /zense agents)

**📍 หน้าที่คุณ:** โฟกัส 2 ส่วนของรายงาน — `Spec debt (needs human)` (ต้อง review ด้วยตา)
และ `Trajectory flags` (เช็ค reward hacking)

## 5. Review — ประตู #2 ที่สำคัญสุด

สั่ง agent `build review packet` → การ์ด **📋 Review packet** ใน transcript (TL;DR ก่อน)

**📍 หน้าที่คุณ:** อ่าน TL;DR → accept / สั่งแก้ / ย้อนด้วย `/tree`

## 6. Maintenance — memory เรียนรู้อัตโนมัติ

- ทุก escalation / trajectory flag / การเซ็น/override spec / eval verdict / sub-agent fail ถูกเขียนลง `.pi/zense/memory.jsonl` เอง — ไม่ต้องทำอะไร
- `/zense memory` — ดูสรุปเป็นกลุ่ม (top flags, escalations by kind, eval history, sub-agent failures); อยากดู raw ใช้ `/zense memory json`
- บทเรียนสะสมจะถูก **feed เข้า compile_spec อัตโนมัติ** — spec ถัดไปจะ reflect incident เก่า เช่น scope เคยกว้างเกิน, override บ่อย (sign dialog จะมี hint `📚 fed N lessons` บอกด้วย)
- production incident → บอก agent แปลงเป็น criterion ใหม่ใน spec รอบหน้า (หรือมันถูก memory ดูดเข้าไปเองถ้าเกิด flag/escalation)

## Cheat sheet คำสั่งสำหรับมนุษย์

| คำสั่ง | เมื่อ | ทำอะไร |
|---|---|---|
| 🔏 dialog เซ็น spec | ตอน spec compile เสร็จ / gate เด้ง | ลายเซ็นในจังหวะเดียว ไม่ต้องพิมพ์คำสั่ง |
| `/zense approve` | เซ็นย้อนหลัง (ถ้ากด ยังไม่เซ็น ไว้ก่อน) | 🔏 ลงนาม spec เดิม |
| `/zense status` | ทุกเวลา | phase / flags / escalations |
| `alt+z` หรือ `/zense agents` | ระหว่าง sub-agent รัน / ย้อนหลัง | ดู live tail ของ grader/reviewer กันสับสนว่าค้างไหม |
| `/zense gate on\|off` | ฉุกเฉิน | ปิด/เปิด spec gate |
| `/zense memory` | ทุกเวลา / จบงาน | ดูบทเรียนสรุปเป็นกลุ่ม (`json` = raw) |

สรุป: **พิมพ์ requirement → เซ็นใน dialog → ปล่อยจนจบ → อ่าน review packet**
interaction ส่วนใหญ่มีแค่นี้ — zense (เซ็น) คือลายเซ็นของคุณใน dialog เดียวจบ

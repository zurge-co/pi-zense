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
1. เมื่อ spec compile เสร็จ dialog จะเด้งขึ้นมาให้เลือก:
   - **🔏 เซ็นอนุมัติ** — spec.approved + เปิด implementation gate ทันที จบในจังหวะเดียว
   - **✏️ ยังไม่เซ็น** — เปิด `.pi/zense/spec.md` แก้เอง, สั่ง agent ปรับ criteria
2. อยากอ่าน spec ก่อนเซ็น: `/zense status` ดูภาพรวม หรือเปิด spec.md (ทุก version ถูกเก็บถาวรไม่ทับกันใน `.pi/zense/specs/…-<slug>.md`)
3. ถ้าเลือก "ยังไม่เซ็น" ไว้ก่อน ค่อยเซ็นทีหลังได้ที่ `/zense approve`

ถ้า dialog เด้งตอน agent กำลังจะเขียนโค้ดทั้งที่ยังไม่เซ็น มันจะมี 3 ทางเลือก:
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

เฝ้า widget: `ZENSE ▸ IMPLEMENTATION · spec: ✅v1 · turns 12 · tok 180k`

**📍 คุณจะถูกเรียกกลับมาเมื่อ:**
- ⚠ trajectory flag เด้ง (out-of-scope write / แก้ไฟล์ test) → ตรวจนัดเดียว

## 4. Eval — สั่ง agent `run eval`

grader sub-agent เช็คผลงานเทียบทุก criterion

**📍 หน้าที่คุณ:** โฟกัส 2 ส่วนของรายงาน — `Spec debt (needs human)` (ต้อง review ด้วยตา)
และ `Trajectory flags` (เช็ค reward hacking)

## 5. Review — ประตู #2 ที่สำคัญสุด

สั่ง agent `build review packet` → การ์ด **📋 Review packet** ใน transcript (TL;DR ก่อน)

**📍 หน้าที่คุณ:** อ่าน TL;DR → accept / สั่งแก้ / ย้อนด้วย `/tree`

## 6. Maintenance

- `/zense memory` — ดู learning log
- production incident → บอก agent แปลงเป็น criterion ใหม่ใน spec รอบหน้า

## Cheat sheet คำสั่งสำหรับมนุษย์

| คำสั่ง | เมื่อ | ทำอะไร |
|---|---|---|
| 🔏 dialog เซ็น spec | ตอน spec compile เสร็จ / gate เด้ง | ลายเซ็นในจังหวะเดียว ไม่ต้องพิมพ์คำสั่ง |
| `/zense approve` | เซ็นย้อนหลัง (ถ้ากด ยังไม่เซ็น ไว้ก่อน) | 🔏 ลงนาม spec เดิม |
| `/zense status` | ทุกเวลา | phase / flags / escalations |
| `/zense gate on\|off` | ฉุกเฉิน | ปิด/เปิด spec gate |
| `/zense memory` | จบงาน | ดู learning log |

สรุป: **พิมพ์ requirement → เซ็นใน dialog → ปล่อยจนจบ → อ่าน review packet**
interaction ส่วนใหญ่มีแค่นี้ — zense (เซ็น) คือลายเซ็นของคุณใน dialog เดียวจบ

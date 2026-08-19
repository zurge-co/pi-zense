# คู่มือผู้ใช้ pi-zense — มุม action ของ human

แนวทางหลัก: **human attention คือทรัพยากรที่หายากที่สุด** คุณจึงมีหน้าที่แค่ 2 ประตูหลัก
(`/sdlc approve` กับ review packet) บวกกับตอบ escalation เมื่อ harness เรียกเท่านั้น

## 0. Setup ครั้งเดียว

```bash
pi -l install git:github.com/zurge-co/pi-zense   # ติดตั้งใน workspace (หรือลบ -l เพื่อ global)
pi                                                # เปิด session — extension/theme โหลดอัตโนมัติ
```

ดู widget เหนือ editor — ถ้าเห็น `SDLC ▸ REQUIREMENTS · spec: —` แปลว่าพร้อมใช้งาน

## 1. Requirements — พิมพ์สิ่งที่ต้องการ แล้ว approve spec

พิมพ์ requirement ปกติ เช่น:

> สร้าง REST API สำหรับ todo list ด้วย Express, ต้องมี unit test ครบทุก endpoint

ถ้า agent พยายามเขียนโค้ดทันที gate จะ block + เด้ง dialog ให้ override — ให้บอก agent ว่า
"compile spec ก่อน" มันจะเรียก requirements sub-agent มาเขียน `.pi/sdlc/spec.json` ให้

**📍 หน้าที่คุณ (gate #1):**
1. `/sdlc status` — ดูภาพรวม; เปิด `.pi/sdlc/spec.md` อ่าน spec ได้
2. โอเค → `/sdlc approve` แล้วยืนยันใน dialog → นี่คือลายเซ็นสัญญาของคุณ
3. ไม่โอเค → แก้ `.pi/sdlc/spec.md` เอง หรือสั่ง agent ปรับ criteria

สิ่งที่ต้องเช็คตอน approve:
- แต่ละ `criteria` มี `check` ที่ตรวจได้จริง (bash probe / path exists) หรือไม่
- `specDebt` — ข้อที่ agent ตรวจให้ไม่ได้ (เช่น "UX ต้องดูดี") จะถูกบังคับให้คุณ review ภายหลัง

## 2. Design — เข้ามาเฉพาะ "one-way door"

Agent เขียน ADR ลง `.pi/sdlc/adr/` เองรายการที่ `status: proposed (NEEDS HUMAN APPROVAL)`
(ตัดสินใจย้อนไม่ได้ เช่น เลือก database / API contract) คือจุดที่คุณต้องอ่านและเปลี่ยนเป็น
`accepted` หรือสั่งแก้ — ส่วน `DENY: <path>` rules ใน ADR จะถูก enforce กับ agent อัตโนมัติ

## 3. Implementation — แทบไม่ต้องทำอะไร

เฝ้า widget: `SDLC ▸ IMPLEMENTATION · spec: ✅v1 · turns 12 · tok 180k`

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

- `/sdlc memory` — ดู learning log
- production incident → บอก agent แปลงเป็น criterion ใหม่ใน spec รอบหน้า

## Cheat sheet คำสั่งสำหรับมนุษย์

| คำสั่ง | เมื่อ | ทำอะไร |
|---|---|---|
| `/sdlc approve` | หลัง spec compile | 🔏 ประตู 1: ลงนาม spec |
| `/sdlc status` | ทุกเวลา | phase / flags / escalations |
| `/sdlc gate on\|off` | ฉุกเฉิน | ปิด/เปิด spec gate |
| `/sdlc memory` | จบงาน | ดู learning log |
| `/terminal-font ghostty` | ครั้งแรก | config ฟอนต์ไทยสำหรับ terminal นั้น |
| `/thai-preview` | ตั้งค่าธีม | ตัวอย่างสี+ฟอนต์ใน browser |
| `/thai-theme` | จะใช้ธีม | ตั้ง `thai-looped-night` ให้ project |

สรุป: **พิมพ์ requirement → `/sdlc approve` → ปล่อยจนจบ → อ่าน review packet**
interaction ส่วนใหญ่มีแค่นี้

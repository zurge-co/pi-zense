# zense Backlog

บันทึก issue/bug/workflow ที่ต้องแก้ สำหรับ zense codebase

## List Style

| ID | Type | Priority | Title | Status | Spec Ref |
|----|------|----------|-------|--------|----------|
| 1 | Bug | Critical | Verdict parser หลวม — `\b` กินที่ `-` (PASS\|FAIL)\b → FAIL-corrected ถูกเข้าใจเป็น FAIL | | |
| 2 | Bug | Critical | zense_eval ทิ้ง parameter `note` | | |
| 3 | Bug | Critical | Probe exit code 127 → false FAIL | | |
| 4 | Bug | Critical | Quality gate false positive — `\bgrep\b` ใน prose grep | | |
| 5 | Workflow | High | Reviewer sub-agent hallucinate | Done | commit นี้ (v3) |
| 6 | Workflow | Medium | Scope check flag เทียบ — worktree redirect | | |
| 7 | Workflow | — | Worktree หลุดตอน bump spec (v6) | Done | 94e2886 |
| 8 | Hygiene | Low | Cleanup worktree + branch ค้าง | Done | release 0.18.0 |
| 9 | Hygiene | Low | Lesson เข้า memory อย่างเป็นทางการ | | |
| 10 | Tool | Medium | `zense_backlog` tool — state เก็บใน `.zense/backlog.json` | | |
| 11 | Bug | Critical | Sub-agent โดน timeout 240s แต่รายงานเป็น `exited code=143 signal=null` ลึกลับ + requirements เสียเวลา probe toolchain เองจนชน timeout | Done | commit นี้ |

---

## Details

### A. Bug ที่ทำให้ eval/probe ตัดสินผิด (สำคัญสุด — เป็นต้นเหตุ false FAIL/PASS วันนี้)

**1. Verdict parser หลวมเกิน**
- `parseGraderOutput` ใช้ `(PASS|FAIL)\b[ \t]*:?` ทำให้ `tests-pass: FAIL-corrected → PASS` โดนจับเป็น FAIL (เพราะ `\b` กินที่ `-`)
- ต้องบังคับ colon หลัง verdict ตาม contract

**2. zense_eval รับ note แต่ทิ้ง**
- `_p` ไม่เคยถูกใช้ `note` ไม่ถึง grader prompt (พิสูจน์แล้ววันนี้: ส่ง note 3 รอบไม่มีผล)
- ต้อง prepend เข้า `buildGraderPrompt`

**3. Probe exit 127 → false-FAIL**
- check แบบ prose grep: `<คำอธิบาย> รัน sh -c แล้ว grep` → `command not found` 127 → probe primacy ทับ grader
- 127 ที่ stderr เป็น command not found ควรเป็น skipped (human review)
- รวมเคส `$-prompt` ที่ผ่าน gate แต่รันไม่ได้

**4. Quality gate false positive**
- `isMachineCheckable` match `\bgrep\b` ใน prose grep: ... → ไม่โดนดันลง specDebt ทั้งที่เช็คด้วยเครื่องไม่ได้
- ต้องตรวจ token แรกเป็น command จริง

---

### B. Bug ด้าน workflow (เจอจากการใช้งานจริงวันนี้)

**5. Reviewer sub-agent hallucinate — ✅ แก้แล้ว (v3, commit นี้)**
- 2 รอบติด: เอาบริบท eval เก่ามาปน, เดา commit/rollback ที่ไม่มีจริง → ราก 2 ชั้น: (1) รอบ FAIL ค้าง escalation `need-fix: criteria failed: …` ไม่เคยถูกล้างตอน PASS → reviewer เห็นปน evidence เขียน TL;DR ขัด verdict จริง — แก้ด้วยล้าง need-fix ตอน PASS; (2) evidence ถูกย่อเหลือ id:status → แต่ง identifier/hash เอง (ENTROPY_TIMEOUT_MINS ฯลฯ) — แก้ด้วย evidence verbatim (probe detail + criteria text) + grounding contract ใน prompt + `findUngroundedTokens` ตรวจ token ใน packet ต้องมีใน evidence (retry×1 → trajectory flag `reviewer hallucination`)

**6. Scope check flag เทียบ**
- write ที่ redirect เข้า worktree โดน out-of-scope write: `.zense/worktree/...` ทุกครั้ง
- flag จริงจมใน noise
- ต้อง normalize worktree prefix ก่อนเทียบ scope

**7. Worktree หลุดตอน bump spec**
- ✅ แก้แล้ว (v6, merge 94e2886)

**11. Sub-agent timeout: `code=143 signal=null` ไม่มี TIMEOUT marker + requirements ชน timeout บ่อย — ✅ แก้แล้ว (commit นี้)**
- ต้นตอ: `runSubagent` ยิง SIGTERM ที่ 240s → pi จับ SIGTERM เองแล้ว exit(143) → close ได้ `code=143 signal=null` → เงื่อนไข `signal==="SIGTERM"` เดิมไม่เคยจริง ทุก timeout ดูเป็น crash ลึกลับ (พิสูจน์จาก log: เวลา start→last write = 240s พอดีทุกไฟล์)
- แก้ A: `timedOut` flag set ใน timer callback + SIGKILL backstop 5s + log มี `(timeout SIGTERM)` marker
- แก้ B: timeout ต่อ role (`SUBAGENT_TIMEOUT_MS`: requirements/grader 600s, reviewer 480s, default 300s) — ช่องปรับของ agent คือ `.zense/config.json` (key `subagentTimeoutMs`) อ่านสดทุก launch (env override ถอดออก 2026-09-02 ตามคำตัดสินใจ user)
- แก้ C (ต้นตอจริง): requirements เสียเวลา `command -v` ทีละตัว (deno cargo go make …) → `gatherRepoFacts` เพิ่ม `probeToolchain` (execSync เดียว, timeout 5s) ดัน `toolchain on PATH` เข้า facts + prompt สั่ง trust facts / batch probe ใน ONE bash loop
- test: `test/subagent-timeout.test.mjs` (เพิ่มใน `npm test`)

---

### C. งานเทียบ / hygiene

**8. Cleanup worktree + branch ค้าง**
- v3 (10-16-46), v5 (11-27-00) ยัง orphan อยู่ใต้ `.zense/worktree/` + branch `zense/impl/v3-...` unmerged

**9. Lesson เข้า memory อย่างเป็นทางการ**
- "probe = ripgrep syntax, literal ต้อง rg -qF" (เจอซ้ำ 2 รอบ)
- ควรกลายเป็น exemplar/fact ที่ `compile_spec` feed ให้ requirements sub-agent ทุกครั้ง จะได้ไม่เขียน check พังอีก

---

### D. Tool ใหม่

**10. `zense_backlog` — tool จัดการ backlog (state อยู่ใน `.zense/`)**

state of truth อยู่ใน `.zense/backlog.json` (แพทเทิร์นเดียวกับ `spec.json` / `memory.jsonl`)

**Storage** — `.zense/backlog.json` (single JSON doc เหมาะกว่า JSONL เพราะ item ต้อง update status ในที่):
```json
{
  "version": 1,
  "items": [
    { "id": 1, "type": "Bug", "priority": "Critical", "title": "...",
      "details": ["..."], "status": "Open",
      "specRef": null, "createdAt": "...", "updatedAt": "..." }
  ]
}
```

**Implementation** — เพิ่ม `pi.registerTool({ name: "zense_backlog", ... })` ใน `extensions/zense-harness/index.ts` ตามแพทเทิร์น zense_spec/adr/eval/review

**Actions**:
- `add` — type (Bug/Workflow/Hygiene/Tool/Feature), priority, title, details[] → id running
- `update` — id + status (Open/InProgress/Done/Dropped), priority, title, details, `specRef` (ลิงก์ spec version / commit ที่แก้)
- `list` — filter ตาม type/priority/status (default ซ่อน Done/Dropped)
- `get` — id → full details

**Integration กับ harness**:
- `zense_eval` FAIL หรือเจอ specDebt → prompt hint ให้ add เข้า backlog (ผ่าน promptGuidelines / learn() เหมือน quality gate)
- ใช้ได้ทั้ง backlog ของ pi-zense เอง (dogfooding) และ project ของ user

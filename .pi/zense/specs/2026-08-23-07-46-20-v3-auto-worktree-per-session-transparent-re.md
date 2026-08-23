# Spec v3: Auto worktree-per-session: transparent redirect at implementation + auto merge-back at eval PASS
approved: false

## Intent
ทำให้การแยก session เป็นอัตโนมัติเพื่อกัน 2 main-agent session เขียนทับกันใน working tree เดียวกัน: เมื่อ spec ถูกเซ็น (phase → implementation) ระบบสร้าง git worktree ของ session นั้นเอง แล้ว redirect ทุก tool call (write/edit/read/bash) ของ main agent ให้ทำงานใน worktree โดย agent ไม่รู้ตัว (ผ่านการ mutate event.input ซึ่ง pi รองรับ); grader/reviewer sub-agent รันใน worktree ด้วยเพื่อเทสโค้ดที่แก้จริง; เมื่อ eval PASS ระบบ auto-commit ใน worktree แล้ว merge กลับเข้า main (มี conflict detection — ถ้าอีก session  merge ชนกันจะ escalate ไม่ clobber เงียบๆ) แล้ว cleanup worktree; ถ้า eval FAIL เก็บ worktree ไว้แก้ต่อ; ถ้า session จบก่อน eval PASS เก็บ worktree ไว้ให้มนุษย์ merge เอง (ไม่ auto-merge งานที่ยังไม่ผ่าน); ไม่มี human dialog ใดๆ ในกระบวนการนี้

## Scope
- extensions/zense-harness/
- test/
- docs/HUMAN-ACTIONS.md
- README.md

## Constraints
- ไม่มี human dialog ในกระบวนการ worktree — สร้าง/redirect/merge/cleanup อัตโนมัติหมด
- ใช้พลังของ pi tool_call interceptor ที่ event.input mutable (extensions.md L759-762): mutate event.input.path (write/edit/read) และ event.input.command (bash) ก่อน execution เพื่อ redirect เข้า worktree โดย agent ไม่รู้ตัว
- redirect เฉพาะ path ที่อยู่ใต้ ctx.cwd (repo) — path ภายนอก repo (เช่น pi docs ที่ /Users/.../node_modules) ต้องไม่ถูก redirect
- path ใต้ .pi/zense/ ต้องไม่ถูก redirect (harness state — spec/memory/adr/logs — อยู่ที่ main เสมอ เพราะ extension เขียนผ่าน ctx.cwd ตรงๆ ไม่ใช่ tool call)
- sub-agent (PI_ZENSE_SUBAGENT=1) เป็นคนละ process มี ctx.cwd ของตัวเอง และ extension ของมัน return ตั้งแต่ต้น (index.ts L404) → redirector ใน main process ไม่กระทบมันอยู่แล้ว แต่ต้อง ensure launchSubagent ส่ง worktree root เป็น cwd ให้ grader/reviewer เวลามี worktree ที่ active (เพื่อเทสโค้ดใน worktree ไม่ใช่ main ที่ไม่มีการแก้)
- trigger สร้าง worktree = approveCurrentSpec (phase → implementation) — ก่อนหน้านี้ไม่มี source write (gate กั้น) จึงไม่ต้องสร้างก่อน
- trigger merge-back = zense_eval PASS (งาน verified สมบูรณ์) — ไม่ใช่ agent_end (เดี๋ยว merge ทุก prompt) และไม่ใช่ eval FAIL (เก็บ worktree ไว้แก้ต่อ)
- merge mechanism: auto-commit ใน worktree ก่อน (`git -C <wt> add -A && commit`) แล้ว `git -C <main> merge --no-ff <branch>` สร้าง merge commit ใน main; หาก conflict (เช่นอีก session merge ชน) ต้อง escalate (need-decision) และเก็บ worktree ไว้ ห้าม force/overwrite
- worktree เป็น best-effort: ถ้า `git worktree add` ล้มเหลว (ไม่ใช่ git repo / ชื่อซ้ำ / dirty blocks) → notify + ทำงานใน main ตามปกติ (no isolation แต่ไม่พัง) — graceful degradation
- worktree สร้างเป็น sibling dir นอก repo: นั่นคือ `<parent of ctx.cwd>/<repo>-wt-<branch>`; branch = `zense/impl/v<N>-<stamp>`; ห้ามซ้ำชื่อที่มีอยู่
- สำหรับให้ unit-test ได้ ต้อง export pure helpers: rewritePathForWorktree(cwd, wtRoot, path) และ buildBashPrefix(cmd, wtRoot) (หรือชื่อเทียบเท่า) จาก index.ts
- ห้ามใช้ native git binding — ใช้ spawnSync/execSync ของ git เท่านั้น; จัดการ error ถ้าไม่ใช่ git repo หรือ git ไม่มี
- copy .pi/zense/spec.json + spec.md + memory.jsonl จาก main เข้า worktree ตอนสร้าง (ให้ bash-based read ของ agent/sub-agent ใน worktree เห็น spec/memory ปัจจุบัน ไม่ใช่ของตอน checkout)
- widget แสดง worktree status (branch หรือ marker 🌳) เมื่อ active
- ห้ามย้าย session cwd — redirect ทำผ่าน tool_call mutation เท่านั้น ไม่ได้เปลี่ยน ctx.cwd

## Acceptance criteria
- [ ] rewrite-path-inside: rewritePathForWorktree(cwd, wtRoot, path) เมื่อ path อยู่ใต้ cwd → คืน path ใต้ wtRoot ที่สอดคล้องกัน (relative structure เดิม) *(check: unit-test: rewritePathForWorktree('/r','/r-wt','extensions/x.ts') === '/r-wt/extensions/x.ts'; และ absolute ใต้ cwd: rewritePathForWorktree('/r','/r-wt','/r/a/b.ts') === '/r-wt/a/b.ts')*
- [ ] rewrite-path-outside: rewritePathForWorktree ไม่ redirect path นอก repo (relative ออกนอก หรือ absolute ไม่ใต้ cwd) → คืน path เดิม *(check: unit-test: rewritePathForWorktree('/r','/r-wt','/Users/elsewhere/doc.md') === '/Users/elsewhere/doc.md'; rewritePathForWorktree('/r','/r-wt','../outside') ไม่อยู่ใต้ wtRoot)*
- [ ] rewrite-path-zense-skip: rewritePathForWorktree ไม่ redirect path ใต้ .pi/zense/ → คืน path เดิม (harness state อยู่ main) *(check: unit-test: rewritePathForWorktree('/r','/r-wt','.pi/zense/spec.md') === '.pi/zense/spec.md' (หรือ absolute ใต้ /r/.pi/zense ไม่ redirect))*
- [ ] rewrite-bash-prefix: buildBashPrefix/wrapper สำหรับ bash นำหน้า command ด้วย `cd <wtRoot> &&` (quoted) เพื่อให้ bash รันใน worktree *(check: unit-test: buildBashPrefix('ls', '/r-wt') === "cd /r-wt && ls" (path มี space ต้อง quote))*
- [ ] worktree-create-on-approve: approveCurrentSpec สร้าง git worktree (git worktree add <dir> -b zense/impl/v<N>-<stamp>) + copy spec/memory เข้า worktree + set state.worktree {root,branch,dir} *(check: integration temp git repo + mock: เรียก approveCurrentSpec → git worktree list มี entry ใหม่ && existsSync(<dir>/.pi/zense/spec.json) === true && state.worktree.branch.startsWith('zense/impl/'))*
- [ ] worktree-create-fail-graceful: ถ้า git worktree add ล้มเหลว (เช่น ไม่ใช่ git repo) → notify + state.worktree=null + session ทำงานใน main ได้ตามปกติ (ไม่ throw/crash) *(check: integration: ใน temp dir ไม่มี .git → approveCurrentSpec → notify ถูกเรียก (warning/error), state.worktree===null, handler ไม่ throw)*
- [ ] redirector-write: tool_call interceptor เมื่อ state.worktree active: mutate event.input.path ของ write/edit/read ให้เป็น path ใน worktree (ผ่าน rewritePathForWorktree) *(check: unit-test: stub tool_call event write {path:'extensions/x.ts'} + state.worktree → หลัง handler, event.input.path === '<wtRoot>/extensions/x.ts')*
- [ ] redirector-bash: tool_call interceptor เมื่อ state.worktree active: mutate event.input.command ของ bash ให้นำหน้าด้วย cd <wtRoot> *(check: unit-test: stub tool_call bash {command:'npm test'} + state.worktree → หลัง handler event.input.command === 'cd <wtRoot> && npm test')*
- [ ] redirector-inactive-noop: เมื่อ state.worktree === null (หรือ merged) interceptor ไม่ mutate อะไรเลย (ทำงานเหมือนเดิม) *(check: unit-test: state.worktree=null → stub write event → event.input.path ไม่ถูกเปลี่ยน)*
- [ ] subagent-cwd-worktree: launchSubagent เมื่อ state.worktree active ส่ง worktree root เป็น cwd ให้ runSubagent (grader/reviewer รัน/เทสใน worktree); เมื่อ null ใช้ ctx.cwd เหมือนเดิม *(check: grep launchSubagent ใน index.ts ใช้ state.worktree?.root ?? ctx.cwd สำหรับ cwd param; unit-test spy runSubagent ได้รับ wtRoot เมื่อ active)*
- [ ] mergeback-on-eval-pass: zense_eval on PASS: auto-commit worktree (git add -A && commit) + git merge --no-ff <branch> เข้า main + cleanup worktree (git worktree remove) + delete branch + state.worktree=null + phase='review' *(check: integration temp git repo: สร้าง worktree + เขียนไฟล์ใน worktree + trigger eval PASS → git -C main log มี merge commit 'zense: merge impl' && git worktree list ไม่มี wt && state.worktree===null && state.phase==='review')*
- [ ] mergeback-conflict-escalate: zense_eval on PASS เมื่อ merge conflict (มี changes ใน main ที่ทับกับ worktree): ไม่ force/overwrite; escalate (need-decision) + เก็บ worktree ไว้ + notify บอกวิธี resolve ด้วยมือ *(check: integration: สร้าง worktree จาก HEAD → แก้ไฟล์เดียวกันใน main (commit) + แก้ใน worktree → trigger eval PASS → state.escalations มี entry 'need-decision' ที่เกี่ยว merge/worktree && git worktree list ยังมี wt && state.worktree ไม่ null)*
- [ ] eval-fail-keep-wt: zense_eval on FAIL: เก็บ worktree ไว้ (ไม่ merge ไม่ cleanup) state.worktree ยัง active เพื่อแก้ต่อ *(check: integration: สร้าง worktree + trigger eval FAIL → state.worktree ยังไม่ null && git worktree list ยังมี wt)*
- [ ] agent-end-unmerged-leave: agent_end เมื่อ state.worktree ยัง active (ยังไม่ merge ไม่ pass): เก็บ worktree ไว้ + notify บอก path/branch ให้มนุษย์ merge ด้วยมือ ไม่ auto-merge งานที่ยังไม่ verified *(check: integration: สร้าง worktree + trigger agent_end → state.worktree ยังไม่ null && notify ถูกเรียก มี path/branch ในข้อความ)*
- [ ] widget-worktree: widget ZENSE แสดง marker worktree (เช่น 🌳 <branch>) เมื่อ state.worktree active *(check: grep 'worktree' ใน updateWidget index.ts; unit-test: state.worktree={branch:'zense/impl/v1-x'} → widget string มี 'zense/impl/v1-x' หรือ marker 🌳)*
- [ ] status-command-worktree: /zense status แสดง worktree state (root, branch, merged หรือ active) เมื่อมี *(check: grep: /zense status handler มี state.worktree ใน notify text; unit-test: state.worktree active → status text มี branch)*
- [ ] subagent-unaffected: sub-agent process (PI_ZENSE_SUBAGENT=1) ไม่โหลด redirector (extension return ตั้งแต่ต้น L404 เดิม) → ทำงานใน cwd ของมัน (worktree root ที่ launchSubagent ส่ง) อย่างเป็นธรรมชาติ *(check: grep PI_ZENSE_SUBAGENT early-return ยังอยู่ใน index.ts; unit-test: process.env.PI_ZENSE_SUBAGENT='1' → default export เรียกแล้วไม่ register tool_call handler (return ก่อน))*
- [ ] readme-doc: README.md + docs/HUMAN-ACTIONS.md อธิบาย auto worktree-per-session: สร้างตอน implementation, redirect transparent, merge-back ตอน eval PASS, conflict → escalate, session-end ก่อน pass → manual merge *(check: grep -l 'worktree' README.md docs/HUMAN-ACTIONS.md ครบ)*

## Spec debt (human-verified only)
- redirect ของ bash ด้วย `cd <wt> &&` อาจไม่เนียนสำหรับ multi-line/heredoc/คำสั่งที่ assume cwd — ต้องทดสอบกับโค้ดจริงที่ agent รัน (manual)
- auto-commit ใน worktree + merge --no-ff สร้าง merge commit ใน main history — เปลี่ยนพฤติกรรมเดิมที่ทิ้งไว้ uncommitted ให้มนุษย์ commit; ยืนยันกับมนุษย์ว่ายอมรับ merge commit อัตโนมัติได้ (manual review)
- กรณี main มี uncommitted .pi/zense/ ตอน merge — git merge อนุญาตถ้าไฟล์ทับไม่ชน แต่ต้องยืนยันจริงใน session 2 ตัว (manual)
- merge conflict escalation ข้อความชี้แนะวิธี resolve ชัดพอให้มนุษย์ทำต่อได้ (manual)
- worktree ที่ยังไม่ merge ตอน session จบ — ยืนยันว่า notify บอก path/branch พอให้มนุษย์กลับมา merge/cleanup ได้ (manual)


## Eval 2026-08-23T08:46:29.292Z
verdict: **PASS** (grader.ok=true)
per-criteria:
- rewrite-path-inside: ?
- rewrite-path-outside: ?
- rewrite-path-zense-skip: ?
- rewrite-bash-prefix: ?
- worktree-create-on-approve: ?
- worktree-create-fail-graceful: ?
- redirector-write: ?
- redirector-bash: ?
- redirector-inactive-noop: ?
- subagent-cwd-worktree: ?
- mergeback-on-eval-pass: ?
- mergeback-conflict-escalate: ?
- eval-fail-keep-wt: ?
- agent-end-unmerged-leave: ?
- widget-worktree: ?
- status-command-worktree: ?
- subagent-unaffected: ?
- readme-doc: ?

grader output:
urn works (handlers: []). Now with env cleared:


⚙ bash {"command":"cd /Users/saint/zurge/pi-zense && env -u PI_ZENSE_SUBAGENT node --no-warnings -e \"\nimport('file:///User…
✗ bash failed



⚙ bash {"command":"cd /Users/saint/zurge/pi-zense && env -u PI_ZENSE_SUBAGENT node --no-warnings -e \"\nimport('file:///User…


rewrite-path-inside: PASS: unit tests `rewritePathForWorktree('/r','/r-wt','extensions/x.ts')==='/r-wt/extensions/x.ts'` and absolute `/r/a/b.ts→/r-wt/a/b.ts` both pass in test/worktree.test.mjs (npm test: 20/20 pass)
rewrite-path-outside: PASS: unit tests confirm `/Users/elsewhere/doc.md` returned unchanged and `../outside.txt` result not under wtRoot (both pass)
rewrite-path-zense-skip: PASS: unit tests confirm `.pi/zense/spec.md` and `/r/.pi/zense/memory.jsonl` returned unchanged; live stub run also shows read `.pi/zense/spec.md` unmutated
rewrite-bash-prefix: PASS: buildWorktreeCommand (named differently) prepends `cd <quoted-wtRoot> &&`: live run produced `cd '/r-wt' && npm test`; test asserts `cd '/path with space/wt' && ls` (always single-quoted, satisfies space-quoting intent)
worktree-create-on-approve: PASS: approveCurrentSpec (index.ts L932) calls createWorktree and sets state.worktree={root,branch,dir}; integration test in real temp git repo verifies branch `zense/impl/v1-*`, `git worktree list` entry, and spec.json copied into worktree
worktree-create-face-graceful: PASS: integration test shows createWorktree in non-git dir returns null (no throw); approveCurrentSpec else-branch (L936-937) sends warning notify and leaves state.worktree null
redirector-write: PASS: live stub of tool_call handler with active state.worktree mutated write `{path:'extensions/x.ts'}` → `event.input.path==='/r-wt/extensions/x.ts'`; edit `/r/a/b.ts` → `/r-wt/a/b.ts`
redirector-bash: PASS: live stub: bash `{command:'npm test'}` with active worktree → `event.input.command==="cd '/r-wt' && npm test"`
redirector-inactive-noop: PASS: live stub with worktree=null: write path stayed `extensions/x.ts` (not blocked, unmutated) and bash cmd stayed `npm test`
subagent-cwd-worktree: PASS: index.ts L565 `const subCwd = state.worktree?.root ?? ctx.cwd;` passed to runSubagent inside launchSubagent
mergeback-on-eval-pass: PASS: integration test: merge commit matches /merge impl/ (`zense: merge impl v1 (eval PASS)`), src.txt landed in main, worktree dir removed, branch deleted; zense_eval PASS branch (L1156-1166) sets state.worktree=null then state.phase='review'
mergeback-conflict-escalate: PASS: integration test: same-file change in main+worktree → mr.ok=false, conflict=true, worktree kept; eval PASS wiring (L1159-1160) escalates need-decision + warning notify with manual-resolve steps, state.worktree untouched
eval-fail-keep-wt: PASS: zense_eval FAIL branch (L1136-1143) only sets phase/escalation and returns isError — never calls mergeWorktreeBack or clears state.worktree, so worktree stays active
agent-end-unmerged-leave: PASS: live stub agent_end with active worktree → notify `🌳 worktree ค้างอยู่ (ยังไม่ merge): /r-wt | branch zense/impl/v1-x — ... git merge zense/impl/v1-x`, state.worktree not cleared; dedupe flag prevents repeat
widget-worktree: PASS: live stub: state.worktree active → widget string `... 🌳 r-wt` (contains 🌳 marker per check; shows basename of root, not branch name, but check allows marker)
status-command-worktree: PASS: /zense status handler (L1241) notify includes `worktree: ${state.worktree.dir}\n branch ${state.worktree.branch} (active...)` when active else `worktree: (none...)`
subagent-unaffected: PASS: index.ts L486 `if (process.env.PI_ZENSE_SUBAGENT === "1") return;` before any registration; live check with env=1 → zero handlers registered (current session itself runs with PI_ZENSE_SUBAGENT=1)
readme-doc: PASS: README.md L31-32,68-70 and docs/HUMAN-ACTIONS.md L51,64 cover create-on-approve, transparent redirect, merge-back on eval PASS, conflict→escalate need-decision, session-end→manual merge
OVERALL: PASS

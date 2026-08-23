# ADR-001: Transparent worktree redirection via tool_call input mutation + auto merge-commit into main
status: accepted
date: 2026-08-23T08:37:02.055Z

## Decision
ใช้ pi tool_call interceptor ที่ event.input mutable (extensions.md L759-762) เพื่อ rewrite path/command ของ write/edit/read/bash ให้ทำงานใน git worktree โดย agent ไม่รู้ตัว (session cwd ยังอยู่ที่ main); grader/reviewer sub-agent รันใน worktree ผ่าน cwd param; merge-back ใช้ `git merge --no-ff` สร้าง merge commit จริงใน main history (ไม่ใช่ squash/working-tree copy) เพื่อให้มี conflict detection ระหว่าง session

## Consequences
main history มี auto merge commit "zense: merge impl v<N>" โดยอัตโนมัติ (ต่างจากพฤติกรรมเดิมที่ทิ้งไว้ uncommitted); path ใต้ .pi/zense/ และ path นอก repo ไม่ถูก redirect; ถ้า git worktree add ล้มเหลวจะ degrade กลับทำงานใน main ตามปกติ

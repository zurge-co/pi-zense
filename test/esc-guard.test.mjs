import { strict as assert } from "node:assert";
import test from "node:test";
import { createEscGuard } from "../extensions/zense-harness/index.ts";

// B (ESC): global input guard ของ dialog zense — กัน ESC รั่วไปชน defaultEditor.onEscape ของ pi
// (abort streaming) แทนที่จะปิด dialog. test ครอบ logic ของ guard ระดับ pure (routing ของ TUI จริง = specDebt)

test("esc-guard: ไม่มี dialog เปิด → คืน undefined ทุก key (ห้าม consume/แตะอะไรเลย)", () => {
	const g = createEscGuard();
	assert.equal(g.handleInput("\x1b"), undefined); // ESC ก็ผ่าน เพราะไม่มี dialog
	assert.equal(g.handleInput("a"), undefined);
	assert.equal(g.handleInput("\x1b[A"), undefined); // arrow up
	assert.equal(g.depth(), 0);
});

test("esc-guard: มี dialog เปิด → ESC consume + ปิด dialog นั้นด้วย close(), key อื่นผ่าน", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => {
		closed++;
		h.close(); // จำลองพฤติกรรมจริง: dialog ถอดตัวเองออกจาก stack ตอนปิด
	});
	assert.equal(g.depth(), 1);
	// key อื่นต้องผ่านปกติ (ให้ component ที่ focused จัดการเอง)
	assert.equal(g.handleInput("a"), undefined);
	assert.equal(g.handleInput("\x1b[A"), undefined);
	assert.equal(closed, 0);
	// ESC → consume + ปิด
	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.equal(closed, 1);
	assert.equal(g.depth(), 0);
	// stack ว่างแล้ว → key ถัดไปผ่าน (รวม ESC ของ editor เอง — เช่น user กดเพื่อ abort ตั้งใจ)
	assert.equal(g.handleInput("\x1b"), undefined);
});

test("esc-guard: stack ซ้อน — ESC ปิดเฉพาะ dialog บนสุด แล้วไล่ตัวถัดไป", () => {
	const g = createEscGuard();
	const order = [];
	const h1 = g.open(() => { order.push("d1"); h1.close(); });
	const h2 = g.open(() => { order.push("d2"); h2.close(); });
	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.deepEqual(order, ["d2"]); // ตัวบนสุด (เปิดทีหลัง) ปิดก่อน
	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.deepEqual(order, ["d2", "d1"]);
	assert.equal(g.handleInput("\x1b"), undefined); // ว่างแล้ว → ผ่าน
});

test("esc-guard: handle.close() ด้วยมือถอดออกจาก stack (ปิดผ่านปุ่มอื่น) → ESC ไม่ consume", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => { closed++; h.close(); });
	h.close(); // dialog ปิดเองผ่านเส้นทางอื่น (y/n/enter) — entry ต้องหายจาก stack
	assert.equal(g.depth(), 0);
	assert.equal(g.handleInput("\x1b"), undefined);
	assert.equal(closed, 0);
});

test("esc-guard: kitty-protocol escape (\x1b[27u) ก็ถือเป็น ESC เช่นเดียวกับ \x1b ดิบ", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => { closed++; h.close(); });
	assert.deepEqual(g.handleInput("\x1b[27u"), { consume: true });
	assert.equal(closed, 1);
});

test("esc-guard: reset() ล้าง stack ทั้งหมด (session ใหม่ — overlay เก่าถูก pi pop ไปแล้ว)", () => {
	const g = createEscGuard();
	g.open(() => {});
	g.open(() => {});
	assert.equal(g.depth(), 2);
	g.reset();
	assert.equal(g.depth(), 0);
	assert.equal(g.handleInput("\x1b"), undefined);
});

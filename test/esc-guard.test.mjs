import { strict as assert } from "node:assert";
import test from "node:test";
import { createEscGuard } from "../extensions/zense-harness/index.ts";

// B (ESC): the global input guard for zense dialogs — keeps ESC from leaking into pi's
// defaultEditor.onEscape (streaming abort) instead of closing a dialog. Tests cover the
// guard's pure logic (real TUI routing = specDebt)

test("esc-guard: no dialog open → undefined for every key (never consumes/touches anything)", () => {
	const g = createEscGuard();
	assert.equal(g.handleInput("\x1b"), undefined); // even ESC passes — no dialog
	assert.equal(g.handleInput("a"), undefined);
	assert.equal(g.handleInput("\x1b[A"), undefined); // arrow up
	assert.equal(g.depth(), 0);
});

test("esc-guard: dialog open → ESC consumed + that dialog closed via close(), other keys pass", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => {
		closed++;
		h.close(); // real behavior: the dialog unregisters itself from the stack on close
	});
	assert.equal(g.depth(), 1);
	// other keys must pass normally (the focused component handles them)
	assert.equal(g.handleInput("a"), undefined);
	assert.equal(g.handleInput("\x1b[A"), undefined);
	assert.equal(closed, 0);
	// ESC → consumed + closed
	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.equal(closed, 1);
	assert.equal(g.depth(), 0);
	// stack empty → later keys pass (incl. the editor's own ESC — e.g. an intentional user abort)
	assert.equal(g.handleInput("\x1b"), undefined);
});

test("esc-guard: nested stack — ESC closes only the topmost dialog, then the next in line", () => {
	const g = createEscGuard();
	const order = [];
	const h1 = g.open(() => { order.push("d1"); h1.close(); });
	const h2 = g.open(() => { order.push("d2"); h2.close(); });
	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.deepEqual(order, ["d2"]); // the topmost (opened last) closes first
	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.deepEqual(order, ["d2", "d1"]);
	assert.equal(g.handleInput("\x1b"), undefined); // empty again → passes
});

test("esc-guard: manual handle.close() unregisters the dialog (closed via another key) → ESC not consumed", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => { closed++; h.close(); });
	h.close(); // the dialog closed itself via another path (y/n/enter) — its entry must leave the stack
	assert.equal(g.depth(), 0);
	assert.equal(g.handleInput("\x1b"), undefined);
	assert.equal(closed, 0);
});

test("esc-guard: kitty-protocol escape (\x1b[27u) counts as ESC, same as a raw \x1b", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => { closed++; h.close(); });
	assert.deepEqual(g.handleInput("\x1b[27u"), { consume: true });
	assert.equal(closed, 1);
});

test("esc-guard: reset() clears the whole stack (new session — old overlays were popped by pi)", () => {
	const g = createEscGuard();
	g.open(() => {});
	g.open(() => {});
	assert.equal(g.depth(), 2);
	g.reset();
	assert.equal(g.depth(), 0);
	assert.equal(g.handleInput("\x1b"), undefined);
});

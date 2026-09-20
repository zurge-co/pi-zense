// zense-harness module: terminal-input ESC guard so zense dialogs close instead of aborting the agent (moved verbatim from index.ts — see AGENTS.md map)

import { Key, matchesKey } from "@earendil-works/pi-tui";

// ----------------------------------------------------------------------------- esc-guard (module scope — exported for unit tests)

/** B (ESC): global input guard for zense dialogs — pi delivers keys only to the focused
 *  component; if focus slips off the overlay (e.g. while the agent streams), ESC lands in the
 *  main editor → onEscape aborts the agent's answer instead of closing the dialog. This guard
 *  sits at terminal-input level (before any component) via ctx.ui.onTerminalInput: every zense
 *  dialog registers itself onto a stack on open and unregisters on close — while the stack is
 *  non-empty ESC is consumed and closes the topmost dialog with its original semantics
 *  (done(null)); other keys pass through. With no dialog open the guard always returns
 *  undefined (never touches system keys). */
export type EscGuardHandler = (data: string) => { consume?: boolean } | undefined;
export interface EscGuardHandle { close: () => void }
export const createEscGuard = (): { open: (close: () => void) => EscGuardHandle; handleInput: EscGuardHandler; reset: () => void; depth: () => number } => {
	const stack: Array<() => void> = [];
	return {
		open: (close) => {
			stack.push(close);
			let alive = true;
			return {
				close: () => {
					if (!alive) return;
					alive = false;
					const i = stack.lastIndexOf(close);
					if (i >= 0) stack.splice(i, 1);
				},
			};
		},
		handleInput: (data) => {
			if (!stack.length) return undefined; // no dialog open → consume nothing
			if (data === "\x1b" || matchesKey(data, Key.escape)) {
				stack[stack.length - 1](); // close the topmost — the dialog unregisters itself via handle.close()
				return { consume: true };  // the key reaches no other component, incl. the main editor (no abort)
			}
			return undefined; // every other key goes to the focused component as usual
		},
		reset: () => { stack.length = 0; }, // new session: old overlays were popped by pi — drop stale entries
		depth: () => stack.length,
	};
};

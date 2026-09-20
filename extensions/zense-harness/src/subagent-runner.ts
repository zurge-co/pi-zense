// zense-harness module: sub-agent runner: spawn pi subprocess, stream log, kill/timeout handling (+ fmtTok) (moved verbatim from index.ts — see AGENTS.md map)

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { zenseDir } from "./types.ts";
import { SUBAGENT_EXCLUDE_TOOLS, SUBAGENT_STRIP_FLAGS, subagentTimeout, buildSubagentArgv } from "./subagent-config.ts";

// ----------------------------------------------------------------------------- sub-agent runner

/** Humanize token counts: 999000→"999k", 1_000_000→"1.0M". */
export const fmtTok = (n: number): string =>
	n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;

export const subagentLogPath = (cwd: string, role: string): string => {
	const dir = join(zenseDir(cwd), "subagents");
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	return join(dir, `${stamp}-${role}.log`);
};

/**
 * Spawn an isolated pi sub-agent (--mode json) with a clean context.
 * stdio ignores stdin — leaving the stdin pipe open makes pi wait for EOF until
 * the timeout (old bug: execFile hung silently until SIGTERM). --mode json, not print:
 * print mode buffers stdout whole and releases it at exit (tested: one chunk right
 * before close — the log looks frozen until the very end), while json mode streams
 * JSONL events from the start → parsed into text and appended live to the log so the
 * user can tail it during the run (/zense agents or ctrl+_).
 * abortSignal = pi's agent-turn signal (Esc): wired like the timeout — SIGTERM +
 * 5s SIGKILL backstop → resolves ok:false "cancelled by user" instead of waiting
 * out the (up to 10-minute) timeout (old bug: Esc did nothing mid-run).
 */
export function runSubagent(
	role: string,
	task: string,
	cwd: string,
	timeoutMs = subagentTimeout("default", cwd),
	onChunk?: (chunk: string) => void,
	logPath: string = subagentLogPath(cwd, role),
	modelPattern?: string,           // pi --model pattern (e.g. "anthropic/claude-sonnet") — undefined = pi default
	excludeTools?: string[],         // C: read-only roles (requirements) → ["write","edit"] (see SUBAGENT_EXCLUDE_TOOLS)
	stripFlags?: string[],           // ext-config: resolved from subagentStripFlags(role, subCwd, ctx.cwd) — undefined = built-in map
	abortSignal?: AbortSignal,       // pi agent-turn signal (Esc) — kill the child mid-run; pre-aborted → never spawn
): Promise<{ ok: boolean; output: string; logPath: string; usedModel?: string }> {
	const relLog = relative(cwd, logPath);
	return new Promise((res) => {
		// Esc already arrived before we got here (e.g. during a clarify dialog between
		// launches) → resolve immediately without spawning a doomed child
		if (abortSignal?.aborted) {
			res({ ok: false, output: "cancelled by user (Esc) — the sub-agent never started", logPath });
			return;
		}
		// M: pass role into the argv builder for that role's strip flags — the log header echoes them for later audit
		const argv = buildSubagentArgv(task, modelPattern, excludeTools, role, stripFlags);
		const strip = stripFlags ?? SUBAGENT_STRIP_FLAGS[role];
		writeFileSync(logPath, `$ pi --mode json --no-session${strip?.length ? ` ${strip.join(" ")}` : ""}${excludeTools?.length ? ` --exclude-tools ${excludeTools.join(",")}` : ""}${modelPattern ? ` --model ${modelPattern}` : ""} <task ${task.length} chars>\n--- live output (${role}) ---\n`);
		const child = spawn("env", argv, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let usedModel: string | undefined; // 'provider/id' of the first assistant message — compared against the configured model
		let finalText = ""; // latest assistant text from message_end — the success output, instead of a raw stdout tail
		const append = (chunk: string) => {
			out = (out + chunk).slice(-1_000_000);
			appendFileSync(logPath, chunk);
			onChunk?.(chunk);
		};
		// JSONL parser: stdout is event-per-line but chunks may split mid-line → buffer split by \n;
		// unparseable events (noise/ERROR lines before the session starts) are appended raw, never dropped
		let lineBuf = "";
		const fmtArgs = (args: unknown): string => {
			try {
				const s = JSON.stringify(args);
				return s.length > 120 ? `${s.slice(0, 117)}…` : s;
			} catch {
				return "";
			}
		};
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let ev: { type?: string; [k: string]: unknown };
			try {
				ev = JSON.parse(line);
			} catch {
				append(`${line}\n`);
				return;
			}
			switch (ev.type) {
				case "session":
					append(`[session ${(ev as { id?: string }).id ?? "?"}]\n`);
					break;
				case "tool_execution_start": {
					const t = ev as { toolName?: string; args?: unknown };
					append(`\n⚙ ${t.toolName} ${fmtArgs(t.args)}\n`);
					break;
				}
				case "tool_execution_end": {
					const t = ev as { toolName?: string; isError?: boolean };
					if (t.isError) append(`✗ ${t.toolName} failed\n`);
					break;
				}
				case "message_update": {
					// stream delta — text only (thinking/toolcall deltas skipped, keeps the log readable)
					const a = (ev as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
					if (a?.type === "text_delta" && typeof a.delta === "string") append(a.delta);
					break;
				}
				case "message_end": {
					// capture the final assistant text (content type text only — thinking skipped) as the
					// success output. json mode puts the message on a top-level field (pi
					// dist/modes/json-event.js — only update events are wrapped as assistantMessageEvent;
					// the old code read the wrong field so finalText/usedModel were never captured
					// → output fell back to a raw tail with tool noise mixed in = the reason some
					// compile_spec rounds couldn't parse a draft)
					type JsonMsg = { role?: string; provider?: string; model?: string; content?: { type?: string; text?: string }[] };
					const boxed = ev as { message?: JsonMsg; assistantMessageEvent?: JsonMsg };
					const msg = boxed.message ?? boxed.assistantMessageEvent;
					if (!usedModel && msg?.role === "assistant" && typeof msg.provider === "string" && typeof msg.model === "string")
						usedModel = `${msg.provider}/${msg.model}`;
					if (msg?.role === "assistant" && Array.isArray(msg.content)) {
						const text = msg.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
						if (text.trim()) {
							finalText = text;
							append("\n"); // newline after each assistant message
						}
					}
					break;
				}
				default:
					break;
			}
		};
		child.stdout?.on("data", (d) => {
			lineBuf += String(d);
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		child.stderr?.on("data", (d) => append(String(d)));
		// A (2026-09-02): timedOut is a flag set by the timer callback — never inspect the signal:
		// pi catches SIGTERM itself and exit(143)s → close arrives with code=143, signal=null, so
		// the old signal==="SIGTERM" check never fired = every timeout got reported as a
		// mysterious "exited code=143".
		// SIGKILL backstop after 5s: covers pi hanging in a long tool call after SIGTERM
		let timedOut = false;
		let cancelled = false; // set by the abort listener — distinguishes a user cancel from a crash in the close handler
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		}, timeoutMs);
		// Esc mid-run → same kill pattern as the timeout; abort supersedes the timeout timer
		const onAbort = () => {
			cancelled = true;
			clearTimeout(timer);
			appendFileSync(logPath, `\n--- cancelled by user (Esc) — SIGTERM ---\n`);
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		};
		abortSignal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (err) => {
			clearTimeout(timer);
			abortSignal?.removeEventListener("abort", onAbort);
			appendFileSync(logPath, `\n[spawn error] ${err.message}\n`);
			res({ ok: false, output: `sub-agent spawn error: ${err.message} (log: ${relLog})`, logPath });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			abortSignal?.removeEventListener("abort", onAbort);
			if (lineBuf.trim()) handleLine(lineBuf); // flush a trailing unterminated line
			appendFileSync(logPath, `\n--- exited code=${code} signal=${signal}${timedOut ? " (timeout SIGTERM)" : cancelled ? " (cancelled SIGTERM)" : ""} ---\n`);
			appendFileSync(logPath, `--- used model: ${usedModel ?? "(not captured from events)"} ---\n`);
			const modelInfo = usedModel !== undefined ? { usedModel } : {};
			if (cancelled)
				res({
					ok: false,
					output: `cancelled by user (Esc) — the ${role} sub-agent was killed mid-run\nlast output:\n${out.slice(-2_000)}\n(full log: ${relLog})`,
					logPath,
					...modelInfo,
				});
			else if (code === 0 && !signal) res({ ok: true, output: (finalText || out).slice(-16_000), logPath, ...modelInfo });
			else
				res({
					ok: false,
					output:
						`sub-agent exited code=${code} signal=${signal}${timedOut ? ` (TIMEOUT ${timeoutMs / 1000}s — bump per-role limit in .zense/config.json key subagentTimeoutMs)` : ""}\n` +
						`last output:\n${out.slice(-4_000)}\n(full log: ${relLog})`,
					logPath,
					...modelInfo,
				});
		});
	});
}

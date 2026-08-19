/**
 * thai-terminal — custom font + color setup for Thai-language pi sessions.
 *
 * Pi (a CLI) cannot change the terminal font itself — fonts are owned by the
 * terminal emulator. This extension therefore does two things:
 *
 *   1. Contributes the "thai-looped-night" color theme (.pi/themes/) and lets
 *      you activate it with /thai-theme.
 *   2. Auto-installs the bundled IBM Plex Sans Thai Looped TTFs (SIL OFL 1.1,
 *      see fonts/OFL.txt) into the OS user font directory on session start —
 *      no admin, no manual download.
 *   3. Writes the terminal emulator config for you (/terminal-font auto-setup
 *      for ghostty/kitty/wezterm/alacritty/vscode, with confirm + backup), or
 *      shows copy-paste snippets for iTerm2/Terminal.app/Windows Terminal —
 *      plus an HTML preview (/thai-preview).
 *
 * Hard limitation: a program running *inside* a terminal cannot change the
 * terminal's font. Auto-install + config write gets the user down to a single
 * terminal restart — nothing less is possible.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolve theme dir regardless of install layout:
// package:  <pkg>/extensions/thai-terminal → join(HERE, "..", "..", "themes") = <pkg>/themes
// global:   ~/.pi/agent/extensions/thai-terminal → ~/.pi/agent/themes
// project:  <cwd>/.pi/extensions/thai-terminal → <cwd>/.pi/themes
const THEME_DIR = [
	join(HERE, "..", "..", "themes"),
	join(process.env.HOME ?? "", ".pi", "agent", "themes"),
].find((d) => existsSync(join(d, "thai-looped-night.json"))) ?? join(HERE, "..", "..", "themes");
const THEME_NAME = "thai-looped-night";
const FONT_FAMILY = "IBM Plex Sans Thai Looped";
const FONT_DOWNLOAD = "https://github.com/IBM/plex/releases (v6.4.0+ > IBM-Plex-Sans-Thai-Looped.zip)";
const FONT_FALLBACK = "Sarasa Term Nerd Font (brew install --cask font-sarasa-nerd หรือ font-sarasa-term-nerd)";

// Bundled TTFs (SIL OFL 1.1 — redistribution permitted, OFL.txt ships alongside).
const FONT_DIR = [
	join(HERE, "..", "..", "fonts"),
	join(process.env.HOME ?? "", ".pi", "agent", "fonts"),
].find((d) => existsSync(join(d, "IBMPlexSansThaiLooped-Regular.ttf"))) ?? join(HERE, "..", "..", "fonts");
const FONT_FILES = ["IBMPlexSansThaiLooped-Regular.ttf", "IBMPlexSansThaiLooped-Bold.ttf"];

/** OS user font dir (no admin): macOS ~/Library/Fonts, Linux ~/.local/share/fonts. */
function userFontDir(): string | null {
	if (process.platform === "darwin") return join(process.env.HOME ?? "", "Library", "Fonts");
	if (process.platform === "linux") return join(process.env.HOME ?? "", ".local", "share", "fonts");
	return null; // Windows needs registry registration — fall back to manual install
}

function fontsInstalled(): boolean {
	const dir = userFontDir();
	return dir !== null && FONT_FILES.every((f) => existsSync(join(dir, f)));
}

/** Copy bundled TTFs into the OS user font dir. Returns null on success, error string otherwise. */
function installFonts(): string | null {
	const dir = userFontDir();
	if (!dir || !existsSync(FONT_DIR)) return "manual";
	try {
		mkdirSync(dir, { recursive: true });
		for (const f of FONT_FILES) copyFileSync(join(FONT_DIR, f), join(dir, f));
		if (process.platform === "linux") {
			try {
				execFileSync("fc-cache", ["-f", dir], { stdio: "ignore" });
			} catch {
				/* fontconfig not installed — most desktop apps still pick it up */
			}
		}
		return null;
	} catch (err) {
		return String(err);
	}
}

// ---------------------------------------------------------------- terminal detection + config writers

type TerminalId = "ghostty" | "kitty" | "wezterm" | "alacritty" | "vscode" | "iterm2" | "apple" | "windows" | "unknown";

function detectTerminal(): TerminalId {
	const e = process.env;
	if (e.TERM_PROGRAM === "ghostty" || e.GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (e.TERM_PROGRAM === "iTerm.app") return "iterm2";
	if (e.TERM_PROGRAM === "Apple_Terminal") return "apple";
	if (e.TERM_PROGRAM === "vscode" || e.TERM_PROGRAM === "cursor") return "vscode";
	if (e.TERM_PROGRAM === "WezTerm" || e.WEZTERM_EXECUTABLE) return "wezterm";
	if (e.TERM_PROGRAM === "mintty" || e.WT_SESSION) return "windows";
	if (e.KITTY_WINDOW_ID || e.TERM === "xterm-kitty") return "kitty";
	if (e.ALACRITTY_SOCKET || e.ALACRITTY_LOG || e.TERM === "alacritty") return "alacritty";
	return "unknown";
}

const HOME = process.env.HOME ?? "";

interface TerminalTarget {
	/** Where the config lives (display + backup). */
	file: string;
	/** Absolute path if we can write it automatically, else null → snippet only. */
	writablePath: string | null;
	/** Lines to append for auto-install (idempotent marker included). */
	autoBlock: string;
	/** Human-readable snippet fallback. */
	snippet: string;
}

const AUTO_MARKER = "# >>> pi-zense thai font >>>";
const AUTO_END = "# <<< pi-zense thai font <<<";

const TARGETS: Record<TerminalId, TerminalTarget | null> = {
	ghostty: {
		file: "~/.config/ghostty/config",
		writablePath: join(HOME, ".config", "ghostty", "config"),
		autoBlock: `${AUTO_MARKER}\nfont-family = ${FONT_FAMILY}\nadjust-cell-width = 0%\n${AUTO_END}`,
		snippet: `font-family = ${FONT_FAMILY}\nfont-size = 14\n# Thai combining marks + consistent cell widths\nadjust-cell-width = 0%`,
	},
	kitty: {
		file: "~/.config/kitty/kitty.conf",
		writablePath: join(HOME, ".config", "kitty", "kitty.conf"),
		autoBlock: `${AUTO_MARKER}\nfont_family      ${FONT_FAMILY}\ndisable_ligatures never\n${AUTO_END}`,
		snippet: `font_family      ${FONT_FAMILY}\nfont_size 14\ndisable_ligatures never`,
	},
	wezterm: {
		file: "~/.wezterm.lua",
		writablePath: join(HOME, ".wezterm.lua"),
		// WezTerm is Lua — can't blindly append inside an existing config-return block,
		// so auto-write only appends lines that work at the end of a typical config.
		autoBlock: `-- ${AUTO_MARKER}\nconfig.font = wezterm.font("${FONT_FAMILY}")\nconfig.font_size = 14\n-- ${AUTO_END}`,
		snippet: `config.font = wezterm.font("${FONT_FAMILY}")\nconfig.font_size = 14`,
	},
	alacritty: {
		file: "~/.config/alacritty/alacritty.toml",
		writablePath: join(HOME, ".config", "alacritty", "alacritty.toml"),
		autoBlock: `${AUTO_MARKER}\n[font]\nnormal = { family = "${FONT_FAMILY}" }\nsize = 14\n${AUTO_END}`,
		snippet: `[font]\nnormal = { family = "${FONT_FAMILY}" }\nsize = 14`,
	},
	vscode: {
		file: "settings.json (Terminal › Integrated: Font Family)",
		writablePath: null, // settings.json is JSON-with-comments; safer to show snippet
		autoBlock: "",
		snippet: JSON.stringify(
			{ "terminal.integrated.fontFamily": FONT_FAMILY, "terminal.integrated.fontSize": 14 },
			null,
			2,
		),
	},
	iterm2: {
		file: "Preferences → Profiles → Text",
		writablePath: null,
		autoBlock: "",
		snippet: `Font → ${FONT_FAMILY}, 14pt · enable "Use a different font for non-ASCII text" pointing at the same family`,
	},
	apple: {
		file: "Settings → Profiles → Text",
		writablePath: null,
		autoBlock: "",
		snippet: `Font → ${FONT_FAMILY}, 14pt (Terminal.app ต้องเปลี่ยนเองในหน้า Settings)`,
	},
	windows: {
		file: "Windows Terminal settings.json",
		writablePath: null,
		autoBlock: "",
		snippet: JSON.stringify({ profiles: { defaults: { font: { face: FONT_FAMILY, size: 14 } } } }, null, 2),
	},
	unknown: null,
};

export default function (pi: ExtensionAPI) {
	// ---------------------------------------------------------------- theme

	// Make the theme discoverable — but only when THEME_DIR is not one of pi's
	// default theme dirs (~/.pi/agent/themes, <cwd>/.pi/themes), which pi scans
	// automatically. Contributing a default dir would load the theme twice and
	// trigger a "Theme conflicts" warning at startup.
	pi.on("resources_discover", async (event) => {
		const defaultDirs = [
			join(process.env.HOME ?? "", ".pi", "agent", "themes"),
			join(event.cwd, ".pi", "themes"),
		];
		if (defaultDirs.includes(THEME_DIR)) return {};
		return { themePaths: [THEME_DIR] };
	});

	// Status reminder + silent font auto-install while in a session.
	pi.on("session_start", async (_event, ctx) => {
		let fontNote = FONT_FAMILY;
		if (!fontsInstalled()) {
			const err = installFonts();
			if (err === null) {
				fontNote += " (ติดตั้งอัตโนมัติแล้ว ✓ — restart terminal 1 ครั้ง)";
				if (ctx.hasUI)
					ctx.ui.notify(
						`ติดตั้งฟอนต์ ${FONT_FAMILY} เข้าระบบแล้วอัตโนมัติ — restart terminal 1 ครั้ง แล้วใช้ /terminal-font เพื่อตั้งค่า terminal ของคุณ`,
						"info",
					);
			} else if (err === "manual") {
				fontNote += " (ยังไม่ได้ติดตั้ง — ดู /terminal-font)";
			}
		}
		if (ctx.hasUI) ctx.ui.setStatus("thai", `ฟอนต์: ${fontNote} · ธีม: ${THEME_NAME}`);
	});

	// ---------------------------------------------------------------- font setup

	/** Append the auto-block to a terminal config file (idempotent, with backup). */
	function writeTerminalConfig(path: string, block: string): string {
		const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
		if (existing.includes(AUTO_MARKER)) return "already";
		mkdirSync(dirname(path), { recursive: true });
		if (existing.trim()) copyFileSync(path, `${path}.bak-pi-zense`);
		writeFileSync(path, existing + (existing.endsWith("\n") || !existing ? "" : "\n") + block + "\n");
		return "ok";
	}

	pi.registerCommand("terminal-font", {
		description: `Auto-setup terminal font for Thai (${FONT_FAMILY}) / ตั้งค่าฟอนต์ภาษาไทยอัตโนมัติ`,
		getArgumentCompletions: (prefix) =>
			[...Object.keys(TARGETS).filter((k) => k !== "unknown"), "install-fonts"]
				.filter((s) => s.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			let picked = args?.trim().toLowerCase() as TerminalId | "install-fonts" | "";

			// Explicit font (re)install — useful on Windows or after OS font cache issues.
			if (picked === "install-fonts") {
				if (process.platform === "win32") {
					ctx.ui.notify(
						`Windows: เปิดโฟลเดอร์ฟอนต์ของ package (${FONT_DIR}) แล้ว double-click ไฟล์ .ttf ทั้งสองเพื่อติดตั้ง`,
						"info",
					);
					return;
				}
				const err = installFonts();
				ctx.ui.notify(
					err === null ? `ติดตั้ง ${FONT_FAMILY} เข้า ${userFontDir()} แล้ว ✓` : `ติดตั้งไม่สำเร็จ: ${err}`,
					err === null ? "info" : "error",
				);
				return;
			}

			// Default: auto-detect the current terminal.
			let detected: TerminalId = "unknown";
			if (!picked || !(picked in TARGETS)) {
				detected = detectTerminal();
				picked = detected;
			}
			if (!ctx.hasUI) return;

			let target = TARGETS[picked as TerminalId];
			if (!target) {
				// Unknown terminal — let the user pick one manually.
				const names = Object.keys(TARGETS).filter((k) => k !== "unknown");
				const chosen = await ctx.ui.select(
					`ตรวจจับ terminal ไม่ได้ — เลือกเทอร์มินัลของคุณ (ฟอนต์ ${FONT_FAMILY} ถูกติดตั้งเข้าระบบให้แล้วอัตโนมัติบน macOS/Linux):`,
					names,
				);
				if (!chosen) return;
				picked = chosen as TerminalId;
				target = TARGETS[picked]!;
			}

			// Auto-write path: confirm, backup, append marked block.
			if (target.writablePath) {
				const exists = existsSync(target.writablePath);
				const already = exists && readFileSync(target.writablePath, "utf8").includes(AUTO_MARKER);
				if (already) {
					ctx.ui.notify(`${target.file} มีการตั้งค่าของ pi-zense อยู่แล้ว ✓ — restart terminal ถ้ายังไม่เห็นฟอนต์`, "info");
					return;
				}
				const ok = await ctx.ui.confirm(
					`เขียน config อัตโนมัติ`,
					`เพิ่มการตั้งค่าฟอนต์ ${FONT_FAMILY} ลงใน ${target.file}?${exists ? " (ไฟล์เดิมจะถูก backup เป็น .bak-pi-zense)" : ""}`,
				);
				if (!ok) {
					ctx.ui.notify(`# เพิ่มเองใน ${target.file}:\n\n${target.snippet}`, "info");
					return;
				}
				const result = writeTerminalConfig(target.writablePath, target.autoBlock);
				if (result === "ok")
					ctx.ui.notify(
						`เขียน config ลง ${target.file} แล้ว ✓ — **restart terminal 1 ครั้ง** เพื่อให้ฟอนต์มีผล`,
						"info",
					);
				else ctx.ui.notify(`เขียน config ไม่สำเร็จ — เพิ่มเองใน ${target.file}:\n\n${target.snippet}`, "error");
				return;
			}

			// Snippet-only path (iterm2 / apple / windows / vscode).
			const fontStatus = fontsInstalled()
				? `ฟอนต์ ${FONT_FAMILY} ติดตั้งเข้าระบบแล้ว ✓`
				: process.platform === "win32"
					? `Windows: double-click ไฟล์ .ttf ใน ${FONT_DIR} เพื่อติดตั้งฟอนต์`
					: `ติดตั้งฟอนต์: ${FONT_DOWNLOAD}`;
			ctx.ui.notify(
				[
					`# ${FONT_FAMILY} → ${picked} (ตั้งเองใน ${target.file})`,
					`# ${fontStatus}`,
					`# Strict-mono fallback / สำรอง: ${FONT_FALLBACK}`,
					``,
					target.snippet,
				].join("\n"),
				"info",
			);
		},
	});

	// ---------------------------------------------------------------- HTML preview

	pi.registerCommand("thai-preview", {
		description: "Generate HTML preview of theme + Thai font (spacing, indentation, combining marks)",
		handler: async (_args, ctx) => {
			const themePath = join(THEME_DIR, `${THEME_NAME}.json`);
			if (!existsSync(themePath)) {
				ctx.ui.notify(`Theme not found: ${themePath}`, "error");
				return;
			}
			const theme = JSON.parse(readFileSync(themePath, "utf8"));
			const resolve = (v: string | number): string =>
				typeof v === "number" ? v.toString() : theme.vars?.[v] ?? (v || "inherit");
			const c = (k: string) => resolve(theme.colors[k]);

			const thai = "สวัสดีครับ การพัฒนาซอฟต์แวร์ด้วย AI กำลังเปลี่ยนแปลงวงการ";
			const combining = "ก่ ก้ ที่ นั่น ได้ ใช้ ไป มา คู่ ดิ้ ศึกษ์"; // tone/vowel stacking test
			const html = `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai+Looped:wght@400;600&family=IBM+Plex+Mono&display=swap" rel="stylesheet">
<style>
  body { background: ${theme.export?.pageBg ?? c("customMessageBg")}; color: ${theme.vars.fore};
         font-family: "${FONT_FAMILY}", "IBM Plex Sans Thai Looped", monospace; padding: 2rem; }
  .card { background: ${theme.export?.cardBg ?? c("userMessageBg")}; border: 1px solid ${c("border")};
          border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  h1 { color: ${c("mdHeading")}; font-size: 1.4rem; }
  pre { font-family: "IBM Plex Mono", "${FONT_FAMILY}", monospace; } /* indent test = strict mono */
  table td { padding: .2rem 1rem .2rem 0; }
  .sw { display: inline-block; width: 1em; height: 1em; border-radius: 3px; vertical-align: -2px; margin-right: .5em; }
</style></head><body>
<div class="card"><h1>ตัวอย่างธีม ${THEME_NAME} + ${FONT_FAMILY}</h1>
<p>${thai}</p>
<p>เครื่องหมายวรรณยุกต์/สระซ้อน (combining marks): <strong>${combining}</strong></p></div>

<div class="card"><h1>การเว้นวรรคและย่อหน้า (space & indent)</h1>
<pre>${"  "}function ตัวอย่าง(name: string) {
${"    "}return \`สวัสดี \${name}\`;
${"  "}	→ tab indent
${"    "}|....|....|  ruler alignment check
}</pre></div>

<div class="card"><h1>สีธีม (theme palette)</h1><table>
${Object.entries(theme.colors as Record<string, string | number>)
	.map(([k, v]) => `<tr><td>${k}</td><td style="color:${resolve(v)}">ตัวอย่างข้อความ Thai text</td><td><span class="sw" style="background:${resolve(v)}"></span>${resolve(v)}</td></tr>`)
	.join("\n")}
</table></div>
</body></html>`;

			const outDir = join(ctx.cwd, ".pi", "preview");
			mkdirSync(outDir, { recursive: true });
			const outFile = join(outDir, "thai-theme-preview.html");
			writeFileSync(outFile, html);
			exec(`open "${outFile}"`);
			ctx.ui.notify(`เปิดตัวอย่างแล้ว: ${outFile}`, "info");
		},
	});

	// ---------------------------------------------------------------- theme activation

	pi.registerCommand("thai-theme", {
		description: `Activate ${THEME_NAME} theme (writes project .pi/settings.json)`,
		handler: async (_args, ctx) => {
			const settingsPath = join(ctx.cwd, ".pi", "settings.json");
			const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
			settings.theme = THEME_NAME;
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
			ctx.ui.notify(`ตั้งธีมเป็น "${THEME_NAME}" แล้ว — ดูผลทันทีผ่าน hot-reload หรือเปิด session ใหม่`, "info");
		},
	});
}

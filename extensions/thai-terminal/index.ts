/**
 * thai-terminal — custom font + color setup for Thai-language pi sessions.
 *
 * Pi (a CLI) cannot change the terminal font itself — fonts are owned by the
 * terminal emulator. This extension therefore does two things:
 *
 *   1. Contributes the "thai-looped-night" color theme (.pi/themes/) and lets
 *      you activate it with /thai-theme.
 *   2. Bundles copy-paste font config snippets for common terminals
 *      (/terminal-font) targeting IBM Plex Sans Thai Looped — a font with full
 *      Thai script coverage, monospaced "Terminal" builds, and consistent
 *      space/indent widths — plus an HTML preview (/thai-preview).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
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

export default function (pi: ExtensionAPI) {
	// ---------------------------------------------------------------- theme

	// Make the project theme discoverable.
	pi.on("resources_discover", async () => ({
		themePaths: [THEME_DIR],
	}));

	// Status reminder while in a session.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("thai", `ฟอนต์: ${FONT_FAMILY} · ธีม: ${THEME_NAME}`);
	});

	// ---------------------------------------------------------------- font config snippets

	const SNIPPETS: Record<string, { file: string; config: string }> = {
		ghostty: {
			file: "~/.config/ghostty/config",
			config: [
				`font-family = ${FONT_FAMILY}`,
				`font-size = 14`,
				`# Thai combining marks + consistent cell widths`,
				`adjust-cell-width = 0%`,
			].join("\n"),
		},
		kitty: {
			file: "~/.config/kitty/kitty.conf",
			config: [
				`font_family      ${FONT_FAMILY}`,
				`font_size 14`,
				`disable_ligatures never`,
			].join("\n"),
		},
		wezterm: {
			file: "~/.wezterm.lua",
			config: [
				`config.font = wezterm.font("${FONT_FAMILY}")`,
				`config.font_size = 14`,
			].join("\n"),
		},
		alacritty: {
			file: "~/.config/alacritty/alacritty.toml",
			config: [
				`[font]`,
				`normal = { family = "${FONT_FAMILY}" }`,
				`size = 14`,
			].join("\n"),
		},
		iterm2: {
			file: "Preferences → Profiles → Text",
			config: `Font → ${FONT_FAMILY}, 14pt · enable "Use a different font for non-ASCII text" pointing at the same family`,
		},
		vscode: {
			file: "settings.json",
			config: JSON.stringify(
				{ "terminal.integrated.fontFamily": FONT_FAMILY, "terminal.integrated.fontSize": 14 },
				null,
				2,
			),
		},
	};

	pi.registerCommand("terminal-font", {
		description: `Show terminal font config for Thai support (${FONT_FAMILY}) / แสดงการตั้งค่าฟอนต์ภาษาไทย`,
		handler: async (args, ctx) => {
			const names = Object.keys(SNIPPETS);
			let picked = args?.trim().toLowerCase();
			if (!picked || !SNIPPETS[picked]) {
				if (!ctx.hasUI) return;
				picked = (await ctx.ui.select(
					`ติดตั้ง ${FONT_FAMILY} ก่อน: ${FONT_DOWNLOAD} — เลือกเทอร์มินัลของคุณ:`,
					names,
				)) ?? undefined;
			}
			if (!picked || !SNIPPETS[picked]) return;
			const s = SNIPPETS[picked];
			const out = [
				`# ${FONT_FAMILY} → ${picked}`,
				`# 1. Install / ติดตั้ง: ${FONT_DOWNLOAD}`,
				`#    Strict-mono fallback / สำรอง: ${FONT_FALLBACK}`,
				`# 2. Edit ${s.file}:`,
				``,
				s.config,
			].join("\n");
			ctx.ui.notify(out, "info");
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
${Object.entries(theme.colors)
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

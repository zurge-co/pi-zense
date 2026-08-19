# thai-terminal — ฟอนต์ไทย + ธีมสี (Thai font + colors)

Pi extension that pairs a Thai-capable font setup with a custom color theme.

## Why

Pi is a CLI — it **cannot change the terminal's font**. Fonts live in the
terminal emulator, and there is no escape sequence a program can send to
switch them. So this extension automates everything that *can* be automated,
reducing user action to a single terminal restart:

| Step | Automated? | How |
|------|-----------|-----|
| Colors | ✅ | `thai-looped-night` theme contributed + activated via `/thai-theme` |
| Font files | ✅ | TTFs are **bundled in the npm package** and auto-copied to the OS user font dir on session start (macOS `~/Library/Fonts`, Linux `~/.local/share/fonts` + `fc-cache`) — no admin, no download |
| Terminal config | ✅* | `/terminal-font` auto-detects your terminal and **writes the config for you** (ghostty / kitty / wezterm / alacritty), with confirm + `.bak-pi-zense` backup |
| Terminal restart | ❌ | The one step that can't be automated |

*iTerm2 / Terminal.app / VS Code / Windows Terminal store font settings in
places that are unsafe or impossible to patch from inside a session — for
those, `/terminal-font` prints the exact snippet to paste instead.

## Font: IBM Plex Sans Thai Looped (bundled)

- **Thai support** — full Thai script; "Looped" variant is the conventional
  reading style for UI/system text (vs. Thai "Formal" style).
- **Free to redistribute** — SIL OFL 1.1 (`fonts/OFL.txt` ships in the package).
- Bundled: Regular + Bold TTF only, keeping the tarball small (~137 KB total).

Strict-mono fallback if you prefer full Nerd-Font glyphs:
`brew install --cask font-sarasa-nerd` (Sarasa Term Nerd Font).

## Commands

| Command | Effect |
|---------|--------|
| `/terminal-font` | Auto-detect terminal → offer to write font config (confirm + backup). Unknown terminals → pick from list |
| `/terminal-font <ghostty\|kitty\|wezterm\|alacritty>` | Write config for that terminal explicitly |
| `/terminal-font <iterm2\|apple\|vscode\|windows>` | Print the exact manual snippet |
| `/terminal-font install-fonts` | Re-run the OS font install (Windows: shows where the bundled .ttf files are) |
| `/thai-theme` | Activates the `thai-looped-night` theme (writes `.pi/settings.json`) |
| `/thai-preview` | Generates & opens `.pi/preview/thai-theme-preview.html` — Thai text, combining-mark (ก่ ที่ ใช้) test, indent ruler, and full color palette |

## Files

```
fonts/                                   # bundled IBM Plex Sans Thai Looped TTFs + OFL.txt
themes/thai-looped-night.json            # Tokyo-Night-inspired palette, all 51 tokens
extensions/thai-terminal/
├── index.ts                             # the extension
└── README.md
```

## Platform notes

- **macOS / Linux** — fonts install silently on first session start; a status
  line and notification confirm it.
- **Windows** — user font install requires registry registration, so nothing
  is auto-copied; run `/terminal-font install-fonts` to locate the bundled
  .ttf files and double-click to install.

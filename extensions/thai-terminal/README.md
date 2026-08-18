# thai-terminal — ฟอนต์ไทย + ธีมสี (Thai font + colors)

Pi extension that pairs a Thai-capable font setup with a custom color theme.

## Why

Pi is a CLI — it **cannot change the terminal's font**. Fonts live in the
terminal emulator. So this extension splits the job:

| Concern | Owner | What this repo provides |
|---------|-------|-------------------------|
| Colors | pi | `thai-looped-night` theme (`.pi/themes/thai-looped-night.json`) |
| Font | your terminal | `/terminal-font` prints exact config per terminal |

## Font selection: IBM Plex Sans Thai Looped

- **Thai support** — full Thai script; "Looped" variant is the conventional
  reading style for UI/システム text (vs. Thai "Formal" style).
- **Space & indent** — IBM ships **Terminal** builds of Plex Thai Looped with
  fixed cell widths, so spaces, tabs, and indentation align in the grid.
  Code blocks in the HTML preview pair it with IBM Plex Mono for strict
  indentation alignment.
- **Free** — SIL OFL license.

Install (macOS):

```bash
# download "IBM-Plex-Sans-Thai-Looped.zip"
# https://github.com/IBM/plex/releases (v6.4.0 or newer)
brew install --cask font-sarasa-nerd        # strict-mono fallback option
```

Then run `/terminal-font` inside pi and pick your terminal — it prints the
exact config snippet to paste.

## Commands

| Command | Effect |
|---------|--------|
| `/thai-theme` | Activates the `thai-looped-night` theme (writes `.pi/settings.json`) |
| `/terminal-font [ghostty\|kitty\|wezterm\|alacritty\|iterm2\|vscode]` | Prints font config snippet for that terminal |
| `/thai-preview` | Generates & opens `.pi/preview/thai-theme-preview.html` — Thai text, combining-mark (ก่ ที่ ใช้) test, indent ruler, and full color palette |

## Files

```
.pi/
├── settings.json                        # theme: "thai-looped-night"
├── themes/thai-looped-night.json        # Tokyo-Night-inspired palette, all 51 tokens
└── extensions/thai-terminal/
    ├── index.ts                         # the extension
    └── README.md
```

## Enabling for other projects

Global install:

```bash
cp -r .pi/extensions/thai-terminal ~/.pi/agent/extensions/
cp .pi/themes/thai-looped-night.json ~/.pi/agent/themes/
```

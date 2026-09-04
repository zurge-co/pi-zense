#!/usr/bin/env bash
# release.sh — one-command release สำหรับ pi-zense:
#   เลือก bump (patch|minor|major|X.Y.Z) → precheck (clean tree + npm test) → npm login (ถ้ายัง)
#   → npm version (commit+tag อัตโนมัติ) → git push --follow-tags → npm publish
# ใช้: npm run release -- patch   หรือ   bash scripts/release.sh   (interactive prompt)
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
	cat >&2 <<'EOF'
usage: bash scripts/release.sh [patch|minor|major|X.Y.Z]
  ไม่ส่ง arg = ถาม interactive (เลือกจากลิสต์ หรือพิมพ์ X.Y.Z เอง)
EOF
}

# ----- เลือก bump: arg แรกก่อน ถ้าไม่มีค่อยถาม interactive
BUMP="${1:-}"
if [ -z "$BUMP" ]; then
	if [ ! -t 0 ]; then
		usage
		exit 2
	fi
	echo "เลือก version bump:"
	select choice in patch minor major "X.Y.Z (custom)"; do
		case "$choice" in
			patch | minor | major) BUMP="$choice" ;;
			"X.Y.Z (custom)") read -rp "version (X.Y.Z): " BUMP ;;
			*) echo "เลือก 1-4" >&2 ;;
		esac
		[ -n "$BUMP" ] && break
	done
fi

# ----- validate ก่อน precheck อื่นเสมอ (c4: arg ผิดต้องตายตรงนี้ ไม่ไปแตะอย่างอื่นเลย)
case "$BUMP" in
	patch | minor | major) ;;
	*)
		if ! [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
			echo "✗ invalid bump \"$BUMP\" — ต้องเป็น patch|minor|major|X.Y.Z" >&2
			usage
			exit 2
		fi
		;;
esac

# ----- prechecks: tree สะอาด + tests เขียว (abort ก่อน bump เสมอ ไม่ทิ้ง state ค้าง)
if [ -n "$(git status --porcelain)" ]; then
	echo "✗ working tree ไม่สะอาด — commit/stash ก่อน release:" >&2
	git status --short >&2
	exit 1
fi

echo "▸ running tests…"
npm test

# ----- npm auth: login เฉพาะตอนที่ยังไม่ได้ (interactive ครั้งเดียว ครั้งต่อไปผ่านเลย)
if ! npm whoami >/dev/null 2>&1; then
	echo "▸ npm login required…"
	npm login
fi
echo "▸ npm user: $(npm whoami)"

# ----- bump+commit+tag (npm version ทำครบในคำสั่งเดียว) → push → publish
NEW=$(npm version "$BUMP" -m "release %s")
echo "▸ bumped → $NEW (commit+tag created)"
git push --follow-tags
npm publish

echo "✅ released $NEW — pushed commit+tag และ publish ขึ้น npm เรียบร้อย"

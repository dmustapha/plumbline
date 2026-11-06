#!/usr/bin/env bash
# Contract rule 23: a judge's view of the repo. Fresh clone of the COMMITTED tree into a temp dir, then:
#   1 npm ci   2 secret-pattern grep over tracked files   3 offline tests   4 verify-claims   5 diff regenerated claims/evidence vs committed
# Needs PLUMBLINE_URL (the judged deployment) for step 4/5 to be meaningful; without it every claim recomputes WITHHELD.
# Usage: scripts/clean-room.sh            Exit 0 only if every step passes. The temp dir is always removed.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/plumbline-clean-room.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
step() { printf '\n== clean-room: %s\n' "$*"; }
fail() { printf 'CLEAN-ROOM FAIL: %s\n' "$*" >&2; exit 1; }

step "clone HEAD ($(git -C "$SRC" rev-parse --short HEAD))"
git clone --quiet --no-hardlinks "$SRC" "$TMP/clone"
cd "$TMP/clone"
[ -z "$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.example$' || true)" ] || fail "a .env file is tracked"

step "npm ci"
npm ci --no-audit --no-fund --loglevel=error

step "secret patterns in tracked files (file:line only, values never printed)"
hits=0
scan() { # $1 label, $2 ERE
  local out; out="$(git ls-files -z | xargs -0 grep -nIE -- "$2" 2>/dev/null | grep -v 'scripts/clean-room.sh' | cut -d: -f1,2 || true)"
  if [ -n "$out" ]; then printf 'SECRET PATTERN (%s):\n%s\n' "$1" "$out" >&2; hits=1; fi
}
scan "PEM private key block" '-----BEGIN [A-Z ]*PRIVATE KEY-----'
scan "Vultr-style key assigned to a name" '(VULTR|API)[A-Z_]*(KEY|TOKEN)[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Z0-9]{36}([^A-Z0-9]|$)'
bare="$(git ls-files -z | xargs -0 grep -nIoE -- '(^|[^A-Za-z0-9])[A-Z0-9]{36}([^A-Za-z0-9]|$)' 2>/dev/null | grep -v 'scripts/clean-room.sh' | grep -E '[0-9]' | grep -E '[A-Z]' | cut -d: -f1,2 || true)"
if [ -n "$bare" ]; then printf 'SECRET PATTERN (bare 36-char key shape):\n%s\n' "$bare" >&2; hits=1; fi
[ "$hits" -eq 0 ] || fail "secret-shaped content in the committed tree"

step "offline tests (live tiers are not in the default run)"
npx vitest run

step "typecheck"
npm run --silent typecheck

step "verify-claims in the clone"
cp -f evidence/claims-regenerated.json "$TMP/committed-claims.json" 2>/dev/null || fail "no committed evidence/claims-regenerated.json"
cp -f CLAIMS.md "$TMP/committed-CLAIMS.md" 2>/dev/null || fail "no committed CLAIMS.md"
npm run --silent verify-claims

step "diff regenerated vs committed (ignoring regenerated_at and the live /api/proof snapshot)"
norm() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); delete j.regenerated_at; delete j.proof; console.log(JSON.stringify(j,null,1))' "$1"; }
diff <(norm "$TMP/committed-claims.json") <(norm evidence/claims-regenerated.json) || fail "claims-regenerated.json differs from what a judge recomputes"
diff "$TMP/committed-CLAIMS.md" CLAIMS.md || fail "CLAIMS.md differs from what a judge recomputes"
printf '\nCLEAN-ROOM PASS\n'

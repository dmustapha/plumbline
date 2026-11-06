#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -f ops/scripts/verify-claims.ts || { echo "verify-claims.ts not built yet: every claim stays WITHHELD" >&2; exit 3; }
npm run --silent verify-claims

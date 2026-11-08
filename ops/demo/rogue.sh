#!/usr/bin/env bash
# File: ops/demo/rogue.sh
# Demo helper for the "second region catches what the ledger never allowed" scene.
# Creates (or removes) ONE server directly through the Vultr API with the OWNER key, bypassing Plumbline entirely, so the
# independent verifier has something to find. The key is read from the environment and never printed.
#   VULTR_API_KEY=... ops/demo/rogue.sh create     # a server no ALLOW decision explains
#   VULTR_API_KEY=... ops/demo/rogue.sh destroy    # remove it again
set -euo pipefail
: "${VULTR_API_KEY:?set VULTR_API_KEY (the owner key) in this shell; it is never printed}"
LABEL="plumbline-oob-demo"; API="https://api.vultr.com/v2"; AUTH="Authorization: Bearer ${VULTR_API_KEY}"
find_id() { curl -s -H "$AUTH" "$API/instances?label=$LABEL" | python3 -c 'import sys,json; r=json.load(sys.stdin).get("instances",[]); print(r[0]["id"] if r else "")'; }
case "${1:-}" in
  create)
    [ -z "$(find_id)" ] || { echo "already exists: $(find_id)"; exit 0; }
    curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' "$API/instances" \
      -d "{\"region\":\"ewr\",\"plan\":\"vc2-1c-1gb\",\"os_id\":2136,\"label\":\"$LABEL\"}" \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); i=d.get("instance"); print("created out of band:", i["id"], i["label"]) if i else (print("create failed:", d.get("error","?")) or sys.exit(1))' ;;
  destroy)
    id="$(find_id)"; [ -n "$id" ] || { echo "nothing to remove"; exit 0; }
    curl -s -X DELETE -H "$AUTH" "$API/instances/$id" -o /dev/null -w "destroy %{http_code} for $id\n" ;;
  *) echo "usage: $0 create|destroy" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# File: ops/scripts/egress-counter.sh
# Installed root-owned as /usr/local/sbin/plb-egress-counter; the broker reaches it through sudo (ops/sudoers/plumbline-egress), no arguments.
# Prints the dropped-packet count of the plb-egress rule in PLB-SBX. It is informational: on an --internal network a sandbox has no
# route off the subnet, so most attempts fail inside the container before any packet exists. A non-zero value is a leak signal.
set -euo pipefail
iptables -L PLB-SBX -v -n -x | awk '/plb-egress/ { sum += $1 } END { print sum + 0 }'

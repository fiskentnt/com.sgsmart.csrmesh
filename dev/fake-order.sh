#!/bin/bash
# Gives the fake devices an order (lib/fake/index.js) while the app runs with
# dev/run-with-fakes.sh: sets the app setting fakeOrder on the Homey the
# Homey CLI has selected. Not tried yet.
#
#   dev/fake-order.sh 7F01 level 40
#   dev/fake-order.sh @SE52C4 on
#   dev/fake-order.sh 7F03 silent
set -euo pipefail

[ $# -ge 2 ] || { echo "usage: $0 <device> <order> [value]" >&2; exit 2; }
value=$(printf '%s' "$*" | sed 's/["\\]//g')
homey api raw -X PUT --path /api/manager/apps/app/com.sgsmart.csrmesh/setting/fakeOrder \
  --body "{\"value\":\"$value\"}"

#!/bin/bash
# Run a wrangler command, and run it again when Cloudflare's API failed on its own side
# (#3567). Usage: retry-cloudflare-api.sh <command> [args...]
#
# Load run 37970129958 lost its verdict to one `504 Gateway Timeout` from the API while
# the fault leg's deploy read the Worker's secrets: nothing of ours was wrong, and the
# judge ruled the whole run INCOMPLETE. Only a 5xx or a malformed reply from the API is
# retried. A failure of our own making (a bad config, a 4xx) fails at once with its own
# exit code, because running it again changes nothing (L527). A deploy is the same deploy
# however many times it runs, so a retry repeats nothing that matters.
#
# Three attempts, RETRY_CLOUDFLARE_WAIT_S apart (default 20; the test sets 0, L524). The
# last attempt's exit code is the step's, and every attempt's output is printed, so the
# failure that was retried is never hidden. scripts/test-retry-cloudflare-api.ts drives it.
set -uo pipefail
attempts=3
wait_s="${RETRY_CLOUDFLARE_WAIT_S:-20}"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
for i in $(seq 1 "$attempts"); do
  "$@" 2>&1 | tee "$out"
  code=${PIPESTATUS[0]}
  [ "$code" -eq 0 ] && exit 0
  if [ "$i" -lt "$attempts" ] && grep -qE -- '-> 5[0-9][0-9] |malformed response from the API' "$out"; then
    echo "retry-cloudflare-api: Cloudflare's API failed on its side (attempt $i of $attempts); trying again in ${wait_s}s" >&2
    sleep "$wait_s"
    continue
  fi
  exit "$code"
done

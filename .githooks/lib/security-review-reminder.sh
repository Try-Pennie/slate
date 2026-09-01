#!/usr/bin/env bash
# Say, at the moment of pushing, that this change wants a security review (#1043).
#
# Review here is self-merge: a PR is opened, the automated gates run, and it merges
# within seconds. That model is documented (docs/review-process.md) and it is a
# deliberate trade, but it has one soft spot the gates do not cover, which is
# judgement about who may do what. A test suite proves the code does what it says; it
# cannot notice that what it says is too permissive.
#
# So a push touching the authorization, webhook or routing surfaces prints a reminder
# to run `/security-review`. Read the two deliberate choices here:
#
#   1. It is a REMINDER, not a gate. It cannot be a gate: nothing in CI can run a
#      review that needs a person and a model, so a blocking version would be a gate
#      whose only satisfying action is to set the skip variable, which teaches people
#      to set skip variables. A checkbox in a PR template would be weaker still,
#      because it can be ticked without doing anything.
#   2. It fires on the PATHS, not on a keyword in the message, so it cannot be
#      avoided by phrasing.
#
# Usage: security-review-reminder.sh "<newline separated changed paths>"
# Always exits 0. The path list is passed in so the decision is testable with no git.
set -u

changed="${1:-}"

if [ "${SKIP_SECURITY_REVIEW_REMINDER:-}" = "1" ]; then
  exit 0
fi

# An unreadable diff arrives as the literal UNKNOWN from the hook. Say so and remind
# anyway: a reminder costs a few lines, and staying quiet on an unreadable diff is how
# a check becomes silent exactly when it cannot see (#1436).
if [ "$changed" = "UNKNOWN" ]; then
  printf '\n  Could not read which files this push touches, so this cannot tell whether\n'
  printf '  it reaches the authorization, webhook or routing surfaces. If it does, run\n'
  printf '  /security-review before merging.\n\n'
  exit 0
fi

# The surfaces where the gates cannot substitute for judgement. Each is a directory
# or file prefix, matched against the changed paths.
sensitive=$(printf '%s\n' "$changed" | grep -E \
  -e '^src/lib/auth/' \
  -e '^src/lib/auth\.ts$' \
  -e '^src/lib/provision\.ts$' \
  -e '^src/lib/bearer-auth\.ts$' \
  -e '^src/lib/api/same-origin\.ts$' \
  -e '^src/middleware\.ts$' \
  -e '^src/app/api/' \
  -e '^src/lib/webhooks/' \
  -e '^src/lib/routing/' \
  -e '^src/lib/rate-limit' \
  -e '^supabase/migrations/' \
  || true)

if [ -z "$sensitive" ]; then
  exit 0
fi

count=$(printf '%s\n' "$sensitive" | grep -c . || true)
printf '\n  This push touches %s file(s) on the authorization, webhook, routing or\n' "$count"
printf '  schema surfaces. The automated gates prove the code does what it says; they\n'
printf '  cannot notice that what it says is too permissive. Run /security-review\n'
printf '  before merging, or say out loud why it is not needed.\n\n'
printf '%s\n' "$sensitive" | sed 's/^/    /' | head -10
if [ "$count" -gt 10 ]; then
  printf '    ... and %s more\n' "$((count - 10))"
fi
printf '\n'
exit 0

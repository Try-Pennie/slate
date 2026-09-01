<!--
Review here is self-merge with the automated gates as the only reviewer
(docs/review-process.md). That makes this body the only durable record of a decision
nobody discussed, so the three sections below are the ones a reader cannot
reconstruct from the diff six months from now. Delete the guidance comments.
-->

## What and why

<!-- What changed, and the reason it needed changing. If it fixes a defect, say what
the defect actually did, not just its name: "an unreadable read returned an empty
list, which the caller read as no bookings" beats "fixed #123". -->

## Tests

<!-- Name the test and what it proves. If a guard is new, say how it was seen to fail,
because a guard nobody has watched fail is not yet a guard.

If this ships without a test, say which override you used and why, here, where it
stays on the record. -->

## Migration status

<!-- One of:
  - none
  - applied to production before this merges (the runbook, docs/migrations-runbook.md)
  - included and NOT yet applied, which will fail migration-drift and the deploy

If a migration is included, SHIPPED_MIGRATION_VERSION is bumped in the same commit. -->

none

## Anything a reader should know

<!-- Optional. A decision deliberately not taken, a follow-up issue, a risk accepted
on purpose, or a manual step somebody has to do after this deploys.

If this touches auth, webhooks, routing or the schema, the pre-push hook will have
reminded you to run /security-review. Say here that you did, or why it was not needed. -->

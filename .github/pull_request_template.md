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

## If this touches UI

<!-- An axe run in BOTH themes, saved to docs/a11y/axe/<surface>-<theme>.axe.json (see
.claude/skills/slate-ui-verification/SKILL.md). The contrast guard is the only a11y check
that runs on its own; focus order, keyboard reachability, ARIA and accessible names are
invisible to every gate here.

Delete this section if the change is not visual. If it is, and there is no axe run, say
why. -->

## Decision record

<!-- Does this change make a decision somebody could reasonably try to undo later:
one Dan or a partner made, a new source of truth, a new gate on who can book or be
routed, or an alternative deliberately rejected? If so, add docs/adr/NNNN-*.md in this
PR and link it here (docs/adr/README.md, "When to write one"). If not, write "none". -->

none

## Anything a reader should know

<!-- Optional. A decision deliberately not taken, a follow-up issue, a risk accepted
on purpose, or a manual step somebody has to do after this deploys.

If this touches auth, webhooks, routing or the schema, the pre-push hook will have
reminded you to run /security-review. Say here that you did, or why it was not needed. -->

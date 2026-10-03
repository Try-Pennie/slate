# Browser checks run before merge, against a production build on a local stack

Pull requests that change anything the app is built from run a real browser before
merge: an axe scan of the rendered pages in both themes, and clicks through sign in,
impersonation, the admin saves and the booking flow. The run uses a production build
(`next build`, `next start`) against a throwaway local Supabase, and cannot reach any
real system. This supersedes [0004](./0004-no-browser-tests-in-ci.md).

## Status

Accepted 2026-10-03, on Dan's decision, closing #3079 and #3100. The mechanics live in
`AGENTS.md` under "What CI covers", `e2e/`, and `.github/workflows/browser-checks.yml`.

## Why 0004 no longer holds

0004 rested on one premise: screenshots and DOM assertions against `next dev` never
settle, so a browser job would be flaky. That premise is about the dev server. A
production build served by `next start`, with motion stopped by an injected style and
`reducedMotion`, is stable, and the suite has not needed a retry.

What 0004 traded away was larger than it looked when it was written. The booking funnel
was only ever proven against production after merge; eleven admin saves had never been
pressed by anybody (#2379); and the staff surfaces had jsdom tests only, which mock the
session. The first run of the new suite found three defects all of those had missed.

## What keeps it safe

The job is given no secret, the server's environment is built from nothing, the run
refuses a checkout holding any `.env*` file Next would load, `SLATE_LOADTEST=true`
makes every outside system synthetic or refused, and an egress guard in the server
process refuses and records any connection off the machine, failing the run on one.

## Consequences

- The production canary stays. A local stack with stubbed Google cannot prove the
  deployed Worker, the real calendars or the real embed host, so the funnel now has a
  check on both sides of the merge.
- The browser workflow is its own check, not a leg of the `ci` fan-in, so it does not
  by itself stop a merge. Making it gating is a separate decision.
- It is billed: about 6 minutes per run on a private repository runner, held down by a
  path gate derived from the run's real inputs (`scripts/test-browser-checks-workflow.ts`).

# Accessibility evidence

Where a11y evidence lives, and which parts of it are automatic.

## What runs on its own

- **`scripts/test-contrast.ts`** (in `pnpm test`, so in the pre-push gate and CI) checks
  every token pairing the design system commits to, in both themes. It is the only a11y
  check that runs without a person, and it is a real one: the primary CTA pairing
  (graphite on sky) is measured at 7.36:1 against a 4.5 floor, and the skip link uses
  that same pairing.
- **`scripts/test-skip-link-target.ts`** keeps the skip link pointing at something. A
  skip link with a missing target is worse than none: it takes a tab stop, looks like a
  control, and moves focus nowhere.

## What does not, and why

There is no axe or Lighthouse job in CI, deliberately (ADR 0004, #611): screenshots and
DOM assertions against `next dev` are unstable to automate, and a flaky gate is worse
than no gate. So axe is an **agent or manual** step, run against a running app through
the browser, following `.claude/skills/slate-ui-verification/SKILL.md`.

The consequence is the one #1054 named: the evidence is point in time. The phase 4 and
5 sweeps of the brand redesign covered the surfaces that existed then
(`.claude/orchestration-slate-brand-redesign/reports/axe/`, kept as the historical
record). UI built since has good markup and no committed axe run.

## Where new evidence goes

`docs/a11y/axe/<surface>-<theme>.axe.json`, one file per surface per theme, holding the
axe run's `violations`, `passes` count and `incomplete`. Both themes, always: the
internal pages support light and dark, and a contrast or focus defect routinely exists
in exactly one of them.

This directory rather than the orchestration reports folder, because that folder is
named for a project that finished, and ongoing evidence filed under a completed project
is evidence nobody will look for.

## Owed

No committed axe run for `BulkReassignCoverage`, `ReasonOptionsEditor` or
`BookingHistory` (#1054). Each needs a browser session against a running dev server;
none is blocked on code.

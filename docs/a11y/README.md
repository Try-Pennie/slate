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

Since 2026-10-03 there IS an axe job (ADR 0011, #3079, reversing ADR 0004 and #611 on
Dan's decision): the `browser` leg of `ci.yml` runs `pnpm test:e2e` and blocks the merge, and it
scans the booker (both steps), the manage page, sign in, every page in the console
navigation and an agent's own pages, in light and dark, against a production build,
and fails on any serious or critical finding. Its spec is
`e2e/tests/40-accessibility.spec.ts`, with two positive controls. There is still no
Lighthouse job, and a manual pass following
`.claude/skills/slate-ui-verification/SKILL.md` still covers what axe cannot judge
(focus order, reading a page with a screen reader, a dialog's real behaviour).

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

## What the 2026-09-01 capture found

All three components the audit named are now captured, both themes, in
`docs/a11y/axe/` (#1054). Two things are worth knowing beyond "clean":

**A real defect, light theme only.** Two pills in the agent detail page's navy
identity band were drawing a graphite label on navy at **1.28:1**: not low contrast,
invisible. The pills use a transparent variant whose label follows the PAGE theme, and
the band paints its own navy fill, so the light theme's foreground landed on a dark
background. The dark theme was fine, which is exactly why both themes are captured.

That is the pair problem (L213): a call site that overrides only the background
silently keeps the base variant's foreground, and **the token contrast guard cannot
see it**, because the guard checks token PAIRINGS and this was a call site composing
two individually correct tokens. Fixed by giving `Pill` an `onDark` prop that
overrides the pair, so the next call site has the right thing to reach for.

**An incomplete is not a pass.** The reason-options editor's reorder buttons came back
`incomplete` for `color-contrast`, because axe declines to judge an element whose
content is only an arrow glyph. That is "could not measure", so it was measured by
hand: 12.45:1 light, 10.86:1 dark. Each file records the resolution rather than
leaving an unexplained `incomplete` for the next reader to re-derive.

## Owed

Nothing outstanding. The next surface built or restyled carries its own capture, which
the PR template asks for.

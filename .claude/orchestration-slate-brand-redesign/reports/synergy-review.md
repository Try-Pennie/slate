# Synergy Review (consolidated) — Slate Brand Redesign

**Date**: 2026-06-09
**Reviewers**: 2 parallel agents (phases 1-3 + phases 4-5/global). Source: `synergy-review-A.md`, `synergy-review-B.md`.
**Scope reviewed**: all 28 task files, PHASES.md, DISCOVERY.md, cross-checked against the real repo + the design system.

## Verdict

The plan is well-coordinated. Dependency graph is acyclic & runnable; the cal.com contract,
ResizeObserver rule, admin/me auth blocker, and contrast-guard ordering are all coherent and
consistently enforced. Issues below are coherence/contract fixes to the TASK FILES — none
change the redesign scope. **1 blocker, 5 major, 9 minor.**

---

## BLOCKER

**S1 — `--pennie-rose` / `--error` token consumed but never defined.**
Tasks 2.3, 2.5, 3.2, 3.3 (error states) and 4.3 (contrast guard) reference a rose/error token,
but the design system has NO rose/error token and Task 1.2 never adds one. An undefined `var()`
renders invisible/fallback text yet still passes a `grep "red-"` check — silent failure.
**Fix:** In Task 1.2, define `--pennie-rose: rgb(196,61,61)` (#C43D3D) + a semantic `--error`
(and `--error-bg` 12% tint). Standardize all consumers (2.3, 2.5, 3.2, 3.3) + the contrast
guard (4.3) on these exact names. (Both reviewers flagged.)

---

## MAJOR

**S2 — `ThemeToggle.tsx` created by two tasks.** 1.5 and 3.1 both create
`src/components/ThemeToggle.tsx` with different implementations → clobber.
**Fix:** 1.5 is the SOLE creator; 3.1 imports/consumes it (and 3.1's `AppHeader` just uses it).

**S3 — Theme-aware focus ownership split + latent circular dep.** 1.2 ports the DS sky
`:focus-visible` ring (fails 3:1 on light); 2.V/3.V *assert* theme-aware focus, but only 4.4
delivers it — and 4.4 is blocked by 2.V/3.V.
**Fix:** Move the theme-aware focus TOKEN/rule into Task 1.2 (graphite outline on light, sky on
navy; sky glow demoted to decorative box-shadow). Recast 4.4 as a verify/sweep task, not the
deliverer. Update 2.V/3.V to check the 1.2-provided focus.

**S4 — Contrast-guard token-name contract.** 4.3 reads token names that 1.2 must guarantee
(incl. `--error` from S1 and `--accent-hover`). Reconcile `--accent-hover` with D17's 6.51:1
assumption (cap at `#6dc5f7`).
**Fix:** Add an explicit "token-name contract" list to Task 1.2; 4.3 reads exactly those.

**S5 — Embed must not inject a default `theme` param.** The light-default flip is single-owned
(2.1 theme, 2.4 brandColor, in `/book/page.tsx`), but 4.1/4.2 both edit widget.js and nothing
guards against widget.js injecting a default `theme` that would override the page-level light
default.
**Fix:** Add a "DO NOT inject a default `theme` param (let the page default to light)" guard +
grep to 4.1 and 4.2.

**S6 — Phase 5 evidence paths/filenames inconsistent.** Same artifact gets different names across
4.x/5.1/5.2; only 1.V/5.1 `mkdir` some `reports/` subdirs, so an early Phase-4 capture could fail
on a missing dir.
**Fix:** Pin canonical filenames + `reports/{screens,axe,lighthouse}` in `slate-ui-verification`
(or a shared note); have every capturing task `mkdir -p` first; 5.4 indexes the canonical names.

---

## MINOR

- **S7 — `sr-only` utility assumed but not created** (used by a11y steps). Add it in Task 1.2.
- **S8 — Serialize sibling edits.** 2.2–2.5 all edit `Booker.tsx`; note they run sequentially
  (or coordinate regions) to avoid edit collisions. Same for admin/me in 3.2/3.3.
- **S9 — reduced-motion global guard double-ownership.** 2.4 cites a Phase-1 guard that 1.2 never
  adds; 4.4 adds it but after 2.V verifies the delight. Add the global `prefers-reduced-motion`
  guard in Task 1.2 so it exists before any animation lands.
- **S10 — `Pill` duplication risk** (like S2). 3.1 owns `Pill`; 3.2/3.3 consume.
- **S11 — 4.4 re-editing the 2.4 delight component.** Make 4.4 verify-only for the delight; don't
  re-edit (the resting state must be the final visible frame when motion is disabled).
- **S12 — 1.4 icon-tint acceptance has no owning verification.** Add a both-themes tint check.
- **S13 — `reports/checklist.md` / per-sweep file clobber.** Use per-phase filenames
  (`checklist-phase-N.md`).
- **S14 — orphaned `pic-3-ribbon.png` alternate.** 1.1 copies it but only `pic-1-coins.png` is
  used; mark it explicitly as the documented alternate (not a gap).
- **S15 — 5.4 D18 sign-off** must not aggregate-away BLOCKED admin/me; report them as BLOCKED, not PASS.

---

## Verified coherent (no action)

Dependency graph acyclic & runnable; `--font-pp-mori` (1.2→1.3) and `slate-theme` localStorage
(1.5→3.1) handoffs; asset/icon path contracts (1.1→1.4→2.x/3.x); brandColor + postMessage embed
contract; cal.com contract protection across 2.4/4.1/4.2/4.V/5.3; ResizeObserver rule (2.4≡4.2);
contrast-guard ordering (1.V tolerates absence, 4.3 gates on 1.2, 5.2 re-runs); admin/me auth
blocker resolve-once/carry-BLOCKED (3.V→5.1→5.2); Phase 5 verifies all Phase 1-4 outputs; D5
visual-only enforced via per-task git-diff gates.

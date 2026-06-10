# Synergy Review B — Phases 4-5 + Global Coherence

**Reviewer focus**: Phase 4 (Embed + a11y), Phase 5 (Comprehensive Verification), and global
cross-phase coherence (dependency graph, contrast guard, cal.com contract). All 28 task files
read, plus PHASES.md, DISCOVERY.md, reports/surface-verification.md, and the execution-surfaces
reference.

---

## Summary

The plan is, on the whole, unusually coherent: the contrast-guard ordering is handled correctly
(1.V explicitly tolerates its absence; 5.2 explicitly creates it if 4.3 was skipped), the cal.com
contract is protected consistently across 2.4/4.1/4.2/4.V/5.3 with byte-for-byte grep + live
checks, the ResizeObserver "opacity/transform only, never height" rule is stated identically in
2.4 and 4.2, and the admin/me auth blocker is carried as a resolve-once / carry-as-BLOCKED item
through 3.V → 5.1 → 5.2. The dependency graph is acyclic and runnable.

I found **no blockers**. There are **3 major** issues (one real ownership gap that can break the
embed contract, one missing-token risk in the contrast guard's `--error`/`--accent-hover` reads,
one Phase-5 evidence-path/count mismatch that will make the final sign-off ambiguous) and **6
minor** issues (mostly double-ownership wording, one assertion-count mismatch, and a couple of
evidence-filename divergences). Each has a specific fix below.

---

## Issues

### Issue 1 — `--error` / `--accent-hover` may not be tokenized, and 4.3 + 1.2 disagree on whether they exist  (MAJOR)

**Files**: `phase-4/task-4-3.md` (Step 1, Step 2, assertions for `skyHover`/`rose`),
`phase-1/task-1-2.md` (Layer A token list).

**Problem**: 4.3 reads `--accent-hover` (#6dc5f7) and `--error` (#C43D3D) "if Step 1 found them
tokenized, else `HEX(...)`". 1.2's Layer A list (lines ~62) includes `--accent-hover` in the
semantic tokens, but it does **not** list `--error` anywhere — the rose `#C43D3D` is only ever
referenced as a literal (`--error`/`rgba(196,61,61,.12)`) in the Phase 2/3 tasks, and 1.2 never
ports an `--error` token. So 4.3's "read `--error` if tokenized" branch will silently fall to the
`HEX("#C43D3D")` literal — which is *fine functionally* but means the contrast guard is asserting
against a **hardcoded copy** of the rose value, not the shipped token. If a future edit changes the
rose tint, the guard won't catch it. Worse: D17 (per 4.3 line 31) lists `--accent-hover #6dc5f7`
contrast as a "must pass ≥4.5" assertion (`graphite on hover-sky 6.51`), but the Booker pressed-CTA
research (2.3) describes capping fill at `sky-hover #6dc5f7`; if 1.2 ports `--accent-hover` as the
DS value and that DS value is *not* `#6dc5f7`, the guard reads a different number than D17 assumes.

**Fix**:
1. In **1.2**, add an explicit instruction: port `--error: #C43D3D` (or whatever the DS
   `colors_and_type.css` calls the rose) into Layer A `:root`, keeping the canonical name, so the
   contrast guard reads the *shipped* token, not a literal copy. If the DS has no `--error` token,
   state that explicitly in 1.2 so 4.3 knows to use `HEX()` by design (not by accident).
2. In **4.3 Step 1**, make the determination an explicit acceptance item: "Confirm whether
   `--accent-hover` resolves to `#6dc5f7` and whether `--error` exists; if `--accent-hover` is a
   different value, reconcile with D17 (the 6.51:1 assertion assumes #6dc5f7) before writing the
   assertion." Add a cross-check line to 1.2's Cross-Surface Coherence section listing
   `--accent-hover` and `--error` alongside the eight color tokens it already promises 4.3.

---

### Issue 2 — widget.js mobile full-screen "belt-and-suspenders" `@media` injection vs. 4.5's right to touch widget.js: ownership is reconciled, but the default-theme/`brand` ownership for the embed is split awkwardly  (MAJOR — embed contract risk)

**Files**: `phase-2/task-2-1.md` (flips `/book/page.tsx` default + Booker prop default),
`phase-2/task-2-4.md` (defaults `brandColor` to sky in `/book/page.tsx` line 56),
`phase-4/task-4-1.md` / `4-2.md` (widget.js), `phase-4/task-4-V.md` (Step 6 asserts "embed default
renders light").

**Problem**: The **embed default-theme flip is owned by 2.1** (`/book/page.tsx` line 55 →
light-unless-`theme=dark`) and the **embed default brandColor=sky is owned by 2.4** (`/book/page.tsx`
line 56). That is correct and single-owned — *good*. **However**, widget.js itself never sets a
`theme` param when the host omits one (per 4.1, widget.js "forwards `theme`/`brand` if present").
So the embed's "renders light by default" property depends entirely on `/book/page.tsx` defaulting
to light when `theme` is absent from the iframe `src`. 4.V Step 6 and 5.3 both assert "embed default
renders light," but **no Phase 4 task re-confirms that widget.js does not inject a stale `theme=dark`**
— and 4.1/4.2 both edit widget.js. If either 4.1 or 4.2 inadvertently adds a default `theme`
fallback while restyling, the embed-default-light contract silently breaks and only 4.V/5.3 would
catch it (late). This is a real contract-coupling that no single task explicitly guards at the
widget.js layer.

**Fix**: Add one line to **4.1 Step 1** ("DO NOT TOUCH" list) and **4.2 Step 1** (additive-edits
list): *"widget.js must continue to forward `theme` only when the host provides it — never inject a
default `theme` param (the light default lives in `/book/page.tsx` per 2.1; injecting `theme` here
would override it and break embed-default-light)."* Mirror it in the 4.1/4.2 grep verification:
`grep -n "theme" public/widget.js` to confirm `theme` only appears in pass-through, not as a hardcoded
default.

---

### Issue 3 — Phase 5 evidence-path + filename conventions are inconsistent across 4.x, 5.1, 5.2 (will make 5.4's evidence index ambiguous)  (MAJOR)

**Files**: `phase-4/task-4-1.md` … `4-V.md`, `phase-5/task-5-1.md`, `5-2.md`, `5-4.md`.

**Problem**: The same logical artifact is written to **different filenames** across phases, and 5.4's
sign-off index reads "all `reports/` artifacts" without a reconciliation map:
- Embed modal screenshot: `embed-modal-chrome-4-1.png` (4.1) vs `embed-chrome-4V.png` (4.V) vs
  `embed-modal-desktop.png` (5.1).
- Focus screenshots: `focus-book-light-4-4.png` (4.4) vs `focus-light-4V.png` (4.V) vs
  `book-focus-light.png` (5.2).
- Reduced-motion confirmation: `confirm-light-reducedmotion-4-4.png` (4.4) vs
  `confirm-reducedmotion-4V.png` (4.V) vs `confirm-light-reducedmotion.png` (5.2/2.4).
- The embed axe JSON is `reports/axe/embed-host-modal-open.axe.json` in 4.2/4.V but `embed-host.axe.json`
  in 5.2.

These aren't collisions (the per-phase suffixes prevent overwrite), but 5.4 Step 6's "Evidence index
— paths to all `reports/` artifacts" and the D21 checklist pointers (5.4 lines 176-185) will be hard
to assemble and verify because the *canonical* filename for each check isn't pinned. Also, `reports/`
is committed-into evidence the whole way, but only 5.1 and 4.V `mkdir -p reports/{screens,axe,lighthouse}`
— 4.1/4.2/4.4 write to `reports/screens/...` and `reports/axe/...` without creating those dirs first
(they assume they exist; the first Phase 4 task to run a browser capture may fail on a missing dir if
1.V/2.V didn't already create it — 1.V only creates `reports/screens`, not `reports/axe`).

**Fix**:
1. Add `mkdir -p reports/{screens,axe,lighthouse}` to the first step of **4.1** (and note that later
   4.x tasks rely on it), OR state in PHASES.md that the evidence tree is created by 1.V and is a
   precondition for all later capture tasks (then have 1.V create all three subdirs, not just
   `screens`).
2. In **5.1 Step 4** (or a new "Evidence naming" note in PHASES.md), declare the **canonical**
   Phase-5 filename for each surface/check (the 5.1 `surface-theme-viewport.png` convention) and
   state that the per-phase `-4V`/`-4-4` captures are working artifacts the 5.x sweep supersedes.
   Then 5.4's evidence index references only the canonical 5.x names.

---

### Issue 4 — 4.3 says "all 12 must-pass + 3 forbidden = 15 assertions" but D17/the assertion list it enumerates contains more than 12 passing pairings  (MINOR)

**Files**: `phase-4/task-4-3.md` (Step 2 lists the assertions; Acceptance line 123 says "All 12
'must pass' assertions"; verification line 136 says `grep -cE "atLeast\(|below\("` → "all 15").

**Problem**: Step 2 enumerates **12 `atLeast` assertions** (graphite-on-sky, graphite-on-skyHover,
graphite-on-beige, graphite-on-white, white-on-navy, beige-on-navy, muted-on-beige, rose-on-beige,
blue-on-beige, blue-on-white, focus graphite-on-beige, focus sky-on-navy) + **3 `below` tripwires**
= 15 total. The acceptance criterion says "All 12 must pass" which matches the `atLeast` count, and
the grep expects 15 total — that's actually self-consistent. **However**, the D17 source list in
4.3 line 31 also names "graphite on white (12.45)" and the research `wcag-accessibility.md` may list
more pairings; the risk is the executor reading "12" and "15" as conflicting targets. Low severity,
but the two numbers in the same file invite a miscount.

**Fix**: In 4.3, change the acceptance line to "All 12 `atLeast` (must-pass) + 3 `below` (forbidden)
assertions = 15 total" so the 12 and the 15 are explicitly the same set counted two ways.

---

### Issue 5 — The reduced-motion guard is "owned" by both 1.2/Phase-1 and 4.4 (double-ownership, mild)  (MINOR)

**Files**: `phase-1/task-1-2.md` (does NOT add the guard — it's silent on reduced-motion),
`phase-2/task-2-4.md` (line 156: "rely on the global `@media (prefers-reduced-motion: reduce)` guard
in `globals.css` (Phase 1)"), `phase-4/task-4-4.md` (Step 4: "Add the global guard to globals.css
**(if not already present from Foundation)**").

**Problem**: 2.4 *assumes the global reduced-motion guard already exists in globals.css from
Foundation* ("the Phase 1 global reduced-motion guard"), but **1.2 never adds it** and no other
Phase 1 task does either (1.2's scope is tokens + `.pn-*` + dark scope; the reduced-motion block is
not in its action list). 4.4 correctly hedges with "if not already present," so the guard will land
by 4.4 at the latest — but **4.4 gates on 2.V/3.V**, which run *after* 2.4. So when 2.4's
confirmation delight is first built and verified (in 2.V), the global guard it "relies on" does not
yet exist. 2.4's own reduced-motion correctness then depends entirely on its JS `useReducedMotion()`
branch (which it does specify) rather than the CSS guard it cites. Not a hard failure (the JS branch
covers it), but the citation is misleading and 2.V will verify reduced-motion before the guard exists.

**Fix**: Either (a) move the global `@media (prefers-reduced-motion: reduce)` guard into **1.2** (add
it to 1.2's action list + acceptance, and reduce 4.4 Step 4 to "confirm present, add only if missing"),
which matches 2.4's and 2.V's assumption; or (b) update **2.4** line 156 and **2.V** Step 5 to say the
guard arrives in 4.4 and that 2.x reduced-motion correctness rests on the JS branch until then. Option
(a) is cleaner and makes the dependency graph honest (the guard becomes a Foundation deliverable that
everything inherits).

---

### Issue 6 — 4.4 edits the confirmation-delight component, which 5.x treats as frozen Phase-2 output — re-verification ownership unclear  (MINOR)

**Files**: `phase-4/task-4-4.md` (Artifacts to Modify: "The confirmation delight component(s) (from
Task 2.4) — ensure the final frame is the resting state and/or branch the JS animation on
reduced-motion"), `phase-2/task-2-4.md` (already implements the reduced-motion JS branch).

**Problem**: 2.4 *already* specifies the `useReducedMotion()` JS branch and the "final frame is the
resting state" rule (2.4 Step 3 / line 156). 4.4 then claims to modify the same component for the
same purpose. This is duplicated work / double-ownership: if 2.4 did it correctly, 4.4 has nothing to
change; if 4.4 changes it, it's editing a Phase-2-owned file after 2.V signed it off, and 5.3's
diff-review will see a delight-component edit attributed to Phase 4 (which is fine, but the
diff-review classification table in 5.3 lists `Booker.tsx` edits as Phase-2/3 visual — a Phase-4 edit
to the same file needs to be expected).

**Fix**: Narrow 4.4's confirmation-component action to **verify-and-only-fix-if-regressed**: "Confirm
2.4's reduced-motion branch lands the final frame statically; modify ONLY if 2.V left it broken
(record any such fix as a 4.4-owned correction to a 2.4 file)." This keeps 2.4 the owner and makes
4.4 a sweep, matching its stated intent ("cross-surface accessibility pass over Phases 2-3").

---

### Issue 7 — 5.2 may run axe on `/me` + `/admin` "if session live," but Lighthouse explicitly can't carry the session — the BLOCKED carry-forward is stated, but 5.4's D18 sign-off can over-claim  (MINOR)

**Files**: `phase-5/task-5-2.md` (Step 2 axe on /me+/admin if live; Step 3 Lighthouse "usually
can't" reach them), `phase-5/task-5-4.md` (D18 sign-off cites "5.2 axe + manual checks").

**Problem**: The auth-blocker carry-forward is handled well (resolve once in 5.1, carry as BLOCKED).
But 5.4's D18 evidence pointer ("5.2 axe + manual checks") doesn't distinguish surfaces that were
*actually audited* from those marked BLOCKED. If `/admin` `/me` stayed BLOCKED (no session this run —
the most likely outcome given the OAuth-only login and headless agent, per surface-verification.md),
5.4 could sign off D18 as satisfied while two internal surfaces were never axe/Lighthouse-tested.

**Fix**: In **5.4 Step 4 (D18 row)** and the master status table (Step 1), require the D18 verdict to
be split per surface and explicitly read "PASS (public surfaces) / BLOCKED (admin, me — no auth
session; human action: provide logged-in profile or screenshots)" rather than a single aggregate
PASS. Already partly implied by the "BLOCKED rows" instruction, but make D18 sign-off
surface-itemized so the gap can't be aggregated away.

### Issue 8 — `reports/checklist.md` template source is the skill `§9`, but no task actually creates the empty template first; 5.1 "write/append" assumes it can scaffold it  (MINOR)

**Files**: `phase-5/task-5-1.md` (Step 7 "Write/append `reports/checklist.md` using the §9 template
from `slate-ui-verification`"), `phase-2/task-2-V.md` + `phase-3/task-3-V.md` (both also write
`reports/checklist.md` / `reports/phase-3/`).

**Problem**: Three different sweeps (2.V, 3.V, 5.1) write to `reports/checklist.md` (2.V explicitly
names `reports/checklist.md`; 3.V writes `reports/phase-3/`; 5.1 writes/appends `reports/checklist.md`).
If 2.V already created a Phase-2-shaped `reports/checklist.md`, 5.1's "write/append" against the §9
template may either clobber it or append a second differently-shaped table. The 5.x sweep wants a
*fresh, all-surface* checklist, not the per-phase 2.V one.

**Fix**: Have **5.1 Step 7** explicitly state it creates a **fresh** `reports/checklist.md` for the
comprehensive sweep (e.g. the per-phase ones live at `reports/phase-2-checklist.md` / `reports/phase-3/`
and 5.1 starts a clean `reports/checklist.md`), or rename the per-phase artifacts so the Phase-5
checklist is unambiguous. Pin this in PHASES.md's evidence layout note (pairs with the Issue 3 fix).

### Issue 9 — `pic-3-ribbon.png` is vendored (1.1) and offered as an alternative, but 2.4 hard-selects coins; the alternate is now an orphaned asset the 5.4 stray-asset check doesn't expect  (MINOR)

**Files**: `phase-1/task-1-1.md` (copies both `pic-1-coins.png` and `pic-3-ribbon.png`),
`phase-2/task-2-4.md` (selects `pic-1-coins.png` only), `phase-5/task-5-4.md` (Step 2 stray grep
focuses on colors, not unused assets; 1.V line 75 expects `pic-3-ribbon.png` to be present).

**Problem**: `pic-3-ribbon.png` is intentionally vendored as a fallback but never referenced after
2.4 picks coins. This is benign, but it's an unreferenced asset that a strict "no dangling assets"
reviewer (1.1's own acceptance grep philosophy: "no references dangling") would flag. It's not in any
forbidden-list, so it won't fail a build, but it's dead weight shipped to the CF bundle.

**Fix**: Minor — either (a) add a one-line note to **2.4** and **5.4** that `pic-3-ribbon.png` is an
intentionally-retained unused alternate (so it's not later "cleaned up" by mistake, and 5.4 doesn't
flag it), or (b) have **1.1** not copy the ribbon until a task needs it (defer the alt). Given DISCOVERY
lists "coins vs ribbon" as an open item resolved to coins, option (a) — document the retained alt — is
the lighter touch.

---

## All-Clear: Verified-Coherent Items

These were specifically checked and are correct/consistent — no change needed:

1. **Contrast-guard ordering vs 1.V**: 1.V (line 36, 52) explicitly states `scripts/test-contrast.ts`
   "is added in Phase 4 (Task 4.3) … the contrast guard is NOT expected to exist yet; do not fail
   this sweep on its absence." 4.3 gates only on 1.2 (not the embed work) and uses the `pnpm test`
   `scripts/test-*.ts` glob (no `package.json` edit). 2.V/3.V both say "contrast guard PASS, or noted
   pending 4.3." **Ordering is coherent: 1.V runs before 4.3 exists and tolerates it.**

2. **Contrast guard re-run consistency**: 4.V Step 1, 5.2 Step 4, 5.3 Step 1, and 5.4 Step 5 all
   re-run it via `pnpm test` and assert the `# scripts/test-contrast.ts` / `ALL PASSED` block. 5.2
   also has the safety-net "create it here per skill §6 if missing from 4.3." **Consistent.**

3. **Contrast-guard token names vs 1.2**: 1.2 Cross-Surface Coherence (line 250) promises the exact
   eight names 4.3 reads (`--pennie-graphite/-sky/-sky-deep/-beige/-white/-navy/-muted/-blue`), and
   1.2 keeps all COLOR token names canonical (only radii/shadow get `--pn-` private aliases). 4.3's
   "throw on token-not-found" guard surfaces any drift. **The eight color names match** (the only
   gap is `--error`/`--accent-hover` — Issue 1).

4. **cal.com contract protection**: Protected identically and explicitly in 2.4 (opacity/transform
   only, `rootRef`/`slate:resize`/`slate:bookingSuccessful` untouched), 4.1 (Step 5 byte-for-byte
   diff confine, "DO NOT TOUCH" list), 4.2 (additive only, `slate:ready` additive-only rule, prefer
   `load` event), 4.V (Step 2 static grep + live `bookingSuccessful`), 5.3 (Step 4 live + file read).
   No task risks breaking it except the latent widget.js-default-`theme` gap in Issue 2.

5. **ResizeObserver no-height-animation rule**: Stated identically in 2.4 (line 152: "Never animate
   height … posts a moving scrollHeight, jittering the iframe") and 4.2 (line 42: "Do NOT animate
   height. Loader fade and iframe fade-in must be opacity/transform only"). 4.V Step 2 and 5.3 both
   re-verify "no resize jump." **Consistent.**

6. **Admin/me auth blocker carry-forward**: Resolved-once / carry-as-BLOCKED is handled in 3.V Step 1
   (resolve or record gap), 5.1 Step 2 (resolve up front, three strategies a/b/c, else escalate +
   mark BLOCKED), 5.2 Step 1 (confirm session still live, "if BLOCKED in 5.1, they stay BLOCKED
   here"). **No task assumes it can headlessly self-auth** — every relevant task cites
   surface-verification.md and the OAuth-only constraint. (Issue 7 is only about how 5.4 *reports* it.)

7. **widget.js stays vanilla / dependency-free**: 4.1 and 4.2 both forbid imports/React/Tailwind/font
   loads, with `grep -nE "import |require\(|tailwind|react"` checks; 4.V and 5.3 re-grep. Both 4.1/4.2
   editing widget.js is reconciled (4.1 = chrome literals; 4.2 = additive a11y/loading/mobile behavior
   on top), with 4.2 explicitly building "on top of 4.1's restyled shell." **Reconciled.**

8. **Dependency graph acyclicity/runnability**: 4.1←2.V, 4.2←4.1, 4.3←1.2, 4.4←2.V&3.V, 4.5←2.V&3.V,
   4.V←4.1-4.5, 5.1←4.V, 5.2←5.1, 5.3←5.2, 5.4←5.3. No cycles; every blocker precedes its dependent.
   4.3 correctly gates on 1.2 (not 1.V) per its "earliest cheapest a11y guard" rationale and PHASES.md
   note. **Acyclic and runnable.**

9. **Phase 5 covers everything Phases 1-4 produced**: 5.1 sweeps all 8 surfaces × theme × viewport
   incl. the booking flow states + embed; 5.2 covers axe/Lighthouse/contrast/focus/keyboard/
   reduced-motion/color-signal; 5.3 covers build/lint/test/E2E/diff-review/cal-contract/CF-deploy;
   5.4 covers stray-color grep + D1-D22 + coherence. The D16 delight-split (3D coins standalone / SVG
   puck embed) is verified in 5.1 Step 5/6 and the reduced-motion pair in 5.2 Step 7. **No Phase-1-4
   deliverable is unverified** (modulo the auth-gated admin/me, which is the known human-action gap).

10. **Surface tags + per-step verification**: Every Phase 4/5 task uses `[code]`/`[browser]`/`[file]`
    tags per execution-surfaces.md, and each has Per-Surface Verification + Cross-Surface Coherence
    sections. Evidence paths use `reports/{screens,axe,lighthouse}` consistently in intent (the only
    issue is filename canonicalization — Issue 3).

---

## Recommended fix priority

1. **Issue 2** (embed-default-`theme` widget.js guard) — small wording add to 4.1/4.2, prevents a
   silent contract break.
2. **Issue 1** (`--error`/`--accent-hover` tokenization) — reconcile 1.2 ↔ 4.3 so the guard reads
   shipped tokens.
3. **Issue 3 + 8 + 5** (evidence-path canonicalization, checklist freshness, reduced-motion guard
   ownership) — pin in PHASES.md's evidence/Foundation notes; clears three issues at once.
4. **Issues 4, 6, 7, 9** — one-line clarifications in the owning tasks.

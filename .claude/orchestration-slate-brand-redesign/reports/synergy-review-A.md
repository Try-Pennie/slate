# Synergy Review A — Slate Brand Redesign Task Plan

**Reviewer focus:** Phases 1–3 (Foundation, Booker, Internal pages) as primary owner; cross-phase
issues (Phase 4/5) noted where they touch the same surfaces/contracts.
**Scope:** Contradictions, Provides/Consumes contract alignment, dependency/ordering correctness,
gaps (assumed-but-never-created), surface-tag consistency, verification completeness, file-edit
collisions, and the visual-only (D5) constraint.
**Method:** Read all 28 task files + PHASES.md + DISCOVERY.md + execution-surfaces.md, then
cross-checked the load-bearing claims against the actual repo and the exported Pennie Design System
(`colors_and_type.css`, `assets/`). Line references in the tasks were spot-verified against the
real files and are accurate.

---

## Summary

The plan is unusually well-specified: dependencies are declared and acyclic, surface tags and
verification steps are present on nearly every action, the foundation→consumer handoffs are explicit,
and the visual-only constraint is repeated and enforced (grep + git-diff gates everywhere). The
two-layer token approach, the `data-theme`/`@custom-variant dark` mechanism, the brandColor and
postMessage embed contracts, and the auth-blocker handling are all coherent and correctly threaded.

However there are a **handful of real contract/gap issues** that will bite an executing agent if not
reconciled. The most important:

1. **BLOCKER — `--pennie-rose` / `--error` tokens do not exist in the design system or in 1.2's
   plan.** Tasks 2.3, 2.5, 3.2, 3.3 all consume them. Either Task 1.2 must define them, or all
   consumers must standardize on the literal `#C43D3D`. As written this is a dangling consume.
2. **MAJOR — `ThemeToggle.tsx` is created twice** (Task 1.5 and Task 3.1), with different
   implementations, at the same path. Guaranteed clobber / drift.
3. **MAJOR — `globals.css` `:focus-visible` is written by 1.2 (verbatim DS, sky ring) and then
   must be overridden by 4.4 (theme-aware), but 2.3/3.1 wire controls to the *intermediate, AA-failing*
   focus rule** and 2.V/3.V assert theme-aware focus that only 4.4 delivers. The ordering means
   Phase 2/3 verification sweeps will fail their own focus criteria before 4.4 runs.
4. **MAJOR — the contrast guard (4.3) asserts token names that 1.2's plan renames or omits**
   (`--pennie-mercury`/`-rose`/`-blue` resolution, and the radii private-alias scheme). Needs a
   name contract pinned in 1.2.

Details, severities, and specific fixes below. An "all-clear" list of verified-coherent items
follows the issues.

---

## Issues

### 1. [BLOCKER] `--pennie-rose` / `--error` tokens are consumed but never defined

**Files:** `task-1-2.md` (owner), `task-2-3.md`, `task-2-5.md`, `task-3-2.md`, `task-3-3.md`,
`task-4-3.md`.

**Problem:** The error/destructive color is referenced under **three different names** across the
plan, and the canonical token does not exist:
- The DS `colors_and_type.css` has **no `--pennie-rose`, no `--error`, and no `#C43D3D`** anywhere
  (verified by grep of the source). The rose `#C43D3D` is a DISCOVERY-introduced value (D8/D17), not
  a shipped DS token.
- Task 1.2 (the token layer owner) **does not list a rose/error token** in its Layer A inventory or
  its `@theme inline` mapping. It ports `--pennie-*` "verbatim from the DS" — so rose won't appear.
- Task 2.3 says `text-[var(--error)]` "if Phase 1 tokenized it; otherwise `text-[#C43D3D]`".
- Task 2.5 says `text-[var(--error)] or text-[#C43D3D]`.
- Task 3.2 hardcodes **`text-[--pennie-rose]`** and `bg-[rgba(196,61,61,.12)]` in its status-ternary
  mapping table (5 sites) — `--pennie-rose` is invented and will resolve to nothing (invisible text).
- Task 3.3 also references `--pennie-rose` indirectly via the same pattern.
- Task 4.3's contrast guard reads `r("--error")` "if found, else `HEX("#C43D3D")`" — so it tolerates
  either, but the runtime surfaces won't render if they used the undefined `--pennie-rose`.

A `var(--pennie-rose)` / `var(--error)` that is undefined renders as `unset`/inherited color — i.e.
**error text becomes invisible or graphite**, silently defeating the rose-error a11y requirement,
and it will pass a naive `grep "red-"` check.

**Fix (pin it in 1.2):** Add to Task 1.2 Layer A `:root`, explicitly:
`--pennie-rose: #C43D3D;` and a semantic `--error: var(--pennie-rose);`, plus a tint helper or
documented use of `rgba(196,61,61,0.12)` for the 12% wash. Map `--color-error: var(--error)` in
`@theme inline` so `text-error`/`bg-error` utilities exist. Then **standardize every consumer
(2.3, 2.5, 3.2, 3.3) on `--error` / `text-error`** (drop the invented `--pennie-rose` name and the
"if tokenized… else literal" hedging). Update 4.3 to read `--error` unconditionally (keep the
`HEX()` fallback only as the throw-on-missing tripwire). Add `--pennie-rose`/`--error` to 1.2's
"Cross-Surface Coherence" name list (which currently lists only graphite/sky/sky-deep/beige/white/
navy/muted/blue — rose is missing there too).

---

### 2. [MAJOR] `ThemeToggle.tsx` created twice with conflicting implementations

**Files:** `task-1-5.md` (creates `src/components/ThemeToggle.tsx`), `task-3-1.md` (also creates
`src/components/ThemeToggle.tsx`).

**Problem:** Both tasks list `src/components/ThemeToggle.tsx` under "Artifacts to Create" with
**different specs**:
- 1.5: text-label toggle ("Light"/"Dark"), reads `document.documentElement.dataset.theme`, styled
  `.pn-btn--small --additional`.
- 3.1: **icon-only** sun/moon button, reads via `getAttribute("data-theme")`, ≥44×44 icon button.

3.1's Step 3 hedges ("if 1.5 already shipped a toggle island, prefer importing/wrapping it rather
than duplicating; otherwise create it here") but its Artifacts list and Verification still say
*create* it, and 1.5's verification asserts its own version. Whichever runs second overwrites the
first; the repo confirms neither exists yet, so there's no tiebreaker. This is a guaranteed
clobber and a contract ambiguity (1.5 "Provides ThemeToggle to 3.1/3.3"; 3.1 "Provides ThemeToggle").

**Fix:** Make 1.5 the sole owner/creator. In 3.1, change "create" to "consume `@/components/ThemeToggle`
from 1.5; if it needs the icon-only ≥44px header treatment, *extend* it (props/variant) rather than
rewrite it." Reconcile the read method (use `dataset.theme` in both) and the accessible-name/size
spec in 1.5 so it already satisfies 3.1's header needs (icon variant + `aria-label` + ≥44px). Remove
`ThemeToggle.tsx` from 3.1's "Artifacts to Create" (leave it only in "Artifacts to Modify" if the
extension is needed). Note: the global skill-list also references a `ThemeToggle` from 1.5 — keep one.

---

### 3. [MAJOR] Focus-rule ownership split: 1.2 ships the AA-failing sky ring; 2.3/3.1 wire to it; 2.V/3.V demand the theme-aware ring that only 4.4 delivers

**Files:** `task-1-2.md`, `task-2-3.md`, `task-3-1.md`, `task-2-V.md`, `task-3-V.md`, `task-4-4.md`.

**Problem:** The DS `colors_and_type.css` (which 1.2 copies "verbatim") contains
`.pn-btn:focus-visible { outline: 3px solid var(--focus-ring); … }` and `:focus-visible { outline-color:
var(--focus-ring); }` where `--focus-ring: rgba(130,208,255,0.45)` (sky) — verified in source. That sky
ring is **1.57:1 on beige / 1.69:1 on white = fails WCAG 1.4.11 (3:1)**. Task 4.4 is the task that
introduces `--focus-ring-line` (graphite-on-light / sky-on-navy) and rewrites the `:focus-visible`
recipe. But:
- **2.3** says "wire visible focus here and prefer graphite outline on light so you never ship a
  sky-only ring on beige" — i.e. it asks the Booker form to implement theme-aware focus *before* 4.4
  defines the token, with no shared mechanism. Two tasks editing the focus story.
- **3.1** research notes say "foundation should set this globally; the header inherits it" — but
  foundation (1.2) ships the *failing* sky ring, not the fixed one. So 3.1 inherits the wrong ring.
- **2.V** acceptance: "Theme-aware focus visible (graphite light / sky navy, ≥2px)" and **3.V**:
  axe/Lighthouse + "theme-aware focus" — both gate *before* 4.4 (4.4 is `Blocked by: 2.V, 3.V`).
  So 2.V and 3.V assert a focus behavior that, by the dependency graph, does not exist until after
  they pass. Circular expectation.

**Fix:** Move the **theme-aware focus token + `:focus-visible` recipe into Task 1.2** (Foundation),
not 4.4. Concretely: 1.2 defines `--focus-ring-line` (`:root` graphite via `--fg`; `[data-theme="dark"]`
sky via `--accent`) and writes the `:focus-visible`/`.pn-btn:focus-visible` recipe as
`outline:2px solid var(--focus-ring-line); outline-offset:2px; box-shadow:0 0 0 4px var(--focus-ring)`
*instead of* copying the DS sky-ring rule verbatim. Then 4.4 becomes a **sweep/verification** task
(audit `overflow-hidden` clipping, branch JS delight on reduced-motion, confirm no `outline:none`)
rather than the task that first defines the token. Update 2.3/3.1 to simply rely on the global recipe
(remove their "prefer graphite here" improvisation). Relax 2.V/3.V focus acceptance to "inherits the
foundation theme-aware focus recipe (graphite light / sky navy)" so it's satisfiable pre-4.4. (4.4's
`overflow-hidden` edge-clip fix on the Booker shell can stay in 4.4.)

Note: 1.2's Step 3 currently says to copy the `:focus-visible { outline-color: var(--focus-ring); }`
rule **verbatim** — that line is the source of the regression; it must be replaced, not copied.

---

### 4. [MAJOR] Contrast-guard token-name contract (4.3) vs 1.2's rename/omit decisions

**Files:** `task-1-2.md`, `task-4-3.md`.

**Problem:** 4.3 reads tokens **by name** out of `globals.css` and throws on missing. It expects:
`--pennie-graphite, --pennie-sky, --pennie-sky-deep, --pennie-beige, --pennie-white, --pennie-navy,
--pennie-muted, --pennie-blue`, plus `--accent-hover` (#6dc5f7) and the error rose. Cross-checks:
- The DS uses `--pennie-graphite`? **Not directly** — verify. The DS defines `--fg-strong`/`--fg` and
  `--pennie-*` core colors; 4.3 assumes a `--pennie-graphite` literal exists. 1.2 must guarantee the
  exact names 4.3 reads are present (1.2 says "keep all COLOR token names exactly as in
  `colors_and_type.css`" — but 4.3's list must match what the DS actually names; e.g. graphite may be
  `--pennie-graphite` or only reachable via `--fg-strong`). **Pin the canonical name list in both.**
- `--accent-hover` is `#6dc5f7` literal in the DS (confirmed). 1.2's `@theme inline` does not map
  `--accent-hover` to a `--color-*` (it maps `--accent`/`--accent-hover` semantic vars in `:root` but
  4.3 needs to *resolve* `--accent-hover` from the file) — fine as long as 1.2 keeps `--accent-hover`
  in `:root` (it does, copied from DS). OK, but state it as a contract.
- The **error rose** (Issue 1) — 4.3 reads `--error`; 1.2 must define it.

**Fix:** Add an explicit "Token-name contract for 4.3" subsection to Task 1.2 listing the exact names
4.3 will `resolve()` and asserting they survive the port unrenamed: `--pennie-graphite` (or document
the actual DS name + have 4.3 read that), `--pennie-sky`, `--pennie-sky-deep`, `--pennie-beige`,
`--pennie-white`, `--pennie-navy`, `--pennie-muted`, `--pennie-blue`, `--accent-hover`, `--error`.
1.2 already protects radii/shadow via private `--pn-*` aliases while keeping color names canonical —
just make the *color* name list explicit and add `--error`/rose to it. (1.2's Cross-Surface Coherence
section lists most of these but omits rose — see Issue 1.)

---

### 5. [MAJOR] `sr-only` utility assumed by 2.2 (and the a11y "today"/visually-hidden cues) but never created in Phase 1

**Files:** `task-1-2.md`, `task-2-2.md`, `task-2-4.md`, `task-3-x`.

**Problem:** The DS `colors_and_type.css` has **no `sr-only`/visually-hidden utility** (verified).
Tailwind v4 *does* ship a built-in `sr-only` utility, but the plan never confirms it's available
(no `tailwind.config`, CSS-only config). 2.2 hedges: "If Phase 1 didn't ship an `sr-only` utility,
use an inline visually-hidden style." 2.4 needs a visually-hidden `aria-live` region. Multiple a11y
cues (today marker, live regions) depend on a reliable visually-hidden primitive. Leaving each task
to improvise inline styles risks inconsistency and missed announcements.

**Fix:** Have Task 1.2 confirm/guarantee a visually-hidden primitive: either verify Tailwind v4's
built-in `sr-only` resolves (add a one-line note + a smoke assertion) or add a small `.sr-only`/
`.pn-visually-hidden` class to `globals.css`. Make it a documented "Provides" so 2.2/2.4/3.x consume
one canonical class. (Low effort, removes three separate improvisation points.)

---

### 6. [MAJOR] `book/page.tsx` is edited by three tasks (2.1, 2.4, 2.5) — sequential but overlapping line regions

**Files:** `task-2-1.md` (line 55 theme), `task-2-4.md` (line 56 brandColor), `task-2-5.md`
(lines 27–32 missing-`xbc` error).

**Problem:** All three modify `src/app/book/page.tsx`. They touch *different* lines (55, 56, 27–32),
and all three are `Blocked by: 2.1`, so 2.1 lands first. But 2.4 and 2.5 are siblings (both only
gated on 2.1, can run in parallel per the graph) and both edit this file. 2.4 edits line 56; 2.5
edits lines 27–32 and *also* `booking/[id]/page.tsx` and `booking/manage/[token]/page.tsx`. Parallel
execution → merge collision on `book/page.tsx`. The same is true for **`Booker.tsx`**, edited by 2.1,
2.2, 2.3, 2.4 (all `Blocked by: 2.1`, siblings 2.2/2.3/2.4 in parallel) — though the tasks carefully
partition by line region (palette 47–92, calendar 324–402, form 406–438, confirmed 263–278), parallel
edits to one file still collide at the patch level.

**Fix:** Add an explicit **serialization note** for the shared-file siblings: run 2.2 → 2.3 → 2.4 →
2.5 sequentially (not parallel) since they all edit `Booker.tsx`/`book/page.tsx`, OR have each rebase
on the prior. The dependency graph shows them as parallel fan-out from 2.1; add "these share
`Booker.tsx`/`book/page.tsx`, execute serially" to PHASES.md and to each task's Blocked-by (e.g.
2.3 blocked-by 2.2, 2.4 blocked-by 2.3, 2.5 blocked-by 2.4). This is the single biggest *execution*
risk even though the task content is partitioned cleanly.

---

### 7. [MINOR] Confirmation graphic filename: 1.1 copies `pic-1.png` → `pic-1-coins.png`; 2.4 consumes `/brand/pic-1-coins.png` — consistent, but the alt `pic-3` rename differs

**Files:** `task-1-1.md`, `task-2-4.md`, `task-3-4.md`.

**Problem:** Verified the names line up for the default: 1.1 produces `public/brand/pic-1-coins.png`
and 2.4 consumes exactly that. Good. But 1.1 also copies `pic-3.png` → `pic-3-ribbon.png`, while
3.4 (login) references "optional `pic-3.png`" by its *original* name. Minor naming drift; 3.4 would
look for a file that 1.1 renamed.

**Fix:** In 3.4, change the optional graphic reference from `pic-3.png` to `public/brand/pic-3-ribbon.png`
(the name 1.1 actually writes). Trivial, but otherwise a dead reference.

---

### 8. [MINOR] `globals.css` edited by 1.2 (write), 4.3 (read), 4.4 (edit) — plus the focus rule from Issue 3

**Files:** `task-1-2.md`, `task-4-3.md`, `task-4-4.md`.

**Problem:** 4.3 only *reads* globals.css (safe). 4.4 *edits* it (focus token + reduced-motion guard).
1.2 also says to keep "the global `font-synthesis: none` rule" and a `prefers-reduced-motion` is
mentioned by 2.4/4.4 as "the global guard in `globals.css` (Phase 1)" — but **1.2 never actually adds
a reduced-motion guard**; 4.4 is the task that adds it. Yet 2.4 ("rely on the global `@media
(prefers-reduced-motion: reduce)` guard in `globals.css` (Phase 1)") and 2.V assume it exists in
Phase 1. So 2.4/2.V reference a guard that doesn't land until 4.4.

**Fix:** Either (a) move the global `@media (prefers-reduced-motion: reduce)` guard into Task 1.2
(it's a one-block, foundation-appropriate addition), and let 4.4 only do the JS-delight branch + focus
sweep; or (b) fix 2.4/2.V wording to not claim the guard is a Phase-1 deliverable and instead have
2.4 ship its own scoped reduced-motion handling. Option (a) is cleaner and matches how 2.4 already
talks about it ("Phase 1 global guard"). If (a), update 1.2's Artifacts/Acceptance to include the
reduced-motion guard, and 4.4 to "confirm/extend" it. (Pairs naturally with the focus-token move in
Issue 3 — both belong in foundation.)

---

### 9. [MINOR] `Pill` helper ownership (3.2 creates, 3.3 consumes) with a soft-dependency race

**Files:** `task-3-2.md`, `task-3-3.md`.

**Problem:** 3.2 creates `src/components/ui/Pill.tsx`; 3.3 consumes it for the bookable pill. But
3.3's Blocked-by is only **3.1** (not 3.2), and 3.3 explicitly says "if running before 3.2 completes,
create the bookable pill inline … and have 3.2/3.V reconcile." So Pill can be created twice (3.3
inline + 3.2 canonical) → drift, the same pattern as the ThemeToggle issue but lower-stakes (it's
acknowledged and has a reconcile path).

**Fix:** Add `3.2` to 3.3's Blocked-by so `Pill` exists before 3.3 runs (3.2 and 3.3 are both gated
on 3.1 and don't share a file, so serializing 3.2→3.3 is cheap and removes the inline-duplicate path).
Then delete 3.3's "create inline" fallback.

---

### 10. [MINOR] `--accent-press` / pressed-CTA: DS token exists but 2.3 says "do not darken on press"

**Files:** `task-2-3.md`, `task-1-2.md`.

**Problem:** The DS defines `--accent-press: var(--pennie-sky-deep)` (#439FE1) and `.pn-btn:active {
transform: translateY(1px) }` (verified). D17 says graphite-on-sky-deep = 4.32:1 **FAIL**, so 2.3
correctly says "do not darken the fill on press; rely on `translateY(1px)`." But 1.2 ports
`--accent-press` into `:root` verbatim, and nothing in the plan ensures no `.pn-btn--primary:active`
or utility *uses* `--accent-press` as a fill. If any DS `.pn-*` rule (or a later task) applies
`background: var(--accent-press)` on active, it reintroduces the failing pairing. The DS
`.pn-btn--primary` block does **not** set an active background (confirmed — only `:hover` →
`--accent-hover`), so it's currently safe, but the token's presence is a latent trap.

**Fix:** Add a note in 1.2 (and 4.3's tripwire already covers it: `below(graphite, skyDeep, 4.5)`):
`--accent-press` exists but must NOT be used as a CTA fill under a graphite/dark label. Optionally
have 1.2 *not* re-expose `--accent-press` as a Tailwind utility in `@theme inline` (it isn't in the
mapping list — good; just make that omission intentional/documented). The 4.3 tripwire is the
backstop; this is belt-and-suspenders.

---

### 11. [MINOR] Booker `theme` prop self-scopes `data-theme`, but `book/page.tsx` doesn't sit under the `<html data-theme>` — interaction with 1.5 is correct but under-verified

**Files:** `task-1-5.md`, `task-2-1.md`.

**Problem:** 1.5 sets `data-theme` on `<html>` from localStorage (internal-page persistence). 2.1
sets `data-theme={theme}` on the Booker's own root wrapper so the embed iframe theme is independent.
The plan correctly reasons that a nested `[data-theme]` wins for its subtree. But there's a subtle
case: the **standalone** `/book` page (not embedded) is also under `<html data-theme="light">` from
1.5's default; if a user toggled internal pages to dark and then opens `/book` (no theme param),
2.1's flip-to-light default sets the Booker root to `light` while `<html>` may be `dark` from
persisted storage. The Booker root nested `data-theme="light"` correctly wins for the Booker subtree —
intended — but the *page chrome outside the Booker* (the beige page background from `body`/`--bg`)
would be dark. No task verifies this standalone-page-vs-Booker-subtree mismatch.

**Fix:** Add a verification line to 2.1 (or 2.V): on `/book?xbc=411` with `localStorage.slate-theme=dark`
persisted, confirm the Booker renders light (its own `data-theme`) AND decide the desired page-chrome
behavior (likely: the standalone `/book` page should not inherit the internal-pages localStorage theme
at all — consider not running 1.5's no-flash script logic on `/book`, or scoping it). Low severity
because the Booker subtree is correct; flag it so the page background doesn't look mismatched.

---

### 12. [MINOR] Surface-tag + verification completeness — small gaps

**Files:** several.

**Problems (each minor):**
- **1.4** app-icon step is tagged `[file][code]` and the favicon browser check is thorough, but
  component icon *tint in both themes* is explicitly deferred ("re-verified in Phase 2 / Task 1.V")
  — yet **1.V does not actually re-verify icon tint** (1.V Step 6 only checks the favicon link +
  navy mark render, not a component tinting in both themes). So the "tint via currentColor in both
  themes" acceptance criterion in 1.4 has **no owning verification** until a Phase 2 surface happens
  to use one. **Fix:** add an explicit icon-tint check to 1.V (mount one icon, set `color`, read
  computed fill in light+dark) or move that acceptance line's verification to 2.2/2.3 explicitly.
- **2.1** verification navigates `/booking/seed-test?xbc=411` to prove the path-entry default flip,
  but `booking/[id]/page.tsx` is a server component reading a real `sfId`; "seed-test" may 404/redirect
  rather than render the Booker. **Fix:** specify a known-good seed id (or note that the path entry is
  verified via the prop default + a unit-level read, since a live path entry needs seed data).
- All other actions carry a surface tag and a matching verification step — coverage is otherwise
  complete and both themes are consistently required.

---

## All-clear (verified coherent)

These were checked and are correct as written — no change needed:

- **Dependency graph is acyclic and the blocked-by ordering is valid.** 1.1/1.2 are roots; 1.3
  correctly blocks on 1.1+1.2; 1.4 on 1.1; 1.5 on 1.2; 1.V on all of 1.x; Phases 2/3/4 gate on 1.V;
  2.x on 2.1; 3.x on 3.1; 4.1→4.2, 4.3 on 1.2, 4.4/4.5 on 2.V+3.V; Phase 5 chain 5.1→5.2→5.3→5.4.
  (The one ordering correction is the *focus/reduced-motion ownership* in Issues 3 & 8 and the
  *shared-file serialization* in Issue 6 — the declared deps are otherwise sound.)
- **Token handoff chain 1.2 → 1.3 → 2.x is correct:** `--font-pp-mori` name is spelled identically
  in 1.3's `pp-mori.ts` (`variable: "--font-pp-mori"`) and 1.2's `--font-sans` chain; 1.2 explicitly
  cross-checks the spelling. PP Mori 400+600+700-alias + `font-synthesis:none` matches D6/D7.
- **`slate-theme` localStorage key is consistent** between 1.5's no-flash `<head>` script and the
  toggle island, and 3.1's research re-asserts the same key (the *component duplication* is Issue 2,
  but the *key* is coherent everywhere).
- **Asset path handoffs are correct:** 1.1 writes `public/brand/logo-pennie-charcoal.svg` (consumed
  by 3.1/3.5), `logo-pennie-cream.svg` (3.4), `logo-mark.svg` (1.4 favicon source), and
  `pic-1-coins.png` (2.4 — name verified matching). All source files exist in the DS `assets/`.
  Fonts under `src/app/fonts/PPMori/` (only Regular+SemiBold, not Medium/Bold/OTF) matches D6 and the
  `next/font/local` relative-path requirement.
- **Icon contract:** 1.4's authored set (ArrowRight, ChevronRight, Check, CheckBadge, Smile, Plus,
  Minus, Phone) all have real DS source SVGs (verified: `arrow-right.svg`, `chevron-right.svg`,
  `check.svg`, `check-badge.svg`, `smile.svg`, `plus.svg`, `minus.svg`, `bold/Phone.svg`, `info.svg`
  for 3.3 all exist). The `check-badge` `#F9F6F0` literal-tick caveat is correctly preserved across
  1.4 → 2.4 → 5.4's grep-exception list. Globe/Clock correctly noted as *not* in the DS and left to
  Booker's existing inline SVGs (no false dependency).
- **`@theme inline` + `data-theme` + `@custom-variant dark` mechanics** are internally consistent
  across 1.2 (defines), 1.5 (drives), 2.1 (Booker subtree scoping), and 3.1/3.2/3.3 (semantic-utility
  re-resolution). The "inline keyword is load-bearing" and "no `@theme` under `@media`" gotchas are
  correctly captured. Radii/shadow private `--pn-*` alias scheme avoids the self-reference collision.
- **brandColor embed contract:** 2.1 preserves the `dotStyle`/`ringStyle`/`confirmStyle` inline
  mechanism; 2.3 fixes only the `color:"#fff"`→graphite default; 2.4 defaults brandColor→sky in
  `book/page.tsx` while keeping host override; 4.1 keeps chrome a fixed Pennie shell (not host-themed).
  D14 is satisfied without contradiction. The white-on-sky fix is owned solely by 2.3, with 2.1
  pre-setting graphite to avoid reintroduction — clean handoff.
- **postMessage / ResizeObserver contract** (`slate:resize`, `slate:bookingSuccessful`, opacity/
  transform-only animation) is consistently protected in 2.4, 4.1, 4.2 (additive `slate:ready` only),
  and re-verified in 4.V/5.3. No task proposes a height animation. cal.com drop-in params
  (`xbc`/`external_id`/`embed`/`theme`/`brand`) are listed as untouchable everywhere they appear.
- **Visual-only (D5) enforcement is thorough and non-contradictory:** every code task lists the exact
  logic regions to NOT touch (with line refs that match the real files: Booker `theme=124`,
  `confirmStyle=134`, emerald dots `394`/`479`; `book/page.tsx` line 55/56; admin `actions.ts` and
  RBAC gates; login `signIn()` 14–30). 3.2's status-ternary "preserve the condition, change only the
  color" guidance is the right framing and is echoed in 5.3's diff-review classification. No task
  asks for a logic change; the few risky spots (focus `useEffect` in 2.4, optional `theme` prop on
  ManageBooking in 2.5) are correctly scoped as presentational/a11y-affordance, not logic.
- **Verification sweeps (x.V) and Phase 5** consume the right upstream artifacts, both themes are
  required throughout, the auth-blocker for `/admin`+`/me` is consistently flagged with the same
  three-option resolution (logged-in profile / injected session / user screenshots) and never silently
  skipped. The contrast guard's "pending if 4.3 hasn't run" is correctly tolerated in 1.V/2.V/3.V.
- **Repo reality check:** current `globals.css`, `layout.tsx`, `package.json` test glob
  (`for f in scripts/test-*.ts`), and `cf:build` script all match what the tasks describe; no existing
  `ThemeToggle`/`Pill`/icon files to conflict with (so the only duplication risk is intra-plan,
  Issues 2 & 9).

# Task 2.3: Restyle the attendee form + primary CTA

## Objective

Restyle the Booker's attendee form (name / email / phone inputs) to the DS field recipe (shadow-led,
labeled, ~52px, sky focus ring, autocomplete + input types), rebuild the primary Confirm button as
`.pn-btn--big --primary` (sky fill + **graphite label** + right-arrow icon) fixing the white-on-sky
contrast bug, and move all error states from bright `red-500`/`red-600` to muted rose `#C43D3D`
with a `role="alert"` live region and a leading icon. **Visual + a11y-attribute only: no submit,
fetch, validation, or state logic changes.**

## Context

**S8 — shared-file coordination:** Tasks 2.2, 2.3, 2.4 all edit `src/components/Booker.tsx`. This
task owns the form region (~406–438) + `confirmStyle` (134). Run sequentially after 2.2 (or with
coordinated, non-overlapping regions); re-read the file right before editing and confine changes to
the form region so 2.2's calendar edits and 2.4's confirmed-view edits don't collide.

After 2.1 (palette) and 2.2 (calendar/slots), the form panel is the last interactive step before
confirmation. It currently has placeholder-only inputs (no labels — SR/low-vision fail), a CTA that
writes **white text on the brand fill (`confirmStyle` color `#fff`, line 134)** which fails AA on
sky (1.69:1), and a bright `text-red-500` error line (429) that is color-only and silent to screen
readers. This task lands the locked CTA pairing (graphite-on-sky 7.36:1) and the rose error system.
2.4 (confirmation delight) and 2.5 (manage rose) follow.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| `src/components/Booker.tsx` (form view ~406–438) | [code] | Inputs → DS field recipe + labels + autocomplete; Confirm → `.pn-btn--big --primary` graphite-on-sky + arrow; errors → rose + `role="alert"`; fix `confirmStyle` white-on-sky |
| `/book?xbc=411&theme=light` / `&theme=dark` | [browser] | Verify form, CTA contrast, error state, axe clean |

## Dependencies

- Task 2.1 — token-driven `PALETTE` (`input`, `confirm`, `backHover` keys), light default, brandColor
  inline mechanism (`confirmStyle`).

## Blocked By

- Task 2.1

## Research Findings

- From `booker-ux-patterns.md` (§3 Form fields): per `forms.html`, inputs ~52px (currently `py-2`
  ≈ 40px — bump to 48–52px / 44px min target), `border-radius: --radius-sm` (8px), `background:
  var(--surface)`, placeholder `rgba(52,52,52,0.45)`, text `--fg`. **Focus = sky ring** is the DS
  global treatment, BUT see the WCAG override below (sky ring fails on light). Add visible labels
  (12–14/600) above inputs rather than placeholder-only.
- From `booker-ux-patterns.md` (§3 Primary CTA): the one place sky lives. Recipe = `.pn-btn
  .pn-btn--big .pn-btn--primary`: `background: var(--accent)` (sky); **label `--fg` = graphite**
  (`.pn-btn--primary { color: var(--fg) }`, `--fg-on-sky: graphite`). Current code uses white on the
  brand fill (line 134) — **change to graphite.** `height: 56px`, `padding: 0 24px`, `border-radius:
  --radius-xl` (16px). Hover `--accent-hover`; active `translateY(1px)`. **Include the right-arrow
  icon** (`arrow-right`), nudging `translateX(4px)` on hover, easing `cubic-bezier(.2,.8,.2,1)`.
  Copy is a verb phrase: "Confirm booking" / "Book my call" (never "Submit").
- From `booker-ux-patterns.md` (§4 Errors): error color is **muted rose `#C43D3D`**, never bright
  red. Replace every `text-red-500`/`text-red-600`/`border-red-*`. The 409 "just taken" race
  (line 251 message) → inline rose notice with a soft 12% rose-wash background pill.
- From `wcag-accessibility.md`:
  - **PRIMARY CTA graphite `#343434` on sky `#82D0FF` = 7.36:1 PASS** — no darker sky. Keep
    `--fg-on-sky: graphite`. **White on sky = 1.69:1 FAIL hard — never.** Pressed: do NOT darken to
    sky-deep (`#439FE1` graphite = 4.32:1 FAIL); signal press via `translateY(1px)`, cap any fill
    change at `--accent-hover` (`#6dc5f7`, 6.51:1).
  - **Sky focus ring on light = 1.57:1 FAIL (3:1 non-text).** Theme-aware focus: 2px **graphite**
    outline on light + sky glow as decorative `box-shadow`; 2px **sky** outline on navy. (The full
    theme-aware focus token is finalized in 4.4, but wire visible focus here and prefer graphite
    outline on light so you never ship a sky-only ring on beige.)
  - **Inputs:** real `<label>` (visually-hidden ok) or `aria-label`; `autocomplete` tokens —
    name→`autocomplete="name"`, email→`type="email" autocomplete="email" inputmode="email"`,
    phone→`type="tel" autocomplete="tel" inputmode="tel"`. `aria-required` on required; on error
    `aria-invalid` + `aria-describedby` → the message.
  - **Errors:** `role="alert"` (assertive) + a leading error icon + rose token; not color-only,
    not silent. The error `<p>` must be a live region.
  - **Targets:** Confirm uses `.pn-btn--big` (56px) — comfortably passes; inputs → ≥44px (`py-3`).
  - **`overflow-hidden`** on the booker shell clips focus outlines on edge controls — use
    `box-shadow` rings or note for 4.4.
  - rose `#C43D3D` on beige = 4.77:1, on white = 5.14:1 (both PASS) — safe for error text.
- From `pennie-design-system-in-slate`: errors = muted rose `#C43D3D` on 12% tint; CTA verb phrase;
  16px button radius (`--radius-xl`); blue text on light must be `--pennie-blue` (not relevant to
  the CTA, but don't use sky as text anywhere).

## Current State (exact references — read before editing)

`src/components/Booker.tsx`:
- **brandColor inline overrides: line 134** — `const confirmStyle = brandColor ? { backgroundColor:
  brandColor, color: "#fff" } : undefined;` — **the `color: "#fff"` is the white-on-sky bug. Change
  the default label to graphite.**
- **Form view: lines 406–438** (the `selectedSlot ?` branch):
  - Back link (408–413): `<button onClick={() => setSelectedSlot(null)} className="text-xs ${c.muted}
    ${c.backHover}">‹ Back</button>`.
  - Slot summary (414–416): `<p className="text-sm font-semibold ${c.title}">{selectedDate?.toFormat("ccc d")} · {fmtTime(selectedSlot)}</p>`.
  - **Inputs (417–428):** maps `["name","email","phone"]`, each `<input className="w-full rounded-md
    border px-3 py-2 text-sm ${c.input}" placeholder={Capitalized field} type={field === "email" ?
    "email" : "text"} value={attendee[field]} onChange=... />`. **Placeholder-only, no labels, no
    autocomplete, phone is `type="text"`.**
  - **Error line (429):** `{error && <p className="text-sm text-red-500">{error}</p>}` — bright red,
    color-only, not a live region.
  - **Confirm button (430–437):** `<button onClick={submit} disabled={submitting} style={confirmStyle}
    className="w-full rounded-md px-4 py-2.5 text-sm font-medium ${c.confirm} disabled:opacity-60">
    {submitting ? "Booking…" : "Confirm"}</button>`. (`c.confirm` was set to sky-fill + graphite in
    2.1; finalize the full `.pn-btn` recipe here.)
- `error` state + `submit()` + 409 handling: lines 220–259 (LOGIC — do not touch; only the rendered
  error markup at 429 is restyled).
- `c.input`, `c.confirm`, `c.backHover` are token-driven from 2.1.

## Execution Plan

### Step 1: Fix the white-on-sky CTA color (the contrast bug)

**Surface:** [code]

- Line 134: change `confirmStyle` so the default label is graphite, not white. Replace
  `color: "#fff"` with the graphite token, e.g.
  `const confirmStyle = brandColor ? { backgroundColor: brandColor, color: "var(--fg)" } : undefined;`
  (graphite via `--fg`). Rationale (WCAG): graphite-on-sky 7.36:1 PASS; white-on-sky 1.69:1 FAIL.
  Auto-contrast against an arbitrary host `brandColor` is out of scope (a host may pass a dark
  brand) — the safe default is graphite; note in PROGRESS.md that runtime luminance-based label
  choice is deferred (hardening pass).

**Verification:**
- [code] `grep -n '#fff\|"#fff"' src/components/Booker.tsx` → no white CTA label.

### Step 2: Rebuild the Confirm button as `.pn-btn--big --primary` + arrow

**Surface:** [code]

- Confirm button (430–437): apply the DS primary recipe. Either compose `.pn-btn pn-btn--big
  pn-btn--primary` (if Phase 1 shipped those classes — preferred, since they map 1:1 to the DS
  previews verification compares against) or token utilities equivalent: full-width, `min-h-[56px]`,
  `px-6`, `rounded-xl` (16px), `bg-accent text-fg` (sky fill + graphite label), `font-semibold`,
  `hover:bg-[var(--accent-hover)]`, `active:translate-y-px`, `disabled:opacity-60`.
- KEEP `onClick={submit}`, `disabled={submitting}`, and `style={confirmStyle}` (logic). Keep the
  submitting/idle copy but warm it to a verb phrase: idle "Confirm booking" (or "Book my call"),
  submitting "Booking your call…". No dashes (`slate-copy-rules`).
- Add the right-arrow icon after the label (inline `ArrowRightIcon` from Task 1.4 if present, else a
  clean inline `currentColor` SVG), `aria-hidden="true"`, with `transition-transform
  group-hover:translate-x-1` (easing `cubic-bezier(.2,.8,.2,1)`). Hide/suppress the arrow nudge when
  submitting if it looks odd. Animate transform/opacity only (reduced-motion gated globally + by 4.4).
- Do NOT darken the fill on press; rely on `translateY(1px)`.

**Verification:**
- [browser] Screenshot the CTA both themes → sky fill, graphite label, 16px radius, arrow; hover
  shows the arrow nudge (no fill darkening to sky-deep). axe `color-contrast` clean on the button.

### Step 3: Restyle inputs to the DS field recipe + labels + autocomplete

**Surface:** [code]

- Inputs (417–428): for each field render a real (visually-hidden if the design wants placeholder
  look) `<label htmlFor>` + the `<input id>`. Field recipe: `w-full rounded-lg` (8px → use `rounded-md`
  per DS `--radius-sm` mapping), `bg-surface text-fg`, `min-h-[48px]` (≥44px target), `px-3`,
  placeholder muted (`placeholder:text-[rgba(52,52,52,0.45)]` or a token). Shadow-led per DS (subtle
  inset/`--shadow-xs` rather than a hard border) — the SKILL notes the README's "field border" is
  stale; lean on the shipped recipe.
- Add input semantics (attributes only — `attendee[field]`/`onChange` logic untouched):
  - name: `autocomplete="name"`
  - email: `type="email" autocomplete="email" inputMode="email"`
  - phone: `type="tel" autocomplete="tel" inputMode="tel"` (change from `type="text"`)
  - `aria-required` on each required field; when `error` is present, you MAY set
    `aria-invalid="true"` + `aria-describedby="booker-error"` (the error `<p>` id from Step 4).
- Keep the `(["name","email","phone"] as const).map(...)` structure; just enrich the per-field
  markup (you can branch type/autocomplete on the field name inside the map without changing state).

**Verification:**
- [browser] Snapshot shows each input has an accessible name (label/aria-label) and correct
  type/autocomplete; axe `label`/`label-title-only` clean.

### Step 4: Move errors to muted rose + `role="alert"` + icon

**Surface:** [code]

- Error line (429): replace `text-red-500` with the rose token. **S1: Task 1.2 defines `--error`
  (= `--pennie-rose` = `rgb(196,61,61)` / `#C43D3D`), so reference it by that exact name** — use
  `text-[var(--error)]` (NOT a raw `#C43D3D` literal, which would dodge the token layer). Add a
  leading error icon (`aria-hidden`) and make it a live region: `<p id="booker-error" role="alert"
  className="flex items-center gap-2 text-sm text-[var(--error)]">`. For the 409 "just taken" case,
  wrap in a soft rose-wash pill using `bg-[var(--error-bg)]` (the 12% tint from 1.2). Keep the
  `{error}` string and the conditional render (logic untouched).
- **`aria-live` mount note:** `role="alert"` regions announce on insertion, which is acceptable here;
  if reliability is a concern, the empty live region can be mounted always and only the text toggled
  — but do NOT change the `error` state machine. Keep it minimal and visual.
- The Back link (408–413) and slot summary (414–416): keep `c.muted`/`c.backHover`/`c.title` (token
  from 2.1); optionally make Back a `.pn-btn--link` with a left arrow and an accessible name like
  "Back to time selection".

**Verification:**
- [code] `grep -n "red-500\|red-600\|red-200\|border-red" src/components/Booker.tsx` → 0 matches.
- [browser] Trigger an error (e.g. submit with a network failure, or temporarily render the 409 copy)
  → the message shows in muted rose with an icon; snapshot shows `role="alert"`.

## Artifacts to Modify

- `src/components/Booker.tsx` — `confirmStyle` color fix (134); form view inputs+labels+autocomplete
  (417–428); error → rose + `role="alert"` + icon (429); Confirm → `.pn-btn--big --primary` +
  graphite + arrow (430–437); optional Back-as-link (408–413) — [code]

## Contracts

### Provides (for downstream tasks)

- The corrected graphite-on-sky `confirmStyle` default + `.pn-btn--big --primary` CTA recipe — 2.4
  reuses the same CTA conventions; 4.3 contrast guard asserts graphite-on-sky and white-on-sky-fail.
- The rose error pattern (`role="alert"` + icon + `#C43D3D`/`--error`) — 2.5 (ManageBooking) reuses it.

### Consumes (from upstream tasks)

- 2.1 token-driven `PALETTE` (`input`, `confirm`, `backHover`), brandColor inline mechanism, light
  default, `data-theme` root.
- Task 1.4 icon components (arrow-right, error/alert icon) if present.

## Acceptance Criteria

- [ ] CTA is sky fill + **graphite** label (passes 7.36:1), 16px radius, includes the arrow icon,
      verb-phrase copy; press is signaled by translate, not a darker fill; never white-on-sky.
- [ ] Inputs are labeled (real/visually-hidden label or `aria-label`), ≥44px, on-brand (shadow-led),
      with correct `type`/`autocomplete`/`inputMode`; phone is `type="tel"`.
- [ ] All errors reference the rose token by name (`var(--error)`; 409 wash = `var(--error-bg)`), are
      a `role="alert"` live region, and carry a non-color (icon) cue. No `red-500`/`red-600`/`red-200`/`border-red-*`
      and no raw `#C43D3D` literal in `Booker.tsx` (use the token).
- [ ] axe clean on the form (`label`, `color-contrast`, `button-name`).
- [ ] No submit/fetch/validation/state logic changed (visual + a11y attributes only).
- [ ] `pnpm build` exits 0; `pnpm lint` clean. All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- `pnpm build` → exit 0; `pnpm lint` → clean.
- `grep -n "red-500\|red-600\|red-200\|border-red\|#fff" src/components/Booker.tsx` → 0 matches.

#### [browser] Web Verification
Dev server + warm per `slate-ui-verification` §2 (`xbc=411`, port 3000).
- Walk the flow: `/book?xbc=411&theme=light` → click a day → click a slot → reach the form.
  Screenshot the form → `reports/screens/book-form-light-desktop.png` (and `…-dark-desktop.png`).
  Confirm labeled inputs, on-brand fields, sky+graphite CTA with arrow.
- Tab to the Confirm button; screenshot focus (graphite outline on light / sky on navy) →
  evidence for 4.4 too.
- Inject axe (`slate-ui-verification` §4 Option A) on the form view → save
  `reports/axe/book-form-light.axe.json`; assert 0 violations for `label`, `color-contrast`,
  `button-name`, `aria-*`.
- Error path: simulate a failed submit (or temporarily force the 409 copy) → screenshot the rose
  `role="alert"` error with icon.

### Cross-Surface Coherence
- The CTA + rose error styling here matches the conventions reused by 2.4 (confirmation CTA absent
  but copy/tone) and 2.5 (ManageBooking rose).

## Skills to Read

- `pennie-design-system-in-slate` — `.pn-btn--big --primary` (sky + graphite + arrow), DS field
  recipe, rose errors, 80/15/5, no white-on-sky, verb-phrase copy.
- `slate-ui-verification` — flow walk, axe injection (Option A), CTA contrast proof, screenshot
  naming, acceptance gate.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/booker-ux-patterns.md` — §3 form fields +
  primary CTA, §4 error/empty states, §6 copy.
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` — §1 graphite-on-sky
  PASS / white-on-sky + pressed-CTA FAIL, §5 labels/autocomplete/`role="alert"`, §7 targets.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at:
`~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md`

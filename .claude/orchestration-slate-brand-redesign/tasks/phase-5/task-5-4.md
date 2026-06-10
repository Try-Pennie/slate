# Task 5.4: Final Coherence + Sign-Off

## Objective

The final gate. Prove cross-surface **coherence** (every surface uses the same Pennie tokens,
type, and shapes — no drift), confirm **no stray non-token colors** remain anywhere in the repo
(grep the whole tree for `neutral-/emerald-/amber-/red-/green-/#hex` outside the token layer),
confirm **every DISCOVERY decision D1–D22 is satisfied**, consolidate the evidence from 5.1
(visual), 5.2 (a11y), and 5.3 (functional/build/deploy), and write the authoritative
`reports/final-verification.md` sign-off report. After this task, the redesign is either signed
off as DONE against D21 or has a clear, evidenced list of remaining failures.

## Context

5.1, 5.2, 5.3 each produced evidence and a per-area verdict. 5.4 is the synthesis: it reads all
that evidence, runs the repo-wide coherence/grep checks that only make sense once everything is
in place, walks the full D1–D22 decision list, and produces the single report a human reads to
decide "ship or not." This is the last task of Phase 5 and of the whole orchestration.

This is a **VERIFICATION task** (D5). You synthesize and grep; you do not edit app code. If a
coherence FAIL, stray-hex, or unmet-decision is found, record it in the report with the location
and the owning phase task; the redesign is marked NOT-DONE with a punch-list. Re-run the relevant
sub-checks after fixes land (the protocol allows iterate-until-green before final sign-off).

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Bash | Repo-wide grep for stray non-token colors; final `build`/`lint`/`test` re-run |
| Browser | Playwright MCP | Spot-check cross-surface coherence in the rendered app (both themes) |
| Files | Read/Write | Read all `reports/*` evidence; walk D1–D22; write `reports/final-verification.md` |

## Dependencies

- Tasks 5.1 (visual), 5.2 (a11y), 5.3 (functional/build/deploy) — all evidence + verdicts.
- All of Phases 1–4 (the redesign being signed off).

## Blocked By

- 5.3 (functional regression). 5.4 is the terminal task; it consumes 5.1/5.2/5.3 outputs.

## Research Findings

Key findings relevant to this task:

- From DISCOVERY.md D2: the EXPORTED Pennie Design System
  (`~/Documents/Pennie Branding/Pennie Design System/`) is the single source of truth — "Use CSS
  variables, never hex." This is the spec for the stray-hex grep.
- From DISCOVERY.md D8/D9: color rules (80/15/5 beige/navy/graphite, sky the ONLY action color,
  errors muted rose `#C43D3D`, blue text on light = `#486CCA`); shapes (buttons/cards 16px,
  bands 24px, chips 4px, pills for badges). Coherence = these applied identically everywhere.
- From DISCOVERY.md D21: "done" = every surface screenshotted both themes vs DS preview; AA+
  (axe/Lighthouse/contrast-script/reduced-motion); `build`/`lint`/`test` green; booking E2E;
  embed contract intact. 5.4 confirms the whole bar, citing 5.1/5.2/5.3 evidence.
- From `research/verification-toolchain-execution.md`: evidence lives under `reports/`
  (`screens/`, `axe/`, `lighthouse/`, `checklist.md`); the sign-off gates list is the D21
  operational checklist.
- From the Phase summaries (PHASES.md 2.1/3.2): the specific stray-color literals the redesign
  replaced — Booker `neutral-*`, emerald today/slot dots, `text-red-*`, admin `text-amber-600` /
  push-health / webhook pills. The grep must confirm these are gone (outside the token layer and
  the contrast script's documented literals).

## Execution Plan

### Step 1: Consolidate the evidence from 5.1/5.2/5.3

**Surface:** [file]

- [file] Read `reports/checklist.md` (filled by 5.1 visual + 5.2 a11y + 5.3 functional),
  `reports/axe/*.json`, `reports/lighthouse/*.report.json`, `reports/build.log`/`lint.log`/
  `test.log`, `reports/diff-review.md`, and `reports/functional-regression.md`.
- [file] Build a master status table: per surface → visual (5.1) / axe (5.2) / Lighthouse (5.2) /
  reduced-motion (5.2) / E2E (5.3) → overall PASS/FAIL/BLOCKED. Note any BLOCKED rows (e.g.
  `/me` + `/admin` if the auth session was never obtained) with the human-action needed.
- **S15: a BLOCKED surface stays BLOCKED in the overall verdict — never silently promoted to PASS
  by aggregation.** If `/admin`/`/me` could not be auth-resolved, their rows (and the D18/axe/
  Lighthouse cells for them) read BLOCKED with the exact unblock step; the overall sign-off is at
  most "DONE except BLOCKED: admin/me (auth)", not a clean PASS.

**Verification:**
- Master status table assembled; every surface has a consolidated verdict; BLOCKED items list
  their unblock action.

### Step 2: Repo-wide stray-color grep (no hex outside the token layer)

**Surface:** [code]

- [code] Grep the whole `src/` + `public/` tree for stray non-token colors. The token layer
  (`src/app/globals.css` and any `tokens.css`) is the ONLY place raw hex/rgb is allowed; the
  contrast script (`scripts/test-contrast.ts`) and widget.js modal chrome are documented
  exceptions (D15: widget.js can't read vars, so it uses literal Pennie values).
  ```bash
  cd /Users/danhankins-wright/Documents/Slate
  # Tailwind palette literals that the redesign was supposed to remove:
  rg -n "\b(neutral|emerald|amber|red|green|slate|gray|zinc|stone)-[0-9]{2,3}\b" \
     src public --glob '!**/*.css'
  # Raw hex in TS/TSX/JS (allowed only in widget.js chrome + currentColor SVGs + contrast script):
  rg -n "#[0-9a-fA-F]{3,8}\b" src --glob '!src/app/globals.css' --glob '!**/tokens.css' \
     --glob '!scripts/test-contrast.ts'
  ```
- [code] Triage every hit:
  - **Allowed**: token definitions in `globals.css`/`tokens.css`; the documented literals in
    `scripts/test-contrast.ts` (`#6dc5f7`, `#C43D3D`); `widget.js` modal-chrome literals
    (D15 — white/16px/`rgba(29,33,47,0.55)`/sky); the `check-badge` literal tick `#F9F6F0`
    (Task 1.4); `currentColor` in inline SVG icons (not a hex).
  - **FAIL**: any `neutral-/emerald-/amber-/red-/green-/slate-/gray-` Tailwind class on a styled
    surface; any raw hex in a `.tsx` that should use a token/`.pn-*` class.
- [file] Record the grep results + triage in the report. Any FAIL → location + owning task.

**Verification:**
- Grep run; every hit triaged; zero un-allowed stray colors (or a logged FAIL list).

### Step 3: Cross-surface coherence (rendered app, both themes)

**Surface:** [browser][file]

- [browser] On the live app (or from the 5.1 screenshots if the server is down), compare across
  Booker, login, admin, me, landing, manage, and the embed:
  - **Type**: PP Mori everywhere; headings 600, body 400; no synthesized bold; tabular numerals
    on times/dates/stats. (`browser_evaluate` `getComputedStyle(...).fontFamily` on a body
    element of each surface = PP Mori.)
  - **Color**: same semantic tokens drive the same roles everywhere (beige/white surfaces, navy
    bands, graphite text, sky the only CTA fill, muted-rose errors, `#486CCA` blue text on light)
    — no surface using a one-off color.
  - **Shape**: buttons/cards 16px radius, bands 24px, chips 4px, badges pill — consistent
    (`getComputedStyle(...).borderRadius` spot-checks).
  - **Theme parity**: light↔dark on each surface is a clean semantic-var flip, not an ad-hoc
    recolor; both match the corresponding DS `preview/*.html`.
- [file] Record coherence verdict per dimension (type / color / shape / theme parity) with any
  drift noted (surface + what differs).

**Verification:**
- Each coherence dimension PASS (or logged drift); computed-style spot-checks confirm PP Mori +
  16px radius + token colors across surfaces.

### Step 4: Walk the D1–D22 decision list

**Surface:** [file][browser][code]

- [file] Go through every DISCOVERY decision and mark satisfied / not / N-A with the evidence
  pointer. Key ones to verify explicitly (not just assert):
  - **D5** (no logic changed): cite `reports/diff-review.md` (5.3).
  - **D6/D7** (PP Mori 400+600, 700→600, `font-synthesis:none`, no Geist/OTF/Helvetica): grep +
    computed font checks.
  - **D8/D9** (color/shape rules): Step 3 coherence + Step 2 grep.
  - **D10/D11** (Booker beige-first default; internal pages both themes): 5.1 screenshots.
  - **D12** (marketing-rich login): 5.1 login screenshots.
  - **D14/D15** (embed brandColor default sky + override; cal.com contract; literal chrome; modal
    a11y; mobile full-screen): 5.1 embed + 5.3 contract verdict.
  - **D16** (confirmation delight: 3D graphic standalone / SVG puck embed; reduced-motion static):
    5.1 + 5.2 reduced-motion pair.
  - **D17** (contrast math): `scripts/test-contrast.ts` PASS (5.2) + focus screenshots.
  - **D18** (a11y: semantics, keyboard, focus, motion, targets, color-not-alone): 5.2 axe +
    manual checks. **S15: if the `/admin` + `/me` auth session was never resolved, their a11y is
    UNVERIFIED — record D18 for those two surfaces as BLOCKED (not PASS). A BLOCKED surface must
    NOT be aggregated into an overall D18 "PASS"; the sign-off carries the BLOCKED state forward
    with its unblock action.** Public surfaces with clean axe/Lighthouse can be D18-PASS independently.
  - **D21** (the "done" bar): the consolidated gate (Step 6).
  - **D22** (foundation-first order): satisfied by execution; note as met.
- [file] Tabulate D1–D22 → status → evidence pointer in the report.

**Verification:**
- All 22 decisions addressed with an evidence pointer; none left "unknown."

### Step 5: Final re-run of the code gate

**Surface:** [code]

- [code] Re-run `pnpm build && pnpm lint && pnpm test` one final time (after any fixes that
  landed during 5.x). Expect all green, contrast block `ALL PASSED`. This is the authoritative
  green-build snapshot for the sign-off. Save to `reports/final-build.log`.

**Verification:**
- All three green in the final run; contrast guard passes.

### Step 6: Write `reports/final-verification.md`

**Surface:** [file]

- [file] Write the authoritative sign-off report. Contents:
  1. **Verdict**: DONE / NOT-DONE (with punch-list) against the D21 bar.
  2. **D21 acceptance checklist** — each clause checked with evidence pointer:
     - [ ] Every surface screenshotted both themes vs DS `preview/*.html` (→ `reports/screens/`, 5.1)
     - [ ] axe 0 violations per surface/theme (→ `reports/axe/`, 5.2)
     - [ ] Lighthouse a11y ≥ 0.95 (→ `reports/lighthouse/`, 5.2)
     - [ ] `scripts/test-contrast.ts` PASS via `pnpm test` (5.2/5.3)
     - [ ] `pnpm build` + `lint` + `test` green (→ `reports/final-build.log`, 5.3/5.5)
     - [ ] Booking E2E standalone + embed (5.3)
     - [ ] Reduced-motion static (5.2)
     - [ ] cal.com drop-in contract intact (5.3)
     - [ ] No stray hex outside token layer (Step 2)
     - [ ] No logic changed — diff review (→ `reports/diff-review.md`, 5.3)
  3. **Master surface status table** (Step 1).
  4. **Cross-surface coherence verdict** (Step 3).
  5. **D1–D22 decision matrix** (Step 4).
  6. **Stray-color grep results** (Step 2).
  7. **Open items / BLOCKED** — anything needing human action (e.g. `/me`+`/admin` if auth was
     never resolved; user decision on tracking `reports/`); with the exact unblock step.
  8. **Evidence index** — paths to all `reports/` artifacts.
- [file] If any clause fails, mark the report NOT-DONE, list the punch-list with owning tasks,
  and (per the final-phase protocol) loop: trigger the fix, re-run the failed sub-check, update
  the report — until green or a hard human-action blocker remains.

**Verification:**
- `reports/final-verification.md` exists with all eight sections; verdict explicit; every D21
  clause has an evidence pointer; punch-list (if any) names owning tasks.

## Artifacts to Create

- `reports/final-verification.md` — the authoritative sign-off report — [file]
- `reports/final-build.log` — final green-build snapshot — [code]

## Artifacts to Modify

- `reports/checklist.md` — final consolidated verdicts if any rows changed after fixes — [file]
- (Do NOT modify app code. FAILs are punch-listed to owning tasks, not patched here.)

## Contracts

### Provides (for downstream tasks)

- `reports/final-verification.md`: the project's terminal deliverable — the human ship/no-ship
  decision artifact. No downstream task in this orchestration.

### Consumes (from upstream tasks)

- 5.1: `reports/screens/*`, visual checklist verdicts, DS-preview parity.
- 5.2: `reports/axe/*`, `reports/lighthouse/*`, focus + reduced-motion evidence, contrast-guard PASS.
- 5.3: `reports/diff-review.md`, build/lint/test logs, E2E + cal-contract + deployability verdicts.
- Phases 1–4: the redesigned surfaces being signed off.

## Acceptance Criteria

- [ ] Evidence from 5.1/5.2/5.3 consolidated into a master surface status table.
- [ ] Repo-wide stray-color grep run; every hit triaged; zero un-allowed stray colors (or logged
      punch-list with locations).
- [ ] Cross-surface coherence verified (type / color / shape / theme parity) across all surfaces,
      both themes; computed-style spot-checks confirm PP Mori + 16px radius + token colors.
- [ ] D1–D22 decision matrix completed with an evidence pointer per decision; none "unknown."
- [ ] S15: any unresolved `/admin`+`/me` auth gate is reported as BLOCKED (D18 + their rows), NOT
      aggregated into a PASS; the verdict reflects the BLOCKED state with its unblock action.
- [ ] Final `pnpm build` + `lint` + `test` green (contrast `ALL PASSED`); log saved.
- [ ] `reports/final-verification.md` written with all eight sections + explicit DONE/NOT-DONE
      verdict + D21 checklist + evidence index + any human-action punch-list.
- [ ] If NOT-DONE: punch-list names owning tasks and the loop ran until green or a hard
      human-action blocker remains.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- Stray-color grep (Step 2) → zero un-allowed hits.
- `pnpm build && pnpm lint && pnpm test` → all exit 0, contrast `ALL PASSED`.

#### [browser] Web Verification
- Spot-check 3–4 surfaces in both themes; `getComputedStyle` confirms PP Mori font-family,
  16px button/card radius, token-driven colors — consistent across surfaces.

#### [file] File Verification
- Read every `reports/*` artifact referenced; confirm they exist and contain the cited evidence.
- `reports/final-verification.md` parses as well-formed markdown with all eight sections and the
  D21 checklist + D1–D22 matrix.

### Cross-Surface Coherence
- This task IS the cross-surface coherence check: confirm the same tokens/type/shapes render
  identically across Booker, login, admin, me, landing, manage, embed — both themes — and that
  the single token source (`globals.css`) is what the contrast script (5.2), axe (5.2), and the
  grep (Step 2) all reference. Any divergence = coherence FAIL logged with the surface + dimension.
- Confirm the booking flow (5.3) and the visuals (5.1) describe the same working surfaces — the
  redesign sits on intact logic (5.3 diff review).

## Skills to Read

- `slate-ui-verification` — the acceptance gate (§10, the D21 "done" list this report formalizes)
  and the surface matrix (§1) for the coherence walk.
- `pennie-design-system-in-slate` — the canonical token/type/shape/color rules (D8/D9) that the
  coherence and stray-color checks enforce.
- `slate-embed-contract` — to confirm the documented widget.js literal-chrome exception when
  triaging the stray-hex grep.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` — the full D1–D22 decision list this
  task walks, and D21 (the "done" bar) it formalizes.
- `.claude/orchestration-slate-brand-redesign/research/verification-toolchain-execution.md` —
  the sign-off gate list and `reports/` evidence layout.
- `.claude/orchestration-slate-brand-redesign/PHASES.md` — the specific stray-color literals the
  redesign replaced (Booker `neutral-*`/emerald/`red-`, admin `amber-`/pills), so the grep knows
  what "gone" looks like.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at:
~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

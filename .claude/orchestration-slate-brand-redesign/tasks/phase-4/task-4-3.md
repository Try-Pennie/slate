# Task 4.3: Commit the contrast guard (`scripts/test-contrast.ts`)

## Objective

Add a node-native, browser-free `scripts/test-contrast.ts` that reads the **real** ported Pennie tokens out of the Slate CSS, implements the WCAG 2.x relative-luminance contrast formula, and asserts the D17 pairings (passes that must stay ≥4.5:1 / ≥3:1, plus the known-forbidden pairings that must stay failing as regression tripwires). It runs as part of `pnpm test` via the existing `scripts/test-*.ts` glob, so a future token edit that silently breaks AA fails CI. This is the one a11y check that lives in `pnpm test` (Cloudflare-safe, no browser, no new dependency).

## Context

Phase 4 task that locks the accessibility math in place permanently. The contrast script can be committed as soon as the Foundation tokens exist (it gates on Task 1.2, not on the embed work), and it is the earliest, cheapest a11y guard. It encodes DISCOVERY D17 (the verified contrast math) so that any later token change can't quietly regress the palette. It follows the established Slate test convention (`scripts/test-copy.ts`, `scripts/test-roles.ts`): a header comment, `fail()`/`ok()` counters, `process.exit(failures === 0 ? 0 : 1)`, run via `node --experimental-strip-types`.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Files / Code | Read / Write / Bash | Locate the ported token file, write `scripts/test-contrast.ts`, run `pnpm test` |

## Dependencies

- 1.2 (token layer ported into Slate) — the script reads the resolved hex/rgb from the ported tokens.

## Blocked By

- 1.2

## Research Findings

Key findings from research and DISCOVERY relevant to this task:

- From `research/verification-toolchain-execution.md` §5 — this is the spec for the script. Read the real token values, do not hardcode a parallel copy that can drift. Tokens live as `rgb(...)` in the DS `colors_and_type.css` and are ported into Slate during Foundation (likely `src/app/globals.css`). The script parses the **Slate** token file (post-Foundation), resolving one+ levels of `var()` aliasing. It `throw`s on "token not found" so a wrong path fails loudly. A full reference implementation is given in that research file §5 (luminance formula, `resolve()`, `atLeast()`/`below()` helpers, all assertions) — use it as the basis; adapt the `readFileSync` path to wherever Foundation actually wrote the tokens.
- From DISCOVERY D17 (the assertions this script encodes):
  - **PASS ≥4.5:1 (text):** graphite `#343434` on sky `#82D0FF` (7.36), graphite on hover-sky `#6dc5f7` (6.51), graphite on beige `#F9F6F0` (11.54), graphite on white (12.45), white on navy `#1D212F` (16.02), beige on navy (14.85), muted `#6A6A70` on beige (4.98 — thin pass guard), rose `#C43D3D` on beige (4.77), blue `#486CCA` on beige (4.56) and on white (4.91).
  - **PASS ≥3:1 (focus lines, 1.4.11):** graphite on beige (light-theme focus line), sky on navy (dark-theme focus line).
  - **FORBIDDEN-as-text tripwires (must stay <4.5:1):** graphite on sky-deep `#439FE1` (4.32 — must NOT be used as a CTA fill under graphite), sky as text on beige (1.57), white text on sky (1.69). If a token edit accidentally pushes one of these ≥4.5, the script must FAIL, signalling the palette shifted unexpectedly.
- From DISCOVERY D17 notes: error rose `#C43D3D` and `--accent-hover #6dc5f7` are literal in the DS. **S1/S4: Task 1.2 now tokenizes both — `--error` (= `--pennie-rose` = `rgb(196,61,61)`) and `--accent-hover` (reconciled to `#6dc5f7`, 6.51:1 under graphite) — and lists them in its Token-name contract. So this guard MUST read them via the token resolver `r("--error")` / `r("--accent-hover")`, NOT the `HEX()` literal fallback.** Confirm by reading the ported file (Step 1); if for some reason a name is missing, the `throw`-on-missing guard surfaces the drift loudly (do not silently fall back to a hardcoded hex that could mask a token regression).
- From `slate-ui-verification` skill: "The ONE a11y check in `pnpm test` is `scripts/test-contrast.ts` — node-native, no browser, reads the real token hex and asserts the D17 pairings."
- From `research/verification-toolchain-execution.md` Pitfalls: the contrast script must read the file Foundation actually writes — if tokens land in a separate `tokens.css` (not `globals.css`), update the `readFileSync` path or the guard silently passes against the wrong/empty map.

## Execution Plan

### Step 1: Locate the ported tokens and confirm the real values/aliases

**Surface:** [file]

- [file] Read `src/app/globals.css` (the Foundation target from Task 1.2). Confirm the `--pennie-*` raw tokens and semantic aliases are present as `rgb(...)` / `#hex` / `var(--…)`. If Foundation split tokens into a separate file (e.g. `src/app/tokens.css`) imported by `globals.css`, note the actual path — the script must read the file that holds the literals (read both and merge maps if needed).
- [file] Confirm the token names present (`--pennie-graphite`, `--pennie-sky`, `--pennie-sky-deep`, `--pennie-beige`, `--pennie-white`, `--pennie-navy`, `--pennie-muted`, `--pennie-blue`) and that `--accent-hover` (`#6dc5f7`) and `--error` (the rose, `rgb(196,61,61)`) ARE tokenized — Task 1.2's Token-name contract guarantees this (S1/S4). Use `grep` to enumerate: `grep -nE "^\s*--pennie-|--accent|--error|--focus" src/app/globals.css`. (If `--error`/`--accent-hover` are missing, that's a 1.2 regression — hand back, don't paper over with a literal.)

**Verification:**
- [file] You have the exact file path the script must read and the exact token names (or confirmed they are literals) for each color in the D17 assertion list.

### Step 2: Write `scripts/test-contrast.ts`

**Surface:** [code]

- [code] Create `scripts/test-contrast.ts` matching the Slate test style (header comment with `Run: node --experimental-strip-types scripts/test-contrast.ts`, `let failures = 0`, `fail()`/`ok()`, final `process.exit`). Base it on the reference in `research/verification-toolchain-execution.md` §5. Structure:
  - **Token parse + resolve:** `readFileSync` the token file (the path from Step 1); build a `Map<string,string>` from `(--name): (value);`; `resolve(name)` that follows `var(--other)` one+ levels and `throw`s on missing or cyclic tokens; `parseColor(v)` that handles `rgb()/rgba()` and `#rrggbb`.
  - **WCAG math:** `lin(c)` sRGB→linear, `luminance([r,g,b])`, `ratio(a,b)` = `(L1+0.05)/(L2+0.05)`.
  - **Helpers:** `atLeast(fg,bg,min,label)` and `below(fg,bg,max,label)`; `r(name)` = `resolve`; `HEX(h)` = `parseColor` for any value that is a DS literal not tokenized.
  - **Assertions (D17):**
    - `atLeast(graphite, sky, 4.5, "PRIMARY CTA graphite-on-sky")`
    - `atLeast(graphite, skyHover, 4.5, "CTA label on hover sky")`
    - `atLeast(graphite, beige, 4.5, "body graphite-on-beige")`
    - `atLeast(graphite, white, 4.5, "graphite-on-white")`
    - `atLeast(white, navy, 4.5, "white-on-navy band")`
    - `atLeast(beige, navy, 4.5, "beige-on-navy (fg-on-ink)")`
    - `atLeast(muted, beige, 4.5, "muted-on-beige (thin pass guard)")`
    - `atLeast(rose, beige, 4.5, "error rose-on-beige")`
    - `atLeast(blue, beige, 4.5, "blue text-on-beige")`
    - `atLeast(blue, white, 4.5, "blue text-on-white")`
    - `atLeast(graphite, beige, 3, "focus line graphite-on-beige (light)")`
    - `atLeast(sky, navy, 3, "focus line sky-on-navy (dark)")`
    - `below(graphite, skyDeep, 4.5, "graphite-on-sky-deep — must NOT be a CTA text bg")`
    - `below(sky, beige, 4.5, "sky as text on beige — forbidden")`
    - `below(white, sky, 4.5, "white text on sky — forbidden")`
  - For `skyHover` (#6dc5f7) and `rose` (#C43D3D): use `r("--accent-hover")` / `r("--error")` — Task 1.2 tokenizes both (S1/S4), so read by name, not via `HEX()`. (The `HEX()` fallback only applies if Step 1 unexpectedly finds them missing — in which case the `throw`-on-missing is the correct loud failure.)
- [code] Do NOT add any dependency. Pure node built-ins (`node:fs`, `node:path`) only. Match the existing 2-space style and the test-script header convention.

**Verification:**
- [code] Re-read the file: all 15 assertions present; reads the correct token path; no external imports.

### Step 3: Run the script directly and via `pnpm test`

**Surface:** [code]

- [code] Run standalone: `cd /Users/danhankins-wright/Documents/Slate && node --experimental-strip-types scripts/test-contrast.ts`. Expect exit 0 and `ALL PASSED`, with each pairing printed `ok: ... = X.XX:1`. Confirm the printed ratios match D17 (e.g. graphite-on-sky ≈ 7.36, muted-on-beige ≈ 4.98).
- [code] Run the full suite: `pnpm test`. The glob `for f in scripts/test-*.ts` auto-discovers the new file; confirm it runs (`# scripts/test-contrast.ts`) and the whole suite stays green.

**Verification:**
- [code] `node --experimental-strip-types scripts/test-contrast.ts` exits 0; `pnpm test` runs the new script and stays green.

### Step 4: Prove the tripwire — deliberately break a token, confirm FAIL, then revert

**Surface:** [code]

- [code] Temporarily edit one token in the ported CSS to break a pairing (e.g. lighten `--pennie-muted` toward white, or change `--pennie-graphite` to a lighter gray). Run `node --experimental-strip-types scripts/test-contrast.ts` and confirm it now reports `FAIL:` for the affected pairing and exits non-zero.
- [code] Also confirm a forbidden tripwire fires: temporarily change a forbidden pairing to accidentally pass (e.g. darken `--pennie-sky` enough that sky-on-beige ≥4.5) and confirm the `below(...)` assertion FAILS.
- [code] **Revert** both temporary edits (`git checkout -- <token file>` or undo the Edit) so the tokens are back to the shipped D17 values. Re-run to confirm green again.

**Verification:**
- [code] The script fails on a broken token and on an accidentally-fixed forbidden pairing; after revert, `pnpm test` is green again. Confirm `git status` shows only the new `scripts/test-contrast.ts` (no leftover token edits).

## Artifacts to Create

- `scripts/test-contrast.ts` - node-native WCAG contrast guard asserting the D17 pairings; auto-discovered by `pnpm test` - [code]

## Artifacts to Modify

- None (the `test` script glob already discovers `scripts/test-*.ts`; do not edit `package.json`).

## Contracts

### Provides (for downstream tasks)

- A permanent CI contrast tripwire — relied on by 4.V, Phase 5 (5.2/5.3), and every future token edit. `pnpm test` now fails if a token change breaks an AA pairing or accidentally "fixes" a forbidden one.

### Consumes (from upstream tasks)

- 1.2: the ported Pennie tokens in the Slate CSS (`src/app/globals.css` or the Foundation token file) — the script reads the resolved values from there.

## Acceptance Criteria

- [ ] `scripts/test-contrast.ts` exists, is node-native (no external deps), and follows the Slate test-script convention.
- [ ] It reads the real ported tokens (resolving `var()` aliases) and `throw`s loudly if a token is missing (wrong-path guard).
- [ ] All 12 "must pass" assertions pass on the current tokens; all 3 forbidden-as-text tripwires correctly stay below threshold.
- [ ] `pnpm test` auto-discovers and runs it; the suite stays green.
- [ ] Deliberately breaking a token makes the script FAIL (verified, then reverted).
- [ ] No `package.json` edit needed; no stray token edits left in the working tree.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- Run: `node --experimental-strip-types scripts/test-contrast.ts` — exit 0, `ALL PASSED`, ratios match D17.
- Run: `pnpm test` — the suite (including the new script) is green.
- Run: `grep -cE "atLeast\(|below\(" scripts/test-contrast.ts` — confirm all 15 assertions present.
- Run: `grep -nE "import .* from \"(?!node:)" scripts/test-contrast.ts` (or visually confirm) — only `node:fs` / `node:path`, no external deps.
- Negative test: break a token → script FAILs non-zero; revert → green. Final `git status` shows only `scripts/test-contrast.ts` added.

#### [file] File Verification
- Read back `scripts/test-contrast.ts`: header comment with the `Run:` line; `fail()`/`ok()` counters; `resolve()` follows `var()` and throws on missing; `lin`/`luminance`/`ratio` implement the WCAG 2.x formula; `process.exit(failures === 0 ? 0 : 1)`.
- Confirm the `readFileSync` path points at the file Foundation actually wrote (verified in Step 1).

### Cross-Surface Coherence
- The token values the script reads are the same ones rendered in the browser (Phase 5 axe/contrast checks) — the script is the static mirror of the runtime contrast. If Foundation later moves tokens to a new file, the `throw`-on-missing guard surfaces the drift immediately.

## Skills to Read

- `slate-ui-verification` - establishes that `scripts/test-contrast.ts` is the single in-`pnpm test` a11y gate; the D17 pairing list and the read-real-tokens rule.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/verification-toolchain-execution.md` - §5 has the full reference implementation and the rationale (read-real-tokens, throw-on-missing, forbidden-as-text tripwires).
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` - §1 the exact computed ratios for every pairing (sanity-check the script's output against these).

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

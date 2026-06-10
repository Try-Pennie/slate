# Task 1.1: Vendor fonts + brand assets into the repo

## Objective

Get the licensed PP Mori web fonts and the Pennie brand assets (logos, confirmation graphic) into the Slate repo at their final paths, and delete the dead Slate-era assets. This is a pure file-copy/cleanup task — no code edits, no logic. It is the asset foundation every later Phase 1 task (fonts, icons, theming) and the Booker/internal restyles (Phases 2/3) build on.

## Context

Phase 1 (Foundation) ports the Pennie Design System into Slate so every later surface inherits the system. This is the very first task and has no dependencies. It only moves bytes into place: the two licensed woff2 weights, the logo SVGs, and the standalone-confirmation graphic. Tasks 1.3 (font loading), 1.4 (icons/app-icon), and Phases 2/3 (logos, delight graphic) consume the paths created here. **This is a visual-only redesign (DISCOVERY D5): do not touch any TS/logic.**

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Files | Bash (`cp`, `rm`, `ls`), Read | Copy 2 woff2 + 5 logo SVGs + 1 PNG into the repo; delete 2 dead assets; read back to verify |

## Dependencies

- None (first task in the phase)

## Blocked By

- None

## Research Findings

Key findings from `research/asset-pipeline-execution.md` (the canonical copy-map) and `research/pp-mori-font-loading.md`:

- **Fonts: ship ONLY the licensed woff2 kit, weights 400 + 600.** Source dir is `~/Documents/Pennie Branding/PP Mori Font/woff2 (licensed web kit)/`. It also contains `PPMori-Medium.woff2` (500) and `PPMori-Bold.woff2` (700) — **DO NOT COPY THESE** (no Medium per brand rule D6; 700 is aliased to 600 in code, not shipped as a file). Do NOT copy the design-system `.otf` files (Free-For-Personal-Use license, forbidden on web — D6).
- **Fonts must live under `src/` (not `public/`)** so `next/font/local`'s relative `src` resolves and Next self-hosts them at build → `_next/static/media`. Destination: `src/app/fonts/PPMori/`.
- **Logos are concrete-fill SVGs loaded via `<img>`** (no `currentColor` across an `<img>` boundary). Destination: `public/brand/`. Variants: `logo-pennie-charcoal.svg` (graphite, on light), `logo-pennie-cream.svg` (cream, on navy), the two `-lg-` footer variants, and `logo-mark.svg` (the "P" glyph for compact contexts).
- **Confirmation delight graphic (D16):** the standalone confirmation page uses the iridescent coins PNG. Source `assets/brand/graphics/pic-1.png` → dest `public/brand/pic-1-coins.png` (renamed for clarity). **`pic-3.png` (ribbon) is the documented ALTERNATE, intentionally NOT used by default** — copy it too as `public/brand/pic-3-ribbon.png` so the Phase 2 task (2.4) can swap coins↔ribbon if desired (DISCOVERY open item: coins vs ribbon, **default coins**). **S14: `pic-3-ribbon.png` being unreferenced is EXPECTED — it is the on-purpose alternate, not an orphan; verification sweeps should NOT flag it as a dead asset.**
- **Cleanup:** `public/slate-logo.png` (1.2 MB) is unused (confirmed by grep) and `src/app/icon.png` (290 KB) is superseded by the `icon.svg` that Task 1.4 adds. Both are dead weight on the Cloudflare asset upload — delete them. NOTE: `apple-icon.png` is NOT deleted here — Task 1.4 decides whether to replace or regenerate it.
- **No conversion / optimization tooling** — the kit is already woff2 and SVGs are clean. Do NOT install SVGO/SVGR/font converters (DISCOVERY scope constraint).

## Execution Plan

### Step 1: Create the destination directories

**Surface:** [file]

Create the two target dirs (idempotent):

```bash
mkdir -p /Users/danhankins-wright/Documents/Slate/src/app/fonts/PPMori
mkdir -p /Users/danhankins-wright/Documents/Slate/public/brand
```

**Verification:**
- `ls -d /Users/danhankins-wright/Documents/Slate/src/app/fonts/PPMori /Users/danhankins-wright/Documents/Slate/public/brand` returns both paths without error.

### Step 2: Copy the two licensed woff2 weights (400 + 600 only)

**Surface:** [file]

```bash
SRC="/Users/danhankins-wright/Documents/Pennie Branding/PP Mori Font/woff2 (licensed web kit)"
DST="/Users/danhankins-wright/Documents/Slate/src/app/fonts/PPMori"
cp "$SRC/PPMori-Regular.woff2"  "$DST/PPMori-Regular.woff2"
cp "$SRC/PPMori-SemiBold.woff2" "$DST/PPMori-SemiBold.woff2"
```

Do **NOT** copy `PPMori-Medium.woff2` or `PPMori-Bold.woff2`. Do NOT copy any `.otf`.

**Verification:**
- `ls -1 /Users/danhankins-wright/Documents/Slate/src/app/fonts/PPMori` lists EXACTLY two files: `PPMori-Regular.woff2`, `PPMori-SemiBold.woff2` (no Medium, no Bold, no otf).
- File sizes are non-zero and match source (Regular ~35.5 KB, SemiBold ~37.9 KB).

### Step 3: Copy the logo SVGs to `public/brand/`

**Surface:** [file]

```bash
ASSETS="/Users/danhankins-wright/Documents/Pennie Branding/Pennie Design System/assets"
DST="/Users/danhankins-wright/Documents/Slate/public/brand"
cp "$ASSETS/logo-pennie-charcoal.svg"    "$DST/"
cp "$ASSETS/logo-pennie-cream.svg"       "$DST/"
cp "$ASSETS/logo-pennie-lg-charcoal.svg" "$DST/"
cp "$ASSETS/logo-pennie-lg-cream.svg"    "$DST/"
cp "$ASSETS/logo-mark.svg"               "$DST/"
```

**Verification:**
- `ls -1 /Users/danhankins-wright/Documents/Slate/public/brand/*.svg` lists all five.
- `head -1` each is valid `<svg …>` markup (Read one to confirm: `logo-pennie-charcoal.svg` has a concrete graphite fill, not `currentColor`).

### Step 4: Copy the confirmation delight graphic(s)

**Surface:** [file]

```bash
GFX="/Users/danhankins-wright/Documents/Pennie Branding/Pennie Design System/assets/brand/graphics"
DST="/Users/danhankins-wright/Documents/Slate/public/brand"
cp "$GFX/pic-1.png" "$DST/pic-1-coins.png"      # default standalone confirmation (D16)
cp "$GFX/pic-3.png" "$DST/pic-3-ribbon.png"     # S14: documented ALTERNATE, intentionally unreferenced (not an orphan)
```

**Verification:**
- `ls -1 /Users/danhankins-wright/Documents/Slate/public/brand/pic-*.png` lists both PNGs, non-zero size.

### Step 5: Delete the dead Slate-era assets

**Surface:** [file]

First re-confirm nothing references them (defense in depth), then delete:

```bash
grep -rn "slate-logo" /Users/danhankins-wright/Documents/Slate/src /Users/danhankins-wright/Documents/Slate/public || echo "no slate-logo refs"
rm /Users/danhankins-wright/Documents/Slate/public/slate-logo.png
rm /Users/danhankins-wright/Documents/Slate/src/app/icon.png
```

Do NOT delete `src/app/apple-icon.png` in this task (Task 1.4 owns the app-icon decision). Do NOT delete `public/widget.js` or `public/embed-example.html`.

**Verification:**
- `ls public/slate-logo.png` and `ls src/app/icon.png` both return "No such file".
- Grep for `slate-logo.png` / `icon.png` across `src/` + `public/` returns no live `<img>`/`src`/URL reference (only the prior grep echo).

## Artifacts to Create

- `src/app/fonts/PPMori/PPMori-Regular.woff2` — PP Mori 400 - [file]
- `src/app/fonts/PPMori/PPMori-SemiBold.woff2` — PP Mori 600 (also 700-aliased in code) - [file]
- `public/brand/logo-pennie-charcoal.svg` — wordmark on light - [file]
- `public/brand/logo-pennie-cream.svg` — wordmark on navy - [file]
- `public/brand/logo-pennie-lg-charcoal.svg` — large footer wordmark on light - [file]
- `public/brand/logo-pennie-lg-cream.svg` — large footer wordmark on navy - [file]
- `public/brand/logo-mark.svg` — "P" mark for compact contexts (also source for Task 1.4 favicon) - [file]
- `public/brand/pic-1-coins.png` — standalone confirmation delight graphic (default) - [file]
- `public/brand/pic-3-ribbon.png` — documented ALTERNATE confirmation graphic (S14: intentionally unreferenced by default, not an orphan) - [file]

## Artifacts to Modify

- None (this task only copies and deletes)

## Artifacts to Delete

- `public/slate-logo.png` — unused 1.2 MB dead weight - [file]
- `src/app/icon.png` — superseded by `icon.svg` (added in Task 1.4) - [file]

## Contracts

### Provides (for downstream tasks)

- `src/app/fonts/PPMori/*.woff2`: the two woff2 source files — consumed by Task 1.3 (`next/font/local` `src` array).
- `public/brand/logo-*.svg`: concrete-fill wordmark/mark SVGs — consumed by Phase 2 (Booker header) and Phase 3 (login, admin/me shell, landing).
- `public/brand/logo-mark.svg`: the mark glyph — also the source markup Task 1.4 bakes a concrete fill into for `src/app/icon.svg`.
- `public/brand/pic-1-coins.png` (+ `pic-3-ribbon.png` alt): the standalone confirmation delight graphic — consumed by Phase 2 Task 2.4.

### Consumes (from upstream tasks)

- None.

## Acceptance Criteria

- [ ] Exactly two woff2 files under `src/app/fonts/PPMori/` (`PPMori-Regular.woff2`, `PPMori-SemiBold.woff2`); no Medium/Bold/otf present.
- [ ] Five logo SVGs present under `public/brand/`.
- [ ] `public/brand/pic-1-coins.png` present (and the documented alternate `pic-3-ribbon.png` — S14: its unreferenced state is expected, not an orphan).
- [ ] `public/slate-logo.png` and `src/app/icon.png` deleted; grep finds no live references to either.
- [ ] No build tooling added (no SVGO/SVGR/font-converter packages).
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [file] File Verification
- `ls -1 src/app/fonts/PPMori` → exactly the two expected woff2 files.
- `ls -1 public/brand` → the five SVGs plus the two PNGs.
- Read `public/brand/logo-pennie-charcoal.svg` → confirm valid SVG with a concrete fill (not `currentColor`).
- `ls src/app/icon.png public/slate-logo.png 2>&1` → both report "No such file or directory".
- `grep -rn "slate-logo.png\|icon.png" src public` → no live reference (a stray comment is acceptable; an `<img src>` / URL is a FAIL — escalate).
- `git status --short` → only the expected adds (`src/app/fonts/PPMori/…`, `public/brand/…`) and deletes (`public/slate-logo.png`, `src/app/icon.png`). No `.ts`/`.tsx`/`.css` modified.

### Cross-Surface Coherence
- Single surface (files only); no cross-surface handoff to check in this task. The handoff to Tasks 1.3/1.4 is the existence + exact paths of the copied files, verified above.

## Skills to Read

- `pennie-design-system-in-slate` — §6 Asset locations (the canonical destination table) and the font/licensing rules. Read before copying so you ship the right woff2 cut and put fonts under `src/`, logos under `public/brand/`.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/asset-pipeline-execution.md` — the full copy-map table (source → dest → usage) and the "do not copy" list.
- `.claude/orchestration-slate-brand-redesign/research/pp-mori-font-loading.md` — why only 400+600 from the licensed kit, and why fonts go under `src/`.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

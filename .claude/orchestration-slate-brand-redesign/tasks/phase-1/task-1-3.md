# Task 1.3: Load PP Mori via next/font/local

## Objective

Self-host PP Mori with `next/font/local` (weights 400 + 600, with 700 aliased to 600 and `font-synthesis: none`), expose it as the `--font-pp-mori` CSS variable, apply that variable to `<html>` in `layout.tsx`, remove the Geist imports, and confirm the design-system `--font-sans` token (set in Task 1.2) resolves to PP Mori so `.pn-*` classes, the Tailwind `font-sans` utility, and the body default all render in the brand typeface. **Code-only, visual foundation — no logic changes.**

## Context

Task 1.2 set `--font-sans` to `var(--font-pp-mori), …` but `--font-pp-mori` is not defined until this task wires up `next/font/local`. Task 1.1 vendored the two woff2 files into `src/app/fonts/PPMori/`. This task connects them: it creates the font-definition module, attaches the generated CSS variable to `<html>`, and drops Geist. After this, the whole app renders in PP Mori (headings 600, body 400, no synthesized bold). It is consumed by nothing further directly — it completes the typography foundation. **DISCOVERY D5: visual-only.**

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Write, Edit, Read, Bash (`pnpm build`) | Create `src/app/fonts/pp-mori.ts`; edit `layout.tsx`; confirm `globals.css` token wiring |
| Browser | Playwright MCP | Confirm computed `font-family` on body = PP Mori; headings 600, body 400; no Geist |

## Dependencies

- **Task 1.1** — the two woff2 files must exist at `src/app/fonts/PPMori/PPMori-Regular.woff2` and `PPMori-SemiBold.woff2` (the `src` array references them by relative path).
- **Task 1.2** — `globals.css` must already set `--font-sans: var(--font-pp-mori), …` and map it in `@theme inline`.

## Blocked By

- 1.1, 1.2

## Research Findings

Key findings from `research/pp-mori-font-loading.md` and `research/tailwind-v4-token-mapping.md` (verified against the installed Next 16.2.7 docs):

- **`next/font/local` is a default export:** `import localFont from "next/font/local"`. `src` is an array of `{ path, weight, style }`; `path` is resolved relative to the file calling `localFont`. The module returns `{ className, style, variable }`.
- **Ship ONLY 400 + 600, alias 700→600** (DISCOVERY D6). A third `src` entry pointing the SemiBold file at `weight: "700"` makes any `font-weight: 700` / Tailwind `font-bold` render SemiBold. Next emits two `@font-face` blocks for the same hashed file — harmless, no double download. No Medium 500, no Bold-700-as-file, no Extralight, no italics (licensed kit lacks them and the `.pn-*` system only uses 400/600).
- **`font-synthesis: none`** belongs both as the global CSS rule (already in `globals.css` from Task 1.2) and, belt-and-suspenders, via the `declarations: [{ prop: "font-synthesis", value: "none" }]` option on the local font. Use both.
- **`variable: "--font-pp-mori"`** is the hook. `globals.css` `--font-sans` already chains to it. Do NOT also paste the DS `@font-face` block — `next/font/local` generates the `@font-face` rules itself (self-hosted, hashed, preloaded).
- **`display: "swap"`**, `fallback: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif']`. `adjustFontFallback` default (`'Arial'`) is fine — it auto-generates CLS-reducing metrics. Do NOT add `subsets` (that's google-only; ignored/invalid for local).
- **Remove Geist:** delete the `Geist`/`Geist_Mono` imports and the `geistSans`/`geistMono` `next/font/google` calls in `layout.tsx`, and remove their `.variable` from the `<html>` className. Confirm nothing relies on `font-mono` (grep) before relying on its removal — the research found no live `font-mono` usage; the `--font-mono` token was already removed in Task 1.2.
- **CF/OpenNext-safe:** `next/font/local` self-hosts at build time → `_next/static/media`; no runtime fetch. Same mechanism trypennie uses in prod.
- **Recommended module location:** `src/app/fonts/pp-mori.ts` (a "font definitions file" so the single instance is reused). Relative paths from there to the woff2: `./PPMori/PPMori-Regular.woff2` etc.

## Execution Plan

### Step 1: Confirm prerequisites exist

**Surface:** [code]

- `ls src/app/fonts/PPMori/` → exactly `PPMori-Regular.woff2` and `PPMori-SemiBold.woff2` (Task 1.1 output). If missing, STOP — 1.1 is incomplete.
- `grep -n "font-pp-mori\|--font-sans" src/app/globals.css` → confirm `--font-sans: var(--font-pp-mori), …` is present (Task 1.2 output). If missing, STOP — 1.2 is incomplete.

**Verification:**
- Both prerequisites confirmed.

### Step 2: Create the font-definition module

**Surface:** [code]

Write `src/app/fonts/pp-mori.ts`:
```ts
import localFont from "next/font/local";

export const ppMori = localFont({
  src: [
    { path: "./PPMori/PPMori-Regular.woff2", weight: "400", style: "normal" },
    { path: "./PPMori/PPMori-SemiBold.woff2", weight: "600", style: "normal" },
    // Alias 700 -> SemiBold so font-bold / font-weight:700 render SemiBold (matches the DS).
    { path: "./PPMori/PPMori-SemiBold.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-pp-mori",
  fallback: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "system-ui", "sans-serif"],
  declarations: [{ prop: "font-synthesis", value: "none" }],
});
```
(`path` is relative to this file; the woff2 live in the sibling `PPMori/` dir.)

**Verification:**
- File written; the `src` array has exactly three entries (400, 600, 700-alias), `variable` is `--font-pp-mori`.

### Step 3: Wire the variable into layout.tsx and remove Geist

**Surface:** [code]

Read `src/app/layout.tsx`, then edit it to:
- Remove `import { Geist, Geist_Mono } from "next/font/google";` and the `geistSans`/`geistMono` declarations.
- Add `import { ppMori } from "./fonts/pp-mori";`.
- Change the `<html>` className from `` `${geistSans.variable} ${geistMono.variable} h-full antialiased` `` to `` `${ppMori.variable} h-full antialiased` ``.
- Keep `lang="en"`, `metadata`, the body, and structure as-is. (Do NOT add `data-theme`/`suppressHydrationWarning` here — that is Task 1.5's job; this task only swaps the font.)

Resulting file shape:
```tsx
import type { Metadata } from "next";
import { ppMori } from "./fonts/pp-mori";
import "./globals.css";

export const metadata: Metadata = {
  title: "Slate",
  description: "Scheduling and booking for Pennie.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${ppMori.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
```

**Verification:**
- No `Geist`/`Geist_Mono`/`next/font/google` references remain in `layout.tsx`; `ppMori.variable` is on `<html>`.

### Step 4: Build

**Surface:** [code]

```bash
cd /Users/danhankins-wright/Documents/Slate && pnpm build
```
Expect exit 0, fonts emitted to `.next/static/media`. Watch for any "missing font file" / path-resolution error (would indicate a wrong relative path in Step 2) or an edge-runtime warning (none expected; local fonts are build-time).

**Verification:**
- `pnpm build` exits 0. Optionally `find .next/static/media -name '*.woff2'` shows the two PP Mori hashes emitted.

### Step 5: Browser font verification

**Surface:** [browser]

Start `pnpm dev` (background), warm and navigate to `/book?xbc=411&theme=light` (or `/`). Via `browser_evaluate`:
```js
() => {
  const bodyFont = getComputedStyle(document.body).fontFamily;
  const h = document.querySelector('h1, .pn-h1, .pn-display, h2');
  const heading = h ? { weight: getComputedStyle(h).fontWeight, family: getComputedStyle(h).fontFamily } : null;
  return { bodyFont, heading };
}
```
Expect `bodyFont` to begin with the hashed `__ppMori`/`PP Mori`-style family name from `next/font` (NOT `Geist`, NOT `Arial`). Heading weight resolves to `600` (since `--fw-bold` aliases to 600). Take a screenshot of a heading + body paragraph as light evidence (full both-theme sweep is 1.V).

**Verification:**
- Computed body `font-family` is the PP Mori (next/font) family, not Geist/Arial. Heading weight 600, body 400. No synthesized faux-bold visible.

## Artifacts to Create

- `src/app/fonts/pp-mori.ts` — `next/font/local` definition (400 + 600 + 700-alias, `--font-pp-mori`, `font-synthesis:none`) - [code]

## Artifacts to Modify

- `src/app/layout.tsx` — remove Geist imports/decls; import `ppMori`; put `ppMori.variable` on `<html>` - [code]

## Contracts

### Provides (for downstream tasks)

- `--font-pp-mori` CSS variable on `<html>` — the value `globals.css` `--font-sans` (Task 1.2) chains to. After this, `.pn-*`, `font-sans` utility, and body default all render PP Mori for every later surface.

### Consumes (from upstream tasks)

- Task 1.1: `src/app/fonts/PPMori/PPMori-Regular.woff2` + `PPMori-SemiBold.woff2` (referenced by the `src` array).
- Task 1.2: `globals.css` `--font-sans: var(--font-pp-mori), …` + its `@theme inline` mapping (the consumer of `--font-pp-mori`).

## Acceptance Criteria

- [ ] `src/app/fonts/pp-mori.ts` exists with 400 + 600 + 700-alias and `font-synthesis: none`.
- [ ] `layout.tsx` applies `ppMori.variable`; no Geist/`next/font/google` imports remain.
- [ ] App renders in PP Mori (body 400, headings 600); no synthesized bold; no Geist anywhere.
- [ ] `pnpm build` exits 0; fonts emit to `.next/static/media`.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- `cd /Users/danhankins-wright/Documents/Slate && pnpm build` → exit 0.
- `grep -rn "Geist\|next/font/google\|--font-geist" src/app` → no matches.
- Read `src/app/fonts/pp-mori.ts` → three `src` entries, `variable: "--font-pp-mori"`, `declarations` present.

#### [browser] Web Verification
- Navigate `/book?xbc=411&theme=light` (warm first). `browser_evaluate` the font snippet (Step 5): body family = PP Mori (next/font hash), not Geist/Arial; heading weight 600.
- Screenshot a heading+body block for evidence.

### Cross-Surface Coherence
- The `variable` name in `pp-mori.ts` (`--font-pp-mori`) must exactly match the name `globals.css` references in `--font-sans` (Task 1.2 handoff). Confirm both spellings identical.

## Skills to Read

- `pennie-design-system-in-slate` — §3 Fonts (licensed woff2 only, 400+600, 700→600 alias, `font-synthesis:none`, "don't paste the DS `@font-face` block", the `pp-mori.ts` + `layout.tsx` + `globals.css` wiring).

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/pp-mori-font-loading.md` — the `next/font/local` API details, the 700→600 alias snippet, the layout.tsx swap, the Tailwind `@theme` wiring, and the licensing rationale.
- `.claude/orchestration-slate-brand-redesign/research/tailwind-v4-font.md` section of `tailwind-v4-token-mapping.md` — the `--font-sans` → `var(--font-pp-mori)` mapping confirmation.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

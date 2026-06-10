# Task 1.5: Theme infrastructure (data-theme, no-flash script, toggle island)

## Objective

Establish the app-wide light/dark mechanism: default `data-theme="light"` on `<html>`, an inline no-flash `<head>` script that reads a persisted choice from `localStorage` before first paint (with `suppressHydrationWarning` on `<html>`), and a small client theme-toggle island that internal pages will mount in Phase 3. After this, toggling `data-theme` flips the semantic tokens (from Task 1.2) with no FOUC and SSR-safe hydration. **Code-only, visual foundation — no logic changes.**

## Context

Phase 1 foundation. Depends on Task 1.2, which defined the `[data-theme="dark"]` semantic-flip rule and `@custom-variant dark`. This task adds the *mechanism* that sets `data-theme`. DISCOVERY (D19, and the `pennie-design-system-in-slate` skill §2) mandates `data-theme` + `@custom-variant dark` rather than the OS `prefers-color-scheme` media query, because the Booker must default to light regardless of OS, the embed needs per-widget theming, and internal pages want a user toggle. The toggle island and no-flash pattern are consumed by Phase 2 (Booker reconciles its `theme` prop with `data-theme`, Task 2.1) and Phase 3 (internal pages mount the toggle, Tasks 3.1/3.3). **DISCOVERY D5: visual-only — do not touch auth, server actions, or booking logic.**

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Write, Edit, Read, Bash (`pnpm build`) | Set default `data-theme` + no-flash script + `suppressHydrationWarning` in `layout.tsx`; create the toggle island component |
| Browser | Playwright MCP | Toggle theme → colors flip; reload → persisted; confirm no flash |

## Dependencies

- **Task 1.2** — `globals.css` must define the `[data-theme="dark"]` semantic flip and `@custom-variant dark` (the CSS this mechanism drives).
- (Soft) **Task 1.3** — `layout.tsx` is also edited there to add the font variable; whichever runs first, the other edits the same `<html>` tag. They are compatible: 1.3 adds `ppMori.variable` to the className; 1.5 adds `data-theme="light"` + `suppressHydrationWarning` + the no-flash `<script>`. If 1.3 has not run, preserve its expected className shape.

## Blocked By

- 1.2

## Research Findings

Key findings from `research/tailwind-v4-token-mapping.md` and the `pennie-design-system-in-slate` skill §2 (verified against the installed Next 16.2.7 doc `01-app/02-guides/preventing-flash-before-hydration.md`):

- **Theming = `data-theme` attribute + `@custom-variant dark`, NOT OS media query** (DISCOVERY D19). Task 1.2 already added the CSS side; this task adds the attribute-setting mechanism.
- **No-flash pattern (Next 16, documented):** an inline `<script>` in `<head>` that sets `data-theme` on `document.documentElement` from `localStorage` **before first paint**, plus `suppressHydrationWarning` on `<html>` (because the server renders `light` but the script may set `dark` before React hydrates — without `suppressHydrationWarning` React logs a mismatch). The script must be inline (not a module/deferred) so it runs synchronously before paint.
- **Default is light** (DISCOVERY D10 — Booker is beige-first; D11 — internal pages support both). So `<html data-theme="light">` is the SSR default; the script only overrides to `dark` if the user previously chose it.
- **Scope caveat:** internal pages persist a choice at the document level (`<html>`). The **Booker/embed sets `data-theme` on its OWN root wrapper** from its `theme` prop (Phase 2, Task 2.1) so the embed iframe theme is independent of any host — do NOT force the embed's theme from this document-level localStorage. This task's localStorage mechanism is for the internal app surfaces; the Booker reconciliation is Phase 2's job. Keep the script's effect limited to setting the `<html>` attribute from storage; it will not fight the Booker because the Booker scopes `data-theme` on its own subtree (a nested `[data-theme]` wins for its subtree).
- **The toggle is a small client island** (`"use client"`) used by internal pages in Phase 3 — build it now, mounted later. It reads/writes the same `localStorage` key and sets `document.documentElement.dataset.theme`, keeping the key name consistent with the no-flash script.

## Execution Plan

### Step 1: Read current layout + confirm CSS prerequisite

**Surface:** [code]

- Read `src/app/layout.tsx` (note whether Task 1.3 has already swapped Geist→`ppMori`; preserve whatever font variable is on `<html>`).
- `grep -n "data-theme\|@custom-variant" src/app/globals.css` → confirm Task 1.2's dark scope + variant exist. If absent, STOP — 1.2 incomplete.

**Verification:**
- Prerequisite CSS confirmed; current `layout.tsx` shape known.

### Step 2: Add default `data-theme`, `suppressHydrationWarning`, and the no-flash script

**Surface:** [code]

Edit `src/app/layout.tsx`:
- Add `data-theme="light"` and `suppressHydrationWarning` to the `<html>` element (alongside `lang="en"` and the existing className).
- Add an inline no-flash `<script>` as the first child of `<head>` (App Router: render a `<head>` in the layout or use the documented approach of placing the script before `{children}` in `<body>` — prefer a `<head>` with the inline script for earliest execution). Use `dangerouslySetInnerHTML` with a minimal IIFE:
```tsx
<head>
  <script
    dangerouslySetInnerHTML={{
      __html: `(function(){try{var t=localStorage.getItem('slate-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`,
    }}
  />
</head>
```
Use the storage key `slate-theme` (keep it identical in the toggle island, Step 3). The script only honors a stored `light`/`dark`; absent/invalid → leaves the SSR default `light`. Do NOT read `prefers-color-scheme` here (DISCOVERY rejects OS-driven theming as the source of truth).

Resulting `<html>` opening tag shape (preserving the font var from 1.3):
```tsx
<html lang="en" data-theme="light" suppressHydrationWarning className={`${ppMori.variable} h-full antialiased`}>
```

**Verification:**
- `layout.tsx` has `data-theme="light"`, `suppressHydrationWarning`, and the inline `<head>` script with the `slate-theme` key. No OS media query read.

### Step 3: Build the theme-toggle island

**Surface:** [code]

Create `src/components/ThemeToggle.tsx` (client component). It must:
- Be `"use client"`.
- On mount, read the current theme from `document.documentElement.dataset.theme` (the source of truth set by the no-flash script / SSR default) into state — read it in a `useEffect` to stay SSR-safe (avoid reading `document` during render).
- Render a button that toggles `light`↔`dark`: set `document.documentElement.dataset.theme = next`, persist `localStorage.setItem('slate-theme', next)`, update state.
- Be accessible: a real `<button>` with an `aria-label` like `"Switch to dark theme"` / `"Switch to light theme"` reflecting the next state, and `aria-pressed` optional. Use a Pennie token-styled appearance (e.g. `.pn-btn .pn-btn--small .pn-btn--additional` or token utilities) — but keep it minimal; Phase 3 places it in the header. You may use an icon from Task 1.4 if a suitable one exists, otherwise a text label ("Light"/"Dark") is fine for now.
- TypeScript, no `any`.

```tsx
"use client";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    if (t === "dark" || t === "light") setTheme(t);
  }, []);
  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("slate-theme", next); } catch {}
    setTheme(next);
  }
  return (
    <button type="button" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} className="pn-btn pn-btn--small pn-btn--additional">
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
```

**Verification:**
- Component compiles; uses the `slate-theme` key; SSR-safe (no `document` access during render); accessible button with `aria-label`.

### Step 4: Build

**Surface:** [code]

```bash
cd /Users/danhankins-wright/Documents/Slate && pnpm build
```
Expect exit 0, no hydration-mismatch warnings in the build output.

**Verification:**
- `pnpm build` exits 0.

### Step 5: Browser verification — flip, persist, no-flash

**Surface:** [browser]

Start `pnpm dev` (background), warm `/` (or `/book?xbc=411`). Since no internal page mounts `ThemeToggle` until Phase 3, verify the mechanism directly:
1. Navigate to `/`. `browser_evaluate` returns `document.documentElement.dataset.theme` → `"light"`. Screenshot (light).
2. Simulate a persisted dark choice + reload to prove no-flash: `browser_evaluate` `() => { localStorage.setItem('slate-theme','dark'); return true; }`, then `browser_navigate` to `/` again (full reload). `browser_evaluate` `document.documentElement.dataset.theme` → `"dark"` and `getComputedStyle(document.body).backgroundColor` resolves to navy `rgb(29, 33, 47)`. Screenshot (dark) — the page should already be dark on first paint (no white→dark flash), which the inline `<head>` script guarantees.
3. Clean up: `browser_evaluate` `() => { localStorage.removeItem('slate-theme'); return true; }`.

(Optionally, to exercise the toggle component itself, you can temporarily render it — but that is not required for Phase 1; Phase 3 mounts it. The mechanism proof above is sufficient.)

**Verification:**
- Default `data-theme="light"`; after persisting `dark` and reloading, the document is dark on first paint (no flash), bg = navy. No React hydration-mismatch error in the console. Toggling the attribute flips the semantic vars (bg/fg) per Task 1.2.

## Artifacts to Create

- `src/components/ThemeToggle.tsx` — client theme-toggle island (used by Phase 3 internal pages) - [code]

## Artifacts to Modify

- `src/app/layout.tsx` — add `data-theme="light"` + `suppressHydrationWarning` to `<html>`; add the inline no-flash `<head>` script (key `slate-theme`) - [code]

## Contracts

### Provides (for downstream tasks)

- Default `data-theme="light"` on `<html>` + the no-flash script + `suppressHydrationWarning` — the document-level theme mechanism consumed by Phase 3 internal pages.
- `src/components/ThemeToggle.tsx` — the toggle island mounted by Task 3.1 (app shell / header) and Task 3.3 (me).
- The `slate-theme` localStorage key convention — used by both the script and the toggle (and any future persistence).
- A confirmed, working `data-theme` flip — Task 2.1 reconciles the Booker's `theme` prop with `data-theme` on the Booker's own root wrapper, relying on this mechanism's nested-scope behavior.

### Consumes (from upstream tasks)

- Task 1.2: the `[data-theme="dark"]` semantic-flip rule + `@custom-variant dark` in `globals.css` (the CSS this mechanism toggles).
- Task 1.3 (soft): the `ppMori.variable` className on `<html>` (preserve it when editing the tag).

## Acceptance Criteria

- [ ] `<html>` defaults to `data-theme="light"` with `suppressHydrationWarning`.
- [ ] Inline no-flash `<head>` script sets `data-theme` from `localStorage` (`slate-theme`) before paint; no OS media query used.
- [ ] `ThemeToggle.tsx` exists, is a client island, accessible, and uses the same `slate-theme` key.
- [ ] Toggling `data-theme` flips the semantic vars (bg/fg) with no FOUC; reload persists; SSR-safe (no hydration warning).
- [ ] `pnpm build` exits 0.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- `cd /Users/danhankins-wright/Documents/Slate && pnpm build` → exit 0, no hydration-mismatch warning.
- `grep -n "data-theme\|suppressHydrationWarning\|slate-theme" src/app/layout.tsx` → all three present; the inline script references `slate-theme`.
- `grep -n "prefers-color-scheme" src/app/layout.tsx` → no match.
- Read `src/components/ThemeToggle.tsx` → `"use client"`, `slate-theme` key, `useEffect`-guarded `document` access, `aria-label`.

#### [browser] Web Verification
- Navigate `/`; `browser_evaluate` `document.documentElement.dataset.theme` → `"light"`. Screenshot `reports/screens/theme-light.png`.
- Persist `slate-theme=dark` via `browser_evaluate`, reload; `dataset.theme` → `"dark"`, body bg = navy, dark on first paint (no flash). Screenshot `reports/screens/theme-dark.png`.
- Console shows no React hydration mismatch error.
- Clean up the localStorage key.

### Cross-Surface Coherence
- The `slate-theme` key is identical in `layout.tsx`'s script and `ThemeToggle.tsx` — confirm both spellings match (a mismatch silently breaks persistence).
- The dark flip observed in the browser must match Task 1.2's semantic-flip rule (bg→navy, fg→beige, accent stays sky) — confirm consistency.

## Skills to Read

- `pennie-design-system-in-slate` — §2 (theming via `data-theme` + `@custom-variant dark`, NOT OS media query; Booker scopes `data-theme` on its own root; internal pages use the inline-`<head>`-script + `suppressHydrationWarning` no-flash pattern).

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/tailwind-v4-token-mapping.md` — the "Theme-without-flash" finding (inline `<head>` script, `suppressHydrationWarning`, `[data-theme]` keying) and the data-attribute-over-OS-media-query rationale.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

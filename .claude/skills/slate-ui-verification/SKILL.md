---
name: slate-ui-verification
description: Verify a restyled Slate UI surface visually and for WCAG 2.1 AA+ (Playwright MCP, axe, Lighthouse, contrast script). Use when verifying any Slate redesign change.
---

# Slate UI Verification

How an execution agent proves a restyled Slate surface actually looks right and meets WCAG 2.1
AA + extra care. This is the verification half of the brand redesign — the styling work is done
elsewhere; here you drive the running app, capture evidence, run the a11y gates, and sign off
against the acceptance bar (DISCOVERY.md D21).

Authority: `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` (D17 contrast math, D18
a11y requirements, D21 "done" bar) overrides everything. Background:
`research/verification-toolchain-execution.md`, `research/wcag-accessibility.md`, and
`reports/surface-verification.md` (route reachability + the auth blocker).

Two principles:
- **Browser-driven checks (Playwright, axe, Lighthouse) are agent/manual gates** — they need a
  running browser and stay OUT of `pnpm test` so CI stays Cloudflare-safe.
- **The ONE a11y check in `pnpm test` is `scripts/test-contrast.ts`** — node-native, no browser,
  reads the real token hex and asserts the D17 pairings.

---

## 1. Surface → URL matrix

Canonical seed bucket: `xbc=411`. Always pass `theme=` explicitly — the Booker default is
flipping (D10 dark→light), so a bare URL is ambiguous. Port 3000.

| # | Surface | Local URL | Theme control | Auth gate |
|---|---------|-----------|---------------|-----------|
| 1 | Booker (embed entry) | `/book?xbc=411&theme=light` and `&theme=dark` | `theme` query param | **public** |
| 2 | Booker (path entry) | `/booking/<sfId>?xbc=411&theme=light` | `theme` query param | **public** |
| 3 | Confirmation (delight, D16) | reach by completing a booking on #1/#2 | inherits booker theme | public |
| 4 | Manage / reschedule / cancel | `/booking/manage/<token>` | page-level | needs a real `manage_token` |
| 5 | Login (marketing-rich, D12) | `/login` | page-level | public page, but **Google-OAuth-only** sign-in |
| 6 | `/me` (agent self) | `/me` | page-level | **auth-gated** — `redirect("/login")` if no session |
| 7 | `/admin` | `/admin` | page-level | **auth-gated** — login + `canManageAgents` role |
| 8 | Embed example (host modal chrome, D15) | `/embed-example.html` (static in `public/`) | host passes `theme`/`brand` | public |
| — | Landing | `/` | n/a | public (stub) |

Public + auto-verifiable: 1, 2, 3, 5, 8, `/`. Auth-gated (need a session): 6, 7.
Needs a token: 4. See §8 for the auth blocker resolution.

`external_id` is optional prefill; `/book?xbc=411` is the minimum that renders.

---

## 2. Start the app + warm routes

Start the dev server in the **background** (do not block the agent):

```bash
cd /Users/danhankins-wright/Documents/Slate && pnpm dev
```

Run via the Bash tool with `run_in_background: true`. Next 16.2.7 (App Router, Turbopack) serves
on `http://localhost:3000` (matches `.env.local` `NEXT_PUBLIC_APP_URL`). Boots from `.env.local`.

Wait for ready, then **warm each route** — Next 16 compiles routes on first hit under `pnpm dev`,
so the first navigate to a cold route renders a compiling/blank state. Warm before screenshotting:

```bash
until curl -sf -o /dev/null http://localhost:3000/book?xbc=411; do sleep 1; done; echo up
for u in "/book?xbc=411&theme=light" "/book?xbc=411&theme=dark" "/login" "/embed-example.html" "/"; do
  curl -sf -o /dev/null "http://localhost:3000$u"; done; echo warmed
```

Create the evidence tree before any capture writes:

```bash
mkdir -p /Users/danhankins-wright/Documents/Slate/reports/{screens,axe,lighthouse}
```

Perf numbers from `pnpm dev` are meaningless (un-minified, on-demand compiled). For any real
perf figure run against `pnpm build && pnpm start` instead.

---

## 3. Playwright MCP visual verification procedure

Playwright MCP `browser_*` tools load at session start (`browser_navigate`, `browser_snapshot`,
`browser_take_screenshot`, `browser_resize`, `browser_evaluate`, `browser_press_key`,
`browser_emulate_media` — names vary by MCP build). Procedure per surface:

1. **Set a deterministic viewport.** `browser_resize` to **1280×900** (desktop, primary captures)
   and **390×844** (mobile, iPhone 12/13 class — for responsive / 44px touch targets / embed
   full-screen `<640px` `100dvh` per D15).
2. **Per surface × per theme** (`light` then `dark` on public booker; both on internal pages):
   - `browser_navigate` to the URL.
   - `browser_snapshot` — the accessibility-tree snapshot is the primary structured evidence; it
     shows roles/names/labels and directly checks D18 semantics (listbox/grid, labeled inputs,
     live regions, `role="alert"`). Paste the snapshot text into the checklist notes.
   - `browser_take_screenshot` to an explicit path under `reports/screens/` (full-page where it
     scrolls). Encode `surface-theme-viewport`: `book-light-desktop.png`, `book-dark-mobile.png`,
     `admin-light-desktop.png`, etc.
3. **Walk the interactive booking flow** (so screenshots show real states, not an empty calendar):
   click a **day** → click a **slot** → reach the name/email/phone **form** → submit → reach the
   **confirmation** delight moment. Screenshot each step.
4. **Focus rings on beige vs navy.** `browser_press_key('Tab')` through controls and screenshot
   the focus ring on BOTH themes (`book-focus-light.png`, `book-focus-dark.png`). D17 theme-aware
   focus is the single most important focus fix — capture proof the outline is **graphite on
   light / sky on navy** and **≥2px**. Watch for the `overflow-hidden` booker shell clipping
   outlines on edge-adjacent controls (month nav, last calendar column) — a clipped ring is a FAIL.
5. **Embed example (#8):** navigate `/embed-example.html`, click the "Schedule your call" trigger,
   screenshot the injected host-page modal. Confirm D15 literal modal chrome (white modal, 16px
   radius, navy scrim `rgba(29,33,47,0.55)`, sky focus ring), branded loading state, and the
   in-iframe confirmation shows the lightweight **SVG puck** (not the heavy 3D graphic). Capture
   mobile (`<640px`) for the full-screen `100dvh` modal. Watch the console — the cal.com contract
   (`Cal()` API, `data-cal-*` triggers, `slate:resize`/`slate:bookingSuccessful` postMessage) must
   still fire.

**Evidence layout** (repo root; gitignore vs track per user decision):

```
reports/
  screens/        # PNGs:  <surface>-<theme>-<viewport>.png
  axe/            # JSON:  <surface>-<theme>.axe.json
  lighthouse/     # JSON+HTML: <surface>-a11y.report.{json,html}
  checklist.md    # the filled per-surface template (§9)
```

**Peekaboo 3.4.0 fallback** — if Playwright screenshot is unavailable: position the browser and
set URL/theme manually, then `peekaboo image --app "Google Chrome" --path reports/screens/<name>.png`,
or `peekaboo see` for a capture + element map. Peekaboo captures the OS window (non-deterministic
viewport, manual theme setup), so Playwright is strongly preferred; Peekaboo is the "MCP screenshot
tool isn't responding" backup only.

---

## 4. axe-core (DOM-level WCAG 2.1 AA)

Run axe-core 4.x against the **running** app. Two wirings; **Option A is the default** for
MCP-driven agents (no new dependency).

**Option A — inject via `browser_evaluate`.** After navigating a surface:

```js
async () => {
  if (!window.axe) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }
  const r = await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  });
  return { violations: r.violations, passes: r.passes.length, incomplete: r.incomplete };
}
```

Save the returned `violations` to `reports/axe/<surface>-<theme>.axe.json`. If CF/CDN is offline,
vendor `node_modules/axe-core/axe.min.js` (read the file, inject its text).

**Option B — `@axe-core/playwright` in a committed script** (only if the team wants a repeatable
file). Add devDeps `@axe-core/playwright` + `playwright`, write `scripts/a11y-scan.ts` looping the
§1 URLs (`new AxeBuilder({ page }).withTags([...]).analyze()`). **Name it `a11y-scan.ts`, NOT
`test-a11y.ts`** — `pnpm test` globs `scripts/test-*.ts` and would try to run a browser script in
CI. Run manually: `node --experimental-strip-types scripts/a11y-scan.ts`. **Never wire axe into
`pnpm test`** — it needs a browser and breaks the CF-safe dep-light convention.

**AA rules that matter (treat as blockers):** `color-contrast` (1.4.3), `label` /
`label-title-only` / `form-field-multiple-labels` (the placeholder-only-input fail),
`aria-required-attr` / `aria-valid-attr-value` / `aria-roles` (new listbox/grid semantics),
`button-name` / `link-name`, `aria-allowed-attr`, `aria-hidden-focus`, `region`, `heading-order`
(one `<h1>` per surface), `frame-title` (embed iframe). Capture all of each violation's `id`,
`impact`, `nodes[].target`, `nodes[].failureSummary`.

**What axe CANNOT catch — verify manually:**
- **Roving tabindex / arrow-key nav** in the date grid and slot listbox (§3.3–3.4 keyboard walk).
- **Focus movement** between steps (slot → form panel → confirmation heading).
- **Live-region announcement timing** — the snapshot shows the region exists, but actual
  announcement needs a manual VoiceOver/NVDA pass on high-stakes surfaces (booker confirmation/error).
- **Sky focus ring on light (1.4.11 non-text)** — axe's `color-contrast` rule is text-only and
  misses this; the contrast script (§6) + focus screenshots cover it. A clean axe run is NOT proof
  the D17 focus rules hold.

---

## 5. Lighthouse

Standalone CLI against the warmed local URL. Accessibility is the must-pass category; perf is
informational only on a dev build.

```bash
# accessibility only → JSON + viewable HTML
npx lighthouse "http://localhost:3000/book?xbc=411&theme=light" \
  --only-categories=accessibility \
  --output=json --output=html \
  --output-path=reports/lighthouse/book-light-a11y \
  --chrome-flags="--headless=new" --quiet
```

**Threshold:** accessibility **≥ 0.95** (target 1.0). Lighthouse a11y is a coarse subset, so a 1.0
here PLUS a clean axe run is the real bar — treat any score < 1.0 as "explain each deduction."
Don't gate on perf from `pnpm dev`. Lighthouse can't reach auth-gated `/me`/`/admin` without a
session (same constraint as §1/§8). LHCI in CI is deferred — too heavy; the contrast script is the
lightweight CI a11y guard instead.

---

## 6. Committed contrast guard — `scripts/test-contrast.ts`

The ONE a11y check in `pnpm test` (node-native, no browser, CF-safe — matches Slate's
`scripts/test-*.ts` convention, run by `node --experimental-strip-types`). It encodes the D17 math
so a future token edit can't silently regress AA.

Design rules:
- **Read the real resolved token hex** out of the ported tokens (Foundation lands them in
  `src/app/globals.css`, or a `src/app/tokens.css` it imports — point `readFileSync` at the file
  Foundation actually writes; read/merge both if split). Don't hardcode a parallel copy that drifts.
  Resolve one+ levels of `var()` aliasing. Have it **throw on "token not found"** so a wrong path
  fails loudly instead of passing against an empty map.
- **Implement WCAG 2.x relative luminance in TS** (sRGB → linear → luminance → ratio).
- Assert the D17 **passing** pairings at their thresholds, AND assert the **forbidden-as-text
  tripwires** stay failing (so an accidental palette shift is caught).

```ts
// Contrast guard: asserts the D17 token pairings meet their WCAG 2.x ratios so a future token
// edit can't silently break AA. Reads resolved hex out of the ported tokens (globals.css)
// rather than hardcoding a copy. Run: node --experimental-strip-types scripts/test-contrast.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function fail(msg: string) { console.error("FAIL:", msg); failures++; }
function ok(msg: string) { console.log("ok:", msg); }

// --- Token resolution -------------------------------------------------------
const CSS = readFileSync(join("src", "app", "globals.css"), "utf8");
const RAW = new Map<string, string>();
for (const m of CSS.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) RAW.set(m[1].trim(), m[2].trim());
function resolve(name: string, seen = new Set<string>()): [number, number, number] {
  if (seen.has(name)) throw new Error(`cyclic token ${name}`);
  seen.add(name);
  const v = RAW.get(name);
  if (!v) throw new Error(`token ${name} not found in globals.css`);
  const varRef = v.match(/var\(\s*(--[\w-]+)\s*\)/);
  if (varRef) return resolve(varRef[1], seen);
  return parseColor(v);
}
function parseColor(v: string): [number, number, number] {
  const rgb = v.match(/rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  const hex = v.match(/#([0-9a-f]{6})/i);
  if (hex) { const n = parseInt(hex[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  throw new Error(`cannot parse color: ${v}`);
}

// --- WCAG 2.x relative luminance + contrast ratio ---------------------------
function lin(c: number) { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
function luminance([r, g, b]: [number, number, number]) { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
function ratio(a: [number, number, number], b: [number, number, number]) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function r(name: string) { return resolve(name); }
const HEX = (h: string) => parseColor(h); // literals not tokenized in the DS

function atLeast(fg: [number,number,number], bg: [number,number,number], min: number, label: string) {
  const v = ratio(fg, bg);
  if (v + 1e-9 >= min) ok(`${label} = ${v.toFixed(2)}:1 (>= ${min})`);
  else fail(`${label} = ${v.toFixed(2)}:1 (needs >= ${min})`);
}
function below(fg: [number,number,number], bg: [number,number,number], max: number, label: string) {
  const v = ratio(fg, bg);
  if (v < max) ok(`${label} = ${v.toFixed(2)}:1 (correctly < ${max}, forbidden as text)`);
  else fail(`${label} = ${v.toFixed(2)}:1 (expected < ${max} — token may have changed)`);
}

const graphite = r("--pennie-graphite");
const sky = r("--pennie-sky");
const skyDeep = r("--pennie-sky-deep");
const skyHover = HEX("#6dc5f7");  // --accent-hover (literal in DS); switch to r("--accent-hover") if Foundation tokenizes it
const beige = r("--pennie-beige");
const white = r("--pennie-white");
const navy = r("--pennie-navy");
const muted = r("--pennie-muted");
const rose = HEX("#C43D3D");      // error rose base; switch to r("--error") if tokenized
const blue = r("--pennie-blue");

// Text pairings that must PASS 4.5:1
atLeast(graphite, sky, 4.5, "PRIMARY CTA graphite-on-sky");        // 7.36 confirmed
atLeast(graphite, skyHover, 4.5, "CTA label on hover sky");        // 6.51
atLeast(graphite, beige, 4.5, "body graphite-on-beige");           // 11.54
atLeast(graphite, white, 4.5, "graphite-on-white");                // 12.45
atLeast(white, navy, 4.5, "white-on-navy band");                   // 16.02
atLeast(beige, navy, 4.5, "beige-on-navy (fg-on-ink)");            // 14.85
atLeast(muted, beige, 4.5, "muted-on-beige (thin 4.98 pass guard)");
atLeast(rose, beige, 4.5, "error rose-on-beige");                  // 4.77
atLeast(blue, beige, 4.5, "blue text-on-beige (only passing blue on light)");
atLeast(blue, white, 4.5, "blue text-on-white");

// Focus indicators must PASS 3:1 (1.4.11 non-text)
atLeast(graphite, beige, 3, "focus line graphite-on-beige (light theme)");
atLeast(sky, navy, 3, "focus line sky-on-navy (dark theme)");

// Forbidden-as-text tripwires: must STAY failing (regression signal if a token edit "fixes" them)
below(graphite, skyDeep, 4.5, "graphite-on-sky-deep — must NOT be a CTA text bg (4.32 fail)");
below(sky, beige, 4.5, "sky as text on beige — forbidden");
below(white, sky, 4.5, "white text on sky — forbidden");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

Implementing notes: (1) point `readFileSync` at the file Foundation actually writes. (2) If
Foundation tokenizes `--accent-hover` / `--error`, switch those `HEX(...)` calls to `r(...)`.
(3) The muted-on-beige `>= 4.5` is a deliberate guard against any future beige/muted lightening
(it passes by only 0.48). Verify it runs in `pnpm test`: `pnpm test` should print the `# scripts/test-contrast.ts` block ending `ALL PASSED`.

---

## 7. prefers-reduced-motion verification

D16/D18 require the confirmation delight and all entry/hover motion to collapse to a static final
frame under reduced-motion (opacity/transform only normally; static under reduce).

**Playwright (primary):**

```
browser_emulate_media reducedMotion=reduce
→ navigate /book?xbc=411&theme=light, complete a booking to reach confirmation
→ screenshot reports/screens/confirm-light-reducedmotion.png
→ browser_evaluate: getComputedStyle on the delight element; assert
  animationName === 'none' || animationDuration ~ '0s', and no looping.
```

Capture the SAME surface WITHOUT emulation (`reducedMotion: 'no-preference'`) so the checklist has
a before/after pair proving motion is present normally and suppressed under the pref. Also confirm
the global CSS guard exists in the token file (`@media (prefers-reduced-motion: reduce)` zeroing
animation/transition durations) — a cheap grep. Visual proof via the two screenshots is the
acceptance evidence. **Fallback:** macOS System Settings → Accessibility → Display → "Reduce
motion" ON, reload, `peekaboo image` the confirmation.

---

## 8. Auth blocker — `/me` and `/admin`

`/me` and `/admin` redirect (307) to `/login`, which is **Google-OAuth-only**
(`signInWithOAuth`, no email/password). A headless Playwright/Peekaboo agent CANNOT self-authenticate.
**Resolve the session strategy BEFORE the internal-pages verification sweep** or those two surfaces
stall. Three options, in priority order:

- **(a) Reuse a logged-in browser profile** — point Playwright at a Chrome profile already signed
  into Slate; the user logs in once, the agent then navigates `/me` and `/admin` directly. Cleanest
  path; keeps full axe/Lighthouse fidelity.
- **(b) Inject a Supabase session cookie** captured from a logged-in browser (DevTools →
  Application → Cookies → `sb-<ref>-auth-token`) via `page.context().addCookies(...)`. Fragile
  across token refresh; use only if (a) is unavailable.
- **(c) User-supplied screenshots** — verify `/login` (public) fully in both themes; the user logs
  in and captures `/me` + `/admin` manually, pasted into `reports/`, agent verifies visually.
  Lowest fidelity (no live axe), but unblocks the visual review.

`/booking/manage/<token>` (#4) needs a real `manage_token`: complete a booking via `/book?xbc=411`
first and reuse the token, or get one from the user. Without a valid token the page renders a
not-found state (worth screenshotting as an edge case, but not the styled happy path).

---

## 9. Per-surface verification checklist

Fill one row block per (surface × theme). Store at `reports/checklist.md`.
Legend: PASS / FAIL / N/A. Attach evidence paths.

```markdown
## Verification checklist — Slate brand redesign

| Surface | Theme | Viewport | Screenshot | a11y-tree snapshot | axe (count / ids) | Lighthouse a11y | Reduced-motion | Manual a11y checks | Notes | Result |
|---------|-------|----------|-----------|--------------------|-------------------|-----------------|----------------|--------------------|-------|--------|
| Booker /book?xbc=411 | light | desktop | reports/screens/book-light-desktop.png | captured | 0 / — | >=0.95 | — | listbox/grid semantics, labeled inputs | matches DS preview | |
| Booker /book?xbc=411 | dark | desktop | reports/screens/book-dark-desktop.png | | | | | | | |
| Booker /book?xbc=411 | light | mobile (390) | | | | | | targets >=44px | | |
| Booker — day+slot picked | light | desktop | | | | | | arrow-key nav, focus moves to form | | |
| Booker — focus ring | light | desktop | reports/screens/book-focus-light.png | | | | | graphite outline >=2px, not clipped | | |
| Booker — focus ring | dark | desktop | reports/screens/book-focus-dark.png | | | | | sky outline on navy >=2px | | |
| Confirmation (delight) | light | desktop | | | | | static under reduce | live-region announce (SR) | warm copy present | |
| Confirmation reduced-motion | light | desktop | reports/screens/confirm-light-reducedmotion.png | | | | reduce ON, no loop/transform | | | |
| Manage /booking/manage/<token> | light | desktop | | | | | | | needs real token | |
| Login /login | light | desktop | | | | >=0.95 | | | marketing split, sky CTA | |
| Login /login | dark | desktop | | | | | | | | |
| /me | light | desktop | | | | | | (needs auth session) | | |
| /me | dark | desktop | | | | | | | | |
| /admin | light | desktop | | | | | | (needs auth + role) | | |
| /admin | dark | desktop | | | | | | | | |
| Embed /embed-example.html (modal) | host | desktop | reports/screens/embed-modal-desktop.png | | | | | role=dialog, focus trap, Esc, scroll lock, >=44px close | white modal 16px radius, navy scrim, sky ring; branded loading; SVG puck in iframe | |
| Embed (modal) | host | mobile (<640) | | | | | | | full-screen 100dvh | |
```

---

## 10. Acceptance gate (D21 "done")

A restyled surface is verified only when ALL of these hold:

- [ ] Every surface screenshotted in BOTH themes, **matching DS `preview/*.html`** (visual parity).
- [ ] **axe clean** — 0 violations on `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` per surface/theme.
- [ ] **Lighthouse accessibility ≥ 0.95** (target 1.0) on reachable public surfaces.
- [ ] **`scripts/test-contrast.ts` passes** (`ALL PASSED`), and so via `pnpm test`.
- [ ] **`pnpm build` + `pnpm lint` + `pnpm test` all green.**
- [ ] **Booking flow works E2E** — day → slot → form → confirmation.
- [ ] **Reduced-motion** — confirmation + entry animations static under emulation.
- [ ] **Embed cal.com drop-in contract intact** — `Cal()` API, `data-cal-*` triggers,
      `slate:resize`/`slate:bookingSuccessful` postMessage all fire (watch the console).
- [ ] Manual a11y checks done where axe can't reach (roving tabindex, focus movement,
      live-region timing — §4).
- [ ] No stray hex outside the token layer.

Reminder (D5): this is visual-only. Verification OBSERVES the existing booking logic working; it
does not modify booking logic, availability cache, Google sync, round-robin, webhooks, or auth.

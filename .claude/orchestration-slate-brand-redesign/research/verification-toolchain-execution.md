# Verification Toolchain & Evidence Capture - Research

**Wave**: Second
**Researcher**: Verification toolchain & evidence capture domain agent
**Date**: 2026-06-09
**Status**: Complete
**Target Surface(s)**: Browser + Code

---

## Summary

This is the execution playbook for proving the Slate brand redesign meets D17/D18/D21 before merge. It pins down exactly how to drive a local `pnpm dev` Slate with Playwright MCP (which URLs reach each surface in both themes, given that `/me` and `/admin` redirect to `/login` and login is Google-OAuth-only), how to run axe-core for WCAG 2.1 AA DOM checks, how to score with Lighthouse locally, a committable node-native `scripts/test-contrast.ts` that reads the real token hex values and asserts the D17 pairings so future edits can't silently regress AA, how to verify `prefers-reduced-motion`, and a per-surface fill-in checklist. Evidence (screenshots, axe JSON, Lighthouse JSON) lands in a new `reports/` tree at repo root. The contrast script is the only piece that runs in CI (`pnpm test`); everything else is a manual/agent-driven gate because it needs a running browser.

## Key Findings

### 1. The surfaces, their URLs, and their reachability gates

The redesign touches eight surfaces (D3/D4). Theme is driven by the `theme` query param on the public/booker surfaces (verified: `book/page.tsx` line 55 reads `theme=light|dark`, defaulting dark today — D10 says flip default to light). Internal pages currently default dark (D11). Reachability differs:

| # | Surface | Local URL (port 3000) | Theme control | Auth gate |
|---|---------|----------------------|---------------|-----------|
| 1 | Booker via embed entry | `/book?xbc=411&theme=light` and `…&theme=dark` | `theme` query param | none (public) |
| 2 | Booker via path entry | `/booking/<sfId>?xbc=411&theme=light` | `theme` query param | none (public) |
| 3 | Standalone confirmation (delight moment, D16) | reached by completing a booking on #1/#2, or the confirmed sub-state of Booker | inherits booker theme | none |
| 4 | Manage / reschedule / cancel | `/booking/manage/<token>` | page-level (verify in code at build time) | needs a real booking token |
| 5 | Login (marketing-rich, D12) | `/login` | page-level | public, but **Google OAuth only** (`signInWithOAuth`, no email/password) |
| 6 | `/me` (agent self) | `/me` | page-level | `redirect("/login")` if no session |
| 7 | `/admin` | `/admin` | page-level | `redirect("/login")` + `canManageAgents` role |
| 8 | Embed example (host-page modal chrome, D15) | `/embed-example.html` (static in `public/`) | host passes `theme`/`brand` | none |

**Canonical seed**: bucket code `411` (README step + `test-booking-orchestration.ts`). Use `xbc=411` for all booker navigation. `external_id` is optional prefill; `/book?xbc=411` is the minimum that renders.

**Auth is the one human-required gate.** `/login` uses `supabase.auth.signInWithOAuth({ provider: 'google', … })` against a `trypennie.com` hosted domain — a Playwright agent cannot complete Google SSO unattended. Three options for screenshotting `/me` and `/admin` (in priority order):
- **(a) Reuse an existing authenticated browser session.** Playwright MCP drives a persistent Chrome profile; if the user logs in once in that profile, the agent can navigate `/me` and `/admin` directly afterward. This is the cleanest path. (Human action: one-time login — see Human Actions table.)
- **(b) Inject a Supabase session cookie** captured from a logged-in browser (DevTools → Application → Cookies → `sb-<ref>-auth-token`) via `page.context().addCookies(...)`. Fragile across token refresh; use only if (a) is unavailable.
- **(c) Verify `/login` (which is public) fully in both themes, and verify `/me` + `/admin` against a screenshot the user captures manually** while logged in, pasted into `reports/`. Lowest fidelity for axe but unblocks the visual review.

`/booking/manage/<token>` (#4) needs a real `manage_token`. Either complete a booking through #1 first and reuse the token from the confirmation/DB, or have the user supply one. Without a valid token the page renders a not-found state (still worth screenshotting as an edge case, but not the styled happy path).

### 2. Driving local Slate with Playwright MCP — exact sequence

Playwright MCP tools load at session start (assume `browser_navigate`, `browser_snapshot`, `browser_take_screenshot`, `browser_resize`, `browser_evaluate`, `browser_press_key`, `browser_emulate_media` or equivalent are available — tool names vary by MCP build; use `browser_*` family). Procedure per execution agent:

1. **Start the dev server in the background** (do NOT block the agent):
   ```bash
   cd /Users/danhankins-wright/Documents/Slate && pnpm dev
   ```
   Run via the Bash tool with `run_in_background: true`. `next dev` serves on `http://localhost:3000` (matches `.env.example` `NEXT_PUBLIC_APP_URL`). Wait for "Ready" by polling: `curl -sf -o /dev/null http://localhost:3000/book?xbc=411 && echo up`. Note Next.js 16 — first hit to a route compiles on demand, so the first navigate may be slow; navigate once to warm each route before screenshotting.
2. **Set a deterministic viewport.** Resize to a desktop frame `1280×900` for the primary captures and a mobile frame `390×844` (iPhone 12/13 class) for the responsive/touch-target and embed full-screen (`<640px`, `100dvh` per D15) captures.
3. **Navigate + snapshot + screenshot, per surface, per theme.** For each row in the §1 table, for `theme=light` then `theme=dark`:
   - `browser_navigate` to the URL.
   - `browser_snapshot` — the accessibility-tree snapshot is the primary structured evidence (it shows roles/names/labels — directly checks D18 semantics: listbox/grid, labeled inputs, live regions, `role="alert"`). Save the snapshot text into the checklist notes.
   - `browser_take_screenshot` with an explicit path under `reports/screens/` (full-page where the surface scrolls). Filenames encode surface+theme+viewport: `book-light-desktop.png`, `book-dark-mobile.png`, `admin-light-desktop.png`, etc.
4. **Exercise interactive state for the booker** (so screenshots show real states, not just empty): click a day in the calendar, then a time slot, to reach the name/email/phone form; screenshot each step. Tab through with `browser_press_key('Tab')` and screenshot the focus ring on both beige and navy (D17 theme-aware focus is the single most important focus fix — capture proof the outline is graphite-on-light / sky-on-navy and ≥2px). Submit to reach the confirmation delight moment (#3) and screenshot it.
5. **Embed example (#8):** navigate to `/embed-example.html`, click the "Schedule your call" trigger, and screenshot the injected host-page modal (white modal, 16px radius, navy scrim, sky focus ring per D15) — confirm the modal chrome uses literal values (it can't read `--pennie-*`), the loading state is branded, and the in-iframe confirmation shows the lightweight SVG puck (not the heavy 3D graphic).

**Evidence locations** (create at repo root, gitignored unless the team wants them tracked):
```
reports/
  screens/        # PNGs:  <surface>-<theme>-<viewport>.png
  axe/            # JSON:  <surface>-<theme>.axe.json
  lighthouse/     # JSON+HTML: <surface>-a11y.report.{json,html}
  checklist.md    # the filled per-surface template (§7)
```

**Peekaboo fallback** (Peekaboo CLI 3.4.0, per orchestration tooling): if Playwright screenshot is unavailable, capture the foreground browser window with `peekaboo image --app "Google Chrome" --path reports/screens/<name>.png`, or use `peekaboo see` to capture + get an element map for an agent to reason about. Peekaboo screenshots the OS window, so position the browser and set the URL/theme manually first. Playwright is preferred because it captures deterministic viewports and the a11y tree; Peekaboo is the "the MCP screenshot tool isn't responding" backup.

### 3. axe-core accessibility automation

Two viable wirings; both run axe-core 4.x against the **running** app:

**Option A — inject axe via Playwright `evaluate` (no new dependency, works with Playwright MCP directly).** This is the recommended path for MCP-driven agents because it needs no test runner:
- After navigating to a surface, run `browser_evaluate` with a function that (1) injects axe from the CDN or a local copy, (2) runs it scoped to the WCAG AA tags, (3) returns the violations JSON. Sketch of the evaluated function:
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
  Save the returned `violations` array to `reports/axe/<surface>-<theme>.axe.json`. (If CF offline, vendor `node_modules/axe-core/axe.min.js` by reading the file and injecting its text via `addScriptTag`-equivalent.)

**Option B — `@axe-core/playwright` in a committed script** (if the team wants axe in a repeatable file rather than ad-hoc MCP calls). Add devDeps `@axe-core/playwright` + `playwright`, then a `scripts/a11y-scan.ts` that loops the §1 URLs. Per the first-wave research the call is:
  ```ts
  import AxeBuilder from '@axe-core/playwright';
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  ```
  Note: this is **not** wired into `pnpm test` — `pnpm test` is the node-native `scripts/test-*.ts` loop and must stay dependency-light and browser-free for CI/CF. Name this `a11y-scan.ts` (not `test-a11y.ts`) so the test loop doesn't try to run a browser script. Run it manually: `node --experimental-strip-types scripts/a11y-scan.ts` after `pnpm dev` is up.

**Rules that matter for AA** (the violations to treat as blockers): `color-contrast` (1.4.3 — but note axe uses WCAG 2.x ratios and can miss the sky-focus-ring 1.4.11 case, so pair with the contrast script), `label` / `label-title-only` / `form-field-multiple-labels` (the placeholder-only-input fail in current Booker), `aria-required-attr` / `aria-valid-attr-value` / `aria-roles` (the new listbox/grid semantics), `button-name` / `link-name`, `aria-allowed-attr`, `region`, `heading-order` (one `<h1>` per surface), `aria-hidden-focus`, `frame-title` (the embed iframe). Capture **all** of `violations` (each has `id`, `impact`, `nodes[].target`, `nodes[].failureSummary`) — that's the actionable evidence.

**axe gaps to cover by hand** (D18 items axe can't fully verify): roving-tabindex arrow-key nav in the date grid, focus *movement* between steps, live-region *announcement* timing, and reduced-motion behavior. Those are covered by the Playwright keyboard walk (§2.4) and §5, plus optional manual VoiceOver.

### 4. Lighthouse / LHCI locally

Use the standalone Lighthouse CLI against the warmed local URL; a11y is the must-pass category, perf is informational (D21 lists both):

```bash
# one surface, accessibility only, JSON + viewable HTML into reports/
npx lighthouse "http://localhost:3000/book?xbc=411&theme=light" \
  --only-categories=accessibility \
  --output=json --output=html \
  --output-path=reports/lighthouse/book-light-a11y \
  --chrome-flags="--headless=new" --quiet

# a11y + performance for the confirmation/booker happy path
npx lighthouse "http://localhost:3000/book?xbc=411&theme=light" \
  --only-categories=accessibility,performance \
  --output=json --output-path=reports/lighthouse/book-light --chrome-flags="--headless=new" --quiet
```

**Thresholds (acceptance):** accessibility score **≥ 0.95** (target 1.0 — Lighthouse a11y is a coarse subset, so a 1.0 here plus a clean axe run is the real bar; treat any score < 1.0 as "explain each deduction"). Performance is advisory given this is a local dev build (un-minified, on-demand compiled) — do not gate on perf numbers from `pnpm dev`; if a perf number is wanted, run it against `pnpm build && pnpm start` instead. Lighthouse cannot reach auth-gated `/me`/`/admin` without a session, same constraint as §1.

**LHCI option** (only if a CI a11y gate is desired later): `npm i -D @lhci/cli` + a `lighthouserc.json` with `assert.assertions["categories:accessibility"] = ["error", { minScore: 0.95 }]`, run `lhci autorun`. Not recommended for now — it needs a running server in CI and pulls a heavy dep; the committed contrast script (§5) is the lightweight CI a11y guard instead.

### 5. Committable contrast guard — `scripts/test-contrast.ts`

This is the one a11y check that belongs in `pnpm test` (node-native, no browser, CF-safe). It encodes the D17 math so a future token edit that breaks AA fails CI. Design:

- **Read the real token hex values, don't hardcode a parallel copy** that can drift. The tokens live as `rgb(...)` in `~/Documents/Pennie Branding/Pennie Design System/colors_and_type.css` and will be ported into Slate during Foundation (D19/D22) — likely `src/app/globals.css`. The script should parse the *Slate* token file (post-Foundation), pulling each `--pennie-*` / semantic var's resolved color, so it tests what actually ships. Resolve one level of `var()` aliasing (e.g. `--accent: var(--pennie-sky)`).
- **Implement the WCAG 2.x relative-luminance formula in TS** (sRGB → linear → luminance → ratio). The script asserts each D17 pairing meets its threshold, and — critically — asserts the **known FAILs stay failing-by-design isn't needed**; instead assert the *chosen compliant* values: graphite-on-sky ≥ 4.5, graphite-on-accent-hover ≥ 4.5, that `--accent-press` is NOT used as a normal-text background under graphite (guard: graphite-on-sky-deep is allowed to be < 4.5 only because it's forbidden as a CTA fill — encode it as an explicit "do not use as text bg" assertion documenting the 4.32 fail), focus-line pairings (graphite-on-beige ≥ 3, sky-on-navy ≥ 3), muted-on-beige ≥ 4.5 (the thin 4.98 pass — guards against beige/muted lightening), rose-on-beige ≥ 4.5, white-on-navy ≥ 4.5, and that sky/sky-deep as text on light is flagged (< 4.5, must use `--pennie-blue` which is asserted ≥ 4.5 on beige and white).

Concrete script (matches Slate's `scripts/test-*.ts` style — header comment, `assert`/`fail` counters, `process.exit`):

```ts
// Contrast guard: asserts the D17 token pairings meet their WCAG 2.x ratios so a
// future token edit can't silently break AA. Reads the resolved hex values out of
// the ported design tokens (src/app/globals.css) rather than hardcoding a copy.
// Run: node --experimental-strip-types scripts/test-contrast.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function fail(msg: string) { console.error("FAIL:", msg); failures++; }
function ok(msg: string) { console.log("ok:", msg); }

// --- Token resolution -------------------------------------------------------
// Parse `--name: rgb(r,g,b);` and `--name: var(--other);` from the token CSS.
// Resolve one+ levels of var() aliasing to a concrete rgb triple.
const CSS = readFileSync(join("src", "app", "globals.css"), "utf8");
const RAW = new Map<string, string>();
for (const m of CSS.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
  RAW.set(m[1].trim(), m[2].trim());
}
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
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  throw new Error(`cannot parse color: ${v}`);
}

// --- WCAG 2.x relative luminance + contrast ratio ---------------------------
function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function r(name: string) { return resolve(name); }
// Literal hexes that aren't tokens (or to assert independent of token file):
const HEX = (h: string) => parseColor(h);

// --- D17 assertions ---------------------------------------------------------
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
const skyHover = HEX("#6dc5f7"); // --accent-hover (literal in DS)
const beige = r("--pennie-beige");
const white = r("--pennie-white");
const navy = r("--pennie-navy");
const muted = r("--pennie-muted");
const rose = HEX("#C43D3D");      // error rose (12% tint base color)
const blue = r("--pennie-blue");

// Text pairings that must PASS 4.5:1
atLeast(graphite, sky, 4.5, "PRIMARY CTA graphite-on-sky");
atLeast(graphite, skyHover, 4.5, "CTA label on hover sky");
atLeast(graphite, beige, 4.5, "body graphite-on-beige");
atLeast(graphite, white, 4.5, "graphite-on-white");
atLeast(white, navy, 4.5, "white-on-navy band");
atLeast(beige, navy, 4.5, "beige-on-navy (fg-on-ink)");
atLeast(muted, beige, 4.5, "muted-on-beige (thin pass guard)");
atLeast(rose, beige, 4.5, "error rose-on-beige");
atLeast(blue, beige, 4.5, "blue text-on-beige (the only passing blue on light)");
atLeast(blue, white, 4.5, "blue text-on-white");

// Focus indicators must PASS 3:1 (1.4.11 non-text)
atLeast(graphite, beige, 3, "focus line graphite-on-beige (light theme)");
atLeast(sky, navy, 3, "focus line sky-on-navy (dark theme)");

// Known-forbidden pairings: must STAY failing (regression tripwire if a token
// edit accidentally "fixes" them, signalling the palette shifted unexpectedly)
below(graphite, skyDeep, 4.5, "graphite-on-sky-deep — must NOT be used as CTA text bg");
below(sky, beige, 4.5, "sky as text on beige — forbidden");
below(white, sky, 4.5, "white text on sky — forbidden");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

Notes for the implementing agent: (1) point the `readFileSync` path at wherever Foundation actually places the tokens — if they land in a dedicated `src/app/tokens.css` imported by `globals.css`, read that file (or read both and merge the maps). (2) The error rose `#C43D3D` and `--accent-hover #6dc5f7` are literal in the DS, not aliased tokens, so the `HEX()` helper is correct; if Foundation tokenizes them (`--error`, `--accent-hover`), switch those to `r("--error")` etc. (3) Adding `>= 4.5` for muted-on-beige is the guardrail the first-wave research called out (4.98 thin pass).

### 6. prefers-reduced-motion verification

D16/D18 require the confirmation delight and all entry/hover motion to collapse to a static final frame under reduced-motion. Verify two ways:

- **Playwright:** emulate the media feature, then drive the confirmation and assert no transform animation:
  ```
  browser: emulate media reducedMotion=reduce  (browser_emulate_media / page.emulateMedia({ reducedMotion:'reduce' }))
  → navigate /book?xbc=411&theme=light, complete a booking to reach confirmation
  → screenshot reports/screens/confirm-light-reducedmotion.png
  → browser_evaluate: read getComputedStyle on the delight element and assert
    animationName === 'none' || animationDuration ~ '0s', and no looping.
  ```
  Capture the same surface WITHOUT the emulation (`reducedMotion: 'no-preference'`) so the checklist has a before/after pair proving motion is present normally and suppressed under the pref. Also confirm the global CSS guard from the first-wave research (`@media (prefers-reduced-motion: reduce)` zeroing animation/transition durations) is present in `globals.css` — a quick grep is a cheap CI-adjacent check the contrast script's sibling could add, but visual proof via the two screenshots is the acceptance evidence.
- **Peekaboo / manual fallback:** macOS System Settings → Accessibility → Display → "Reduce motion" ON, reload the surface, `peekaboo image` the confirmation. Slower; use only if Playwright media emulation is unavailable.

### 7. Per-surface verification checklist template

Execution agents fill one row block per (surface × theme). Store as `reports/checklist.md`. Template:

```markdown
## Verification checklist — Slate brand redesign

Run after `pnpm dev` is up (port 3000) and tokens/Foundation are in place.
Legend: PASS / FAIL / N/A. Attach evidence paths.

| Surface | Theme | Viewport | Screenshot | a11y-tree snapshot | axe violations (count / ids) | Lighthouse a11y | Reduced-motion | Notes | Result |
|---------|-------|----------|-----------|--------------------|------------------------------|-----------------|----------------|-------|--------|
| Booker /book?xbc=411 | light | desktop | reports/screens/book-light-desktop.png | captured | 0 / — | — | — | matches DS preview | |
| Booker /book?xbc=411 | dark | desktop | reports/screens/book-dark-desktop.png | | | | | | |
| Booker /book?xbc=411 | light | mobile (390) | | | | | targets >=44px | | |
| Booker — day+slot picked (states) | light | desktop | | | | | | listbox/grid semantics present | |
| Booker — focus ring | light | desktop | reports/screens/book-focus-light.png | | | | | graphite outline >=2px, visible | |
| Booker — focus ring | dark | desktop | | | | | | sky outline on navy | |
| Confirmation (delight) | light | desktop | | | | | static under reduce | warm copy present | |
| Confirmation (delight) | light | desktop | reports/screens/confirm-light-reducedmotion.png | | | | reduce ON | no looping/transform | |
| Manage/reschedule/cancel /booking/manage/<token> | light | desktop | | | | | | needs real token | |
| Login /login | light | desktop | | | | | | marketing split layout, sky CTA | |
| Login /login | dark | desktop | | | | | | | |
| /me | light | desktop | | | | | | (needs auth session) | |
| /me | dark | desktop | | | | | | | |
| /admin | light | desktop | | | | | | (needs auth + role) | |
| /admin | dark | desktop | | | | | | | |
| Embed example /embed-example.html (modal open) | host | desktop | reports/screens/embed-modal-desktop.png | | | | | white modal, 16px radius, navy scrim, sky focus ring; branded loading; SVG puck in iframe | |
| Embed example (modal) | host | mobile (<640) | | | | | | full-screen 100dvh | |

### Sign-off gates (D21 "done")
- [ ] Every surface screenshotted in BOTH themes, compared to DS `preview/*.html`.
- [ ] axe: 0 violations on wcag2a/wcag2aa/wcag21aa tags per surface/theme.
- [ ] Lighthouse accessibility >= 0.95 (target 1.0) on public surfaces.
- [ ] `node --experimental-strip-types scripts/test-contrast.ts` PASS (also via `pnpm test`).
- [ ] `pnpm build` green, `pnpm lint` clean, `pnpm test` green.
- [ ] Booking flow works E2E (pick day → slot → form → confirmation).
- [ ] Reduced-motion: confirmation + entry animations static under emulation.
- [ ] Embed cal.com drop-in contract intact (Cal() API, data-cal-* triggers, postMessage).
- [ ] No stray hex outside the token layer.
```

## Recommended Approach

1. **Foundation first, then verify per surface** (mirrors D22). The contrast script can be committed during Foundation and run immediately — it's the earliest gate and catches token mistakes before any restyle.
2. **Background `pnpm dev`, warm each route, then loop the §1 table** with Playwright MCP: navigate → `browser_snapshot` (a11y tree) → `browser_take_screenshot` → inject-axe `browser_evaluate`, for `theme=light` then `theme=dark`, at desktop then mobile for booker+embed.
3. **axe via Playwright `evaluate` injection** (no new dep) is the primary DOM-WCAG gate; commit `scripts/test-contrast.ts` (node-native) as the CI tripwire; Lighthouse CLI for the score number. Keep all three — they catch different things (DOM semantics / token math / aggregate score).
4. **Handle the auth gate up front**: ask the user to log in once in the Playwright Chrome profile so `/me` and `/admin` are reachable; otherwise verify `/login` (public) live and `/me`+`/admin` from user-supplied screenshots.
5. **Store all evidence under `reports/`** with the encoded filenames and fill `reports/checklist.md`. Gitignore `reports/` unless the team wants the audit tracked.

## Alternatives Considered

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| axe via Playwright `evaluate` injection | no new dep, works directly from MCP, per-surface | ad-hoc, not a committed artifact | **Recommended (primary)** |
| `@axe-core/playwright` committed `scripts/a11y-scan.ts` | repeatable, reviewable | pulls playwright+axe devDeps; can't go in `pnpm test` (browser) | Optional adjunct |
| Wire axe into `pnpm test` | one command | breaks CF/CI dep-light convention; needs a browser | Rejected |
| `scripts/test-contrast.ts` reading token file | node-native, CI-safe, catches token regressions, matches convention | only checks declared pairings, not rendered DOM | **Recommended (CI gate)** |
| Hardcode hexes in contrast script | simplest | drifts from real tokens — defeats the guard | Rejected |
| Lighthouse CLI standalone | quick a11y+perf score, HTML report | a11y is a coarse subset; can't reach auth pages; perf noisy on dev build | Recommended for score, paired with axe |
| LHCI in CI | automated a11y gate | heavy dep + needs running server in CI | Deferred |
| Pa11y / pa11y-ci | CI a11y alternative | another runner; overlaps axe | Skip (axe+contrast cover it) |
| Peekaboo for all screenshots | works without MCP | OS-window capture, non-deterministic viewport, manual theme/URL setup | Fallback only |

## Pitfalls and Edge Cases

- **`/me` and `/admin` redirect to `/login`** and login is **Google-OAuth-only** — a headless agent can't authenticate. Resolve the session strategy (§1 a/b/c) before the verification pass starts, or those two surfaces stall.
- **`/booking/manage/<token>` needs a real token** — complete a booking via `/book?xbc=411` first and reuse the token, or get one from the user; otherwise you only screenshot the not-found state.
- **Next.js 16 compiles routes on first hit** under `pnpm dev` — warm every URL once before screenshotting or the first capture shows a compiling/blank state; perf numbers from the dev build are meaningless (run `pnpm build && pnpm start` for any real perf figure).
- **axe `color-contrast` misses the sky-focus-ring case** (1.4.11 non-text, not in axe's text-contrast rule) — the contrast script + the focus-ring screenshots cover that gap; don't treat a clean axe run as proof D17 focus rules hold.
- **Theme default is flipping** (D10: dark→light) — always pass `theme=` explicitly in URLs so a captured screenshot is unambiguous; don't rely on the default.
- **Embed modal chrome can't read `--pennie-*` vars** (D15) — verify the modal uses literal values by inspecting computed styles in the screenshot/DOM, not by assuming the tokens cascade in.
- **`overflow-hidden` on the booker shell clips focus outlines** (first-wave finding) — when screenshotting focus, confirm the ring on edge-adjacent controls (month nav, last calendar column) isn't clipped; if it is, that's a FAIL to file.
- **Contrast script must read the file Foundation actually writes** — if tokens land in a separate `tokens.css` (not `globals.css`), update the `readFileSync` path or the guard silently passes against the wrong/empty map. Have the script `throw` on "token not found" (it does) so a wrong path fails loudly.
- **`reports/` directory must exist** before screenshot/JSON writes — `mkdir -p reports/{screens,axe,lighthouse}` first.
- **Live regions only announce if mounted before the text changes** (first-wave finding) — the a11y-tree snapshot shows the region exists, but actual announcement timing needs a manual SR pass (VoiceOver) for high-stakes surfaces (booker confirmation/error).

## References

- DISCOVERY.md D17/D18/D21/D10/D15/D16 — `.claude/orchestration-slate-brand-redesign/DISCOVERY.md`
- First-wave a11y research (contrast math, axe call, tool table) — `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md`
- Slate test convention — `package.json` `test` script + `scripts/test-copy.ts`, `scripts/test-roles.ts`
- Token source — `~/Documents/Pennie Branding/Pennie Design System/colors_and_type.css`
- Booker theme prop / book entry — `src/components/Booker.tsx`, `src/app/book/page.tsx`
- Auth gates — `src/app/me/page.tsx`, `src/app/admin/page.tsx`, `src/app/login/page.tsx`
- Embed host page — `public/embed-example.html`, `public/widget.js`
- axe-core 4.x: https://github.com/dequelabs/axe-core ; @axe-core/playwright: https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright
- Lighthouse CLI: https://github.com/GoogleChrome/lighthouse#using-the-node-cli
- WCAG 2.x relative luminance / contrast: https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html

---

## Second Wave Additions

### Execution Details (filtered by DISCOVERY.md)

- **D21 defines "done"**: this playbook operationalizes each clause — both-theme screenshots vs DS preview, axe-core via Playwright, Lighthouse, `scripts/test-contrast.ts`, reduced-motion emulation, `build`/`lint`/`test` green, E2E booking, embed contract intact.
- **D10/D11 theming**: always drive theme via explicit `?theme=light|dark` on public surfaces; internal pages support both (capture both). Default is flipping to light — never rely on it.
- **D17 is the contrast script's spec**: graphite-on-sky ≥4.5 (7.36 confirmed), cap CTA fill at `--accent-hover` (6.51) not `--accent-press` (4.32 — encoded as a forbidden-as-text tripwire), theme-aware focus (graphite-on-beige / sky-on-navy ≥3), muted-on-beige ≥4.5 guard, `--pennie-blue` for blue text on light.
- **D16 reduced-motion**: confirmation delight must verify static-under-`reduce` (before/after screenshot pair); lightweight SVG puck inside the embed iframe (not the 3D graphic) — check in the embed capture.
- **D15 embed**: verify literal modal chrome values, branded loading, mobile full-screen `100dvh`, and that the cal.com contract (Cal() API, data-cal-* triggers, postMessage resize/success) still fires — watch the console during the embed click.
- **Out of scope (D5)**: no functional changes — verification observes the existing booking logic working, it does not modify it.

### Tool and Surface Configuration

| Tool/Service | Surface | Purpose | Setup Required | Agent Can Self-Configure? |
|--------------|---------|---------|----------------|---------------------------|
| `pnpm dev` (Next 16, port 3000) | Code→Browser | Serve local app for live verification | none (`.env.local` present) | Yes (Bash, run_in_background) |
| Playwright MCP (`browser_*`) | Browser | Navigate, a11y-tree snapshot, screenshot, keyboard walk, media emulation | loads at session start | Yes |
| axe-core 4.x (CDN/vendored, injected) | Browser | DOM-level WCAG 2.1 AA violations | none (injected via evaluate) | Yes |
| `@axe-core/playwright` (optional) | Code | Committed `scripts/a11y-scan.ts` | `pnpm add -D @axe-core/playwright playwright` | Yes |
| Lighthouse CLI (`npx lighthouse`) | Browser | a11y score + (optional) perf | npx-fetched | Yes |
| `scripts/test-contrast.ts` | Code | CI contrast tripwire on D17 pairings | commit the script; reads token CSS | Yes |
| Peekaboo CLI 3.4.0 | Browser (fallback) | Window screenshots when MCP unavailable | installed | Yes |
| Google OAuth session | Browser (auth) | Reach `/me` and `/admin` | one-time human login in PW profile | No (user) |
| Real `manage_token` | Browser | Reach styled manage page | book once or user-supplied | Partly (agent can book) |

### Verification Strategy

- **Verification method**: drive local Slate with Playwright MCP across the §1 surface matrix in both themes/two viewports; per surface capture a11y-tree snapshot + screenshot + injected-axe JSON; run Lighthouse a11y; run the committed contrast script; emulate reduced-motion for the confirmation.
- **Evidence to capture**: PNG screenshots (`reports/screens/`), accessibility-tree snapshots (in checklist notes), axe violations JSON (`reports/axe/`), Lighthouse JSON+HTML (`reports/lighthouse/`), contrast-script stdout, and the filled `reports/checklist.md`.
- **Acceptance threshold**: 0 axe violations (wcag2a/2aa/21aa) per surface/theme; Lighthouse a11y ≥0.95 (target 1.0); `test-contrast.ts` PASS; `build`/`lint`/`test` green; visual parity with DS `preview/*.html`; reduced-motion static; embed cal contract fires; no stray hex.

### Human Actions Required

| Action | Who | How | Status |
|--------|-----|-----|--------|
| Log into Slate once in the Playwright Chrome profile (Google SSO, trypennie.com) so `/me` and `/admin` are reachable | User | Open the PW-driven Chrome, visit `/login`, complete Google sign-in; agent reuses the session | Pending |
| Provide a real `manage_token` (or confirm agent may complete a test booking on bucket 411 to mint one) | User | Share a `/booking/manage/<token>` URL, or approve a throwaway booking | Pending |
| Confirm `reports/` may be gitignored vs tracked as an audit trail | User | One-line decision | Pending |
| Optional: macOS "Reduce motion" toggle if Playwright media emulation is unavailable | User | System Settings → Accessibility → Display → Reduce motion | Pending (fallback only) |
</content>
</invoke>

# Booker Layout (strip default + month grid setting) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the booker two date-picker layouts — a compact next-few-days strip (default) and the existing month grid — chosen by an org-wide setting, and stop leaking the internal bucket name to leads.

**Architecture:** A new `booker_layout` column on `organizations` (default `'strip'`) is read by the `/book` server page and passed to `Booker` as a prop. `Booker` keeps all shared chrome (event panel, timezone, 12h/24h, slot list, attendee form, confirm, theming, embed resize) and only swaps the date-picker region: the existing `BookerCalendar` for `'month'`, a new presentational `BookerStrip` for `'strip'`. An admin toggle writes the column. Spec: `docs/superpowers/specs/2026-06-19-booker-layout-strip-design.md`.

**Tech Stack:** Next 16 (App Router, RSC + client components), Supabase, Luxon, Tailwind v4 + Pennie DS tokens, node-native `scripts/test-*.ts` + vitest `pnpm test:components`. Cloudflare/OpenNext.

## Global Constraints

- Visual-only: no change to `/api/availability`, booking, routing, or availability data. Both layouts consume the same `meta.slots`.
- Pennie DS (read `pennie-design-system-in-slate` first): tokens only, sky is the sole action color, 16px card radius, both **light and dark** themes; honor `prefers-reduced-motion`.
- Embed contract (`slate-embed-contract`): keep `slate:resize` height postMessage + `slate:escape`; `/api/availability` response unchanged.
- Accessibility WCAG 2.1 AA+: full keyboard nav, visible sky focus ring, 44px targets.
- Migrations use UNQUALIFIED table names (`test-migrations` parses `[a-z_]+` after `create/alter table`). Run the FULL `pnpm test` before pushing (it includes `test-migrations`); the pre-push gate ignores `scripts/test-*.ts`, so push with `SKIP_TEST_CHECK=1`.
- Branch `feat/booker-layout-strip` is stacked on `feat/precompute-availability` (PR1 #256); rebase onto main once #256 merges. Commits read as the author's own work (no AI attribution).
- Weekday convention Luxon (1=Mon..7=Sun). Server uses `supabaseAdmin`.

## File Structure

- `supabase/migrations/0036_org_booker_layout.sql` (create) — add the column.
- `src/lib/db/types.ts` (modify) — add `booker_layout` to `Organization`.
- `src/lib/booking/layout.ts` (create) — pure `normalizeBookerLayout(value): 'strip' | 'month'`.
- `scripts/test-booker-layout.ts` (create) — tests for the pure normalizer.
- `src/app/book/page.tsx` (modify) — resolve the bucket's org layout, pass `layout` prop.
- `src/components/Booker.tsx` (modify) — accept `layout`, switch the picker region, remove the `bucket.name` line.
- `src/components/BookerStrip.tsx` (create) — the strip date picker (presentational, keyboard-navigable).
- `src/app/admin/page.tsx` (modify) — add a `setOrgBookerLayout` server action + a toggle next to the existing org-defaults form.

---

## Task 1: `booker_layout` column + pure normalizer

**Files:**
- Create: `supabase/migrations/0036_org_booker_layout.sql`
- Modify: `src/lib/db/types.ts` (the `Organization` interface, ~line 22)
- Create: `src/lib/booking/layout.ts`
- Test: `scripts/test-booker-layout.ts`

**Interfaces:**
- Produces: `type BookerLayout = 'strip' | 'month'`; `normalizeBookerLayout(value: unknown): BookerLayout` — returns `'month'` only for exactly `'month'`, else `'strip'` (safe default for null/garbage/legacy rows).

- [ ] **Step 1: Write the failing test**

```ts
// scripts/test-booker-layout.ts
import { normalizeBookerLayout } from "../src/lib/booking/layout.ts";
let failures = 0;
const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); failures++; } else console.log("ok:", m); };

assert(normalizeBookerLayout("month") === "month", "'month' stays month");
assert(normalizeBookerLayout("strip") === "strip", "'strip' stays strip");
assert(normalizeBookerLayout(null) === "strip", "null -> strip (default)");
assert(normalizeBookerLayout(undefined) === "strip", "undefined -> strip");
assert(normalizeBookerLayout("garbage") === "strip", "unknown -> strip");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run → FAIL** (`node --experimental-strip-types scripts/test-booker-layout.ts`): module missing.

- [ ] **Step 3: Implement the normalizer**

```ts
// src/lib/booking/layout.ts
export type BookerLayout = "strip" | "month";

/** Safe coercion: only the exact string "month" selects the month grid; anything
 *  else (null/legacy/garbage) falls back to the strip default. */
export function normalizeBookerLayout(value: unknown): BookerLayout {
  return value === "month" ? "month" : "strip";
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Write the migration** (unqualified table name; ALTER so no RLS-lint concern)

```sql
-- supabase/migrations/0036_org_booker_layout.sql
-- Org-wide booker date-picker layout: 'strip' (default, next-few-days) or 'month'.
alter table organizations
  add column if not exists booker_layout text not null default 'strip';
```

- [ ] **Step 6: Add the column to the hand-written type** — in `src/lib/db/types.ts`, add to `interface Organization` (after `default_weekdays`): `booker_layout: string;`

- [ ] **Step 7: Run the full suite + typecheck.**

Run: `npx tsc --noEmit && pnpm test`
Expected: green (incl. `test-migrations` and `test-booker-layout`).

- [ ] **Step 8: Apply the migration to the linked DB.**

Run: `npx supabase db push` (applies 0036)
Expected: "Finished supabase db push."

- [ ] **Step 9: Commit.**

```bash
git add supabase/migrations/0036_org_booker_layout.sql src/lib/db/types.ts src/lib/booking/layout.ts scripts/test-booker-layout.ts
git commit -m "Add org booker_layout column + pure layout normalizer"
```

---

## Task 2: `/book` reads the org layout and passes it to Booker

**Files:**
- Modify: `src/app/book/page.tsx`

**Interfaces:**
- Consumes: `normalizeBookerLayout` (Task 1); existing `resolveBucketByCode` (`src/lib/availability/service.ts`) which returns `{ bucket: { org_id }, ... }`.
- Produces: `<Booker layout={BookerLayout} … />` — Task 3 reads this prop.

- [ ] **Step 1: Resolve the org layout in the server page.** In `src/app/book/page.tsx`, after `bucketCode` is known and before rendering `<Booker>`, look up the bucket's org layout. Use `supabaseAdmin`; one indexed read, off the cached availability path:

```ts
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeBookerLayout } from "@/lib/booking/layout";

// …inside the component, after bucketCode:
const { data: bucketRow } = await supabaseAdmin()
  .from("buckets")
  .select("organizations(booker_layout)")
  .eq("code", bucketCode)
  .maybeSingle();
const layout = normalizeBookerLayout(
  (bucketRow as { organizations?: { booker_layout?: string } } | null)
    ?.organizations?.booker_layout,
);
```

- [ ] **Step 2: Pass the prop.** Add `layout={layout}` to the `<Booker … />` element.

- [ ] **Step 3: Build + lint.**

Run: `pnpm build && pnpm lint`
Expected: green (Booker will accept the prop after Task 3; if building Task 2 alone, add the optional prop in Task 3 first or land them together).

- [ ] **Step 4: Commit.**

```bash
git add src/app/book/page.tsx
git commit -m "Read org booker_layout in /book and pass it to the Booker"
```

---

## Task 3: Booker accepts `layout`, switches the picker, drops the bucket name

**Files:**
- Modify: `src/components/Booker.tsx`

**Interfaces:**
- Consumes: `layout` prop; `BookerStrip` (Task 4).
- Produces: renders `BookerCalendar` when `layout === 'month'`, else `BookerStrip`.

- [ ] **Step 1: Add the prop.** In `BookerProps` add `layout?: BookerLayout;` (import the type from `@/lib/booking/layout`); default it in the destructure: `layout = "strip"`.

- [ ] **Step 2: Remove the leaked bucket name.** Delete the event-panel line:
`<p className={`text-xs font-medium ${c.muted}`}>{meta?.bucket.name ?? ""}</p>` (the org avatar + event name + description remain).

- [ ] **Step 3: Switch the picker region.** Replace the single `<BookerCalendar … />` in the calendar `<section>` with a conditional. Keep ALL existing props/handlers; the strip reuses the same `slotsByDay`/`activeDay`/select handlers:

```tsx
{layout === "month" ? (
  <BookerCalendar
    /* …all existing props unchanged… */
  />
) : (
  <BookerStrip
    today={today}
    availableDays={[...slotsByDay.keys()].sort()}
    activeDay={activeDay}
    zone={zone}
    onSelect={(iso) => { setSelectedDay(iso); setSelectedSlot(null); }}
  />
)}
```

For `'strip'`, render it in a 2-column grid (`md:grid-cols-[260px_1fr]`) instead of the 3-column month grid: the strip sits above the times list in the right region. (Keep the 3-column grid for `'month'`.) Gate the grid class on `layout`.

- [ ] **Step 4: Visual verify (deferred to Task 6).** Build + lint now:

Run: `pnpm build && pnpm lint`
Expected: green.

- [ ] **Step 5: Commit.**

```bash
git add src/components/Booker.tsx
git commit -m "Switch booker picker by layout + remove leaked bucket name"
```

---

## Task 4: `BookerStrip` component

**Files:**
- Create: `src/components/BookerStrip.tsx`
- Test: `scripts/test-booker-strip-days.ts` (pure day-label helper only)

**Interfaces:**
- Consumes: `today: DateTime`, `availableDays: string[]` (ISO dates, sorted), `activeDay: string | null`, `zone: string`, `onSelect: (iso: string) => void`.
- Produces: a horizontal day-chip strip; clicking/Enter selects a day. Pure helper `stripDayLabel(iso, today, zone): string` ("Today" | "Tomorrow" | weekday like "Thu").

- [ ] **Step 1: Failing test for the label helper**

```ts
// scripts/test-booker-strip-days.ts
import { DateTime } from "luxon";
import { stripDayLabel } from "../src/components/booker-strip-labels.ts";
let failures = 0;
const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); failures++; } else console.log("ok:", m); };
const tz = "America/New_York";
const today = DateTime.fromISO("2026-06-18", { zone: tz });
assert(stripDayLabel("2026-06-18", today, tz) === "Today", "today -> Today");
assert(stripDayLabel("2026-06-19", today, tz) === "Tomorrow", "tomorrow -> Tomorrow");
assert(stripDayLabel("2026-06-20", today, tz) === "Sat", "later -> weekday abbr");
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement the pure helper**

```ts
// src/components/booker-strip-labels.ts
import { DateTime } from "luxon";
export function stripDayLabel(iso: string, today: DateTime, zone: string): string {
  const d = DateTime.fromISO(iso, { zone });
  const days = Math.round(d.startOf("day").diff(today.startOf("day"), "days").days);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return d.toFormat("ccc");
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Implement the component** (presentational; Pennie tokens; keyboard nav mirrors `BookerCalendar`'s roving tabindex — Left/Right move, Enter/Space select). Chips show `stripDayLabel` (uppercase, muted) + the day number; selected chip = navy fill (light) / sky per theme; empty list handled by the Booker's existing slot-list states.

```tsx
// src/components/BookerStrip.tsx
"use client";
import { DateTime } from "luxon";
import { stripDayLabel } from "./booker-strip-labels";

export function BookerStrip({
  today, availableDays, activeDay, zone, onSelect,
}: {
  today: DateTime;
  availableDays: string[];
  activeDay: string | null;
  zone: string;
  onSelect: (iso: string) => void;
}) {
  return (
    <div role="group" aria-label="Available days" className="flex gap-2 overflow-x-auto">
      {availableDays.length === 0 ? (
        <p className="text-sm text-fg-muted">No times available in the next few days.</p>
      ) : (
        availableDays.map((iso) => {
          const d = DateTime.fromISO(iso, { zone });
          const selected = iso === activeDay;
          return (
            <button
              key={iso}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(iso)}
              className={`flex min-h-11 flex-1 flex-col items-center rounded-lg border px-3 py-2 tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky ${
                selected
                  ? "border-fg bg-fg text-bg"
                  : "border-border text-fg hover:border-pennie-sky"
              }`}
            >
              <span className="text-[11px] uppercase tracking-wide opacity-70">
                {stripDayLabel(iso, today, zone)}
              </span>
              <span className="text-lg font-semibold">{d.toFormat("d")}</span>
            </button>
          );
        })
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the day-label test + build.** `node --experimental-strip-types scripts/test-booker-strip-days.ts` PASS; `pnpm build` green.

- [ ] **Step 7: Commit.**

```bash
git add src/components/BookerStrip.tsx src/components/booker-strip-labels.ts scripts/test-booker-strip-days.ts
git commit -m "Add BookerStrip date picker (keyboard-navigable day chips)"
```

---

## Task 5: Admin toggle for the org layout

**Files:**
- Modify: `src/app/admin/page.tsx`

**Interfaces:**
- Consumes: existing admin server-action + org-defaults form pattern (`setOrgDefaultHours`, ~line 517) and `supabaseAdmin`.
- Produces: `setOrgBookerLayout` server action; a two-option control writing `organizations.booker_layout`.

- [ ] **Step 1: Add the server action** (mirror `setOrgDefaultHours`: same auth guard, `"use server"`, read the org id the same way that action does, then update):

```ts
async function setOrgBookerLayout(formData: FormData) {
  "use server";
  // (reuse the exact admin auth guard + org-id resolution setOrgDefaultHours uses)
  const layout = formData.get("booker_layout") === "month" ? "month" : "strip";
  await supabaseAdmin().from("organizations").update({ booker_layout: layout }).eq("id", orgId);
  revalidatePath("/admin");
}
```

- [ ] **Step 2: Render the toggle** near the org-defaults form: a small `<form action={setOrgBookerLayout}>` with two radios (Strip / Month) defaulting to the current `org.booker_layout`, and a save button styled with the existing admin classes. Label it "Booker calendar layout".

- [ ] **Step 3: Build + lint.** `pnpm build && pnpm lint` green.

- [ ] **Step 4: Commit.**

```bash
git add src/app/admin/page.tsx
git commit -m "Admin: org-wide booker layout toggle"
```

---

## Task 6: Verification sweep + PR

- [ ] **Step 1: Full checks.** `pnpm test && pnpm build && pnpm lint` all green.

- [ ] **Step 2: Visual verify (slate-ui-verification).** Deploy to a previewable state or run against the dev server with motion frozen (AGENTS.md). For BOTH `booker_layout` values and BOTH themes (light/dark): screenshot `/book?xbc=<live code>`, confirm the strip shows next-few-days chips + full times and the month grid is unchanged; run axe; check contrast (sky-on-surface, graphite-on-sky); Lighthouse. Confirm the bucket name is gone from the event panel.

- [ ] **Step 3: Embed resize.** In an embed/iframe context, switch days in the strip and confirm the iframe height tracks (`slate:resize`) with no clipped slot list, in both layouts.

- [ ] **Step 4: Push + PR.**

```bash
SKIP_TEST_CHECK=1 git push -u origin feat/booker-layout-strip
gh pr create --title "Booker layout: strip default + month grid setting" --body "PR2 of precompute-availability. Adds the strip date picker (default) + an org-wide layout setting, removes the leaked bucket name. Spec: docs/superpowers/specs/2026-06-19-booker-layout-strip-design.md. Stacked on #256; rebase after it merges. Verified both layouts in both themes (axe/contrast/Lighthouse) + embed resize."
```

- [ ] **Step 5:** Confirm CI green (`gh pr checks`), fixing any failure before claiming done.

## Self-Review notes

- **Spec coverage:** storage+normalizer (T1), data flow (T2), Booker switch + bucket-name removal (T3), strip component + keyboard + empty state (T4), admin toggle (T5), responsive/embed/themes/a11y verification (T6). All spec sections mapped.
- **Type consistency:** `BookerLayout` from `@/lib/booking/layout` used in T1/T2/T3; `normalizeBookerLayout` same signature throughout; `stripDayLabel` defined T4 used only T4.
- **Stacking:** T2 (prop pass) and T3 (prop accept) are coupled — land together if building strictly task-by-task, or order T3 before T2's build step.

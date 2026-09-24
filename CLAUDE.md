@AGENTS.md

# Slate

Cal.com-style booking for Pennie. Routes landing-page bookings to a round-robin
pool of agents ("debt buckets"), syncs Google Calendar, embeds via `widget.js`,
emits webhooks to Regal/Cadence. See `README.md` for setup + the URL contract.

## Stack

Next.js 16 (App Router, TS) · Supabase (Postgres + Auth) · googleapis · Tailwind
v4 · Luxon. Package manager: pnpm.

## Architecture notes

- **Availability is cache-first.** `busy_blocks` is the cached index: Slate
  bookings write through synchronously; Google push (`/api/google/push`) +
  the 1-min `/api/cron/sync` backstop keep external changes fresh. The embed
  reads the cache via `/api/availability` — never live Google. The recompute lane
  computes once per POOL rather than once per bucket code (#2245: 60 codes, 15
  pools) and writes every code in the pool its own row, each keeping its own
  bucket identity; see AGENTS.md before changing what feeds the compute. The only
  live Google call on the hot path is verify-on-book at confirm time
  (`src/lib/booking/service.ts`): it checks the round-robin candidates in batched
  waves (one Google call per wave, #167) and takes the first actually-free agent.
- **A bookable time passes three availability gates, in one shared predicate.**
  `bookableSlotReason` (`src/lib/availability/compute.ts`) is the only judge: the
  ORG's business hours (#1295), then the AGENT's working hours, then their
  calendar. The org window comes from `business_hours` via `loadBusinessHours`,
  which THROWS on an unreadable week rather than degrading, because serving
  unfiltered hours would silently re-open a narrowing and look like a healthy day.
  The two hour windows are each judged in their OWN zone and never intersected:
  clipping is correct only for an agent in the business zone. **The roster is NOT
  all Eastern** (#1739, corrected 2026-09-02): it spans seven zones, 27 in Phoenix
  and 16 in Los Angeles among them, so production data now CAN tell the two apart
  and a mistake here is visible rather than theoretical. It used to read "every
  live agent is Eastern, so no production data can tell the two apart", which was
  true of the stored data and false about the world: every schedule said
  `America/New_York` because that was the seeded default nobody had edited.
  `scripts/test-availability-zones.ts`
  (#1316) is what does tell them apart: it drives a Pacific, a Tokyo and a London
  agent at instants where the correct answer and minute-clipping DISAGREE, including
  the org's day spanning two of the agent's local weekdays and the three weeks a year
  when only one of two zones has changed its clocks. Breaking the gates either
  plausible way (judging the agent in the org's zone, or intersecting the windows)
  makes it fail.
  `businessHours` is REQUIRED on `SlotRules` / `SlotComputeInput` so `tsc`
  enumerates every construction site.
- **A fourth gate is the LEAD's calling window** (#2310): a call may only start
  from 08:00 to before 20:00 in the lead's zone (the booker's zone, or the
  booking's own on an admin move), because Regal's quiet hours journey cancels
  anything else. It is judged in the lead's zone, separately from the org and
  agent windows and never intersected with them, by one predicate
  (`src/lib/booking/lead-calling-window.ts`). It is NOT in
  `bookableSlotReason` or the slot cache, which is shared by every lead: the
  shared picker (`pickerSlots`) filters the served list, and `createBooking` /
  `rescheduleBooking` refuse with `OutsideCallingWindowError` before any write.
- **The org window is ALSO applied at read time** (#1296), because a slot computed
  under a wider window can still be sitting in the slot cache after a narrowing.
  `resolveBucketSlots` filters every tier (cache hit, stored row, cold compute)
  through `slotsWithinBusinessHours`, so an edit lands on the next request rather
  than the next recompute. The cache keeps the UNFILTERED payload so re-opening a
  day is just as immediate as closing one. The hours come from
  `loadBusinessHoursCached`, one read per isolate per `BUSINESS_HOURS_TTL_MS`
  (pinned equal to `SLOT_TTL_SECONDS` by `scripts/test-business-hours-ttl.ts`); a
  failed refresh serves the LAST KNOWN week rather than failing the request, which
  stays honest because a sustained failure stops recompute writing and
  `bucket_slots_stale` pages. Consequence: the stored row and the served response
  may disagree for up to one recompute cycle, deliberately. Mass invalidation was
  rejected because marking 60+ buckets stale can page a false stale alarm.
  Anything counting cached slots must use the same filter, which is why
  `slotHealthByCode` takes the hours and returns `null` (not 0) for a count it
  could not measure.
- **Server code uses the secret-key client** (`supabaseAdmin`, bypasses RLS; the
  new-style `sb_secret_…` key — anon/service_role JWTs are legacy).
  RLS is default-deny; the only client-readable row is a user reading itself.
- **DB types are hand-written** (`src/lib/db/types.ts` + `schema.ts`). Regenerate
  with `supabase gen types typescript` once a project is linked.
- Weekday convention is Luxon's (1=Mon..7=Sun).

## Design Context

Slate's UI follows the **Pennie Design System**. Full context in `.impeccable.md`;
source of truth is the exported system at
`~/Documents/Pennie Branding/Pennie Design System/` (port `colors_and_type.css` tokens +
`.pn-*` classes and `assets/`; use CSS variables, never raw hex). This export
**supersedes** the older markdown `pennie-brand.skill` on any conflict.

- **Color (80/15/5).** Beige `#F9F6F0` / White surfaces dominate; Navy `#1D212F` for
  occasional hero/stat/footer bands; Graphite `#343434` text. **Sky `#82D0FF` is the only
  action color** (primary CTA = sky fill + graphite text). Yellow/mint/peach are
  illustration/accent only — never CTAs. No hard black; errors use muted rose `#C43D3D`.
- **Type.** PP Mori only — **200 / 400 / 600** (no Medium; 700→600; `font-synthesis:none`).
  Body = Regular 400; headings = SemiBold 600 (the signature weight, never 700/800).
  Tabular numerals on rates/payments/stats. No Helvetica Now Display.
- **Shape.** Buttons & cards 16px radius (not pills); large bands 24px; chips 4px; pills
  (999px) for badges only. Soft `--shadow-*` tokens — never a hard black drop shadow.
- **Voice.** Warm, plain, optimistic — a financial *partner*, not a bank. Verb-phrase
  button copy ("View my offers", "Continue", never "Submit"). Always disclose rates;
  never guarantee ("may / up to / based on eligibility"). Pennie is a lending marketplace,
  NOT the PA health-insurance pennie.com.
- **Surfaces.** Consumer Booker defaults to beige/light (embed host can override to dark;
  both themes maintained). Internal admin/me/login support light **and** dark.
- **Accessibility: WCAG 2.1 AA + extra care** — visible sky focus ring, full keyboard nav,
  honor `prefers-reduced-motion`, color never the sole signal, 44px+ targets. Verify
  sky-on-beige and graphite-on-sky contrast actually pass.
- **Booker treatment:** clean, focused booking steps; one branded delight moment
  (illustration + warm copy) on the confirmation/success screen.

## Brand Redesign Orchestration

A phased plan to apply the Pennie Design System across all of Slate's UI. Run with `/start`.

| What | Where |
|------|-------|
| **Top authority** | `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` (D1–D22) |
| **Action plan** | `.claude/orchestration-slate-brand-redesign/PHASES.md` — 28 tasks / 5 phases |
| **Progress tracker** | `.claude/orchestration-slate-brand-redesign/PROGRESS.md` |
| **Orchestrator** | `.claude/orchestration-slate-brand-redesign/START.md` |
| **Task files** | `.claude/orchestration-slate-brand-redesign/tasks/phase-N/task-N-M.md` |
| **Research** | `.claude/orchestration-slate-brand-redesign/research/` (8 files) |
| **Reports** | `.claude/orchestration-slate-brand-redesign/reports/` |

**Authority rule:** DISCOVERY.md overrides everything; if unsure, ask the human.

**Scope (DO NOT change):** booking logic, availability cache, Google sync, round-robin,
webhooks, auth/RBAC, server actions, DB. This is a **visual-only** redesign. Don't break the
cal.com embed contract; keep it Cloudflare-deployable.

**Surfaces & verify:** Code (`pnpm build`/`lint`/`test`) + Browser (Playwright MCP snapshot/
screenshot both themes, axe, `npx lighthouse`; Peekaboo CLI fallback). Sandbox Bash may lack
`curl`/coreutils — use Node `fetch`.

**Skills (read before restyling):** `pennie-design-system-in-slate` (tokens/fonts/assets/
theming), `slate-ui-verification` (verify any surface), `slate-embed-contract` (widget.js).

**Phases:** 1 Foundation → 2 Booker → 3 Internal pages → 4 Embed + a11y → 5 Comprehensive
verification. Each phase ends with a verification sweep.

**Subagents:** read your task file first, then PROGRESS.md, then the skills it lists; run the
Execute→Verify→retry(≤3)→escalate loop; record evidence in PROGRESS.md.


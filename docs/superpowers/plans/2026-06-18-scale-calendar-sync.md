# Scale the Calendar Sync to the Full Roster (#238) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the every-minute backstop sync cron keep ~100-200 bookable agents' calendars watched and fresh without ever blowing its time budget, instead of spending ~100s on first-time watch setup and skipping the sync for everyone (the cutover blocker found in #238).

**Architecture:** Three changes to the cron tick only — (1) put the WHOLE agent loop under one wall-clock budget with a hard `break` so it stops cleanly at the deadline instead of running watch-setup for every remaining agent; (2) cap how many *brand-new* agents (no calendars stored yet) get onboarded per tick, since onboarding is the only ~2-Google-calls-per-agent step; (3) order agents least-recently-synced-first using a new `users.last_synced_at` timestamp so successive ticks rotate through the roster instead of re-processing the same first N. No change to what a sync *produces* per calendar — only how the tick is paced and ordered. Real-time freshness already comes from Google push (`/api/google/push` → `syncByChannel`); the cron is a backstop + watch renewer, so covering the roster over several ticks is correct, not a regression.

**Tech Stack:** Next 16 (App Router) / OpenNext on Cloudflare Workers, Supabase (Postgres via `supabaseAdmin` secret-key client), googleapis-over-fetch with domain-wide delegation. Node-native tests (`scripts/test-*.ts`, run with `node --experimental-strip-types`). Luxon not involved here.

## Global Constraints

- **Visual-only-redesign scope does NOT apply here** — this is the explicitly in-scope sync/availability backend, not UI. But still: do NOT change booking logic, the availability cache read path, round-robin, webhooks, auth/RBAC, or the embed contract.
- Do NOT change what `syncCalendar` / `runIncrementalSync` produce per calendar: `busy_blocks` write-through, sync-token advance semantics, the `SyncTokenExpired`→bootstrap path, `purgeVanished` after a full sync, and the #30 push-path coalescing in `syncByChannel` are all unchanged. Only the cron's loop pacing + agent ordering + onboarding cadence change.
- The tick must respect a single wall-clock budget (`SYNC_TICK_BUDGET_MS`, currently 25_000) across BOTH watch setup and calendar sync, and must finish well under the Worker CPU/time limit so it never holds the `cron_sync` lock (`CRON_LOCK_TTL_MS` = 5 min) for ~2 minutes.
- Fail-soft per agent: one agent's watch or sync error must never abort the tick (already true via the per-agent try/catch and `ensureWatches` never throwing — preserve it).
- DB types are hand-written (`src/lib/db/types.ts`). Any schema change ships a numbered migration in `supabase/migrations/` (next number is `0034`) AND the matching hand-edit to `types.ts`. Migrations are applied with `supabase db push` (the human runs this — note it in the task, don't assume it ran).
- TypeScript everywhere, no `any`. 2-space indent, existing Prettier/ESLint. New work on a fresh branch off `origin/main`; `pnpm test` / `pnpm build` / `pnpm lint` green; small PR.

## Root cause (confirmed from `src/app/api/cron/sync/route.ts` + `src/lib/google/sync.ts` + #238 Worker logs)

The cron loop (`route.ts:102-117`) iterates every bookable agent and, per agent, calls `ensureWatches(userId)` then `runIncrementalSync(userId, deadlineMs)`:

1. **`ensureWatches` is cheap in steady state but expensive on first-time onboarding.** For an agent that already has `agent_calendars` rows with healthy watches it returns `{status:"current"}` after a single DB read, no Google call (`sync.ts:260-266`). But for a brand-new agent (`existing.length === 0`) it enters the try-block and makes ~2 sequential Google calls: `listCalendars(email)` then `watchCalendar(...)` per calendar (`sync.ts:268-318`). At the #238 flip, all ~110 agents hit that path at once → ~220 serial Google calls ≈ the observed ~100s.
2. **The loop never breaks on the deadline, and `ensureWatches` runs first for every agent unconditionally.** `deadlineMs` is only consumed *inside* `runIncrementalSync` (`sync.ts:159`), so once the budget is blown the loop still calls `ensureWatches` for every remaining agent. The whole run overruns to ~100-124s, holds the `cron_sync` lock, and the next minute-ticks skip with `{skipped:"overlapping-run"}` → the roster stalls at ~10/112 synced.
3. **No rotation signal exists.** Agents are processed in the DB's default order every tick, so after an overrun the *same* first agents are retried and the tail never gets reached. There is no "last synced" timestamp: `sync_token` is per-calendar (null = never bootstrapped, not a time), and `sync_claimed_at` is set only on the push path and nulled right after — neither is usable for least-recently-synced ordering. We add `users.last_synced_at`.

Why this is safe to pace across ticks: watches live ~7 days and renew 3 days early (`WATCH_RENEW_THRESHOLD_MS`, `sync.ts:30`), and once an agent is watched, Google **push** keeps their `busy_blocks` fresh in real time via `syncByChannel`. The cron is a backstop — it only needs to onboard new agents gradually, renew watches before they lapse, and re-sync a rotating slice as a safety net. Covering 200 agents over a handful of minutes is the intended behavior.

## File Structure

- `src/lib/google/sync-pace.ts` (**create**) — pure, side-effect-free pacing/ordering helpers: `withinBudget`, `MAX_ONBOARDS_PER_TICK`, `orderAgentsForTick`, `shouldOnboard`. Mirrors the existing pure-helper pattern in `sync-coalesce.ts`. Unit-tested in isolation — this is where all the testable logic lives.
- `scripts/test-sync-pace.ts` (**create**) — node-native tests for the pure helpers (mirrors `scripts/test-sync-coalesce.ts`).
- `supabase/migrations/0034_users_last_synced_at.sql` (**create**) — add the `last_synced_at timestamptz` column.
- `src/lib/db/types.ts` (**modify**, `interface User`) — add `last_synced_at: string | null`.
- `src/lib/google/sync.ts` (**modify**) — add a DB-only `loadSyncAgents()` that returns each bookable agent's `{ userId, hasCalendars, lastSyncedMs }` in as few queries as possible (no Google calls), and a `markAgentSynced(userId)` that stamps `users.last_synced_at`.
- `src/app/api/cron/sync/route.ts` (**modify**) — rewrite the loop to use the pure helpers: order agents, break on the shared deadline, only onboard up to the per-tick cap, stamp `last_synced_at` after each agent.

Out of scope (do NOT touch): the per-calendar sync logic in `sync.ts` (`syncCalendar`/`runIncrementalSync`/`applyEvents`/`purgeVanished`), `syncByChannel` (push path), `ensureWatches`' internals, the `/api/google/push` handler, the availability read path.

---

## Task 1: Pure pacing + ordering helpers

**Files:**
- Create: `src/lib/google/sync-pace.ts`
- Test: `scripts/test-sync-pace.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `withinBudget(nowMs: number, deadlineMs: number | null): boolean` — `true` while there is budget left (`deadlineMs === null` means "no budget" → always `true`; otherwise `nowMs < deadlineMs`). This is the positive form the cron loop guards on (the inverse of `sync-coalesce.ts`'s `pastDeadline`).
  - `MAX_ONBOARDS_PER_TICK: number` (= 10) — cap on brand-new agents onboarded per tick.
  - `SyncAgent` type: `{ userId: string; hasCalendars: boolean; lastSyncedMs: number | null }`.
  - `orderAgentsForTick(agents: SyncAgent[]): SyncAgent[]` — returns a new array ordered least-recently-synced first: agents never synced (`lastSyncedMs === null`) come first, then ascending `lastSyncedMs`; stable within ties.
  - `shouldOnboard(agent: SyncAgent, onboardedSoFar: number, cap?: number): boolean` — `true` when the agent needs first-time onboarding (`!hasCalendars`) AND `onboardedSoFar < cap` (default `MAX_ONBOARDS_PER_TICK`). For an already-onboarded agent (`hasCalendars`) it returns `false` (no onboarding needed — the cron still syncs them; see Task 4).

- [ ] **Step 1: Write the failing test** — create `scripts/test-sync-pace.ts`:

```ts
import {
  withinBudget,
  orderAgentsForTick,
  shouldOnboard,
  MAX_ONBOARDS_PER_TICK,
  type SyncAgent,
} from "../src/lib/google/sync-pace.ts";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
};

// withinBudget
ok(withinBudget(100, 200) === true, "within budget when now < deadline");
ok(withinBudget(200, 200) === false, "at deadline is out of budget");
ok(withinBudget(250, 200) === false, "past deadline is out of budget");
ok(withinBudget(999, null) === true, "null deadline always has budget");

// cap is a small positive number
ok(
  MAX_ONBOARDS_PER_TICK > 0 && MAX_ONBOARDS_PER_TICK <= 25,
  "onboard cap is a small positive number",
);

// orderAgentsForTick: never-synced first, then oldest-synced first, stable
const agents: SyncAgent[] = [
  { userId: "synced-old", hasCalendars: true, lastSyncedMs: 1000 },
  { userId: "never-a", hasCalendars: false, lastSyncedMs: null },
  { userId: "synced-new", hasCalendars: true, lastSyncedMs: 5000 },
  { userId: "never-b", hasCalendars: false, lastSyncedMs: null },
];
const order = orderAgentsForTick(agents).map((a) => a.userId);
ok(order[0] === "never-a" && order[1] === "never-b", "never-synced agents first, stable order");
ok(order[2] === "synced-old" && order[3] === "synced-new", "then oldest-synced first (rotation)");
ok(agents[0].userId === "synced-old", "orderAgentsForTick does not mutate input");

// shouldOnboard: only un-onboarded agents, only under the cap
const newAgent: SyncAgent = { userId: "n", hasCalendars: false, lastSyncedMs: null };
const oldAgent: SyncAgent = { userId: "o", hasCalendars: true, lastSyncedMs: 1 };
ok(shouldOnboard(newAgent, 0, 3) === true, "onboard a new agent under the cap");
ok(shouldOnboard(newAgent, 3, 3) === false, "do not onboard once the cap is reached");
ok(shouldOnboard(oldAgent, 0, 3) === false, "never 'onboard' an already-onboarded agent");

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types scripts/test-sync-pace.ts`
Expected: FAIL — module `../src/lib/google/sync-pace.ts` does not exist (import error).

- [ ] **Step 3: Write the minimal implementation** — create `src/lib/google/sync-pace.ts`:

```ts
/**
 * Pure helpers for pacing the every-minute backstop sync cron across a large
 * agent roster (#238). The cron is a backstop + watch renewer (real-time
 * freshness comes from Google push), so it bounds its own work per tick and
 * rotates least-recently-synced agents first instead of re-processing the same
 * head of the list every minute. Exercised by scripts/test-sync-pace.ts.
 */

/** Cap on brand-new agents onboarded (first watch setup) per cron tick. */
export const MAX_ONBOARDS_PER_TICK = 10;

export interface SyncAgent {
  userId: string;
  /** Whether the agent already has agent_calendars rows (DB-only check). */
  hasCalendars: boolean;
  /** users.last_synced_at as epoch ms, or null if never synced by the cron. */
  lastSyncedMs: number | null;
}

/**
 * True while the tick still has budget. A null deadline means "unbounded"
 * (used by callers that pass no budget) and always returns true. The positive
 * form the cron loop guards on; inverse of sync-coalesce.ts pastDeadline.
 */
export function withinBudget(nowMs: number, deadlineMs: number | null): boolean {
  return deadlineMs === null || nowMs < deadlineMs;
}

/**
 * Least-recently-synced first: never-synced agents (lastSyncedMs null) lead,
 * then ascending lastSyncedMs. Stable within each group so the DB's order is
 * preserved among ties. Returns a new array; never mutates the input.
 */
export function orderAgentsForTick(agents: SyncAgent[]): SyncAgent[] {
  return [...agents].sort((a, b) => {
    const an = a.lastSyncedMs === null;
    const bn = b.lastSyncedMs === null;
    if (an !== bn) return an ? -1 : 1; // nulls first
    if (an && bn) return 0; // both never-synced: stable
    return (a.lastSyncedMs as number) - (b.lastSyncedMs as number);
  });
}

/**
 * Whether to spend this tick's onboarding budget on this agent. Only agents
 * with no calendars yet need first-time watch setup (the ~2-Google-call path);
 * already-onboarded agents are synced without counting against the cap.
 */
export function shouldOnboard(
  agent: SyncAgent,
  onboardedSoFar: number,
  cap: number = MAX_ONBOARDS_PER_TICK,
): boolean {
  return !agent.hasCalendars && onboardedSoFar < cap;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types scripts/test-sync-pace.ts`
Expected: `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/google/sync-pace.ts scripts/test-sync-pace.ts
git commit -m "Add pure pacing/ordering helpers for the sync cron"
```

---

## Task 2: `last_synced_at` column + type

**Files:**
- Create: `supabase/migrations/0034_users_last_synced_at.sql`
- Modify: `src/lib/db/types.ts` (`interface User`)

**Interfaces:**
- Consumes: nothing.
- Produces: a `users.last_synced_at` column (nullable `timestamptz`) and `User.last_synced_at: string | null` for Task 3 to read/write.

This task has no unit test (a schema + type declaration is verified by `pnpm build`/`lint` and by Task 3's behavior). It is its own task because it is an independently reviewable, independently appliable migration.

- [ ] **Step 1: Write the migration** — create `supabase/migrations/0034_users_last_synced_at.sql`:

```sql
-- #238: least-recently-synced ordering for the backstop sync cron. Nullable;
-- null means "never synced by the cron" and sorts first (see sync-pace.ts).
alter table public.users
  add column if not exists last_synced_at timestamptz;
```

- [ ] **Step 2: Add the field to the hand-written type** — in `src/lib/db/types.ts`, inside `interface User`, add after the `bookable` field:

```ts
  /** When the backstop sync cron last processed this agent (#238 rotation); null = never. */
  last_synced_at: string | null;
```

- [ ] **Step 3: Verify the type compiles**

Run: `pnpm lint && npx tsc --noEmit`
Expected: no errors referencing `last_synced_at`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0034_users_last_synced_at.sql src/lib/db/types.ts
git commit -m "Add users.last_synced_at for sync cron rotation (#238)"
```

> **Apply note for the executor/human:** the migration must be applied to the live DB with `supabase db push` before the Task 4 cron change is deployed (the cron reads/writes the column). Flag this in the PR description; do not assume it has run.

---

## Task 3: DB-only agent loader + sync stamp

**Files:**
- Modify: `src/lib/google/sync.ts`

**Interfaces:**
- Consumes: `SyncAgent` type from `src/lib/google/sync-pace.ts` (Task 1); `User.last_synced_at` (Task 2); existing `supabaseAdmin` from `@/lib/supabase/admin`.
- Produces (both exported from `sync.ts`):
  - `loadSyncAgents(): Promise<SyncAgent[]>` — one or two DB reads (NO Google calls) returning every `bookable=true` agent as `{ userId, hasCalendars, lastSyncedMs }`. `hasCalendars` = the agent has ≥1 `agent_calendars` row; `lastSyncedMs` = `Date.parse(users.last_synced_at)` or `null`.
  - `markAgentSynced(userId: string): Promise<void>` — sets `users.last_synced_at = now()` for the agent (best-effort; logs on error, never throws).

- [ ] **Step 1: Add the loader and stamp to `src/lib/google/sync.ts`** (top-level exports; place after the existing `loadAgentCalendars` helper near line 47). Import the `SyncAgent` type at the top of the file.

Add to the imports block (the `@/lib/google/...` group):

```ts
import type { SyncAgent } from "@/lib/google/sync-pace";
```

Add the two functions:

```ts
/**
 * Every bookable agent's pacing facts for one cron tick — DB only, no Google
 * calls. `hasCalendars` distinguishes brand-new agents (need first-time watch
 * setup) from already-onboarded ones; `lastSyncedMs` drives rotation. Two
 * reads: the bookable users, then which of them have any agent_calendars row.
 */
export async function loadSyncAgents(): Promise<SyncAgent[]> {
  const db = supabaseAdmin();
  const { data: users } = await db
    .from("users")
    .select("id, last_synced_at")
    .eq("bookable", true);
  const rows = (users ?? []) as { id: string; last_synced_at: string | null }[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: cals } = await db
    .from("agent_calendars")
    .select("user_id")
    .in("user_id", ids);
  const withCalendars = new Set(
    ((cals ?? []) as { user_id: string }[]).map((c) => c.user_id),
  );

  return rows.map((r) => ({
    userId: r.id,
    hasCalendars: withCalendars.has(r.id),
    lastSyncedMs: r.last_synced_at ? Date.parse(r.last_synced_at) : null,
  }));
}

/** Stamp users.last_synced_at = now for rotation. Best-effort; never throws. */
export async function markAgentSynced(userId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("users")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) console.error(`markAgentSynced(${userId}) failed: ${error.message}`);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm lint && npx tsc --noEmit`
Expected: no errors.

> **Why no unit test here:** `loadSyncAgents`/`markAgentSynced` are thin DB adapters (Supabase query builder calls) with no branching logic worth isolating — the testable decisions all live in the Task 1 pure helpers, and the integration is verified live in Task 5. Adding a test would mean mocking the Supabase client, which the project's node-native test style does not do. This matches how `loadAgentCalendars`/`loadAgentEmail` in the same file are untested adapters.

- [ ] **Step 3: Commit**

```bash
git add src/lib/google/sync.ts
git commit -m "Add DB-only loadSyncAgents + markAgentSynced for the sync cron (#238)"
```

---

## Task 4: Wire pacing + capped onboarding + rotation into the cron

**Files:**
- Modify: `src/app/api/cron/sync/route.ts`

**Interfaces:**
- Consumes: `loadSyncAgents`, `markAgentSynced`, `ensureWatches`, `runIncrementalSync` from `@/lib/google/sync`; `withinBudget`, `orderAgentsForTick`, `shouldOnboard` from `@/lib/google/sync-pace`; `SYNC_TICK_BUDGET_MS`, `CRON_LOCK_TTL_MS` from `@/lib/google/sync-coalesce`.
- Produces: same JSON response shape as today plus two fields — `processed` (agents actually worked this tick) and `onboarded` (new agents set up this tick) — so the at-scale verification can watch progress.

- [ ] **Step 1: Replace the agent-fetch + loop** in `src/app/api/cron/sync/route.ts`. Update the import on line 4 from:

```ts
import { ensureWatches, runIncrementalSync } from "@/lib/google/sync";
```

to:

```ts
import {
  ensureWatches,
  runIncrementalSync,
  loadSyncAgents,
  markAgentSynced,
} from "@/lib/google/sync";
import {
  withinBudget,
  orderAgentsForTick,
  shouldOnboard,
} from "@/lib/google/sync-pace";
```

Then replace the body from the `const { data } = await supabaseAdmin()...` block (currently lines 85-117, ending at the close of the `for` loop) with:

```ts
    // Bookable agents with their pacing facts (DB only, no Google calls).
    const agents = orderAgentsForTick(await loadSyncAgents());
    // One budget for the whole tick (#44/#238): we BREAK at the deadline so
    // watch setup can't run for every remaining agent after the budget is
    // spent. Unreached agents are picked up next tick (rotation makes them
    // sort first). Real-time freshness meanwhile comes from Google push.
    const deadlineMs = Date.now() + SYNC_TICK_BUDGET_MS;
    const results: {
      userId: string;
      watch: string;
      watchError?: string;
      synced?: number;
      truncated?: boolean;
      error?: string;
    }[] = [];
    let onboarded = 0;
    for (const agent of agents) {
      if (!withinBudget(Date.now(), deadlineMs)) break;
      // A brand-new agent needs ~2 Google calls to set up watches; cap how many
      // we onboard per tick so a fresh roster drains over several minutes
      // instead of blowing the budget in one ~100s run. Already-onboarded
      // agents are always processed (their ensureWatches is a cheap DB read
      // unless a renewal is genuinely due).
      if (!agent.hasCalendars && !shouldOnboard(agent, onboarded)) continue;

      const watch = await ensureWatches(agent.userId);
      if (!agent.hasCalendars && watch.status === "renewed") onboarded++;
      const row: (typeof results)[number] = {
        userId: agent.userId,
        watch: watch.status,
        ...(watch.status === "error" ? { watchError: watch.error } : {}),
      };
      try {
        const sync = await runIncrementalSync(agent.userId, deadlineMs);
        row.synced = sync.events;
        if (sync.truncated) row.truncated = true;
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err);
      }
      await markAgentSynced(agent.userId);
      results.push(row);
    }
```

Then update the response line (currently line 124) from:

```ts
    return NextResponse.json({ agents: userIds.length, watchErrors, truncated, results });
```

to:

```ts
    return NextResponse.json({
      agents: agents.length,
      processed: results.length,
      onboarded,
      watchErrors,
      truncated,
      results,
    });
```

And update the two alert calls (currently lines 120-121) that referenced `userIds.length` to use `results.length` (the agents actually processed this tick):

```ts
    const watchErrors = results.filter((r) => r.watch === "error").length;
    await alertWatchLapse(watchErrors, results.length);
    await alertSyncFailures(results.filter((r) => r.error), results.length);
```

- [ ] **Step 2: Verify it compiles and the suite is green**

Run: `pnpm lint && npx tsc --noEmit && pnpm test`
Expected: no type errors; existing tests pass (including `scripts/test-sync-pace.ts` and `scripts/test-sync-coalesce.ts`).

- [ ] **Step 3: Reason-check the budget math** (no code change — confirm in the PR description). With the cap at 10 onboards/tick and a 25s budget: a fresh 110-agent roster onboards ~10/tick → fully watched in ~11 ticks (~11 min), each tick doing ≤ ~20 Google calls (well under budget). Steady state: `ensureWatches` is a cheap DB read for watched agents, so the budget/rotation covers a rolling slice each minute while push keeps everyone real-time-fresh. No tick holds the `cron_sync` lock long enough to make the next tick skip.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/sync/route.ts
git commit -m "Pace the sync cron: budget break, capped onboarding, LRU rotation (#238)"
```

---

## Task 5: Verify at scale (post-merge, gated on the migration)

This task has no code; it is the at-scale verification that closes #238. It runs against the deployed Worker after Tasks 1-4 merge AND `supabase db push` has applied migration 0034.

- [ ] **Step 1:** Confirm `pnpm test` + `pnpm build` + `pnpm lint` are green on the branch and the PR notes the `supabase db push` requirement.

- [ ] **Step 2 (post-deploy, with a temporary roster flip):** Re-create the at-scale condition the way #238 was found: set the full roster `bookable=true` in prod (the team confirmed nobody is using Slate yet; restore after). A throwaway flip/status/restore script like the one used in the original investigation is fine; it must snapshot the currently-bookable ids and restore them, and the operator must run `restore` when done (and tear down any watches left on agents that end up non-bookable, which #239 later automated in PR #926). Then watch, over consecutive minutes:
  - the cron response `onboarded` climbs ~10/tick and `processed` stays bounded;
  - distinct agents with `busy_blocks` rises steadily across ticks to cover the roster within ~10-15 min (instead of stalling at ~10);
  - Worker cron wall-times (Cloudflare observability MCP, account Pennie `3e7f907a9c19e51417873e2cce4fbc5c`) stay well under the budget — no ~100s runs, no `{skipped:"overlapping-run"}` cascade.
- [ ] **Step 3:** Once the roster is actually watched and synced, re-run the fair Slate-vs-cal.com NY availability benchmark on a large bucket (~70 agents both sides) — the original goal #238 blocked. Then restore the roster and clean up.

## Self-Review notes

- **Spec coverage:** root cause has three parts (no deadline break / uncapped onboarding / no rotation) — Task 4 adds the break (part 1), the onboarding cap (part 2), and ordering (part 3); Tasks 1-3 provide the helpers, column, and loader those need. Task 5 verifies. All covered.
- **The fix is pacing + ordering, not new sync behavior** — `syncCalendar`, sync-token advance, `purgeVanished`, and the #30 push coalescing are untouched, so existing sync correctness holds.
- **Onboarding-cap detection is DB-only** (`hasCalendars` from one `agent_calendars` read), so deciding NOT to onboard an agent costs no Google call — the whole point.
- **Renewal spikes are handled by the deadline break + rotation, not a separate cap:** watches created together (e.g. a flip) come due together, but renewals have a 3-day window before expiry, and least-recently-synced ordering spreads them across many ticks; the break caps any single tick's work. The onboarding counter increments only on `watch.status === "renewed"` for a previously-calendar-less agent, so it tracks genuine first-time setups.
- **`markAgentSynced` runs even on a per-agent sync error** (it's after the try/catch) — intentional: "we attempted this agent this tick" is what rotation needs, so a persistently-failing agent can't wedge the head of the queue and starve everyone behind it. The error is still recorded in `results` and surfaced to the existing streak alert.
- **Type consistency:** `SyncAgent` is defined once in `sync-pace.ts` (Task 1) and imported by both `sync.ts` (Task 3) and the cron (via the helpers); `last_synced_at: string | null` is consistent between the migration, `types.ts`, `loadSyncAgents`, and `markAgentSynced`.
- **Open risk to watch in Task 5:** if even the cheap steady-state path (DB-read `ensureWatches` + incremental `runIncrementalSync` per agent, sequential) can't cover the roster's *renewals* within budget at 200 agents, the next lever is bounded concurrency in the loop (the `mapWithConcurrency` pattern already used for #164) — deliberately deferred here to keep the first fix minimal and observable; add it only if Step 2 shows the budget still saturating after onboarding completes.

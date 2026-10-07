# The `is_test` synthetic-data convention

`is_test` is Slate's one marker for **synthetic test entities** (the smoke-test
agent and its isolated buckets). One boolean, set on the seeded smoke rows, makes
those entities invisible to internal staff, invisible to real consumer leads, and
unbookable on every public path, while the key-authed smoke test can still reach
them. It was added in migration `0051_test_flags.sql` as a follow-up to the smoke
test work (#396).

**If you need a new test fixture that should be hidden from staff and from the
public, reuse this marker. Do not invent a second hiding mechanism.** Every gate
below already respects `is_test`, so a row that sets it inherits all of them for
free. A parallel flag would have to re-implement all of them and would drift.

## Where the column lives

`0051_test_flags.sql` adds one column to each of two tables. Both default
`false`, both `not null`, so every existing and future real row is non-test
unless it explicitly opts in:

```sql
alter table public.users   add column if not exists is_test boolean not null default false;
alter table public.buckets add column if not exists is_test boolean not null default false;
```

- **`users.is_test`** marks a synthetic **agent**. A test agent is a real,
  bookable user row (it has working hours and is a member of test buckets) but is
  filtered out of every internal listing and never counted in routing/staffing.
- **`buckets.is_test`** marks a synthetic **bucket**. A test bucket is routable
  internally (the smoke test must still round-robin to the test agent inside it)
  but is hidden from public availability and unbookable by real leads.

Routing itself is **deliberately not gated** on `is_test`: the smoke test has to
route to the test agent inside its test buckets, so assignment must still see
them. The blocks live on the read side (UI and public availability) and on the
**public create** path, not in the round-robin.

## How the gates use it

### Public availability read (`src/app/api/availability/route.ts` + `slot-cache.ts`)

`GET /api/availability` is public and cached. A test bucket's slots must be
readable **only** by the key-authed smoke test:

1. The route resolves auth up front, DB-free, by parsing the bearer token against
   the env keys (`authenticateBearer`), producing `authorizedForTest`.
2. It passes that flag into `getBucketSlotsWithFallback(code, from, authorizedForTest)`.
3. In `slot-cache.ts`, the gate runs **before** the tier cascade:
   `if (requested.bucket.is_test && !authorizedForTest) return null;`. The route
   turns that `null` into the same `404 Unknown bucket` an unknown code returns.

Gating before the cascade is intentional (#601): an unauthorized hidden bucket
does the same single resolve an unknown code does, so its 404 timing gives no
signal that it exists. Separately, the display cascade itself skips any test
bucket it walks past (`if (row?.bucket.is_test) return null;`), so a test bucket
can never be the fallback a real lead's request drops into.

### Public booking page (`src/app/book/page.tsx`)

The `/book` page selects `is_test` with the bucket and short-circuits when true,
rendering "This booking link is not available." instead of an (empty) Booker. A
test bucket has no public booking page at all.

### Public create path (`src/lib/booking/orchestration.ts`)

Two places in the booking orchestration enforce it, both keyed on the
`allowTestBuckets` input flag (only the key-authed direct booking API sets it;
the public embed submit never does):

- **Direct create** (around line 1411): after resolving the bucket,
  `if (bucket.is_test && !input.allowTestBuckets) throw new UnknownBucketError();`.
  To a real lead a test bucket looks exactly like an unknown code, with no hint a
  hidden bucket is there.
- **Tier fallback** (`assignAgentWithTierFallback`, around line 971): while
  walking the debt-tier ladder, `if (resolved.bucket.is_test && !allowTestBuckets)
  return { hit: false };` skips a test rung, so a public booking can never cascade
  down into one.

### Webhook suppression (`fire()` + `src/lib/webhooks/emit.ts`)

The smoke test books **real** bookings on a hidden test bucket via the key-authed
API, so its webhooks must never reach Regal/Cadence (#459). Every booking webhook
flows through `fire()` in `orchestration.ts`, which passes `bucket.is_test` as the
`suppressed` argument to `emitWebhook`. A suppressed delivery is still **recorded**
(so the crash-resume dedupe tests can count the `webhook_deliveries` rows) but is
written in a terminal `success` state with `last_response` set to the suppressed
marker and the external POST skipped. The admin resend button and the batch
dead-letter replay both filter `suppressed = false`, so a suppressed row can never
leak out later.

### Internal UI and routing math (read-side filters)

Every internal surface that lists agents or reasons about capacity filters
`is_test` out with `.eq("is_test", false)`:

- `src/app/admin/page.tsx` (admin agents list)
- `src/app/admin/agents/[id]/page.tsx`
- `src/app/admin/ooo/page.tsx` (out-of-office roster)
- `src/lib/booking/service.ts` `listActiveAgents` (the manager reassign picker)
- `src/lib/routing/staffing-depth.ts` (`.filter((b) => !b.is_test)`, so test
  buckets never distort staffing-depth analysis)
- `src/app/api/cron/monitor/route.ts` reads `is_test` per bucket so the
  availability-health classifier can walk the tier ladder without treating a
  hidden bucket as a real dead end, and filters test agents out of its counts.

A guard test, `scripts/test-test-agent-hiding.ts`, asserts that each of those
listing pages keeps its `.eq("is_test", false)` filter and that the `/book` page
still resolves and short-circuits on the flag, so the hiding cannot silently
erode.

## How the smoke seed sets it

The synthetic rows are the only rows in the system that set `is_test: true`. They
come from `scripts/smoke-seed.ts`, a **pure** row builder (`buildSmokeSeed`) whose
output `scripts/seed-smoke-test.ts` inserts. Keeping it pure lets
`scripts/test-smoke-seed.ts` unit-test the row shapes before anything touches a
real project.

Every synthetic row the builder emits carries `is_test: true`:

- **The smoke-test agent** (`Sarah Mitchell`, a made up name for the `/demo` confirmation, #3424): a bookable, non-Salesforce
  mailbox with Mon-Fri working hours. The roster sync never deactivates it
  because it is not in Salesforce.
- **The isolated buckets** (`Smoke Test (CODE)`): `round_robin` with **empty**
  criteria, so the lone member always matches and the smoke test stays off the
  production round-robin and its fairness data.
- **The optional reassign-target agent** (`Smoke Reassign Target`, #450/#464):
  a second bookable test agent, the explicit target of the reassign scenario and
  a fallback member of the first bucket.

Because the builder is the single place that sets the flag, and every gate above
reads it, seeding a new synthetic entity is a matter of emitting a row with
`is_test: true` from this builder rather than adding new hiding logic elsewhere.

## Guidance for future test fixtures

1. **Reuse `is_test`, do not reinvent hiding.** If a fixture (a synthetic agent,
   bucket, or seed row) must be hidden from staff and the public, set
   `is_test: true` on it and it inherits every gate documented here. A second flag
   would have to re-implement all of them and would drift out of sync.
2. **Add the fixture to the pure builder** (`buildSmokeSeed`) so its shape is
   unit-tested before it reaches a real project, following the existing agent and
   bucket rows.
3. **Never gate routing on `is_test`.** The marker hides on the read side and
   blocks the public create path. Assignment must still see test entities so the
   smoke test can route to them.
4. **If you add a new surface that lists agents or buckets, or a new public read
   or create path, add the `is_test` filter to it** and extend
   `scripts/test-test-agent-hiding.ts` so the guard covers it.

## Reference files

- `supabase/migrations/0051_test_flags.sql` (the column definitions).
- `scripts/smoke-seed.ts` / `scripts/seed-smoke-test.ts` (the seed that sets it).
- `src/lib/booking/orchestration.ts` (public create and tier-fallback gates, and
  webhook suppression via `fire()`).
- `src/app/api/availability/route.ts` + `src/lib/availability/slot-cache.ts`
  (public availability gate and display cascade skip).
- `src/app/book/page.tsx` (public booking page short-circuit).
- `src/lib/webhooks/emit.ts` (suppressed-delivery recording and replay exclusion).
- `scripts/test-test-agent-hiding.ts` (guard test for the read-side filters).

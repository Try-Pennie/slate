# Plan: Crash-safe booking change-path via a transactional outbox (#429)

Status: PLAN-COUNCIL COMPLETE · winner = intent-first outbox (8.3/10) · reality-check HOLDS · 2026-06-24
Canonical record: GitHub Discussion #434 (https://github.com/Try-Pennie/slate/discussions/434)

## User decisions (LOCKED, post-council)

1. **Webhook delivery = inline first-send + dedupe guard** (NOT pure enqueue-only). The `/complete`
   send lane runs every 5 min (`worker/cron-routes.ts:22`), so pure enqueue-only would delay every
   booking's Regal/Cadence webhook 0–5 min, hurting speed-to-lead. Phase 1 keeps the inline first
   send but routes it through the deterministic `ON CONFLICT DO NOTHING` enqueue + delivery-id guard
   so a retry can never double-fire. Exactly-once preserved, latency unchanged.
2. **busy_blocks(booking_id) CONCURRENTLY index = extend `test-migrations.ts`** (option b) to permit a
   designated non-transactional migration file, kept in `migrations/`, applied via a non-transactional
   path (raw psql, never `apply_migration`/`db push`).
3. **Google create primitive = events.insert + deterministic client id, 409-as-success** (RESOLVED
   2026-06-25 by the P0 spike vs the live DWD domain: Spike A retry returned HTTP 409 "identifier
   already exists"; Spike B import-by-iCalUID reused the same event — both reliable). insert+id is
   the locked primary; events.import+iCalUID is the proven fallback. Id must be base32hex and
   incorporate the target calendar. Notification single-notify/no-re-notify on retry STILL to verify
   in Phase 4 (#439) with a real attendee.

---

Status: DRAFT — RED-TEAMED, ESCALATION RECOMMENDED · 2026-06-24

## Red-team verdict (independent agent, grounded in code)

The draft below has a load-bearing flaw and should NOT be executed as-is.

- **CRITICAL — create's real crash window is upstream of the outbox and uncoverable by it.**
  `createBooking` calls `createEvent()` (Google) BEFORE `insertBooking()`, and
  `gcal_event_id` is NOT NULL on the insert. A crash between the two orphans a real
  calendar event with no booking row, no outbox row, nothing keyed to it — invisible to
  the outbox (which is anchored to a booking_id that never existed) and to the Phase 5
  backstop (which scans bookings). The draft was written against an imagined create-then-store
  ordering; the real order is the opposite. A true transactional (Postgres-function) outbox
  does NOT fix this either, since the Google event is created outside any DB transaction.
  Create needs an **intent-first** redesign (write an intent row keyed by idempotency_key
  BEFORE calling Google; Google create carries a deterministic iCalUID so retries reuse).
- **Factual corrections:** sync tick budget is 25s (not ~10s); the webhook retry drain
  (`retryFailedDeliveries`) is in the `/complete` lane, not sync; the sync lane already
  truncates at 100 agents/tick under load, so a third best-effort tail drain would starve
  exactly when crashes are likeliest → the outbox needs its OWN lane + budget.
- **Double-create race:** no lease on an outbox row; inline-create-then-crash-before-store
  makes the drain create a SECOND calendar event. Needs a per-row claim + a Google-honored
  dedupe key (iCalUID/extendedProperty), neither in the draft.
- **Webhook double-fire to Regal:** `emitWebhook` is insert+send, not idempotent-enqueue;
  an outbox webhook step re-run sends a 2nd POST with a new delivery-id, defeating dedupe.
  Must split into enqueue-only (deterministic id) + let `webhook_deliveries` own sending.
- **busy_block move not atomic:** delete-then-insert with a crash between leaves the slot
  free (re-opens the double-book window); also races the #428 sweep. Needs one statement.
- **Process:** RECOMMEND `/plan-council`. Four rival architectures deserve scoring:
  (1) app-level outbox-after-commit (this draft — can't cover create orphan);
  (2) intent-first record keyed by idempotency_key + deterministic iCalUID;
  (3) true transactional Postgres-function outbox (partial — misses the Google orphan);
  (4) dedicated drain lane + lease-based executor (orthogonal, required regardless).
  Hand flaw #1 (the create ordering) to the council as a FIXED constraint.

---

Status: DRAFT (plan-lite, pre-red-team) · 2026-06-24

## Goal

No ill-timed crash in create / cancel / reschedule / reassign leaves partial
state. Record each mutation's intent durably, then deliver every side effect
(calendar, busy_blocks, slot-cache, webhook) idempotently with retry until
complete. Hard constraints: a booking must ALWAYS go through; double-book safety
stays fail-safe; embed contract unchanged; Cloudflare-deployable; pure-TS
orchestration core stays unit-testable (no business logic pushed into SQL).

## What already exists (grounding, verified against code + live schema)

- **Atomic commit points** per path: `insertBooking()` (unique-index gated),
  `claimCancellation()` (atomic flip), `claimReschedule()` lock + `updateBooking()`,
  `updateBooking()` (reassign).
- **Durable side-effect retry already in place:** calendar DELETE → `pending_event_deletions`
  (#401, drained in sync lane); webhooks → `webhook_deliveries` (status/attempts/backoff,
  delivery-id dedupe); cancel-direction busy_block stuck-slot → `reconcileCancelledBusyBlocks`
  (#428, sync lane).
- **No durable retry today (the real gaps):** calendar CREATE failure → orphaned event
  (only best-effort rollback); calendar time-UPDATE failure on reschedule → event left at
  wrong time; slot-cache recompute (`invalidateSlots`) is fire-and-forget; busy_block INSERT
  miss → slot shows free (#431, filed).
- Deps pattern: pure `orchestration.ts` functions take `BookingDeps`; `realDeps()` in
  `service.ts` wires Supabase/Google/webhooks; fakes in `scripts/test-*.ts`.
- Durable-queue table template: `pending_event_deletions` / `webhook_deliveries`
  (uuid PK, status, attempts, last_error, created/updated_at, status index, unique
  guard). Migrations sequential (next = 0046), RLS-on-every-table, server-only via
  `supabaseAdmin()`; `scripts/test-migrations.ts` is CI-only.

## Core design

A `booking_outbox` table is the durable intent log. One row per mutation,
written **at the mutation's atomic commit point**, listing the side-effect steps
to perform as a JSONB `steps` array (`{name, state: pending|done|failed, error?}`).
The happy path runs the steps inline exactly as today (no added latency on
success). A drain in the sync lane resumes any row that isn't fully `delivered`,
re-running only its `pending`/`failed` steps idempotently, until all are `done`.

Idempotency per step (reuse existing mechanisms):
- calendar delete → already idempotent (404/410 = success) via `deleteEventBestEffort`.
- calendar create → make resumable: store the created `gcal_event_id` on the booking
  as the first thing after creation; a retry that finds an event id present skips re-create.
- calendar time-update → idempotent by nature (setting the same time twice is a no-op).
- busy_block move → delete-by-booking + insert; reconcilable, keyed by booking_id.
- webhook → existing `webhook_deliveries` (do NOT duplicate; outbox step just ensures
  the delivery row was enqueued).

### The create-vs-mutate asymmetry (key design point)

- **Mutations (cancel/reschedule/reassign):** the booking already exists, so write the
  outbox row FIRST (before side effects). The booking_id is the anchor; the row's
  existence guarantees resumption.
- **Create:** there is no booking_id until the insert. The booking row itself is the
  intent. The outbox row is written immediately AFTER `insertBooking()` succeeds, to
  drive the post-insert steps (busy_block, webhook; the gcal event is created pre-insert
  with existing rollback). Residual window (booking committed, outbox insert crashes) is
  closed by the Phase 5 reconciliation backstop, not left to chance.

## Phases

### Phase 1 — Outbox table + drain skeleton (no behavior change)
Migration `0046_booking_outbox.sql` (uuid PK, booking_id FK, action, status
pending|delivered, steps jsonb, attempts, last_error, created/updated_at, status
index, RLS server-only). Row types in `schema.ts`/`types.ts`. New `BookingDeps`
methods: `enqueueOutbox`, `loadPendingOutbox(limit)`, `markOutboxStep`,
`markOutboxDelivered`. Attach a no-op-until-populated `processBookingOutbox(limit)`
drain in the sync lane next to #401/#428. Migration-invariant + drain unit tests.

### Phase 2 — Pure idempotent step executor (TDD)
`runOutboxSteps(deps, row)` in `orchestration.ts`: given an outbox row + the
booking, perform each not-`done` step idempotently, updating step state; return
remaining failures. No producer changes yet. Full fake-driven tests: each step
done-once, re-run-safe, partial-failure resume, all-done → delivered.

### Phase 3 — Wire producers (behavior-preserving)
Each change-path writes its outbox row at the commit point and calls
`runOutboxSteps` inline (replacing the current ad-hoc inline side-effect calls).
Happy path identical; every step now resumable. Tests assert the same external
calls happen in the same order on success, and that a simulated mid-sequence
crash + drain reaches the same end state.

### Phase 4 — Close the un-queued gaps
Route failed calendar CREATE and failed calendar time-UPDATE through the outbox
executor (durable retry instead of best-effort), and fold in the busy_block
INSERT direction (#431) so a missed write self-heals. Make recompute a drained
step rather than fire-and-forget.

### Phase 5 — Reconciliation backstop + verification
Drain also scans recently-changed bookings lacking a terminal outbox row (closes
the create-window). Retire now-redundant ad-hoc retries if fully subsumed (keep
#401/#428 if still cheaper). Load/soak test at 200-agent scale; verify both the
happy path and injected-crash resumption; confirm webhooks/Regal still fire once.

## Open decisions / risks (to resolve with red-team + user)
1. **Same-transaction guarantee.** App-level outbox (this plan) has a tiny
   booking-committed-but-outbox-missing window, closed by Phase 5 reconciliation.
   The zero-window alternative is a Postgres function writing booking + outbox in
   one transaction (true transactional outbox) — rejected here to keep logic in
   testable TS, but it's the gold-standard fallback if the window proves unacceptable.
2. **Migration count + apply discipline:** 0046 must be `db push`-applied before the
   code that reads it deploys (CI drift check is a no-op).
3. **Drain cost in the sync lane** at 200 agents (already carries #401 + #428 + sync);
   bound the outbox batch and watch the tick budget.
4. Does the full outbox subsume #428/#431, or run alongside? (teardown risk).

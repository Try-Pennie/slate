# Plan: P4 — intent-first crash-safe create (#439)

Status: DRAFT — RED-TEAMED, ESCALATION TO /plan-council RECOMMENDED · 2026-06-25

## Red-team verdict (independent agent, grounded in code)
The draft's central safety claim is FALSE as written; do NOT execute it.
- **CRITICAL — the agent pin does NOT prevent duplicate events.** The deterministic id is
  keyed on `idempotencyKey` ONLY, not the agent. A Google client id is unique PER CALENDAR,
  not globally. A resumer (re-submit or drain) that re-runs the non-deterministic `assignAgent`
  (round-robin + live verify-on-book) and lands on a DIFFERENT agent will `createEvent(agentB,
  {id})` SUCCESSFULLY (the id is free on B's calendar) → the SAME id on two calendars = the exact
  duplicate the phase exists to prevent. FIX: key the id on `sha256(idempotencyKey + ':' +
  agentUserId)` AND write the reservation as the FIRST durable act (before createEvent), as the
  single source of the agent pin; every resumer reads that one row and reuses ITS agent + id.
- **CRITICAL — Phase C is incompatible with the executor as built.** Every OUTBOX_HANDLER starts
  `if (!row.booking_id) return;` + rebuilds context via `loadBookingById`. A create reservation
  has `booking_id=null` → no booking to load → the create handler must reconstruct bucket/eventType/
  agent/attendee/prefill/manage-token/deterministic-id/sf-id/trace/tz/org ENTIRELY from a NEW
  create-payload shape, AND do createEvent+insertBooking+side-effects+its OWN 23505 active-slot
  swallow with none of the shared scaffolding. It's a fundamentally different handler; "follow the
  pattern" is misleading.
- **CRITICAL/GATE — 409-reuse notification semantics is a BLOCKING prerequisite.** createEvent uses
  `sendUpdates=all`. A resume that successfully inserts a 2nd event double-emails the lead (a
  consumer-facing delight moment). The spike never tested sendUpdates behavior on the 409/GET. Must
  run a live-domain notify spike BEFORE any code, not deferred.
- Others: concurrency-arbiter loser path underspecified; dead-reservation/mark-delivered crash needs
  the drain handler to findBookingByIdempotencyKey + swallow 23505; caller-supplied
  `input.idempotencyKey` override would silently break determinism; anonymous phone-only embed leads
  (null key) keep the non-crash-safe path — quantify before accepting; Phase A is independently
  deployable but B is NOT safe without C.
- **Process: RECOMMENDS /plan-council** — central claim wrong + Phase C architecturally incompatible +
  a consumer-trust notification gate, cross-cutting data-integrity/external-idempotency/consumer-trust.
  Wants a data lens (pin in gcal-id vs a dedicated reservation table w/ event-id column), a backend
  lens (create-handler divergence), and the live notify spike resolved before code.

---

Status: DRAFT (plan-lite, pre-red-team) · 2026-06-25

## Goal
A new booking creates the Google event BEFORE the booking row exists, so a crash
between strands an orphaned calendar event. Make create **reservation-first**: a
durable record pins the chosen agent + a deterministic event id BEFORE the Google
call, so any retry (a re-submit OR the /api/cron/outbox drain) re-creates with the
SAME agent + id and Google REUSES the event (409-as-success) — zero orphan, no
duplicate. Architecture is council-locked (#434) + spike-confirmed (#435: events.insert
+ deterministic client id reliably 409s). Webhook stays exactly-once.

## Verified ground truth (code read this session)
- `createBooking` (orchestration.ts): idempotency fast-path (`findBookingByIdempotencyKey`)
  → `assignAgent` (round-robin + verify-on-book) → `createEvent` (auto-gen id) →
  `insertBooking` → busy_block + `invalidateSlots` → `fire("booking.created")`.
- `idempotencyKeyFor(parts)` (core.ts:169) → pipe-joined string, or **null** when no
  email/phone/salesforceId (anonymous booking).
- `createEvent(email, input)` (calendar.ts:216) → `POST events?sendUpdates=all`,
  Google-generated id, no client id today. `ok()` throws on non-2xx except 410.
- P0 spike LOCKED: events.insert + deterministic base32hex client id → retry 409s
  "identifier already exists"; events.import+iCalUID is the proven fallback.
- `booking_outbox` (0047/0050): action ∈ create|cancel|reschedule|reassign; `payload`
  jsonb; status pending|delivered; lease. The `booking.created` webhook has NO
  booking_events row → dedupe key = `booking.id` (P1).
- `bookings.gcal_event_id` is NULLABLE at the DB level (only the TS type is non-null) —
  so an intent-first placeholder needs no schema relaxation.

## Phases

### Phase A — deterministic id + 409-as-success in the gcal layer
- New pure helper `deterministicEventId(idempotencyKey)`: `"slate" + sha256hex(key)`
  (hex 0-9a-f ⊆ base32hex 0-9a-v, so it's a valid Google client id; per-intent unique).
- `createEvent` gains an optional `clientId`. When set, send `requestBody.id`. A wrapper
  treats 409 (reason `duplicate` / "identifier already exists") as success → GET the
  existing event by id → return it. Preserve `sendUpdates=all`.
- **Notification check (carried from the spike):** a 409-reuse / GET must NOT re-notify
  the attendee. Verify against the live domain before shipping Phase B.

### Phase B — intent-first reservation in `createBooking`
- Compute `idempotencyKey`. If **null** (anonymous) → fall back to today's behavior
  (no reservation; not crash-safe but rare). Most bookings have identity.
- Fast-path: existing booking by key → return (unchanged #357).
- Look up an existing **create reservation** by idempotency_key. If found → resume:
  use its pinned agent + deterministic id → createEvent (409-reuse) → insertBooking →
  side effects → mark delivered.
- Else: `assignAgent` → pinned agent. Write a `booking_outbox` reservation
  (`action='create'`, `booking_id=null`, `payload` = idempotencyKey + agentUserId +
  agentEmail + deterministicEventId + ALL fields insertBooking needs). A **partial
  UNIQUE on idempotency_key WHERE action='create'** is the concurrency arbiter: two
  concurrent same-key creates → one reservation wins, the loser reads it and reuses the
  winner's pinned agent + id (no double-create).
- `createEvent(pinnedEmail, { clientId: deterministicEventId })` → 409-reuse.
- `insertBooking` (deterministic gcal id + idempotency_key); existing 23505 active-slot
  handling.
- busy_block + invalidate + `fire("booking.created")`.
- Mark reservation delivered.

### Phase C — drain resume for create
- A create reservation left `pending` (crash before delivered) → the outbox drain's
  create handler: check if the booking already exists by idempotency_key; if not,
  createEvent (reuse) → insertBooking; then side effects; mark delivered. Idempotent.

### Migration
- `booking_outbox.idempotency_key text` + `create unique index ... on booking_outbox
  (idempotency_key) where action = 'create' and idempotency_key is not null`.

## Open risks
1. **409-reuse notification semantics** — does reusing an existing event re-email the
   attendee? Spike B's notify check was deferred; verify before shipping.
2. **Reservation payload size** — must carry every field `insertBooking` needs (org,
   bucket, event_type, attendee, prefill, salesforce_id, routing_trace, …).
3. **Anonymous (null-key) bookings** keep the non-crash-safe create — a residual gap.
4. **assignAgent before the reservation** — a crash there leaves no reservation, but
   also no event (safe; nothing to orphan).
5. Drain double-insert guard relies on the idempotency_key unique index on bookings.

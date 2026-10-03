# Disaster recovery runbook

What to do when the Slate database has to be restored, and what has to be
reconciled afterwards. Read the whole page before starting: the restore itself is
the easy half, and the order of the reconciliation matters.

The reason this page exists at all: **a booking is not one write.** Confirming a
call writes a row in Postgres, creates an event on a Google calendar, sends the
lead and the agent a calendar invite, and emits a webhook to Regal. A restore
rolls back only the first of those. Everything else stays exactly as it was, so a
database-only restore is **guaranteed** to leave Slate disagreeing with Google,
with the customer's inbox, and with Regal. Reconciling those is most of this
page.

---

## Recovery objectives

| | Objective | What is in force today |
|---|---|---|
| **RPO** (data we may lose) | **24 hours** | Supabase daily backups only. Point-in-Time Recovery is **not** enabled, so the restore target is the most recent nightly backup and everything written since is lost. |
| **RTO** (time to serve again) | **Same business day** | Slate's bookings are business hours only, so a restore that lands before the next working morning has not breached. |

These are deliberate choices, not aspirations.

**On the RPO.** Losing up to a day of bookings is accepted because PITR is a paid
Supabase add-on and, before cutover, the only bookings in the system are the
canary's. Revisit this the moment real leads are booking: at that point a day of
lost bookings is a day of leads with a calendar invite for a call Slate has no
record of, and section 4 below is the only thing standing between that and a
no-show. The decision is recorded here rather than left implicit so that turning
PITR on is a decision somebody makes, not something discovered during an
incident.

**On the RTO.** The restore is minutes; the reconciliation is not. Budget the
whole morning and work the sections in order.

**On the forensic window, which is a third objective nobody usually writes down**
(#1047). Cloudflare keeps every log line for **7 days** and there is no export, so
anything that happened longer ago than a week can only be reconstructed from the
database: the tables, `booking_events`, `audit_log`, `webhook_deliveries`. That is
enough to answer what HAPPENED (every state change a booking went through is a durable
row) and not enough to answer WHY at the level a log line would (which agent's calendar
read failed, what Google actually returned, which code path a request took).

Accepted, with the trade stated: a Logpush job shipping error-level lines to R2
would extend it indefinitely and costs both money and a new place holding customer data
for longer, which the PII inventory would have to account for (`docs/pii.md` names the
request URL as carrying contact data, so a longer-lived log copy is a longer-lived PII
copy, not just more diagnostics). What would change it: a compliance requirement for
longer retention, or a second incident where the answer was genuinely a week old. In
practice the constraint is simpler than it sounds, because an incident that matters is
noticed by an alert within minutes, and every alert here fires while the window is wide
open.

The operational consequence, worth knowing before you need it: **when an incident starts,
capture the logs first.** They expire; the database rows do not.

---

## 0. Before you restore

**Stop and confirm a restore is actually the answer.** Restores are destructive:
they replace the current database. Most incidents that feel like they need one
(a bad deploy, a broken migration, a runaway lane) are fixed by
`wrangler rollback` or by a corrective migration, and both are reversible where
this is not.

A restore IS the answer when data has been destroyed or corrupted and no forward
fix can reconstruct it.

1. **Take a fresh backup or snapshot first**, so the current (broken) state is
   still available. You may need it to reconstruct what the restore is about to
   discard: section 4 depends on being able to read the bookings that existed
   after the restore point.
2. **Write down the restore target** as a UTC timestamp, and the current UTC time.
   Everything below is scoped to the window between them. Call it the **gap
   window**.
3. **Check the migration version.** Restoring to a point before a migration was
   applied puts the database *behind* the deployed Worker, which fails the
   migration drift check in CI and pages the production monitor. If the restore target
   predates the newest applied migration, plan to re-apply the migrations
   immediately after the restore (see `docs/migrations-runbook.md`) and do not
   deploy anything in between.
4. **Tell whoever owns Regal.** Section 5 is a downstream problem you cannot fix
   from here, and they need the gap window.

---

## 1. Restore the database

Supabase project **`slate`**, ref `drukfvgaynzrralbzkzj`
([dashboard](https://supabase.com/dashboard/project/drukfvgaynzrralbzkzj)).

Dashboard → Database → Backups → choose the backup → Restore.

<!-- runbook-unverified: a real restore replaces the production database, so this cannot be executed to prove it. The 2026-09-02 rehearsal (#1584) used a Supabase preview branch, which is a fresh database with the migrations applied rather than a backup restored into it, so it exercised everything AFTER this step and not this step itself. The steps mirror DEPLOY.md's backup section and Supabase's dashboard flow. -->
<!-- runbook-verified: 2026-09-02 (fd5067c4) rehearsal for #1584. The health check below was run against production and returned exactly the shape this section tells you to expect: {"status":"ok","reason":"ok","db":"ok","alerting":"ok","staleLane":null,...}. The migration catch-up instruction is confirmed too: the rehearsal branch reported 113 of 113 migrations applied, so a target behind production is brought forward by the documented flow. -->
```
# Confirm the app is talking to a live database again before going further.
curl -s https://slate.trypennie.app/api/health
```

Expect `{"status":"ok"|"degraded", "db":"ok", ...}`. `db` must read `ok`. A
`degraded` status here is normal and expected: the cron lanes have not stamped a
heartbeat since the restore, so several will read as stale for a few minutes.

If the restore target predated a migration, apply the outstanding migrations now,
following `docs/migrations-runbook.md`, before anything below.

---

## 2. Re-register the Google push channels (do this FIRST)

**This is the step that will be missed, and it fails silently.**

Slate keeps each calendar's push channel id and its expiry in `agent_calendars`.
The watch lane only re-registers a calendar whose stored expiry is inside three
days, and a channel lasts about a week. So after a restore the stored expiry is
still comfortably in the future and **the watch lane will decide every calendar
is current and do nothing.**

Meanwhile Google is pushing to whatever channel was live at the moment of the
outage, which for any calendar re-registered inside the gap window is a channel
id the restored database has never heard of. `/api/google/push` looks the channel
up by id, finds no row, and drops the notification. Nothing errors. Nothing
pages. Calendar changes simply stop reaching Slate, and the only thing keeping
availability honest is the one-minute backstop sync, which is slower and
coarser than push.

The fix is to make every calendar read as due, then run the lane:

<!-- runbook-verified: 2026-09-02 (065e6dd7) rehearsal for #1584. The statement below was run against a Supabase preview branch carrying the identical schema (all 113 migrations applied), with its SET clause exactly as written here and a RETURNING appended so it reported the rows it touched. This is the claim the issue singled out as a deduction rather than an observation, and both directions were measured on three seeded calendars.

BEFORE: a calendar whose restored expiry sits 6 days out reported due_for_renewal = FALSE against the lane's own predicate (watch_expiration is null or watch_expiration - now() < interval '3 days', transcribed from src/lib/google/sync.ts:951-957). One at 1 day and one already lapsed reported TRUE. So the paragraph above is right: after a restore the lane really does read a healthy-looking expiry as current and do nothing.

AFTER: the statement below affected all 3 rows and every one reported due_for_renewal = TRUE. So the fix really does make them due.

The other half of the claim was confirmed by reading the live code path rather than by pushing a real notification: syncByChannel (src/lib/google/sync.ts:846-858) resolves the channel with .eq("watch_channel_id", channelId).maybeSingle() and returns "unknown-channel" when there is no row, and /api/google/push ignores that resolved value and answers 200 (only a THROWN error is logged). So an orphaned channel is dropped with no error and no alert, exactly as written.

What is still not proven here: running this across the LIVE roster, which would tear down production push channels. -->
```sql
-- Force every calendar to re-register its push channel on the next watch tick.
-- Safe: a null expiry reads as "due for renewal", and the renewal stops the old
-- channel first where it still has the ids to do so.
update agent_calendars
set watch_channel_id = null,
    watch_resource_id = null,
    watch_expiration = null,
    watch_consecutive_failures = 0,
    watch_last_error = null,
    watch_last_failure_kind = null;
```

Then trigger the watch lane rather than waiting up to five minutes for it:

<!-- runbook-unverified: running this with the CORRECT secret re-registers push channels across the live roster, which is an action on production rather than a check, so it stays for a real recovery. What the 2026-09-02 rehearsal (#1584) DID confirm is that the line is not wrong: GET https://slate.trypennie.app/api/cron/watch answers 401 with no bearer and 401 with a wrong one, so the URL is right, the route is deployed, and the Bearer CRON_SECRET it uses is really what the route wants. -->
```
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://slate.trypennie.app/api/cron/watch
```

Channels that the restore orphaned at Google (registered inside the gap window,
unknown to the restored database) cannot be stopped, because stopping one needs
the channel id and resource id that the restore discarded. They expire on their
own within about a week, and until then they push to an endpoint that ignores
them. That is noise, not a fault.

---

## 3. Rebuild the availability cache

`busy_blocks` is a **cache**, not a source of truth, which is the one piece of
good news on this page: it can be rebuilt from Google in full, and nothing has to
be reconciled by hand.

Two lanes do it, and they do different halves:

- **`/api/cron/hydrate-calendars`** re-bootstraps calendars over the whole cached
  window (21 days ahead). This is the one that matters after a restore, because
  the incremental delta from Google will not re-send events that have not changed
  since the restored sync token.
- **`/api/cron/sync`** is the every-minute backstop and will catch up on its own.

<!-- runbook-unverified: same as the watch lane above, running it for real is a live action against the roster. The 2026-09-02 rehearsal (#1584) confirmed the line itself: GET https://slate.trypennie.app/api/cron/hydrate-calendars answers 401 with no bearer, so the URL is right and the route is deployed behind the Bearer CRON_SECRET this uses. -->
```
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://slate.trypennie.app/api/cron/hydrate-calendars
```

The hydration lane deliberately refreshes a **slice** of the roster per tick, so
one call does not cover everybody. It reaches every calendar at least once a day
at any roster size; if you need the whole roster fresh sooner, call it repeatedly
and watch the log line for the slice it took.

Do not try to speed this up by deleting `busy_blocks` wholesale. An empty cache
reads as "everybody is free", and the booker will happily offer times that are
already taken until hydration catches up.

---

## 4. Find the bookings the restore threw away

This is the part with real customer consequence, and there is no automation for
it. Every booking confirmed inside the gap window is now:

- **gone from Postgres**, so Slate has no record of it, will not remind anybody,
  will not mark it complete, and will happily offer the same slot to somebody
  else;
- **still on the agent's Google calendar**, as a real event with the lead
  attached;
- **still in the lead's inbox**, as a calendar invite for a call they are
  expecting to happen.

So the customer's expectation is intact and Slate's record of it is not. The
agent's calendar is the surviving source of truth, and it is the one to
reconcile against.

**The order that matters:**

1. **Read the pre-restore snapshot you took in step 0.** That is the fastest and
   most complete list of what was lost: `bookings` rows created or modified
   inside the gap window. If for any reason there is no snapshot, fall back to
   listing Slate-created events on the agents' calendars inside the gap window.
2. **Decide per booking whether to recreate it.** Recreating through the normal
   booking path writes a new Postgres row AND a second Google event, so the
   original event has to be deleted first or the agent ends up double booked for
   one call.
3. **Leave the customer's invite alone unless you are changing the time.** They
   have a correct invite for a call that will happen; a cancellation followed by
   a new invite for the same slot is a worse experience than a silent repair.
4. **Cancellations and reschedules inside the gap window are the dangerous
   direction.** A booking cancelled inside the window is back in the restored
   database as `confirmed`, so Slate now believes in a call the lead has already
   been told is off. Those have to be re-cancelled by hand, and they are the ones
   to work first.

There is deliberately no script here. Writing one that had never been run against
a real restore would be worse than none, because it would read as proven while
being untested against the only situation it exists for.

---

## 5. Downstream systems Slate cannot roll back

**Regal has already been told.** Every `booking.created`, `booking.rescheduled`
and `booking.cancelled` webhook emitted inside the gap window was delivered and
acted on. There is no compensating event for "that booking no longer exists", and
inventing one is not something to do under pressure. Hand whoever owns Regal the
gap window and let them decide what to reconcile on their side.

**The Snowflake mirror is now ahead of the source.** The export walks each
mirrored table on a strictly forward keyset over `export_cursor`, and the restore
rolled that cursor backwards along with everything else. Two consequences:

- The export will re-send rows it has already sent. That is harmless: the load is
  a MERGE on `id` with no DELETE.
- Rows exported inside the gap window still exist in the warehouse and no longer
  exist in Supabase. The six-hourly reconcile lane counts both sides and **will
  page on the drift**, correctly. Expect that alert, do not treat it as a second
  incident, and clear it by removing the stranded warehouse rows once section 4
  is settled and you know which bookings are genuinely gone.

**Any completed PII erasure inside the gap window has been undone.** A restore
from before an erasure reintroduces the data it deleted. `docs/pii-erasure-runbook.md`
(section 6, Backups) states the obligation: re-run the erasure runbook for every
`pii.erasure` audit entry in the gap window. This is a legal commitment rather
than a tidiness one, so it is not optional and it is not deferrable.

---

## 6. Verify

Work down this list. Each line is a different failure, and passing one says
nothing about the next.

<!-- runbook-verified: 2026-08-20 (7b71692a) run against production; /api/health returned 200 {"status":"ok","db":"ok","alerting":"ok"} and /api/health/availability returned 200. -->
```
# The app and the database.
curl -s https://slate.trypennie.app/api/health

# Availability specifically: 200 means the routing pool can still offer times,
# 503 means it cannot. This is the check the external uptime monitor watches.
curl -s -o /dev/null -w "%{http_code}\n" https://slate.trypennie.app/api/health/availability
```

Then, in order:

1. **Every cron lane is stamping again.** `/api/health` returns `status: "ok"`
   once no covered lane is stale. Give it fifteen minutes; the lanes on longer
   cadences take that long to prove themselves.
2. **Push is live again.** Change an event on one agent's calendar by hand and
   confirm the corresponding `busy_blocks` row moves within a minute or so. This
   is the only check that distinguishes a working push channel from the
   every-minute backstop quietly covering for a dead one, which is section 2's
   whole failure mode.
3. **A booking can actually be made.** Run the full smoke pass against the
   isolated SMOKE agents and buckets. It creates, reschedules and cancels a real
   booking end to end and is the only automated proof of the funnel.

<!-- runbook-unverified: the full strict smoke pass creates a real booking, so it is left to be run deliberately during a recovery rather than executed while writing this page. The invocation is the same one docs/smoke-test-runbook.md documents. -->
```
SMOKE_STRICT=1 node --experimental-strip-types --import ./scripts/register-paths.mjs \
  scripts/smoke-booking-api.ts
```

4. **The Snowflake reconcile drift alert has been dealt with**, per section 5,
   rather than muted.
5. **Nothing in section 4 is still outstanding.** A restore is not finished when
   the app is up; it is finished when Slate's record of the world matches the
   calendars and inboxes of the people in it.

---

## When Supabase or Google hangs rather than fails

Not a restore, and nothing here needs reconciling afterwards, but it is the
outage most likely to arrive first, so what Slate does in it is written down
(#3102). A dependency that refuses a request fails fast and every path already
handles that. One that accepts the request and never answers used to hold the
caller until something outside Slate gave up: a lead's confirm until the browser
aborted at 20 seconds, and a cron lane until its invocation ran out. Every call
now carries a deadline instead, enforced in one wrapper
(`src/lib/fetch-within-deadline.ts`).

**Per call.** Each request waits no longer than its own limit:

| Call | Deadline | Where it is set |
|---|---|---|
| Every Supabase request (the secret key client, the cookie client, the middleware's session refresh). The slowest statement measured on production is 7.9 seconds | 15 seconds | `SUPABASE_FETCH_TIMEOUT_MS`, `src/lib/supabase/fetch-deadline.ts` |
| Google calls a lead waits on: verify on book, the event insert, a lead's move, cancel or correction. One expiry for the call, token mint included | 8 seconds | `GOOGLE_CONFIRM_TIMEOUT_MS`, `src/lib/google/calendar.ts` |
| Google calls the sync lanes make: the event sync, the calendar list, push watches | 15 seconds | `GOOGLE_SYNC_TIMEOUT_MS`, same file |
| The OOO calendar writes a manager waits on | 8 seconds | `CALENDAR_WRITE_TIMEOUT_MS`, same file |
| The delegated token mint | shares the expiry of the call it is minting for; 8 seconds for the Gmail digest and the photo lane | `DELEGATED_TOKEN_TIMEOUT_MS`, `src/lib/google/dwd.ts` |
| Each Salesforce attempt | 10 seconds, three attempts | `SF_TIMEOUT_MS`, `src/lib/salesforce/retry.ts` |

A Google call can only be sent without one by writing `NO_DEADLINE` at the call
site, and today nothing does.

**Per request a lead is waiting on.** A per call limit bounds one call, and a
confirm makes a dozen Supabase reads and two or three Google calls in a row, so
those limits alone still add up past the booker's 20 seconds. So the three lead
facing booking routes (`/booking`, the key authed `POST /api/bookings`, and a
lead's reschedule) run under one budget (`src/lib/booking/confirm-budget.ts`,
carried through the async context by `src/lib/call-budget.ts`). Every Supabase,
Google and Salesforce call inside it waits for the smaller of its own limit and
what the budget has left, and once the budget is spent the next call fails at
once instead of starting.

| Part | Length |
|---|---|
| The confirm budget, for everything the request does | 12 seconds (`BOOKING_CONFIRM_BUDGET_MS`) |
| The cleanup allowance after it, for handing back the lead's rate limit hit | 2 seconds (`BOOKING_CLEANUP_BUDGET_MS`) |
| Worst case, against the booker's 20 | 14 seconds, leaving 6 for computation and the response |

Work deferred past the response (webhook sends, recomputes) leaves the budget and
gets the per call limits again, because the lead already has their answer. The
cron lanes never run under a budget, so for them only the per call limits apply.

**What a lead sees.** A confirm, an API booking or a lead's reschedule whose
dependency times out answers **503** with the same sentence a verify outage
uses ("We hit a temporary issue confirming this time. Please try again in a
moment."), which the booker already shows, and the lead's rate limit hit is handed
back. It is counted as `verify_unavailable` and pages under
`verify_on_book_outage`, with the words naming which dependency did not answer.

**What can still happen after that 503.** If the timeout came after the booking's
reservation was written (the Google insert is the usual one), the reservation
stays pending and the reservation drain finishes it on a later tick. The event
insert carries a fixed client id, so the finish reuses an event that landed
rather than writing a second. So the lead can receive an invite even though the
page asked them to try again. A retry that carries the same stable booking key
resumes that reservation rather than making a second booking; an anonymous retry
has no key to resume by, which is the existing posture for any confirm that
failed after its reservation was written.

**A budget miss.** When the budget runs out, the page names the budget ("the
booking confirm did not answer within 12 seconds") rather than whichever call was
running, because no single call was at fault: the dependencies were slow together.

**What the lanes do.** A sync tick stops waiting on a hung calendar after 15
seconds and records an ordinary failed sync for it; the next tick tries again.
A hung Supabase read reaches the lane as an error rather than an empty result,
so a lane that `unwrap`s it fails loudly and its heartbeat goes stale, as for any
database outage. PostgREST does not retry a request that hit the deadline, so one
hung read costs one deadline, not four.

**Staff pages.** The middleware's session refresh gives up after 15 seconds and
the page renders as signed out, so staff are sent to sign in again rather than
facing a page that never loads.

**What the deadline does not cover.** It runs until the response headers arrive.
A response that starts and then stalls mid body is not cut by it; every call
here reads a small JSON body, so that has not been worth arming for.

---

## What would make the next one easier

Recorded here rather than in an issue nobody reads during an incident:

- **Point-in-Time Recovery** turns section 4 from a day of manual reconciliation
  into a handful of minutes of lost writes. It is the single highest-value thing
  to buy before real leads are booking.
- **A pre-restore export of `bookings` inside the gap window**, taken as step 0
  every time, is what makes section 4 tractable at all. Never skip it.
- **A rehearsal of the RESTORE ITSELF.** Most of this page has now been
  exercised (2026-09-02, #1584): section 2's SQL was run verbatim against a
  branch with the identical schema and both directions were measured, the two
  cron lanes were confirmed deployed and correctly gated, and section 1's health
  check was run against production. What has still never happened here is a real
  restore, because there is nothing to restore INTO short of production: a
  Supabase preview branch is a fresh database with the migrations applied, not a
  backup restored into it. So section 1 and the live-roster halves of sections 2
  and 3 remain deductions. Buying that would mean a scratch project big enough to
  take a real backup, and it is worth deciding deliberately rather than
  discovering the answer mid-incident.
- **The rehearsal is worth repeating** whenever `dueForRenewal`, the watch
  columns, or the push channel lookup changes. What was measured was the
  BEHAVIOUR of those three, and a change to any of them makes this page a
  deduction again.

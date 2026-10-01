# PII retention, erasure, and compliance posture

Status: policy of record for consumer PII in Slate. The retention windows and the
four compliance positions behind them were **confirmed on 2026-07-29** and are
recorded in §9; the memo written for counsel's review is
[pii-legal-positions.md](./pii-legal-positions.md). Parent: #1029 (milestone #14).

Slate collects consumer contact information on a **public** booking surface
(`/book`, `widget.js`) and routes it to agents. This document is the single record
of what PII we hold, how long we keep it, how a person's data is erased on request,
and which data we deliberately keep forever and why.

## 1. What PII Slate holds, and where

| Data | Table.column | Collected on | Class |
|------|--------------|--------------|-------|
| Attendee name | `bookings.attendee_name` | public booker | direct contact PII |
| Attendee first name, as answered (#2549) | `bookings.attendee_first_name` | public booker | direct contact PII; cleared by retention and by `erase_booking_pii`; not mirrored to Snowflake |
| Attendee email | `bookings.attendee_email` | public booker | direct contact PII |
| Attendee phone | `bookings.attendee_phone` | public booker | direct contact PII |
| Prefill answers | `bookings.prefill` (jsonb) | public booker | may carry contact PII |
| Reschedule/cancel reason (free text) | `booking_events.reason_detail` | manage link / admin | may carry PII |
| Full delivery payload | `webhook_deliveries.payload` (jsonb) | derived, per delivery | copy of attendee PII |
| Subscriber response body | `webhook_deliveries.last_response` | derived | may echo PII |
| External Salesforce/lead reference | `bookings.salesforce_id`, `bookings.external_id` | booking URL / landing page | **external reference, NOT Slate-controlled PII** (see §4) |

The attendee's meeting also exists as an event on the **assigned agent's Google
Calendar** (`bookings.gcal_event_id`). That copy is addressed in §4.

**Staff data, not in the table above on purpose.** `regal_call_events.agent_email`
(#2090) is the work address of the Pennie employee who placed a call in Regal, the
same value `users.email` already holds. It is not lead PII, so it is not a row above,
not in the erasure path and not mirrored to Snowflake. The inbound Regal body it is
read from does carry lead contact data and a call summary, and none of that is ever
written: see [pii.md](./pii.md) §3.

## 2. Retention windows (confirmed 2026-07-29)

| Data | Window | Mechanism |
|------|--------|-----------|
| `bookings` contact data (name/email/phone/prefill) | 24 months after the appointment (`starts_at`) | redact in place, `/api/cron/prune-bookings-pii` (#1071) |
| `webhook_deliveries.payload` + `last_response` | 90 days after the delivery is terminal | blank + `payload_erased` flag, `/api/cron/prune-webhook-payloads` (#1073) |
| Delivered `booking_outbox` rows | 30 days | delete, `/api/cron/prune-bookings-pii` (#1071) |
| `routing_decisions` | 12 months | delete, `/api/cron/prune-routing` (existing) |
| `booking_events.reason_detail` | on an erasure request, not on a timer | redact in place via `erase_booking_pii` through the §5 sentinel (shipped, migration 0092) |
| `regal_call_events` (staff data: an agent email on candidate rows, no lead data) | 3 days after receipt | delete, `/api/cron/prune-regal-calls` (#2090) |
| `regal_call_outcomes` (the lead's Salesforce Lead id key, an external reference, plus call start, talk time and labels; no contact data) | 120 days after receipt | delete, `/api/cron/prune-regal-calls` (#2944) |

**A window above does not propagate to the Snowflake mirror by itself.** Redacting
or blanking a row in place sets the flag that freezes it from re-export
(`applySkipRedacted`), deliberately, so the mirror cannot clobber a redaction with
the full-fidelity copy. The consequence is that the redaction propagates nowhere:
Snowflake keeps what it last held until something clears the warehouse copy
explicitly.

**Two of these windows now have a warehouse side, and two do not.**

- **Bookings contact data (24 months) IS enforced on the mirror** (#1180), by
  `/api/cron/prune-warehouse-pii`, which clears the same fields in Snowflake for
  bookings whose appointment is past the same window. It shares its statements
  with the deletion-request purge, so the two cannot clear different field sets,
  and it needs no marker column: "past the window and still holding contact data"
  is directly observable, which also makes it idempotent and resumable.
- **`webhook_deliveries` payloads and `routing_decisions` have no warehouse
  window.** So "90 days" for `webhook_deliveries.payload` + `last_response` is the
  Supabase lifetime, not the lifetime of the data. For an erasure request the
  purge clears them (#1205 found `last_response` missing from that purge and from
  the audit that checks it; #1207 found `booking_outbox.steps` the same way), but
  nothing clears them on a timer.

The 24 month booking window is **confirmed** (Dan, 2026-07-29, see §9), not
provisional. Nothing in production is near it yet: the oldest bookings date from
June 2026, so there is no aged backlog and the lane has nothing to redact.

Note the last row is **not** a timer. The reschedule/cancel reason text is
redacted when a person asks to be erased, not on an age sweep, because the
`booking_events` table is append-only (§5) and the sanctioned escape hatch is the
erasure function. An aged booking whose owner never requested erasure keeps its
reason text.

Retention is keyed on the **appointment time**, not a completion status a
background sweep might fail to set (#883), so a stale booking cannot dodge the
window.

**The prune is gated on the Snowflake mirror.** Redaction is irreversible and the
warehouse copy is the only remaining full-fidelity record, so
`/api/cron/prune-bookings-pii` refuses to redact until the export lane is proven
current, and then only redacts rows strictly behind the confirmed export watermark,
proving per row that Snowflake holds that version first (#1102 / #1118 / #1139). A
run that cannot confirm the mirror skips and alerts rather than redacting blind.

**The warehouse side of the 24 month window is now enforced** (#1180). The
confirmed position (§9) is that the window applies to both, and until
`/api/cron/prune-warehouse-pii` existed this document overstated what the system
did: Supabase enforced it and Snowflake held a full-fidelity copy indefinitely.

That lane is SCHEDULED rather than operator-triggered, which was the open decision
on the issue. The deletion-request purge stayed a deliberate action so the audit
lane remains the thing that notices a missed one; retention has no per-request
trail to miss and is purely time driven, and a window nobody remembers to enforce
is not a window. Running unattended is paid for with the same pair the other
retention lanes carry: a heartbeat with a bound in `RETENTION_STALE_BOUNDS_MS`, so
a lane that stops firing or fails nightly pages, and its own skip alert, because
without the warehouse credential it would otherwise no-op behind a cheerful 200
while the mirror side of the window quietly stopped being honored.

Everything it cannot measure fails LOUD: an unreadable select, an unreadable row
count, and a verify that still finds contact data all throw, and the lane turns
that into a 500 with the heartbeat withheld. A "cleared 0" result means one thing
only, that nothing was past the window. Nothing is close to it yet (Slate's oldest
bookings are June 2026), so this exists to be already working in mid 2028 rather
than to have work to do today.

The other two windows (`webhook_deliveries` payloads, `routing_decisions`) still
govern Supabase only; see the note in §2 above.

## 3. Redaction, not deletion

Aged `bookings` rows are **redacted in place** (PII columns cleared), not
hard-deleted, so aggregate reporting and foreign-key integrity survive. The row
persists with its status, times, bucket, and agent; only the person's contact data
is removed.

Redaction (not physical deletion) is the **confirmed** answer for a data-subject
deletion request as well (Dan, 2026-07-29, §9). It is also what the schema
supports: `bulk_reassign_items.booking_id` is `NO ACTION`, so deleting a booking
row errors outright once it has been part of a bulk batch, and
`booking_events.booking_id` is `CASCADE`, so a delete would destroy the
append-only history §5 exists to protect. Hard deletion would require unwinding
both, plus losing the row from show-rate reporting and admin lookup.

## 4. What Slate deliberately does NOT touch

These are policy decisions (Dan, 2026-07-23), and they override the more
aggressive erasure the #1029 red-team proposed:

- **External Salesforce / lead reference** (`salesforce_id`, `external_id`): these
  are the **same** external reference to the person's record in Salesforce.
  **Slate is not the system of record** for that identity; Salesforce is (see the
  contact-owner model). Retention and erasure in Slate do **not** clear these
  fields. Deletion of the underlying identity is Salesforce's responsibility.
- **The agent's Google Calendar event**: a completed meeting's calendar event is
  the **agent's operational record** and stays. Retention and erasure do **not**
  delete calendar events. A calendar event is deleted **only** on a genuine
  booking **cancellation** (the existing cancel path), never as a PII sweep.
- **`audit_log`** and the append-only event history: kept for integrity /
  tamper-evidence (see §5). Erasure redacts free-text PII within `booking_events`
  but does not delete the audit trail.

## 5. Tamper-evidence and erasure must coexist (#1040 reconciliation)

Migration `0089` (#1040, **shipped**) makes `booking_events` and `audit_log`
**append-only** with triggers that raise on `UPDATE`, `DELETE`, and `TRUNCATE`
(the last is a separate statement-level guard, since row triggers do not fire on
a bulk wipe). A trigger fires **regardless of the calling role**, so even the
RLS-bypassing secret-key client cannot rewrite the trail, and a `SECURITY
DEFINER` erasure function does **not** bypass it on its own. The two triggers
differ by design:

- **`audit_log` is strictly immutable** (no bypass): its trail is never redacted
  or deleted; erasure only *appends* an audit entry (§4, §7).
- **`booking_events` carries one sanctioned bypass** on a session GUC:
  `IF current_setting('slate.allow_erasure', true) IS DISTINCT FROM 'on' THEN
  RAISE EXCEPTION 'booking_events is append-only ...';`. The erasure function
  (`erase_booking_pii`, #1072, **shipped** as migration 0092) sets that GUC inside its own
  transaction (`perform set_config('slate.allow_erasure','on', true)`) before
  redacting `reason_detail`, and only for that transaction.

**Ordering contract:** 0089 shipped the trigger *with* the sentinel first, so
#1072's erasure function (plus the #1071 deferred `reason_detail` redaction) can
land later without breaking it. No plain `UPDATE`/`DELETE` on `booking_events`
is permitted outside the sentinel path; none is ever permitted on `audit_log`.

Because of existing FKs (`bookings`→`booking_events` cascade, `users`/
`organizations` set-null/cascade), the triggers also block the write
side-effects of hard-deleting a booking, user, or org. That is safe (the roster
is deactivate-not-delete; orgs/bookings are never hard-deleted) and intended:
the audit trail must outlive what it references.

## 6. Backups resurrect erased data

Erasure is **logically immediate** in the live database but **physically complete
only after backups roll off**. Supabase daily backups (and PITR, if enabled per
#1028) retain the pre-erasure rows for their retention period. Therefore:

- A restore from a backup taken before an erasure **reintroduces** that PII.
- Any restore must **re-run the erasure log** (the `audit_log` erasure entries)
  as a post-restore reconciliation step.

This is a documented limitation, not a defect; a defensible DSR response states
that erasure is complete in production immediately and in backups within the
backup retention window.

## 7. Data-subject erasure (DSR) path

Erasure is **cross-system** (#1103): it must clear the person's contact PII from
both Supabase and the Snowflake mirror. The full step-by-step is the
[erasure runbook](./pii-erasure-runbook.md); read it before honoring a request.

**Supabase half** (#1072, shipped as migration 0092): a `SECURITY DEFINER`
`erase_booking_pii(target_email)` function (chosen over an admin UI for a smaller
attack surface). In one idempotent transaction it:

1. redacts matching `bookings` contact fields (name/email/phone/prefill), but
   **not** `salesforce_id`/`external_id` (§4), and stamps `pii_redacted_at` so the
   Snowflake export freezes the row instead of re-mirroring the blanked one (#1118);
2. redacts their `booking_events.reason_detail` via the §5 escape hatch;
3. blanks matching `webhook_deliveries.payload` rows, matched by the affected
   **booking ids** (catches a delivery whose attendee email is null but whose
   payload still carries the person's other PII);
4. takes the free-text reason out of those bookings' `booking_outbox` rows
   (migration 0093, #1140), described below;
5. writes an `audit_log` erasure entry recording the affected booking ids and an
   **email hash** (never the cleartext email);
6. does **not** delete Google Calendar events (§4).

**The `booking_outbox` step (#1140)** closes a gap: 0092 redacted the reason text
in `booking_events` but left the identical text in `booking_outbox.payload`, whose
`reasonDetail` is written from the same mutation. That copy used to age out with the
30-day delivered-outbox prune, but since #1102 that prune **pauses** when the
warehouse cannot confirm a row, so the window became open-ended.

Measured against production rather than assumed (601 rows, all delivered): the
outbox `payload` carries `fromAgentUserId`, `fromStartsIso`, `initiator`,
`reasonCode`, and `reasonDetail`, and `steps[]` carries `name`, `state`, `error`.
**Only `reasonDetail` holds consumer PII**, and `steps[].error` / `last_error` can
embed an external response body. It does **not** carry attendee name/email/phone/
prefill: no producer writes those here.

So erasure takes the reason text and the error strings **only**, leaving the
operational fields (`reasonCode`, `initiator`, `fromStartsIso`, `fromAgentUserId`)
intact. That is what makes it safe to blank a still-**pending** row rather than
having to exclude it: the drain still has everything it needs to finish a half-done
mutation, and its history-write step then records a null reason, which is exactly
the erased state. No erasure ever waits on the drain.

Unlike `bookings`, the outbox row is **not** frozen from the export. It has no
`set_updated_at` trigger and is deliberately absent from the export's
skip-redacted set, so the erasure stamps `updated_at` itself and the next export
MERGEs the blanked row over the warehouse copy. The warehouse therefore converges
on the erased version on its own, which reinforces the operator's step 3 purge
instead of reverting it. Retention is not frozen either: the per-row verify reports
`stale` until the export catches up, then allows the delete.

**Snowflake half** (#1103): the steady-state export role is append-only (no
DELETE) by design, so the warehouse purge is an **operator-run manual step** with
a credential that never lives in the Worker. Using the affected booking ids from
the audit row, the operator redacts the same PII columns in place in Snowflake
(bookings contact fields, `booking_events.reason_detail`, `webhook_deliveries`
payload, and the `booking_outbox` reason), then runs a verification query that must
return zero residual PII. The [erasure runbook](./pii-erasure-runbook.md) carries
the exact SQL. Because the Supabase redaction stamps `pii_redacted_at` /
`payload_erased`, the export lane freezes those rows, so the operator's warehouse
redaction is not later clobbered. `booking_outbox` is the one exception, and in the
safe direction: it is not frozen, so the export re-mirrors the already-blanked
Supabase row over the warehouse copy and keeps it erased.

## 7b. How a retention lane actually destroys something (#1102)

All three retention lanes (`prune-routing`, `prune-webhook-payloads`,
`prune-bookings-pii`) follow one contract, and it is worth stating because the
obvious-looking version of it does not work.

**The export watermark is not a gate.** Each lane deletes rows older than its
window and also requires the row to sit below `export_cursor.last_ts`. That cursor
is minutes old, so for a row 30 days / 90 days / 12 months past its window the
second condition is always true. It withholds nothing. Worse, "the cursor is past
timestamp T" says nothing about whether the specific row at T was exported: the
export fetch is a strictly-forward keyset, so a row committed with an earlier
`updated_at` after the cursor moved past it is never exported. `booking_outbox` is
the live example, because it has no `set_updated_at` trigger and its writers stamp
`updated_at` from the Worker's own clock.

**So the real control is a per-row read-back.** Before destroying anything, a lane
reads a bounded batch of candidates and asks Snowflake, per id, whether it holds
that row at a version no older than Supabase's. Only confirmed ids are destroyed,
by explicit id list, never by a range predicate. Three outcomes are kept distinct:
the row is archived, the warehouse lacks it, or the warehouse has an older copy. A
failed or malformed warehouse read is none of those and throws, because an empty
answer must never read as "the warehouse has none of these".

**Redaction counts as destruction.** Blanking booking contact fields or a webhook
payload leaves no other copy in Supabase, so it takes the same proof a delete does.

**A refusal is recoverable.** Rows the warehouse could not confirm are re-sent by
id (`reexportByIds`) before the lane refuses, so a single missed row does not make
the refusal permanent. Nothing else would revisit it: the cursor only moves
forward, and the #1100 backfill lane does not exist. A row already redacted in
place is never re-sent, since that would overwrite the warehouse's full-fidelity
copy.

**Windows.** routing decisions 12 months, webhook payloads 90 days, booking contact
data 24 months, delivered outbox rows 30 days. `bookings` are never hard-deleted:
retention redacts in place and migration 0089 blocks the cascade outright.

**The outer gate is an export-lag reading, not a row count (#1139).** Before any of
this, a lane checks that the export lane is keeping up: per mirrored table, how long
the oldest exportable row past the export cursor has been waiting, measured against
the clock the lane read at. Past an hour (six missed 10-minute export ticks) the lane
refuses and alerts. It reads only Supabase.

The reading is an AGE, not the gap between the two newest rows, and the difference
is #1713. `newest - cursor` reads zero while everything is exported and, the moment
one row lands, reads the interval between that row and the one before it, which on a
sparse table is hours however healthy the lane is. On 2026-09-02 a time off request
filed at 02:53 UTC, with the previous audit row at 00:11, scored "3 hours behind" at
03:00 while being seven minutes old, and all three lanes refused for the night, holding
four webhook payloads with contact data a day past their window. The lanes also run at
03:05 rather than 03:00 now, so the gate never reads the mirror while the export tick
it is judging is still running; `scripts/test-cron-routes.ts` pins that minute off the
export lane's step.

That replaced a Supabase-vs-Snowflake row-count reconciliation, which could not
survive its own success: the count flags only "Snowflake is behind", which goes
structurally negative the moment retention deletes rows (routing_decisions,
booking_outbox) or redacts them (bookings, webhook_deliveries, since the Supabase
count skips redacted rows while the warehouse counts every row). As a gate it would
have become a rubber stamp exactly when deletion began. The reconciliation still
runs every 6h as an independent drift monitor, which is the job only it can do:
it is the one thing that asks the warehouse what it actually holds. Its positive
control now probes `routing_decisions` as well as `bookings`, the table these
lanes hard-delete from and previously the one with no control at all.

What the lag reading proves is that the export lane is alive and current, not that
the warehouse still holds a given row: that remains the per-row read-back above.
Its one blind spot is a row committed with a watermark EARLIER than the cursor
(booking_outbox, which has no `set_updated_at` trigger), which the forward keyset
fetch never exports and which is neither backlog nor lag. The per-row read-back
catches exactly that at delete time.

**Monitoring.** Each lane stamps a heartbeat when it completes without throwing
(including a skip) and is judged against a 28h bound, so a lane that fails nightly
goes stale and pages. A lane that runs but skips because the mirror is not confirmed
current gets its own alert, because both skip paths otherwise return a cheerful 200
and retention would stop indefinitely while reporting healthy. The skip alert names
its cause and gives the matching remedy: an unconfigured warehouse credential sends
the reader to DEPLOY.md, a lagging export lane to the export lane itself.

**Accepted residual risk: there is no database-layer control on these deletions.**
`audit_log` and `booking_events` are tamper-evident against the secret key via
triggers (0089), but the three hard-delete targets are not: they carry no
append-only trigger, no RLS policy that binds the secret key, and no separate
grant. A bug or a compromised secret key could delete from them directly, and the
guarantees above all live in application code. This was a deliberate choice when
Phase 6 landed: the issue originally called for a distinct
`slate.allow_archival_delete` GUC plus a SECURITY DEFINER RPC, which was dropped
after verifying nothing blocks these deletes and that the only case needing it
(hard-deleting a booking) is one we never do. It is recorded here as residual risk,
the way AGENTS.md records the main-push-guard residual risk, rather than being
treated as free. Revisit it if these tables ever get a second writer.

## 8. PII inventory / processor map

The processor map lives in **[pii.md](./pii.md)** (#1045): the six destinations a
lead's contact data reaches, what each one gets, how long it keeps it, who can read
it there, and which of them an erasure actually reaches. This document keeps the
field level inventory (§1), the windows (§2) and the positions (§9), and does not
restate any of that map.

Two things in it that change how a request should be answered, so they are flagged
here too rather than only there:

- **Slate does not hold the consent it asserts.** On `booking.created` it sends
  `voiceOptIn` / `smsOptIn` / `emailOptIn` as subscribed to Regal. #1041 has since put
  privacy policy and terms links on the standalone booker and the manage page, and the
  embedded booker inherits the host page's, but a policy link is not a record that this
  person agreed to be called: there is still no consent checkbox and Slate records no
  consent of its own. Consent is captured upstream on the landing page, so "prove this
  person agreed to be called" cannot be answered from Slate's own data.
- **The Snowflake mirror no longer carries the booking manage token** (#2564). It
  reached the warehouse twice, as `bookings.manage_token` and inside
  `webhook_deliveries.payload.manage_url`, and both are stripped at the one point
  every merge path goes through. A 6 hourly sweep clears what was already exported
  and pages if any survives, and a build guard stops another credential joining the
  mirror. The warehouse columns are left in place and permanently null.

## 9. Confirmed legal positions (2026-07-29)

The four questions this document previously left open were decided by Dan on
2026-07-29 (#1074). They are recorded as **Pennie's stated position**, not as
outside counsel's opinion: counsel can revise any of them later, and the memo in
[pii-legal-positions.md](./pii-legal-positions.md) is written for that review. The
code implements what is below.

1. **Applicability: both CCPA and GLBA, built to the stricter reading.** Slate
   treats consumer booking PII as in scope for CCPA consumer rights and a GLBA
   safeguards posture. The operative consequence is a **45 day response deadline**
   for a verified deletion request (see §7 and the erasure runbook).
2. **Retention window: 24 months**, measured from the appointment, confirmed
   rather than provisional, and applying to the Snowflake mirror as well as
   Supabase (§2). Both sides are now enforced in code: `/api/cron/prune-bookings-pii`
   for Supabase and `/api/cron/prune-warehouse-pii` for the mirror (#1180). Until
   the second of those shipped, this position was stated here and half enforced.
3. **Deletion means redaction in place**, and `salesforce_id` / `external_id` stay
   (§3, §4). Accepted residual risk, stated plainly so review can see it: an
   erased row still carries an identifier that links to the person's record in
   Salesforce, so Slate retains a linkable row after honoring an erasure. The
   position is that the external reference is Salesforce's obligation as system of
   record, not Slate's.
4. **No separate processor obligation for Regal/Cadence.** They are treated as
   downstream controllers with their own relationship to the consumer, so Slate
   neither propagates an erasure to them nor holds a DPA for this flow. Accepted
   residual risk, and the one most exposed to challenge given position 1: Slate
   sends attendee name, email, and phone to Regal/Cadence on every booking, and
   when Slate honors a deletion request **nothing tells them to delete their
   copy**. A person told by Pennie that their data is erased still has it held
   downstream. Revisit this if counsel reads position 1 as binding on the whole
   data flow rather than on Slate's own store.

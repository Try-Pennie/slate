# PII retention, erasure, and compliance posture

Status: policy of record for consumer PII in Slate. Retention windows are
**provisional** and marked so; they are pending confirmation by Pennie legal (see
"Legal confirmation owed" at the end). Parent: #1029 (milestone #14).

Slate collects consumer contact information on a **public** booking surface
(`/book`, `widget.js`) and routes it to agents. This document is the single record
of what PII we hold, how long we keep it, how a person's data is erased on request,
and which data we deliberately keep forever and why.

## 1. What PII Slate holds, and where

| Data | Table.column | Collected on | Class |
|------|--------------|--------------|-------|
| Attendee name | `bookings.attendee_name` | public booker | direct contact PII |
| Attendee email | `bookings.attendee_email` | public booker | direct contact PII |
| Attendee phone | `bookings.attendee_phone` | public booker | direct contact PII |
| Prefill answers | `bookings.prefill` (jsonb) | public booker | may carry contact PII |
| Reschedule/cancel reason (free text) | `booking_events.reason_detail` | manage link / admin | may carry PII |
| Full delivery payload | `webhook_deliveries.payload` (jsonb) | derived, per delivery | copy of attendee PII |
| Subscriber response body | `webhook_deliveries.last_response` | derived | may echo PII |
| External Salesforce/lead reference | `bookings.salesforce_id`, `bookings.external_id` | booking URL / landing page | **external reference, NOT Slate-controlled PII** (see §4) |

The attendee's meeting also exists as an event on the **assigned agent's Google
Calendar** (`bookings.gcal_event_id`). That copy is addressed in §4.

## 2. Retention windows (provisional)

| Data | Window | Mechanism |
|------|--------|-----------|
| `bookings` contact data (name/email/phone/prefill) | 24 months after the appointment (`starts_at`) | redact in place, `/api/cron/prune-bookings-pii` (#1071) |
| `webhook_deliveries.payload` + `last_response` | 90 days after the delivery is terminal | blank + `payload_erased` flag, `/api/cron/prune-webhook-payloads` (#1073) |
| Delivered `booking_outbox` rows | 30 days | delete, `/api/cron/prune-bookings-pii` (#1071) |
| `routing_decisions` | 12 months | delete, `/api/cron/prune-routing` (existing) |
| `booking_events.reason_detail` | 24 months (matching the booking) | redact in place, **pending the #1040 lock (§5)** |

Retention is keyed on the **appointment time**, not a completion status a
background sweep might fail to set (#883), so a stale booking cannot dodge the
window.

## 3. Redaction, not deletion

Aged `bookings` rows are **redacted in place** (PII columns cleared), not
hard-deleted, so aggregate reporting and foreign-key integrity survive. The row
persists with its status, times, bucket, and agent; only the person's contact data
is removed. Whether a data-subject "deletion" request legally requires physical
deletion versus redaction is a legal question (see the end).

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
4. writes an `audit_log` erasure entry recording the affected booking ids and an
   **email hash** (never the cleartext email);
5. does **not** delete Google Calendar events (§4).

**Snowflake half** (#1103): the steady-state export role is append-only (no
DELETE) by design, so the warehouse purge is an **operator-run manual step** with
a credential that never lives in the Worker. Using the affected booking ids from
the audit row, the operator redacts the same PII columns in place in Snowflake
(bookings contact fields, `booking_events.reason_detail`, `webhook_deliveries`
payload), then runs a verification query that must return zero residual PII. The
[erasure runbook](./pii-erasure-runbook.md) carries the exact SQL. Because the
Supabase redaction stamps `pii_redacted_at` / `payload_erased`, the export lane
freezes those rows, so the operator's warehouse redaction is not later clobbered.

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

**Monitoring.** Each lane stamps a heartbeat when it completes without throwing
(including a skip) and is judged against a 28h bound, so a lane that fails nightly
goes stale and pages. A lane that runs but skips because the mirror is unusable
gets its own alert, because both skip paths otherwise return a cheerful 200 and
retention would stop indefinitely while reporting healthy.

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

The processor map (who we send PII to: Regal/Cadence via webhooks, Google
Calendar) lives in the separate PII inventory doc (#1045); this document
cross-references it rather than duplicating it.

## Legal confirmation owed (Pennie legal)

The following are business/legal decisions the implementer cannot make; the code
ships provisional defaults until they are confirmed:

1. Does **CCPA** (and any **GLBA** safeguards/privacy obligation) apply to Slate's
   consumer booking PII, given the lending-marketplace context?
2. What is the **authoritative retention window** for completed/cancelled booking
   contact data? (Code ships a provisional 24 months.)
3. Does a data-subject "deletion" request require **hard deletion** or is
   **redaction in place** sufficient?
4. Does the attendee PII we send to Regal/Cadence via webhooks create a separate
   **processor** obligation requiring a DPA or downstream erasure propagation?

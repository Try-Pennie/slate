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

Issue #1040 will make `booking_events` (and `audit_log`) **append-only** by a
`BEFORE UPDATE OR DELETE` trigger that raises an exception. A trigger fires
**regardless of the calling role**, so a `SECURITY DEFINER` erasure function does
**not** bypass it on its own. The two must be designed together:

- The append-only trigger carries a **bypass sentinel** on a session GUC, e.g.
  `IF current_setting('slate.allow_erasure', true) IS DISTINCT FROM 'on' THEN
  RAISE EXCEPTION 'booking_events is append-only';`.
- The erasure function (`erase_booking_pii`, #1072) sets that GUC inside its own
  transaction (`perform set_config('slate.allow_erasure','on', true)`) before
  redacting `reason_detail`, and only for that transaction.

**Ordering contract:** #1040's trigger and #1072's erasure function (plus the
#1071 deferred `reason_detail` redaction) must ship **together**, or one breaks
the other. No plain `UPDATE`/`DELETE` on `booking_events` is permitted outside
this sanctioned path.

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

Implemented by #1072 as a documented runbook plus a `SECURITY DEFINER`
`erase_booking_pii(target_email)` function (chosen over an admin UI for a smaller
attack surface). In one idempotent transaction it:

1. redacts matching `bookings` contact fields (name/email/phone/prefill), but
   **not** `salesforce_id`/`external_id` (§4);
2. redacts their `booking_events.reason_detail` via the §5 escape hatch;
3. blanks matching `webhook_deliveries.payload` rows, matched on the exact
   attendee path `payload->'attendee'->>'email'` (not a top-level or agent email);
4. writes an `audit_log` erasure entry recording the affected booking ids and an
   **email hash** (never the cleartext email);
5. does **not** delete Google Calendar events (§4).

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

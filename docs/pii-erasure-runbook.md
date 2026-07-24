# PII erasure runbook (data-subject deletion requests)

How an operator honors a verified request to erase a person's contact data from
Slate. The mechanism is the `erase_booking_pii(target_email)` database function
(migration 0090, #1072). Policy context and the full retention posture live in
[pii-retention.md](./pii-retention.md); read §4 and §7 there before running this.

## Before you run it

1. **Verify the requester out of band.** Confirm the request is genuine and that
   the email belongs to the person, per whatever identity check Pennie's process
   requires. This function does no identity verification; it trusts the operator.
2. **Have the exact email.** The function matches Slate bookings on the
   attendee's email (case-insensitive, trimmed). If the person booked under more
   than one email, run it once per email.

## Running it

Run this SQL against the production database as an admin (Supabase SQL editor, or
`psql` with the service connection). It is server/operator-only: the API roles
have no execute grant.

```
select erase_booking_pii('person@example.com');
```

The function runs as a single transaction and returns a JSON summary, for
example `{"erased": true, "bookings": 2, "events": 1, "deliveries": 3}`. If
nothing matched (already erased, or never present) it returns
`{"erased": false, "reason": "no-match"}`.

It is **idempotent**: re-running for the same email after a successful erasure is
a safe no-op and writes no new audit row.

## What it does

For every booking matching the email, in one transaction:

1. Redacts the booking's contact fields: name, email, phone set to null; the
   prefill answers blob set to empty.
2. Redacts the free-text reschedule/cancel reason notes on that booking's history
   (through the sanctioned append-only bypass; see pii-retention.md §5).
3. Blanks any outbound webhook delivery payloads that carry that exact attendee
   email, so no re-send path can replay them.
4. Writes one `audit_log` entry recording the affected booking ids and a **SHA-256
   hash** of the email (never the cleartext email).

## What it deliberately does NOT do (policy, §4)

1. It does **not** clear `salesforce_id` / `external_id`. Those are the external
   Salesforce reference; Salesforce is the system of record for that identity, and
   its deletion is Salesforce's responsibility, not Slate's.
2. It does **not** delete the agent's Google Calendar events. A completed
   meeting's event is the agent's operational record; only a genuine booking
   cancellation deletes a calendar event.

## After you run it

1. **Confirm the audit entry.** A row should exist in `audit_log` with
   `action = 'pii.erasure'` and the booking ids + email hash in `details`. That
   row is the durable record that the request was honored.
2. **Backups (important caveat, §6).** Erasure is immediate in the live database
   but **physically complete only after backups roll off**. Supabase daily
   backups (and point-in-time recovery, if enabled) still hold the pre-erasure
   data for their retention window. A restore from before the erasure would
   reintroduce the PII, so **any restore must re-run the erasure log** (replay the
   `pii.erasure` audit entries) as a post-restore reconciliation step. A
   defensible response states that erasure is complete in production immediately
   and in backups within the backup retention window.

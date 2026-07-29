# PII erasure runbook (data-subject deletion requests)

How an operator honors a verified request to erase a person's contact data from
Slate. Erasure is **cross-system**: the person's PII must be cleared from both
Supabase (the live database) and the Snowflake mirror (the long-term warehouse).
Policy context and the full retention posture live in
[pii-retention.md](./pii-retention.md); read sections 4 and 7 there first.

The mechanism is two steps: a database function for the Supabase half, and an
operator-run SQL step for the Snowflake half (the Worker's export role is
append-only by design, so it cannot purge the warehouse; that credential stays
with the operator, never in the app).

## Before you run it

1. **Verify the requester out of band.** Confirm the request is genuine and that
   the email belongs to the person, per whatever identity check Pennie's process
   requires. This function does no identity verification; it trusts the operator.
2. **Have the exact email.** The function matches Slate bookings on the
   attendee's email (case-insensitive, trimmed). If the person booked under more
   than one email, run the whole runbook once per email.

## Step 1: Supabase erasure

Run this SQL against the production database as an admin (Supabase SQL editor, or
`psql` with the service connection). It is server/operator-only: the API roles
have no execute grant.

```
select erase_booking_pii('person@example.com');
```

It runs as a single transaction and returns a JSON summary, for example
`{"erased": true, "bookings": 2, "events": 1, "deliveries": 3, "outbox": 1}`. If
nothing matched (already erased, or never present) it returns
`{"erased": false, "reason": "no-match"}` and you are done (there is nothing in
Snowflake to purge either).

A zero in any of those counts is worth a second look before you move on: it means
that path matched no rows. That is normal for a person with no reschedule or
cancel history (`events: 0`) but not for `bookings`, which is 0 only on a
no-match.

It is **idempotent**: re-running for the same email after a successful erasure is
a safe no-op and writes no new audit row. The match is case-insensitive and
trimmed, so a re-run with different capitalization or stray whitespace is also a
no-op rather than a second erasure.

Verified end to end against production on 2026-07-29 (#1074): on a retired smoke
booking the function returned
`{"erased": true, "bookings": 1, "events": 1, "deliveries": 3, "outbox": 1}`,
matching the row counts measured beforehand; the contact fields came back null
with `pii_redacted_at` stamped and `salesforce_id` / `external_id` intact; the
`booking_events` rows survived with only `reason_detail` cleared; and a second
call (plus a mixed-case padded variant) returned `no-match` leaving exactly one
audit row. The append-only trigger was separately confirmed to REJECT the same
`reason_detail` update when the sentinel is not set, so the escape hatch is
genuinely load-bearing rather than redundant.

What it does, in one transaction: redacts the booking contact fields (name, email,
phone null; prefill emptied) and stamps `pii_redacted_at`; redacts those bookings'
`booking_events.reason_detail`; blanks the matching outbound webhook payloads
(matched by the affected booking ids); takes the free-text reason and any embedded
error body out of those bookings' `booking_outbox` rows (#1140, keeping the
operational fields the drain needs, so a still-pending row is safe to blank); and
writes one `audit_log` entry with the affected booking ids and a **SHA-256 hash** of
the email (never the cleartext).

## Step 2: get the affected booking ids

The Snowflake purge needs the booking ids the Supabase step just redacted. Read
them from the audit row (most recent erasure):

```
select details->'booking_ids' as booking_ids
from audit_log
where action = 'pii.erasure'
order by created_at desc
limit 1;
```

Copy the list of ids for the next step.

If you want to be certain this is the erasure you just ran, recompute the hash and
compare it to the `email_sha256` in the same row. The function hashes the
**normalized** email (lowercased and trimmed), so you must normalize it here too:

```
select encode(sha256(convert_to(lower(trim('person@example.com')), 'UTF8')), 'hex');
```

Do **not** hash the address exactly as the requester typed it. Any capital letter
or stray space produces a completely different hash, and you would wrongly
conclude you are looking at the wrong erasure. Measured on 2026-07-29, the same
address padded and mixed-case hashed to `1c5e9832...` raw against `bf887269...`
normalized.

## Step 3: Snowflake purge (operator credential, redact in place)

Run this against Snowflake using your **own admin login**, never the Worker's
export user. It redacts the same PII columns in place for the affected bookings,
so the warehouse keeps the PII-free analytics rows but holds none of the person's
contact data. Substitute the ids from step 2 for `<ids>` (comma-separated,
single-quoted, e.g. `'id1','id2'`).

```
update SLATE.PUBLIC.bookings
   set attendee_name = null, attendee_email = null, attendee_phone = null,
       prefill = object_construct()
 where id in (<ids>);

update SLATE.PUBLIC.booking_events
   set reason_detail = null
 where booking_id in (<ids>);

update SLATE.PUBLIC.webhook_deliveries
   set payload = object_construct(), payload_erased = true
 where payload:booking_id::string in (<ids>);

update SLATE.PUBLIC.booking_outbox
   set payload = object_insert(payload, 'reasonDetail', null, true),
       last_error = null
 where booking_id in (<ids>);
```

Because the Supabase redaction stamped `pii_redacted_at` / `payload_erased`, the
export lane has frozen the `bookings` and `webhook_deliveries` rows and will not
re-mirror the full-fidelity version back over your redaction.

`booking_outbox` works the other way round and is the reason the step above is
belt-and-braces rather than the only defense: it is deliberately **not** frozen from
the export, so within a few minutes the export MERGEs the already-blanked Supabase
row over the warehouse copy and keeps it erased. Your manual update just makes it
immediate instead of waiting for the next export tick. Note the `steps[].error`
strings are cleared on the Supabase side only; the export overwrite is what carries
that to the warehouse, so if step 4 shows a residual there, give the export a tick
and re-check before escalating.

## Step 4: verify (mandatory)

Run this against Snowflake. Every count **must be 0**. A non-zero count means the
purge missed rows (or an export re-mirrored them); do not consider the request
honored until it returns all zeros.

```
select
  (select count(*) from SLATE.PUBLIC.bookings
     where id in (<ids>) and attendee_email is not null) as bookings_residual,
  (select count(*) from SLATE.PUBLIC.booking_events
     where booking_id in (<ids>) and reason_detail is not null) as events_residual,
  (select count(*) from SLATE.PUBLIC.webhook_deliveries
     where payload:booking_id::string in (<ids>)
       and payload:attendee:email is not null) as webhook_residual,
  (select count(*) from SLATE.PUBLIC.booking_outbox
     where booking_id in (<ids>)
       and payload:reasonDetail is not null) as outbox_residual;
```

Also confirm the Supabase side: the `audit_log` row from step 2 exists with
`action = 'pii.erasure'`. That row is the durable record that the request was
honored.

One thing not to be surprised by while checking the Supabase side: once a webhook
delivery is blanked, it can no longer be found by `payload ->> 'booking_id'`,
because the payload that held the booking id was itself emptied. A query keyed
that way returns nothing whether the erasure worked or the rows never existed, so
do not read an empty result there as proof of either. Use `payload_erased = true`
(or `dedupe_key`, which for a `booking.created` delivery is the booking id) if you
need to see the rows. In Snowflake the pre-purge rows ARE still findable by
payload booking id, because the export freezes them at full fidelity, which is
what makes steps 3 and 4 work there.

### You are not the only check

`/api/cron/erasure-audit` re-reads every booking id in every `pii.erasure` audit
entry and asserts Snowflake holds no residual contact PII for it, alerting to
Slack when it does. So a skipped or half-finished step 3 gets caught even if
nobody re-reads this runbook. Treat that as a backstop, not a substitute: the
lane can only report a residual, it cannot purge the warehouse (the export role
is append-only by design). If it pages about an erasure you performed, come back
to step 3.

## What it deliberately does NOT do (policy, §4)

1. It does **not** clear `salesforce_id` / `external_id`. Those are the external
   Salesforce reference; Salesforce is the system of record for that identity, and
   its deletion is Salesforce's responsibility, not Slate's.
2. It does **not** delete the agent's Google Calendar events. A completed
   meeting's event is the agent's operational record; only a genuine booking
   cancellation deletes a calendar event.

## Backups (important caveat, §6)

Erasure is immediate in the live database and warehouse but **physically complete
only after backups roll off**. Supabase daily backups (and point-in-time recovery,
if enabled) still hold the pre-erasure data for their retention window, as do
Snowflake Time Travel and Fail-safe. A restore from before the erasure would
reintroduce the PII, so **any restore must re-run this runbook** for every
`pii.erasure` audit entry as a post-restore reconciliation step. A defensible
response states that erasure is complete in production immediately and in backups
within the backup retention window.

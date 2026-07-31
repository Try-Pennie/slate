# PII erasure runbook (data-subject deletion requests)

How an operator honors a verified request to erase a person's contact data from
Slate. Erasure is **cross-system**: the person's PII must be cleared from both
Supabase (the live database) and the Snowflake mirror (the long-term warehouse).
Policy context and the full retention posture live in
[pii-retention.md](./pii-retention.md); read sections 4 and 7 there first.

The mechanism is two steps: a database function for the Supabase half, and an
operator-triggered purge for the Snowflake half.

A correction worth knowing, because three places in this repo used to say
otherwise (#1128). The export role is append-only in the sense that matters:
`docs/snowflake-setup.sql` withholds DELETE and TRUNCATE. It does hold **UPDATE**,
which the export's own MERGE needs. Redacting in place is an UPDATE, so Slate can
run the warehouse purge with the credential it already has, and step 3 below is
one authenticated request rather than four statements pasted by hand. Nothing in
Slate can delete a warehouse row.

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

Verified against production on 2026-07-29 (#1074). Note this verified **step 1
only**: the Snowflake half (steps 3 and 4) was not run in that pass, which is
exactly how the broken purge statement in step 3 survived unnoticed until #1197.
A verification that exercises only the automated half of a cross-system procedure
proves only that half. On a retired smoke booking the function returned
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

## Step 3: Snowflake purge (redact in place)

Trigger it. This redacts the same PII columns in place for the affected bookings,
so the warehouse keeps the PII-free analytics rows but holds none of the person's
contact data, then runs step 4's verify itself and reports the counts.

```
POST /api/admin/erasure-purge
```

Callable by a signed-in admin, or by an operator process holding `CRON_SECRET`. It
purges **every** booking in the `pii.erasure` audit trail by default, so you do not
need the ids from step 2 unless you deliberately want a subset:
`{"bookingIds": ["..."]}`.

Repeating it is safe, and idempotent in effect rather than in the counts: the
statements carry no "only if not already null" guard, so a second run re-nulls
already-null columns and reports the same rows changed. Judge a run by the verify
counts, never by the rows-changed counts.

It can only ever touch a booking that already appears in a `pii.erasure` audit row,
i.e. one whose contact data Slate has ALREADY erased in Supabase. An id outside
that trail is refused with a 400 rather than purged, so a typo cannot blank the
wrong person's row. `ok` in the response is true only when the verify measured zero
residual everywhere; a purge that ran and left data behind reports false and a 500.

### The SQL it runs

Kept here because an operator sometimes needs to read, or hand-run, exactly what
executed. This block is not a copy: it is the same text Slate executes, and
`scripts/test-erasure-purge-sql.ts` fails the build if this and
`src/lib/snowflake/purge-sql.ts` differ by a character. That parity is the point.
If the runbook kept its own copy, the every-6-hour probe below would only prove
that the copy compiles, and the version an operator pastes could rot untouched,
which is exactly how #1197 happened.

To hand-run it, substitute the ids from step 2 for `<ids>` (comma-separated,
single-quoted, e.g. `'id1','id2'`) and use your own Snowflake admin login.

<!-- canonical-sql: purge -->
```
update SLATE.PUBLIC.bookings
   set attendee_name = null, attendee_email = null, attendee_phone = null,
       prefill = object_construct()
 where id in (<ids>);

update SLATE.PUBLIC.booking_events
   set reason_detail = null
 where booking_id in (<ids>);

update SLATE.PUBLIC.webhook_deliveries
   set payload = object_construct('booking_id', payload:booking_id),
       last_response = null
 where payload:booking_id::string in (<ids>);

update SLATE.PUBLIC.booking_outbox
   set payload = object_insert(payload, 'reasonDetail', null, true),
       last_error = null
 where booking_id in (<ids>);
```

Because the Supabase redaction stamped `pii_redacted_at` / `payload_erased`, the
export lane has frozen the `bookings` and `webhook_deliveries` rows and will not
re-mirror the full-fidelity version back over your redaction.

Four things about the `webhook_deliveries` statement are deliberate. **Do not
"simplify" any of them**, and read this before editing that line:

0. It clears **`last_response` as well as `payload`**, and that column is the easy
   one to miss (#1205). It holds up to 1000 characters of whatever the subscriber
   sent back, and an error response commonly quotes the request that caused it, so
   it carries the person's name, email and phone (`docs/pii-retention.md` lists it
   as "may echo PII"). Supabase blanks it during erasure, but blanking is exactly
   what **freezes the row from re-export** so the mirror cannot clobber a
   redaction, which means the Supabase null **never reaches the warehouse**. This
   statement is the only thing that ever clears it there. Before #1205 it was left
   behind indefinitely and step 4 still returned zero.

1. It does **not** set `payload_erased`. That column exists only in Supabase, where
   it is the flag that freezes the row from re-export; the warehouse table has no
   such column and never did. Naming it made Snowflake reject the entire statement
   with an invalid identifier, so the payloads were silently never purged. If you
   are reading a copy of this runbook older than #1197, that is the bug.
2. It **keeps `booking_id`** rather than emptying the payload, which is what the
   Supabase side does. `payload:booking_id` is the ONLY key step 4 and the
   erasure-audit lane can find these rows by: the warehouse copy carries no
   `payload_erased` and no `dedupe_key` to fall back on. Empty the payload and the
   verify below returns 0 whether the purge worked or the rows were never there, so
   it becomes a check that cannot fail, which is worse than no check. A booking id
   is one of our own record identifiers, not personal data, so keeping it costs
   nothing against the request being honored.
3. It builds the survivor with `object_construct` rather than deleting keys with
   `object_delete`. Snowflake documents `OBJECT_DELETE` as **failing** on a key that
   is absent from a structured object, and documents nothing at all for the variant
   case these payloads are, while the payloads legitimately omit keys (`reason` is
   null on `booking.created`). `OBJECT_CONSTRUCT` is documented to omit a key whose
   value is NULL, so this form is the only well-defined one here.

`scripts/test-erasure-runbook-claims.ts` (claims 5 and 6) fails the build if this
statement names a column the warehouse lacks, drops the booking id, or reaches for
`object_delete`, so the three points above are enforced rather than merely asked for.

### It is proven to RUN, every six hours

A static guard can only check the SQL against a column list in this repo. What it
cannot check is whether the statements still compile against the warehouse as it
exists today, and that gap is the whole of #1197.

So the erasure-audit lane (`/api/cron/erasure-audit`, every 6h) now executes **every
statement above, plus step 4's verify**, bound to an id no booking can have
(`slate-purge-sql-probe-matches-nothing`, deliberately not uuid-shaped). Each one
must compile and report zero rows changed. A statement that stops running pages on
its own key, `snowflake_purge_sql_broken`, separate from the residual page so
neither can clear the other.

Stated plainly, because a check may claim only what it measured: this proves the SQL
parses and resolves against the live warehouse schema. A zero-row statement can only
ever report zero rows, so it says nothing about whether the statements clear fields
on a real row. That half is proven by the recorded runs below.

What step 4 can and cannot tell you, stated plainly: it proves that for every erased
booking id **still present in the warehouse**, no contact PII remains, in both the
payload and `last_response`. It cannot prove a row was not deleted or made
unfindable by some other means.

**`booking_outbox` is split: its payload is out of erasure scope, its `last_error`
is not.** Read both halves before editing that statement.

The **payload** carries no contact data: only `reasonCode`, a staff-typed
`reasonDetail`, `initiator`, timestamps, and internal agent and staff user ids
(`OutboxPayload`, `src/lib/db/types.ts`). Internal user ids are our own record
identifiers, not the data subject's personal data, and incidental mentions in staff
free text are explicitly not treated as PII requiring erasure (decision,
2026-07-31, #1199). So step 4 does **not** count `payload:reasonDetail`, and a
value there does not block honoring the request.

**`last_error` is different, and an earlier version of this runbook got it wrong by
asserting otherwise.** It is `err.message` from whatever a step threw
(`src/lib/booking/outbox.ts`), and two of those steps are OUTBOUND calls (a Google
Calendar delete and a notify), so the text is the external service's rather than
ours. A calendar API error can quote an attendee's email address back at us. We
cannot enumerate what a third party puts in an error string, so it is treated as
**possibly carrying contact data**: step 3 clears it, and step 4 verifies that
clear rather than assuming it.

**Never wait for the export to fix a `booking_outbox` residual.** An earlier
version of this runbook told you to "give the export a tick and re-check", on the
belief that the export would MERGE the blanked Supabase row over the warehouse
copy. That is false: `booking_outbox` retention is a **hard delete**, not a
redaction (`src/app/api/cron/prune-bookings-pii/route.ts`), so once the Supabase
row is gone there is nothing left to MERGE and no amount of waiting changes the
warehouse. Combined with "do not consider the request honored until it returns all
zeros", that left an operator waiting on a condition that could never clear
(#1199). Step 3's statement is the only thing that clears it; if
`outbox_error_residual` is non-zero, re-run step 3, do not wait.

## Step 4: verify (mandatory)

Step 3 runs this itself and returns the counts, so on the normal path you read them
in its response rather than running anything. Run it by hand when you hand-ran the
purge, or when you want to re-check later.

Every count **must be 0**. A non-zero count means the purge missed rows (or an
export re-mirrored them); do not consider the request honored until it returns all
zeros.

<!-- canonical-sql: verify -->
```
select
  (select count(*) from SLATE.PUBLIC.bookings
     where id in (<ids>) and attendee_email is not null) as bookings_residual,
  (select count(*) from SLATE.PUBLIC.booking_events
     where booking_id in (<ids>) and reason_detail is not null) as events_residual,
  (select count(*) from SLATE.PUBLIC.webhook_deliveries
     where payload:booking_id::string in (<ids>)
       and (payload:attendee:email is not null
            or last_response is not null)) as webhook_residual,
  (select count(*) from SLATE.PUBLIC.booking_outbox
     where booking_id in (<ids>)
       and last_error is not null) as outbox_error_residual;
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
need to see the rows. In Snowflake the rows stay findable by payload booking id
both before and after the purge, because the export freezes them at full fidelity
and step 3 deliberately keeps that one key, which is what makes steps 3 and 4 work there
and what keeps the erasure-audit lane a real check rather than a vacuous one.

### You are not the only check

`/api/cron/erasure-audit` re-reads every booking id in every `pii.erasure` audit
entry and asserts Snowflake holds no residual contact PII for it, alerting to
Slack when it does. So a skipped or half-finished step 3 gets caught even if
nobody re-reads this runbook. Treat that as a backstop, not a substitute: the lane
reports a residual, it does not clear one. That separation is deliberate rather
than a limit of the credential (see the correction at the top): a check that
silently fixed what it found would stop being able to tell you the purge had been
missed at all. If it pages about an erasure you performed, come back to step 3.

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

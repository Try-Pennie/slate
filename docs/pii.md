# Slate PII inventory and processor map

**What this document is for.** Answering, quickly and without reading code, two
questions: *where has a given consumer's data actually gone*, and *who else holds a
copy*. Those are the questions a deletion request and a breach both start with, and
the ones that take longest to answer from scratch.

**What lives elsewhere, deliberately.** This is the *processor map*: the outbound
flows. The field level inventory (which column holds what, and its class), the
retention windows, and the confirmed legal positions live in
[pii-retention.md](./pii-retention.md) §1, §2 and §9. The step by step for actually
honouring a request is [pii-erasure-runbook.md](./pii-erasure-runbook.md), and the
memo written for counsel is [pii-legal-positions.md](./pii-legal-positions.md).
Nothing here restates those, because two copies of a retention number is how one of
them becomes wrong (L41).

Written 2026-08-13 (#1045), measured from the code rather than from recollection.
Every claim below names the file that implements it, so it can be rechecked.

---

## 1. The flows at a glance

A lead types their name, email and phone into the public booker. Six places end up
holding some of it.

| Destination | What reaches it | Retention there | Reached by an erasure? |
|---|---|---|---|
| **Supabase** (system of record) | name, email, phone, prefill, reason free text, full webhook payloads | 24 months from the appointment, then redacted in place | **Yes**, this is what the erasure path clears |
| **Google Calendar** (the assigned agent's own calendar) | attendee name and email as a real invitee; phone in the event description | Indefinite. A completed meeting's event stays | **No** |
| **Regal / Cadence** (webhook subscriber) | name, email, phone, prefill, manage URL, plus asserted `voiceOptIn` / `smsOptIn` / `emailOptIn` | Theirs, unknown to Slate | **No** |
| **Snowflake** (archival mirror) | name, email, phone, prefill, **and the manage token** | 24 months, stated to match Supabase | **Yes**, but by a separate purge that must be run |
| **Cloudflare** (Worker logs) | whatever a log line or a serialized error happens to carry | 7 days, then gone | **No**, and it does not need to be |
| **Slack** (alerts) | **no lead contact data at all** | Slack's own | n/a |

The two rows worth pausing on are Google Calendar and Regal: both hold direct
contact data indefinitely and neither is touched when Slate honours a deletion.
That is a stated, accepted position rather than an oversight
([pii-retention.md](./pii-retention.md) §9 positions 3 and 4), and it is the part of
this map most exposed to challenge.

---

## 2. Google Calendar

**What goes there, and how.** On confirm, Slate creates an event on the assigned
agent's own primary calendar via domain wide delegation
(`src/lib/google/calendar.ts`). The lead is a real invitee, so their **name and
email address** are on the event, and their **phone number is written into the event
description** by `eventDescription` (`src/lib/booking/core.ts`), because that is what
the advisor reads when they dial.

**Who can see it.** The assigned agent, anyone that agent shares their calendar
with, and Google Workspace administrators. That set is governed by Workspace, not by
Slate, and Slate cannot enumerate it.

**Retention.** Indefinite. The retention lane deliberately does not touch calendars:
a completed meeting's event stays, and only a real cancellation deletes the event
([pii-retention.md](./pii-retention.md) §4). So a booking whose Supabase row was
redacted at 24 months still has a calendar event naming the person, on an agent's
calendar, for as long as that calendar exists.

**Consequence for an erasure request.** Honouring one leaves this copy in place.
Anyone answering a request should say so rather than implying the data is gone.

---

## 3. Regal and Cadence (webhooks)

**What goes there.** Every booking event (`created`, `rescheduled`, `cancelled`,
`completed`) POSTs a payload carrying `attendee.name`, `attendee.email`,
`attendee.phone`, the `prefill` blob, and the `manage_url`
(`src/lib/webhooks/types.ts`). For the Regal format, contact data is additionally
sent as **traits** keyed by the phone number and email address
(`src/lib/webhooks/regal.ts`).

**The consent assertion, and where consent actually comes from.** On
`booking.created`, Slate sends `voiceOptIn`, `smsOptIn` and `emailOptIn` as
`subscribed: true`. **Slate does not collect that consent and holds no record of
it.** There is no consent checkbox, no privacy notice and no policy link anywhere on
the booker: `src/lib/booking/booker-copy.ts` holds every sentence a lead reads and
contains none. Consent is captured upstream on the Pennie landing page that sends
the lead to Slate, and Slate asserts it on that basis with nothing in its own data
to evidence it.

That is the single largest gap in this map. If asked "prove this person consented to
being called", Slate cannot; the answer has to come from the landing page's own
records. **#1041** is the issue for putting a privacy link and consent copy on the
booker itself.

**Retention.** Regal's and Cadence's own, unknown to Slate.

**Erasure.** Not propagated, by stated position: they are treated as downstream
controllers with their own relationship to the consumer, and Slate holds no DPA for
this flow ([pii-retention.md](./pii-retention.md) §9 position 4). So a person told
their data is erased still has it held there.

**Copies Slate keeps of what it sent.** `webhook_deliveries.payload` stores the full
payload and `last_response` may echo it back. Both are in Supabase, in scope for
retention, and covered by §1 of the retention doc.

---

## 4. Snowflake (archival mirror)

**What goes there.** The booking mirror exports `attendee_name`, `attendee_email`,
`attendee_phone`, `prefill` and, notably, **`manage_token`**
(`src/lib/snowflake/export-core.ts`).

The manage token is worth calling out separately, because it is not a description of
the person, it is a **credential**: whoever holds it can reschedule or cancel that
booking without any other authentication. It is mirrored to the warehouse along with
the contact data, so warehouse read access is effectively booking control access.

**Who can see it.** Whoever holds Snowflake access. Slate's own export role can
UPDATE as well as INSERT, so Slate can redact the warehouse itself
([pii-retention.md](./pii-retention.md), and slate#1128 corrected three places that
wrongly claimed it could not).

**Retention.** 24 months, stated to apply to the mirror as well as to Supabase.

**Erasure.** Reached, but by a **separate** purge step that has to actually run.
This has bitten twice and both are recorded: the export freeze that protects a
redaction also stops the redaction reaching the mirror (slate#1205), and a runbook
purge step once named a Supabase only column and silently no-opped (slate#1197). The
erasure runbook is the authority on the order.

---

## 5. Cloudflare (Worker logs)

Cloudflare captures every `console` line from the deployed Worker with any `Error`
serialized, for **7 days**
([cloudflare-platform-notes.md](./cloudflare-platform-notes.md)). Nothing routes
attendee contact data there deliberately, and log lines go through `src/lib/log.ts`
with structured fields rather than raw records. But a serialized error can carry
whatever was in scope, so treat the log as *possibly* containing contact data rather
than as guaranteed clean.

The one path that deliberately carries free text out of a page holding a lead's
details is the **client error beacon** (`src/lib/api/client-error-scrub.ts`). It
scrubs email addresses, phone numbers and long digit runs in both the browser and
again on the server, and its own header states the limit plainly: it catches
*shapes*, and a person's **name has no shape**, so a message interpolating one
carries it through. What bounds that is what the beacon sends: a page level
signature and a short reason to Slack, full text to the log only, with field caps.
Residual, not eliminated.

Seven day retention means this needs no erasure step: any copy here ages out well
inside the 45 day response deadline.

---

## 6. Slack

**No lead contact data reaches Slack.** Verified 2026-08-13: no module under
`src/lib/notify` or `src/lib/monitor` references `attendee_name`, `attendee_email`
or `attendee_phone`. Alerts identify *agents* (by work email) and *bookings* (by id),
never leads by contact detail, and a guard already forbids interpolating a raw error
into alert copy (`scripts/test-alert-error-text.ts`), which is the shape most likely
to smuggle a record in.

Agent work email addresses do reach Slack. That is workforce data, not consumer PII,
and is out of scope for the consumer retention window.

Keep it this way. If an alert ever needs to name a booking, name its **id** and let
the reader open it, which is the pattern the alert copy rules already require.

---

## 7. Who can read consumer PII inside Slate

- **Postgres RLS is default deny**, and the only client readable row is a user
  reading itself. No consumer PII is readable by a browser session directly.
- **Server code uses the secret key client** (`supabaseAdmin`), which bypasses RLS,
  so every read of attendee data is gated by application authorization rather than
  by the database.
- **The admin surfaces show it.** `src/app/admin/page.tsx` selects
  `attendee_name, attendee_email, attendee_phone` and `RecentRoutingTable` renders
  them, behind the admin role check (`src/lib/auth/roles.ts`; agent < manager <
  admin, enforced server side).
- **The lead themselves**, through the manage link, which is authorized by the
  manage token alone. Note slate#1340: a weak contact match must never disclose
  another lead's booking or its token, because that token is a credential.

---

## 8. Answering a request

For the actual procedure use [pii-erasure-runbook.md](./pii-erasure-runbook.md).
What this map adds is the honest scope, which is the part easiest to get wrong when
replying to a person:

**A deletion request reaches:** the Supabase booking row (redacted in place, so the
row survives without contact data) and, via its own purge step, the Snowflake mirror.

**It does not reach:** the event on the agent's Google Calendar, the copy held by
Regal and Cadence, or the `salesforce_id` / `external_id` reference that still links
the redacted row to a Salesforce record. Cloudflare logs are not reached either but
age out in 7 days regardless.

Each of those is a recorded position rather than an accident, with its reasoning and
its residual risk in [pii-retention.md](./pii-retention.md) §9. Say what is true.

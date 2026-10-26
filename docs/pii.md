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

A lead types their name, email and phone into the public booker. Seven places end up
holding some of it.

| Destination | What reaches it | Retention there | Reached by an erasure? |
|---|---|---|---|
| **Supabase** (system of record) | name, email, phone, prefill, reason free text, full webhook payloads | 24 months from the appointment, then redacted in place | **Yes**, this is what the erasure path clears |
| **Google Calendar** (the assigned agent's own calendar) | attendee name and email as a real invitee; phone in the event description | Indefinite. A completed meeting's event stays | **No** |
| **Regal / Cadence** (webhook subscriber) | name, email, phone, prefill, manage URL, plus asserted `voiceOptIn` / `smsOptIn` / `emailOptIn` | Theirs, unknown to Slate | **No** |
| **Snowflake** (archival mirror) | name, email, phone, prefill, **and the manage token** | 24 months, stated to match Supabase | **Yes**, but by a separate purge that must be run |
| **Cloudflare** (Worker logs) | whatever a log line or a serialized error happens to carry, **plus the full request URL**, which for a prefilled booking link holds name, email and phone (#1046), and for a manage page holds **the manage token** in its path, an accepted risk (Dan, 2026-10-03; #3143) | 7 days, then gone | **No**, and it does not need to be |
| **Better Stack** (shipped Worker logs, #3105) | the same lines as Cloudflare AFTER redaction: every URL's query string and fragment cut whole, the manage token and legacy advisor link token replaced in every path, emails, phone numbers and long digit runs replaced. A **name** in free text has no shape and can survive | the Better Stack plan's: 3 days on the free tier, 30 to 90 days on a paid plan | **No**; see §5 on the 45 day deadline |
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

**The one other event Slate writes, and why it is not in that position** (#2371).
When the machine routes a lead back to the advisor who has already pitched them,
Slate writes a SECOND, advisor only event on that advisor's calendar: 20 minutes at
the head of the call, titled "ALERT: Previously pitched lead", with no attendees and
marked free. It carries **no lead name, email address or phone number**, and no link
either: the advisor reads who it is from the booking's own invitation, which is on the
same calendar at the same time and which this section has already accounted for. So it
is not a copy of anybody's data, it is outside the erasure scope, and Slate's record of it
(`owner_alert_events`, migration 0126) holds only a booking id, a user id, a calendar
address and a Google event id. A label on the booking's own event was rejected for
exactly the reason this section describes: Google copies an event's title and
description to every guest, and the lead is a guest on that one. Unlike the booking
event above, this one IS removed on a cancel and moved on a reschedule.

---

## 3. Regal and Cadence (webhooks)

**What goes there.** Every booking event (`created`, `rescheduled`, `cancelled`,
`reassigned`, `contact_updated`) POSTs a payload carrying `attendee.name`,
`attendee.email`, `attendee.phone`, the `prefill` blob, and the `manage_url`
(`src/lib/webhooks/types.ts`). A `contact_updated` (#1512) also carries the number
the lead replaced, `previous_attendee_phone`, and so does a `rescheduled` whose move
corrected the number (#2164, #4031). For the Regal format, contact data is additionally
sent as **traits** keyed by the phone number and email address
(`src/lib/webhooks/regal.ts`).

**The consent assertion, and where consent actually comes from.** On
`booking.created`, Slate sends `voiceOptIn`, `smsOptIn` and `emailOptIn` as
`subscribed: true`. A CORRECTED number is sent `isPrimary: true` with `voiceOptIn`
and `smsOptIn` as `subscribed: true`: on every `booking.contact_updated` (#1512), and
on a `booking.rescheduled` whose move also corrected the number (#2164), which the
payload says by carrying `previous_attendee_phone`. Primary because Regal's journey
triggered calls and texts go only to the primary phone; subscribed because they go
only to a phone carrying opt in. The rule is Dan's decision, recorded on #4031 on
2026-10-21: "a phone number a lead types on the manage page counts as consent." The
email on those events carries no opt in. Until that decision the corrected number was
sent primary with NO opt in, on the view that the landing page's consent covered only
the number given there. A number Slate FILLS into a booking that lacked one (a Marcia
move filling from the lead's earlier bookings or the Salesforce Lead, #4006) is not a
correction: the lead did not type it, so the decision above does not reach it, and it
rides `booking.rescheduled` for identity only, never primary and never opted in.
**Slate does not collect consent and holds no record of
it.** There is no consent checkbox and no consent sentence anywhere on the booker:
`src/lib/booking/booker-copy.ts` holds every sentence a lead reads and contains
none, and `pnpm preview:booker` prints the lot. Consent is captured upstream on the
Pennie landing page that sends the lead to Slate, and Slate asserts it on that basis
with nothing in its own data to evidence it. For a corrected number the basis is the
lead having typed it, by the decision above, and Slate records only the correction
itself (the booking row and its `webhook_deliveries` row), not any agreement.

**The policy links exist, and they are not the same thing as consent.** #1041 put
Pennie's Privacy policy and Terms of service on the lead facing surfaces that stand
alone: `legalLinks` in `src/lib/booking/booker-copy.ts`, rendered by
`src/components/LegalFooter.tsx` on the standalone booker
(`StandaloneBookerShell`) and on the manage page. They are absolute links to
trypennie.com, because those surfaces are served from slate.trypennie.app. The
EMBEDDED booker does not render them and does not need to: it sits inside a
trypennie.com page that already carries Pennie's policies. #2204 then deleted the
sentence that used to sit above the confirm button, on the grounds that it
explained the screen back to the reader and nothing legal rested on it, since Slate
records no consent anywhere and the sentence claimed no agreement. Neither change
altered what this section is about: a link to a policy tells a lead where the terms
are, and it is not a record that this person agreed to be called.

So the gap stands, narrower than it was. If asked "prove this person consented to
being called", Slate still cannot; the answer has to come from the landing page's
own records. What has changed since #1041 is only that a lead reaching the booker
directly can now find the policy.

**Retention.** Regal's and Cadence's own, unknown to Slate.

**Erasure.** Not propagated, by stated position: they are treated as downstream
controllers with their own relationship to the consumer, and Slate holds no DPA for
this flow ([pii-retention.md](./pii-retention.md) §9 position 4). So a person told
their data is erased still has it held there.

**Copies Slate keeps of what it sent.** `webhook_deliveries.payload` stores the full
payload and `last_response` may echo it back. Both are in Supabase, in scope for
retention, and covered by §1 of the retention doc.

**What comes back the other way, and why it is not a seventh holder (#2090).**
Regal also POSTS to Slate: its reporting webhook sends every completed call to
`POST /api/regal/calls`, and that body carries the lead's phone, email and
Salesforce lead id (`traits`, `userId`, `properties.contact_phone`) plus an AI
written summary of what was said (`properties.notes`). **For the detector's table,
none of it is stored:** its classifier in `src/lib/regal/inbound-call.ts` keeps three
things and drops the rest at the edge: Regal's `eventId`, the call's instant, and the
acting AGENT's email. `regal_call_events` holds only those, the agent email only on the rows about
a Slate user, and deletes everything after three days (`prune-regal-calls`). The
agent email is **staff data, not lead PII**: it is a Pennie employee's work address,
already held on `users.email`, so this feed adds nothing to the lead inventory above,
nothing to the erasure path, and nothing to the Snowflake mirror (the table is not
mirrored). Decided by Dan on 2026-09-08; widening what is kept (#324 wants the
disposition keyed to a booking, which means lead linkage) is a separate decision with
its own privacy review, never a drift.

**That widening, made deliberately (#2944).** The show rate in the Slate vs cal.com
split is judged from these calls, so a second table, `regal_call_outcomes`, keeps one
row per completed call for **120 days**: the lead's **Salesforce Lead id** (as its 15
character key, read from `userId`), Regal's event id, the call's start and talk time,
its direction, type and disposition, whether a conversation happened, whether the AI
agent placed it, and the acting agent's work address. Dan decided on 2026-10-01 that
the Salesforce id is an **external id and safe to store**, the same footing as
`bookings.salesforce_id` (pii-retention.md §1). Still **no phone, no lead email, no
name and no notes**: the edge never reads them. The table is not mirrored to
Snowflake and is outside the erasure function, since it holds an external reference
and no contact data; `prune-regal-calls` deletes each row 120 days after receipt.

---

## 4. Snowflake (archival mirror)

**What goes there.** The booking mirror exports `attendee_name`, `attendee_email`,
`attendee_phone` and `prefill` (`src/lib/snowflake/export-core.ts`).

**It no longer carries the booking manage token** (slate#2564). That token is not a
description of the person, it is a **credential**: whoever holds it can reschedule or
cancel that booking with no other authentication, so mirroring it made warehouse read
access equal to booking control access.

It reached the warehouse by two routes, and the second was the larger. Measured on
2026-09-18, `bookings.manage_token` covered 2,392 rows while
`webhook_deliveries.payload.manage_url`, the same token in a link inside a payload
mirrored whole, covered 6,522 of 6,550 deliveries. Both are stripped now, both are
declared in one place (`src/lib/snowflake/mirror-credentials.ts`), and three things
are derived from that declaration: the redaction applied in `buildMergeSql`, which
every merge path goes through; the 6 hourly sweep that clears rows already exported
and pages if a residual survives; and `scripts/test-mirror-credentials.ts`, which
fails the build when a credential shaped column joins the mirror without being
declared or reasoned about.

The warehouse columns are left in place and permanently null rather than dropped: a
DROP is hand applied DDL against production that would break any consumer naming
them, and gains nothing over a column nothing writes.

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

### The booking URL itself carries contact data, on every request

This is the one path here that is not incidental, and it is an accepted position
rather than a gap (#1046).

The cal.com compatible entry point takes the lead's details as **query parameters**:
`/book?bucket=411&name=…&email=…&phone=…`, which is how cal.com's own embed works
and therefore how Slate's has to work to be a drop in replacement. Cloudflare
records the full request URL on every invocation, so for a lead who arrives with a
prefilled link, their name, email and phone are in the log for the 7 day window. Not
because anything logged them, but because they are in the address that was fetched.

The reduction was considered and declined. Passing prefill through `postMessage` or
`sessionStorage` would keep it out of the URL for a JavaScript embed host, but the
bare link fallback is a real supported path (an email or an SMS with a prefilled
booking link, no host page to talk to), and query parameters are the frozen contract
`widget.js` mirrors. Splitting the two would mean two prefill mechanisms and a
different one taken depending on how a lead arrived, for a copy that ages out in a
week inside a log only Pennie can read.

What makes it acceptable, stated plainly so it can be challenged: the unredacted
copy lives only in Cloudflare, for 7 days, reachable only with Cloudflare account
access, and nothing downstream reads a URL back out of it. The logs ARE exported
since #3105, to Better Stack, but the URL leaves without its query string: the tail
worker cuts every query and fragment whole before anything is sent (next subsection),
so the prefill never reaches the longer lived copy. What would change the decision is
an export that kept the query (any new log destination must reuse that redaction, not
ship raw lines) or the bare link path being retired.

Seven day retention means this needs no erasure step: any copy here ages out well
inside the 45 day response deadline.

### Shipped to Better Stack, redacted first (#3105)

Since #3105 a tail worker (`worker/log-tail/index.ts`) forwards every Slate log line,
uncaught exception and invocation outcome to Better Stack, which keeps them for the
plan's retention rather than Cloudflare's 7 days. That is the "log retention grows"
case the two positions above and below name, so the copy that leaves Cloudflare is
not the copy Cloudflare holds. Before anything is sent
(`src/lib/log-shipping/redact.ts`, `records.ts`):

- **every URL loses its query string and fragment whole.** The prefill is percent
  encoded, which defeats any shape a scrub looks for (L741), so it is never scrubbed,
  it is cut. This is what turns the prefill position above from "in the log" into
  "not in the shipped log".
- **every credential in a path is replaced** with `[redacted]`: the manage token on
  `/booking/manage/…` and `/api/bookings/…/cancel|phone`, and the legacy advisor link
  token on `/book/advisor/…`. The list of dynamic routes and what happens to each is
  `DYNAMIC_SEGMENT_POLICY`, and `scripts/test-log-shipping-routes.ts` fails when a new
  `[param]` route appears that it does not classify.
- **every message, stack and string field goes through `scrubContactData`**, the same
  scrub the client error beacon and the fault page use, so emails, phone numbers and
  long digit runs become markers. The scrub reads DECODED text (#4237): a `slate`
  line is parsed first, each field is scrubbed, and the shipped message is rebuilt
  from those scrubbed fields; an object argument has its strings scrubbed before it
  is turned into JSON. Escaped text writes a line break as backslash n, which the
  phone shape does not read as a break, so scrubbing it as written let a phone after
  a line break ship in the clear.
- **request headers and `cf` are never sent**, so no cookie, authorization header or
  client address leaves.

The residue is the beacon's: a **name** interpolated into free text has no shape and
is not caught. What bounds it is that nothing logs a lead's name on purpose.

**The erasure question depends on the plan, and is a decision, not a default.** On
the free tier (3 days) and on any plan of 45 days or less, a copy ages out inside the
45 day response deadline and needs no erasure step, exactly like Cloudflare's. A
plan **longer than 45 days** (the 90 day option) holds a copy past the deadline, so
choosing it means either accepting that the redacted residue (names in free text
only) is out of scope for erasure and saying so in
[pii-retention.md](./pii-retention.md), or adding a Better Stack deletion step to the
erasure runbook. Better Stack is also a new processor to list wherever processors are
disclosed.

### The manage token is in the URL path (#3143)

The manage page is `/booking/manage/[token]`, and the token alone authorizes
viewing, rescheduling and cancelling that booking. So every manage page request
puts a live credential into the same 7 day request log as the prefill above.

**This is an accepted risk (Dan, 2026-10-03).** The link stays as it is. Moving
the token out of the path (for example, exchanging it for a cookie on the first
load and redirecting to a tokenless address) would change the link every lead
already holds in an email and a calendar invite. What bounds the exposure is the
same as for the prefill: the copy holding the token is Cloudflare's, kept 7 days and
reachable only through the Cloudflare account. Treat that log as holding manage
tokens. The logs are exported since #3105, and the exported copy carries `[redacted]`
in place of every manage token, so the longer lived copy does not extend this risk.

---

## 6. Slack

**No lead contact data reaches Slack.** Verified 2026-08-13: no module under
`src/lib/notify` or `src/lib/monitor` references `attendee_name`, `attendee_email`
or `attendee_phone`. Alerts identify *agents* (by work email) and *bookings* (by id),
never leads by contact detail, and a guard already forbids interpolating a raw error
into alert copy (`scripts/test-alert-error-text.ts`), which is the shape most likely
to smuggle a record in.

The one alert that carries a library's own error text is the unexpected fault page
(`reportInternalError`, `src/lib/api/errors.ts`), whose detail is the diagnosis
itself. Since #3143 that detail goes through `scrubContactData` (the client error
beacon's scrub) before it is shortened, so an error quoting an email address, a
phone number or a URL with its prefill query reaches Slack with those replaced by
markers, while the log keeps the full text. A name has no shape and is not caught,
the same residue the beacon carries.

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

**What the audit trail records, and what it deliberately does not (#3089).** The
trail (`audit_log`, written through `recordAudit` in `src/lib/audit.ts`) records
CHANGES: every privileged write, after it succeeds, with the value before and after.
It does **not** record staff VIEWS of lead data, by decision (Dan, 2026-10-03: "No,
changes only"). So "which staff member looked at this lead's details" cannot be
answered from Slate; "who changed this, from what, to what" can. Reconsider if a
regulator or a contract asks for an access log, which would be a new table and a
write on every admin page read rather than an extension of this one.

---

## 7a. Credentials Slate stores, and encryption at rest (#3091)

Anyone who can read the database (a leaked service key, a backup copy, a SQL editor
session) can read whatever is stored in plaintext in it. Four columns hold a bearer
credential, and each has a recorded position:

- **`bookings.manage_token`, the lead's manage code, stays as it is.** It is handed
  to the lead in their confirmation email and calendar invite, and it authorizes
  only that one booking. It is deliberately public to the person who holds it, so
  hashing it would protect nothing the email does not already expose, while making
  it impossible to re-send the link (Dan, 2026-10-03).
- **`agent_links.token`, an advisor's personal booking link code, stays as it is**,
  for the same reason: it is the advisor's own link, handed out to leads on purpose,
  and it books a call with that advisor and nothing more. When it ends up somewhere
  it should not, it is rotated (`rotated_at`, `rotated_by`) rather than hidden.
- **`webhook_endpoints.auth_header`, the Regal API key, is now the Worker secret
  `REGAL_WEBHOOK_KEY`**, and
- **`webhook_endpoints.secret`, the HMAC signing secret, is now the Worker secret
  `WEBHOOK_SIGNING_SECRET`.** Both are real credentials that nobody outside Slate
  should hold, so only the running Worker can read them. The admin webhooks page
  shows whether each is set and cannot edit either; changing one is a deploy step
  (DEPLOY.md, section 2b). The move was expand then contract: the expand half read
  the Worker secret with the column as a fallback and paged until both were set;
  migration 0163 nulled both columns, and the code no longer reads them at all, so a
  value written there by hand is ignored rather than becoming the credential again.
  The columns remain only because the code deployed before 0163 still selected them.

**Encryption at rest, as each platform states it.** This protects a stolen disk or a
raw storage copy. It does NOT protect against a reader with database access, which
is why the two real credentials above move into the Worker rather than relying on it.

- **Supabase** (the Postgres database and its backups): "All customer data is
  encrypted at rest with AES-256 and in transit via TLS." Source:
  [supabase.com/security](https://supabase.com/security), read 2026-10-03.
- **Snowflake** (the archival mirror): "All Snowflake customer data is encrypted by
  default", with "strong AES encryption with a hierarchical key model rooted in a
  cloud-provider-hosted hardware security module", keys rotated automatically every
  30 days. Source:
  [Understanding encryption key management in Snowflake](https://docs.snowflake.com/en/user-guide/security-encryption-manage),
  and [end-to-end encryption](https://docs.snowflake.com/en/user-guide/security-encryption-end-to-end),
  read 2026-10-03.

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

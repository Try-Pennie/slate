# Booking API

A key-authed HTTP API for programmatic / AI booking. It applies the **same XBC
bucket routing, round-robin assignment, and verify-on-book** as the embed, and
creates the booking server-side in one call — no browser automation. (Replaces
the old headless embed-scraping auto-booker. Refs #253/#250.)

> **Two surfaces:**
> - **Public create** — `POST /booking` (keyless; same as the embed form submit).
> - **Key-authed API** — everything under `POST|GET|DELETE /api/bookings`
>   (requires `Authorization: Bearer <your caller's key>`).

Three calls cover the full flow:

1. **Find slots** — `GET /api/availability` (public, cached).
2. **Book a slot** — `POST /api/bookings` (key-authed).
3. **Look up / list / cancel** — `GET /api/bookings` / `DELETE /api/bookings` (key-authed).

---

## 1. Find slots — `GET /api/availability`

```
GET /api/availability?bucket=411&from=<ISO>&to=<ISO>
```

- `bucket` (required) — the XBC bucket code.
- `from` / `to` (optional ISO instants): default from now to a few days ahead.
  Every slot returned lies inside them (#2220). Slate offers only the next few
  open days, so a window that starts after the last offered time returns
  `slots: []` with `emptyBecause: { "kind": "beyond_horizon", "lastOfferedAt":
  "<ISO>" }`, never the times of another window. A bound that cannot be read as a
  time is ignored.
- Public, no auth. Reads the precomputed cache (no live Google), edge-throttled
  ~30/min per datacenter (fails open).

Response:

```json
{ "bucket": { "code": "411" }, "slots": ["2026-07-01T15:00:00.000Z", "..."], "emptyBecause": null }
```

`emptyBecause` is null whenever there are slots. With none it says why, when that can
be told: `closed` (with `reopensOn`), `unstaffed`, `busy`, or `beyond_horizon` (with
`lastOfferedAt`).

> **Read→book race.** Slots come from a cache that lags real calendars by up to
> ~1 minute, and verify-on-book runs at booking time. A slot you read here can be
> gone by the time you book it — handle a `SLOT_TAKEN` response (below) by
> re-querying and picking another slot. This is expected, not an error in your
> integration.

### The org's own opening hours (#1295)

Every slot passes three gates: the **org's business hours**, then the **agent's**
own working hours, then their calendar. The first is org-wide (Monday to Saturday
08:00 to 20:00 America/New_York as seeded, admin-editable), so a time outside it
is never offered and can never be booked, however the roster is configured.

The window is judged in the org's zone and the agent's in theirs; they are never
intersected, so an agent outside Eastern is treated correctly in both directions.

---

## 1b. Check one time: `GET /api/bookings/bookable` (key-authed)

Ask whether a specific bucket and time **could** be booked, before collecting the
lead's details, so a caller never offers a slot that then fails at confirm. It runs
the real routing pass (round-robin plus verify-on-book, cascading the debt-tier
ladder) with writes disabled, so the answer cannot disagree with an actual book.

```
GET /api/bookings/bookable?bucketCode=411&startIso=<ISO>&timezone=<IANA>
```

- `startIso` (required): the instant to test.
- `bucketCode` (optional): falls back to the admin-configured default bucket;
  with neither, `400 NO_DEFAULT_BUCKET`.

Response `200`:

```jsonc
{ "bookable": true, "reason": "available",
  "effectiveBucketCode": "411", "tierFallback": false, "rungsDropped": 0,
  "wouldAssign": { "id": "…", "name": "…", "email": "…" } }
```

`reason` says **why**, and the causes are deliberately distinct:

| `reason` | `bookable` | Meaning |
|---|---|---|
| `available` | `true` | An agent would take it; `wouldAssign` names who. |
| `closed` | `false` | The **org** is not open at that time. No roster change makes this bookable; the hours themselves have to change. |
| `slot_taken` | `false` | The org is open and the pool is staffed, but every agent down the tier ladder is busy at that instant. Try another time. |
| `no_eligible_agents` | `false` | No agent is eligible for that bucket at all, all the way down the ladder. A configuration problem, not a busy diary. |

`closed` was added in #1295. Before it, a closed hour answered `slot_taken` (that
the times had gone) about times nobody was ever offered.

Other codes: `422` unknown or hidden bucket, `429` over the per-key ceiling
(~200/hr, since each call is a full routing pass), `503` a transient calendar
outage. A `503` is never downgraded to a confident `bookable: false`.

---

## 2. Book a slot — `POST /api/bookings`

### Auth

```
Authorization: Bearer <your caller's key>
```

- **One key per caller** (#2645). Each system that calls this API holds its own
  secret, so rotating or revoking one never touches another, and the logs and the
  rate ceiling can say who made a request:

  | Caller | Worker secret | Rotation slot |
  |---|---|---|
  | Regal | `BOOKING_API_KEY_REGAL` | `BOOKING_API_KEY_REGAL_2` |
  | trypennie | `BOOKING_API_KEY_TRYPENNIE` | `BOOKING_API_KEY_TRYPENNIE_2` |
  | smoke canary | `BOOKING_API_KEY_CANARY` | `BOOKING_API_KEY_CANARY_2` |
  | Marcia (Pipedream SMS workflow), cancel only | `BOOKING_API_KEY_MARCIA` | `BOOKING_API_KEY_MARCIA_2` |

  **Marcia's key opens the cancel and nothing else** (#2940): `POST
  /api/bookings/cancel` and `DELETE /api/bookings`. Every other route refuses it
  with `401`, exactly as the smoke endpoints refuse a partner key. Marcia cancels a
  lead's booking when the lead opts out or asks to cancel by text, and a key that
  could also book or read every lead's bookings would be a wider grant than that.
  The set lives in `CANCEL_ONLY_CALLERS` (`src/lib/booking/api-callers.ts`), and a
  route admits it only by naming every caller; the default leaves it out, so a new
  route refuses it without having to say so.

  There is no shared key. The one every caller held before the split is retired
  (#2865): the canary moved to its own, Regal was given a fresh one, and trypennie
  kept the value it already had, now in its own `_2` slot. Never give two callers
  the same value: the request would be attributed to whichever is listed first.
- **Each caller has two slots** so its secret rotates with **zero downtime**: add
  the new key in the `_2` slot, point that caller at it, then retire the primary.
  **When you retire one, add its hash to `BOOKING_API_RETIRED_KEY_HASHES`**
  (#2879, the step is in `DEPLOY.md`), so a caller still presenting it pages
  `retired_booking_key` naming its host and route, instead of being found by a lead
  landing on a broken page. Do it once the old value has LEFT its slot, never
  before: a key still in a live slot authenticates, so its hash can never fire.
  The list is empty today, because the old shared key's value still lives in
  `BOOKING_API_KEY_TRYPENNIE_2`; it is armed at the next rotation.
  `pnpm -s hash:retired-key <label>` prints the WHOLE list (the committed
  `docs/retired-booking-key-hashes.txt` plus the new entry) for the secret, because
  `wrangler secret put` replaces the value and it cannot be read back; once the put
  succeeds, `pnpm -s hash:retired-key --record <label>` adds the entry to the file.
- `503` if no key is configured (endpoint disabled); `401` on a missing/wrong key.
- **A hand run probe with a partner's key sends `X-Slate-Probe: <why>`** (#2868), for
  example `curl -H 'X-Slate-Probe: key check after rotation' ...`. It is answered
  exactly as any call, and recorded as `probe:<caller>` rather than as the partner, so
  it can never make their key look proven in `pnpm verify:parallel-run-readiness` or
  on `/admin/booking-outcomes`. Do not fake an `Origin` to achieve the same thing.
- The smoke endpoints (`/api/smoke/*`) and the hidden test buckets accept only
  the canary's key, never a partner's.
- **Rate limit:** per CALLER (both of a caller's slots share one budget), generous, a runaway/leaked-key backstop rather than a
  per-request throttle. Writes (`POST`/`DELETE`) and reads (`GET`) draw from
  **separate** ceilings, so frequent status polling can't throttle the booking
  path: writes 120/min · 6000/hr, reads 600/min · 30000/hr. Over a ceiling → `429`.

### Request body

```jsonc
{
  "bucketCode": "411",                       // required — XBC bucket
  "start": "2026-07-01T15:00:00Z",           // required — ISO instant WITH an
                                             //   explicit offset (Z or ±HH:MM)
  "timezone": "America/New_York",            // required — IANA zone (display)
  "attendee": {                              // required — all three fields
    "name": "Dana Lee",
    "email": "dana@example.com",
    "phone": "+12155550100"
  },
  "externalId": "00Q5x000001abcEAA",         // required — the lead's Salesforce id
  "salesforceId": "00Q5x000001abcEAA",       // optional — defaults to external_id
  "prefill": { "utm_source": "regal" },      // optional — forwarded in webhooks
  "confirmReschedule": false                 // optional — see "rebook" below
}
```

Validation is strict (returns `VALIDATION`): name + email + phone all required,
`timezone` must be a real IANA zone, and `start` must carry a timezone offset (a
bare local time is rejected, since it could book the wrong hour).

#### `prefill` carries the partner join keys (#2659)

Two keys inside `prefill` mean more than "forwarded": **`submissionId`**, the
lead's Salesforce submission (`sfdc_submission_id` in Pennie's GTM/GA4 tagging
spec), and **`regalProfileId`**, the Regal contact, when the page has one. They
are how the warehouse ties a booking to a lead and to a call platform contact
without leaning on GA4. They live INSIDE `prefill` rather than as top level
fields because that is where the embed already puts them (`/book` keeps every
URL param there), so there is one home and one reader. Send them there, under
exactly that spelling:

```jsonc
"prefill": { "submissionId": "a0G5x00000AbCdEQAU", "regalProfileId": "rp_01HZY3" }
```

Leave a key out when the page has no value; an empty or blank value is read as
absent. They come back on every view (sections 3 to 5, and the confirm response
below) as `submissionId` and `regalProfileId`, `null` when absent, and reach Regal
as `properties.sfdc_submission_id` and `properties.regal_profile_id`, left out of
the event entirely when absent.

#### `prefill.source` records where the booking came from (#2072)

`source` inside `prefill` names the page the lead is booking from, from the
vocabulary in the README's URL contract (for example `"prefill": { "source":
"offerhub" }`). It is read on the server: an absent or blank value is recorded as
`not-given`, and a value outside the vocabulary is still booked and recorded as
`unrecognised`, so a caller that sends none is never refused for it.

#### `prefill.leadIdFrom` is written by Slate, never by a caller (#3739)

On a booking made through an advisor's own link (`kind = 'agent_link'`),
`prefill.leadIdFrom` records where its Salesforce id came from: `link` when the
link carried it, `earlier-booking` when the link carried none and Slate took it
from the lead's earlier bookings (the same email AND the same phone, every one of
them naming one Lead; two different Leads save none). Any value a caller sends
under that key is dropped on every booking, so it cannot be forged.

### One active appointment per person (dedupe + auto-reschedule)

Before creating, the API looks the person up across **active** bookings by
`externalId`, then `salesforceId`, then email and phone, so a returning lead
never ends up double-booked, even across channels. **A strong id you send is
matched against either id column** (#2663): a booking made through the embed
holds the lead's id as its `salesforceId` and has no `externalId`, so sending
only `externalId=<lead id>` still finds it, and so does sending only
`salesforceId`. A different lead's id matches nothing.

| Situation | `outcome` | HTTP | What happened |
|---|---|---|---|
| No existing appointment | `created` | 200 | New booking created. |
| Same person, **same slot**, same bucket | `deduped` | 200 | Existing booking returned; nothing created. |
| Same person, **same slot**, **different bucket** | `rescheduled` | 200 | The lead is **moved to the new team** at the time they already hold (#1465). |
| Same person, **different time**, confident match¹ | `rescheduled` | 200 | Existing booking **moved** to the new time. |
| Same person, **different time**, weak match² | `confirm_required` | 409 | **No change made.** The existing appointment is returned — confirm with the lead, then retry with `confirmReschedule: true`. |

¹ confident = matched by `externalId`/`salesforceId`, **or** by both email **and** phone.
² weak = matched by email **or** phone only. The confirm step guards against
silently moving the wrong person (shared household phone, recycled id).

A booking made through an advisor's own link (#2073, `kind = 'agent_link'`) can
only be moved to a time that same advisor can take; a time only somebody else in
the bucket is free for is refused. Read the times it CAN move to with
`GET /api/availability?booking=<manageToken>` (#2827, `docs/api.md`), not the
bucket's pooled times.

> A rebook **moves the existing appointment** rather than making a second one. If
> it targets the **same bucket**, the appointment's time is shifted in place. If
> it targets a **different bucket**, the lead is **moved to the new bucket** (a
> fresh booking is created there and the old one is cancelled), so they route to
> the team matching their new request. That holds at a new time (#364) **and at
> the time they already hold** (#1465): a bucket change is a routing request, not
> a time request, and a re-tiered lead confirming their existing slot is the
> ordinary call.
>
> The new booking is created **before** the old one is cancelled, so a bucket with
> nobody free leaves the lead's appointment intact. At the same instant that
> matters most, because the lead's own booking still occupies their current agent
> while the new one is placed. When the move is refused that way, the response is
> `deduped` with a **`bucketChangeDeclined`** object naming the requested bucket
> and the reason (`slot_taken` or `no_eligible_agents`), so the caller can tell
> that the bucket it asked for is not the bucket the lead is in. The field is
> absent whenever nothing was declined.

### Success / confirm response

```json
{
  "outcome": "created",
  "booking": {
    "id": "…",
    "externalId": "lead-abc-123",
    "startsAt": "2026-07-01T15:00:00.000Z",
    "endsAt": "2026-07-01T15:30:00.000Z",
    "status": "confirmed",
    "agent": { "name": "…", "email": "…" },
    "manageUrl": "https://…/booking/manage/<token>",
    "submissionId": "a0G5x00000AbCdEQAU",
    "regalProfileId": null,
    "contact": { "name": "…", "email": "…", "phone": "+1…" },
    "calendarLinks": { "google": "…", "outlook": "…", "office365": "…", "ics": "…" }
  },
  "bucket": {
    "code": "421",
    "requestedCode": "411",
    "tierFallback": true,
    "rungsDropped": 1
  }
}
```

#### `contact` and `calendarLinks` (#2643)

The lead's own contact as stored, and four add to calendar links, the same
fields the by id lookup (section 3) returns and from the same builder. Both are
**left out on `confirm_required`**, because the booking named there is one a
weak match found and may belong to somebody else (#1340). See section 3 for what
each link is. The partner join keys `submissionId` and `regalProfileId` (#2659)
are withheld on `confirm_required` for the same reason, and carried on every
other outcome off the booking the response names (on `deduped` and `rescheduled`
that is the booking the lead already held).

#### `bucket`: which team owns the lead (#1515)

Present on every success and on `confirm_required`. **`code` is the bucket the
lead is actually in**, which is not always the one you asked for: a cross bucket
rebook moves them to a new team (#364, #1465), and tier fallback can route the
request down a rung. Do not infer the team from the agent, who may serve more
than one bucket, and who tells you nothing about a tier drop.

| Field | Meaning |
|---|---|
| `code` | The effective bucket, read from the booking's own routing trace. `null` when that booking predates the trace (2 of 1,146 rows as of 2026-08-17, none of them active) — it is never the requested code standing in for the real one. |
| `requestedCode` | The `bucketCode` this request named, echoed so the two can be compared without keeping state. |
| `tierFallback` | The booking named in the response was placed a rung down from the tier that was asked for. |
| `rungsDropped` | How far down. `0` when `tierFallback` is false. |

On a `deduped` outcome the booking returned is the one the lead **already held**,
so `bucket.code` is the team they are still in and `tierFallback` describes how
that earlier booking was routed, not this request. That is the point: when a
bucket change is refused, `bucket.code` names where the lead really is while
`bucketChangeDeclined` names what was dropped.

### Errors

Every failure returns `{ "error": "<message>", "code": "<CODE>" }` (plus
`fieldErrors` for `VALIDATION`). Branch on `code`, never on the message:

| `code` | HTTP | Meaning | What to do |
|---|---|---|---|
| `VALIDATION` | 400 | Bad request body | Fix the request; don't retry as-is. |
| `NOT_FOUND` | 404 | Booking not found / not owned / not active (GET/DELETE only) | Check the booking id and ownership; booking may be cancelled or completed. |
| `UNKNOWN_BUCKET` | 422 | Bucket code resolves to nothing | Config error — stop, escalate. |
| `NO_ELIGIBLE_AGENTS` | 409 | Bucket has zero eligible agents | Config error (e.g. unsynced XBC) — stop, escalate. |
| `SLOT_TAKEN` | 409 | The slot filled before booking | Re-query availability, pick another slot. |
| `VERIFY_UNAVAILABLE` | 503 | Couldn't confirm calendars (transient) | Retry shortly. |
| `OUTSIDE_CALLING_WINDOW` | 422 | The start is before 08:00 or at or after 20:00 in the request's `timezone`, the lead's calling window (#2310). Applies to a create and to the reschedule a rebook turns into. | Pick a time inside the window. The same time can never succeed, so do not retry it. |
| `WRITE_FAILED` | 503 | The cancel statement did not run, so the booking still stands (DELETE only) | Retry shortly. Nothing changed, so a retry is safe. |
| `INTERNAL` | 500 | Unexpected | Retry once; if it persists, escalate. |

**The lead's calling window (#2310).** A call may only START from 08:00 up to
(not including) 20:00 in the lead's zone, which is the request's `timezone`; an
unreadable zone is judged in `America/New_York`, never skipped. `GET
/api/availability` is served from a shared cache and is NOT filtered by anybody's
zone, so a caller offering times to a lead must drop the ones outside the window
itself, as the Booker does. The Booker's keyless `POST /booking` refuses the same
way, with `422 OUTSIDE_CALLING_WINDOW` and a sentence for the lead.

`UNKNOWN_BUCKET` / `NO_ELIGIBLE_AGENTS` are deliberately distinct from
`SLOT_TAKEN` so a misconfigured bucket makes you **stop and escalate** instead of
retrying a never-bookable slot forever.

### Dry run (test mode)

Add `"dryRun": true` to any request to preview **what would happen** without
creating a calendar event, a booking, or firing a webhook. It runs the real
routing — person match, round-robin, and verify-on-book — and returns the
outcome plus, for a would-be create, the agent who **would** be assigned:

```json
{ "dryRun": true, "outcome": "created",
  "wouldAssign": { "id": "…", "name": "…", "email": "…" },
  "existingBookingId": null }
```

For `deduped` / `rescheduled` / `confirm_required`, `wouldAssign` is null and
`existingBookingId` names the matched appointment. Routing failures still surface
as their normal error code (e.g. `NO_ELIGIBLE_AGENTS`), so a dry run is a safe way
to check that a bucket is bookable. A dry run is side-effect-free and does not
alert.

### Test buckets emit no webhooks (#459)

A key-authed caller may book a hidden `is_test` bucket (that is how the smoke test
books a real booking against a real calendar). Those bookings are **fully real
everywhere except downstream**: they create the calendar event, hold the slot, and
record history exactly like a lead's booking, but they emit **no** webhooks at all,
on any event (created, rescheduled, cancelled, completed). So a smoke run never
injects a synthetic lead into Regal or Cadence, and never cancels one there either.

This is a property of the bucket, not of the caller: flag a bucket `is_test` and
nothing booked on it can reach a downstream system.

### The public test bucket (#2660)

One test bucket, `PARTNER`, is served on the PUBLIC paths with no key at all:
`GET /api/availability?bucket=PARTNER`, `GET /api/availability/next`, the `/book`
page and the Booker's own `POST /booking`. It is how a partner tests the embed
from their own site without booking a real advisor. It is still `is_test`, so
everything above holds: no webhook, no reminder, a test calendar. The
`slate-embed-contract` skill has what a tester will see. The canary's hidden
buckets stay hidden: to a keyless caller they answer the same 404 as a typo, and a
hidden code posted to `POST /booking` gets the same `422 UNKNOWN_BUCKET` an unknown
code gets (#2667).

### Idempotency

Retrying with the same `externalId` + slot is safe: the same call dedupes to the
existing booking (`deduped`) rather than creating a second one.

---

## 3. Look up a booking — `GET /api/bookings` with `externalId` (key-authed)

Resolve a lead's booking(s) by the same `external_id` used to create them — no
need to retain the per-booking manage token.

```
GET /api/bookings?externalId=<id>                 # list active bookings
GET /api/bookings?externalId=<id>&bookingId=<id>  # one booking, any status
GET /api/bookings?externalId=<id>&bookingId=<id>&status=confirmed  # assert state
```

- `externalId` (required) — the lead's stable id (the Salesforce id). Optionally
  pass `salesforceId` too; resolution is by **strong id only**. **Each id you
  supply matches a booking whose `external_id` OR `salesforce_id` equals it**
  (#2657): a booking made through the embed stores the lead id in
  `salesforce_id` only, one made through `POST /api/bookings` stores whichever
  ids you sent, and you cannot tell which route made it, so `externalId=<lead id>`
  finds either. A different lead's id still gets a `404` or an empty list.
- `bookingId` (optional) — return just that booking. Without it, returns the
  person's **active** bookings (`confirmed`/`rescheduled`).
- `status` (optional, by-id only) — `confirmed` | `rescheduled` | `cancelled` |
  `completed`. Returns the booking only if it is in that status, else `404`.

Response (list): `{ "bookings": [ <booking>, ... ] }` — empty array if none.
Response (by id): `{ "booking": <booking detail> }`, which is `<booking>` plus the
two fields below.

```jsonc
// <booking>
{
  "id": "…",
  "externalId": "…",
  "salesforceId": "…",
  "startsAt": "2026-07-01T15:00:00.000Z",
  "endsAt":   "2026-07-01T15:30:00.000Z",
  "status":   "confirmed",
  "agent":    { "name": "…", "email": "…" },
  "manageUrl": "https://…/booking/manage/<token>",
  "isTest":   false,
  "submissionId":   "a0G5x00000AbCdEQAU",
  "regalProfileId": null
}
```

- **`isTest`** (#2660) is `true` for a booking on a test bucket: the public
  `PARTNER` bucket a partner tests the embed with, or the canary's hidden ones. It
  reached a test calendar and no downstream system (no webhook, no text). A host's
  confirmed page reads it to label a test booking; the Booker's own confirm
  response and the `slate:bookingSuccessful` payload carry the same field. A test
  booking is readable and cancellable here with your own key, by the same strong
  id, exactly like a real one: that is how the confirmed page is tested end to
  end. Read off the booking's bucket on the server, never off the caller.
- **`submissionId`** and **`regalProfileId`** (#2659) are the partner join keys
  the landing page put on the booking URL (section 2), read off the booking's
  own `prefill`, trimmed, and `null` when the page passed none or an empty
  value. The field is always present, so a reader never has to tell "absent"
  from "not yet supported". A host's confirmed page can carry them onward, and
  the warehouse joins on the same values (`docs/snowflake-setup.md`).

```jsonc
// <booking detail>: the by id answer, and the confirm response's booking (#2643)
{
  // ...every <booking> field above, plus:
  "contact": { "name": "Dana Lee", "email": "dana@example.com", "phone": "+12155550100" },
  "calendarLinks": {
    "google":    "https://calendar.google.com/calendar/render?action=TEMPLATE&…",
    "outlook":   "https://outlook.live.com/calendar/0/action/compose?rru=addevent&…",
    "office365": "https://outlook.office.com/calendar/0/action/compose?rru=addevent&…",
    "ics":       "https://slate.trypennie.app/api/bookings/<manage token>/ics"
  }
}
```

- **`contact`** is the lead's name, email and phone as Slate stores them (phone in
  `+1…` form). It is returned only here, where the caller has already named the
  booking by a strong id, so it can never hand one person's phone to another
  (#1340). It is deliberately not on the list response.
- **`calendarLinks`** are the four add to calendar buttons. The first three open
  the provider's own new event form, prefilled. **`ics` is a plain link a browser
  can open with no API key**: it is served by the booking's manage token, it is
  built when it is clicked (so a call that moved since downloads at its new
  time), and a cancelled call's link redirects (`303`) to that booking's manage
  page, which shows it as cancelled (#2648). The entry is titled "Pennie
  call with {advisor}" and its description carries the manage link.
- **`calendarLinks` is `null` on a cancelled booking**: there is nothing to add.

This is what trypennie's booking confirmed page reads for a Slate booking: the
widget's `bookingSuccessful` event carries the booking id (for a fresh booking
and for a lead moving the call they already have, told apart by `data.outcome`,
`created` or `rescheduled`, #2644), the page redirects to
`/my-offers/result/booking-confirmed?bookingId=<id>&submissionId=<id>`, and that
page fetches this lookup server side with its own key.

**Look the booking up with the lead id from the EVENT, never with one your page
re-derives** (#2750). A moved call keeps the lead id it was first booked under. A
person who submits twice holds two lead records, and if they move the call they
already have from the second page, that page's lead id does not own the booking,
so a by id lookup sent with it is refused with `404` (above). The success events
therefore carry two different lead ids, and they are different on purpose:

| Where | Whose id |
|---|---|
| `bookingSuccessful` `data.booking.salesforceId` / `data.booking.externalId` | the BOOKING's, as stored |
| `bookingSuccessfulV2` / `rescheduleBookingSuccessfulV2` `data.salesforceId` / `data.externalId` | the BOOKING's, as stored |
| `bookingSuccessful` `data.salesforceId` (beside `booking`) | the PAGE's, as the page passed it |

Read `uid` (V2) or `booking.id` together with the booking's `salesforceId`, and
pass that as `externalId`. On a fresh booking the two lead ids agree; on a moved
call only the booking's finds it. Either id field may be `null` when the booking
holds none; it is never filled in from the page.

By-id not found / not owned / status mismatch → `404 { "code": "NOT_FOUND" }`.

---

## 4. List bookings — `GET /api/bookings` (no `externalId`)

When `externalId` is absent, the endpoint switches to **cross-person list mode**
(admin / ops / reporting use). All filters are optional.

```
GET /api/bookings?bucket=411&limit=20
GET /api/bookings?status=confirmed&afterStart=2026-07-01T00:00:00Z
GET /api/bookings?updatedSince=2026-07-01T00:00:00Z&cursor=<opaque>
GET /api/bookings?agentEmail=agent@trypennie.com&limit=50
```

### Filters

| Parameter | Type | Notes |
|---|---|---|
| `bucket` | string | Filter to a single XBC bucket code. |
| `agentEmail` | string | Filter to a single agent. |
| `status` | string | `confirmed` \| `rescheduled` \| `cancelled` \| `completed` |
| `afterStart` | ISO instant | Bookings whose `starts_at` is ≥ this value. |
| `beforeEnd` | ISO instant | Bookings whose `starts_at` is ≤ this value. |
| `updatedSince` | ISO instant | Bookings updated at or after this instant; switches ordering to `updated_at ASC` (see below). |
| `limit` | integer | Page size (default 50, max 200). |
| `cursor` | string | Opaque offset cursor from the previous page's `nextCursor`. |

### Ordering

- **Default** (`updatedSince` absent): ordered by `starts_at ASC`.
- **`updatedSince` present**: ordered by `updated_at ASC` — use this for
  incremental polling (you'll see every modified row since the last poll, in
  modification order).

### Pagination

```json
{
  "bookings": [ … ],
  "nextCursor": "<opaque>"
}
```

- `nextCursor` is absent (or `null`) when there are no further pages.
- Pass `cursor=<nextCursor>` to fetch the next page; keep all other filter
  parameters unchanged.
- Cursors are single-use; the offset cap is 10 000 rows (returns `VALIDATION`
  if exceeded — use a tighter date range instead).

### `bucketCode` field

Each item in the returned array includes a `bucketCode` field (the XBC bucket
the booking belongs to) in addition to the standard booking fields, including
`isTest` (#2660), read off the same joined bucket, and the partner join keys
`submissionId` and `regalProfileId` (#2659), off each booking's own `prefill`.

### 400 cases

| Condition | `code` | Notes |
|---|---|---|
| `externalId` is present but blank (`externalId=`) | `VALIDATION` | An empty string is not a valid id — omit the param entirely to use list mode. |
| `externalId` present **and** list-only filter present (`bucket`, `agentEmail`, `afterStart`, `beforeEnd`, `updatedSince`) | `VALIDATION` | These filter modes are mutually exclusive. |
| `cursor` is malformed / expired | `VALIDATION` | Re-query from page 1. |
| `bookingId` present **without** `externalId` | `VALIDATION` | A booking id selects one booking and is honoured only beside the lead id it was booked under (#2872). It used to be ignored, answering with the first page of every booking. |

---

## 5. Cancel a booking — `DELETE /api/bookings` (key-authed)

```
DELETE /api/bookings?externalId=<id>&bookingId=<uuid>
```

- Requires **`bookingId`** and a strong id (`externalId` **or** `salesforceId`).
  The booking must be owned by that person and currently active. Ownership is
  judged the way section 3 judges it (#2657): each id you supply matches a
  booking whose `external_id` OR `salesforce_id` equals it, so a booking you can
  read by `externalId` you can cancel by the same id.
- Optional `reason` (a `CANCEL_REASONS` code; `other` needs `reasonDetail`);
  defaults to `api_cancellation`. Recorded with initiator `customer`.

Success → `200 { "outcome": "cancelled", "booking": <booking> }`, the section 3
shape with the partner join keys included (#2659). Deletes the
Google event, frees the slot, and fires the `booking.cancelled` webhook.

Not found / not owned / not active → `404 { "code": "NOT_FOUND" }` (a repeat
cancel of an already-cancelled booking therefore returns `404`).

## 6. Reschedule or move a booking — re-submit `POST /api/bookings`

There is **no separate reschedule endpoint** and you never need the per-booking
manage token. To move a lead's appointment, re-submit the same booking with the
new details: `POST /api/bookings` with the **same `externalId`**, a new
`start`, the same required attendee fields, and optionally a different
`bucketCode`. The "one active appointment per person" engine recognises the
returning lead by strong id and **moves the existing appointment** instead of
creating a second one.

```jsonc
POST /api/bookings
Authorization: Bearer <key>
{
  "externalId": "lead-abc-123",   // same id as the original booking
  "bucketCode": "411",            // same bucket = time change; different = move teams
  "start": "2026-07-03T15:00:00Z",// the new time
  "timezone": "America/New_York",
  "attendee": { "name": "…", "email": "…", "phone": "…" }
}
```

| You send | `outcome` | What happens |
|---|---|---|
| Same `bucketCode`, new `start` | `rescheduled` | The appointment's **time is shifted in place** (same agent/bucket). |
| Different `bucketCode`, new `start` | `rescheduled` | The lead is **moved to the new team**: a fresh booking is created there and the old one cancelled (#364). |
| Same `externalId`, same slot, same bucket | `deduped` | No change: the existing booking is returned. |
| Different `bucketCode`, **same** `start` | `rescheduled` | The lead is **moved to the new team** at the slot they already hold (#1465), or `deduped` with `bucketChangeDeclined` when that team has nobody free. |

Because the bot always carries a strong id (`externalId`/`salesforceId`), a
reschedule is **deterministic** — it never returns `confirm_required` (that
outcome is only for weak email/phone-only matches). The move reuses the full
reschedule path: verify-on-book, a history row, and the `booking.rescheduled`
webhook (a cross-bucket move emits `booking.cancelled` + `booking.created`).
Errors are the same `code`s as a normal create (`SLOT_TAKEN`,
`VERIFY_UNAVAILABLE`, `UNKNOWN_BUCKET`, `NO_ELIGIBLE_AGENTS`, `VALIDATION`).

> **Leads still self-serve via their manage link.** End-users reschedule or
> cancel from the emailed `…/booking/manage/<token>` link without logging in —
> that token-based flow is for humans and is unaffected by (and unnecessary for)
> the key-authed bot, which acts by `externalId` instead.

---

## Ops: Clearing existing orphaned events (#401)

When a booking is cancelled Slate now enqueues the Google Calendar event for
deletion and retries on each sync tick. For bookings that were cancelled
**before** this queue existed, run the following SQL once in Supabase to seed
the retry queue from already-cancelled bookings. The next sync tick(s) will
delete the events idempotently — no local Google credentials required.

```sql
insert into pending_event_deletions (calendar_email, gcal_event_id, booking_id)
select agent_email, gcal_event_id, id
from bookings
where status = 'cancelled' and gcal_event_id is not null and agent_email is not null
  and starts_at > now() - interval '14 days'
on conflict (calendar_email, gcal_event_id) do nothing;
```

This is a queue-seed only (DB write, no Google calls). The deployed drain in the
sync cron handles the actual deletions.

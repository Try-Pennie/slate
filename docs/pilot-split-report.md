# Slate against cal.com across the pilot split (`pnpm report:pilot-split`)

Does Slate lift the booking rate over cal.com? (#2898)

The pilot used to be all or nothing (`SlatePilotActive__c`), so there was no
concurrent control and a before and after comparison could not separate a lift
from a change in lead mix or day of week. Halo-lab-Trypennie/trypennie#517 splits Low leads
(XBC starting with 1) on `/booking/[SO_ID]` and `/my-offers/result` per lead:
`slateBucket(submission id)`, FNV-1a over the first 15 characters of the id mod
100, against `SlatePilotPercent__c` (null means 100). This command reads both
halves over the same days, says whether their booking rates differ with a 95%
interval, and estimates how many days the split needs before a difference of a
given size is readable.

It writes nothing anywhere. It is a hand run command, deliberately not named
`test-*.ts`, because that glob is the offline unit suite.

## Why the input is a file

GA4 reaches the warehouse only as daily totals (`stg_google_analytics__events_report`:
report date and event name) with no event parameters, so the warehouse cannot
split by submission. Slate holds no GA4 API credentials. So the input is a GA4
Exploration export, downloaded by hand.

## Setting up the export, once

1. **GTM.** A GA4 Event tag named `booking_assignment`, fired on the custom event
   trigger `booking_assignment`, sending the dataLayer values `booking_provider`
   and `submission_id` as event parameters. trypennie pushes the event on every
   load of both pages (Halo-lab-Trypennie/trypennie#517), and GA4 never sees it without this tag: the command
   exits 6. The existing `cal_booking` tag must also send `booking_provider` and
   `submission_id` beside `ga4_event_name`.
2. **GA4 Admin, Custom definitions.** Register three EVENT scoped custom
   dimensions, display names exactly `submission_id`, `booking_provider` and
   `ga4_event_name`, each on the parameter of the same name. Registration is not
   retroactive: only events after it carry the dimension.
3. **Explore, Free form.** Rows: Date, submission_id, booking_provider, Event name,
   ga4_event_name. Values: Event count. Filter: Event name exactly matches
   `booking_assignment` or `cal_booking` (or, if the GTM tag names GA4 events after
   `ga4_event_name`, those names; the command reads `ga4_event_name` when it is set
   and the event name when it is `(not set)`). Date range: only days
   `SlatePilotPercent__c` held one value. Set Show rows to its largest and check
   the table's row count is under it, because a truncated export under-counts
   both halves without saying so.
4. **Share, Download file, CSV.** That file is `PILOT_SPLIT_CSV`.

## The population must be pilot leads only

`booking_assignment` fires for EVERY lead on those two pages, and a non Low lead
is labelled `cal.com`. An unfiltered export therefore puts High and Medium leads
into the control half, which is exactly the lead mix difference the split exists
to remove. There are two ways to exclude them, and the command refuses without
one:

- **An `xbc` column.** A fourth custom dimension, which needs trypennie to push
  `xbc` with `booking_assignment`. Leads whose XBC does not start with 1 are left
  out and counted.
- **`PILOT_SPLIT_PERCENT`.** A `cal.com` lead whose bucket is UNDER the percentage
  cannot be a pilot lead, so the hash finds those. It cannot find a non Low lead
  whose bucket is over the percentage, so when it finds any at all the command
  exits 8 with an estimate of how many more are hiding in the control half. The
  fix is on trypennie's side: push `xbc`, or push `booking_assignment` only for
  pilot leads, in which case the hash finds nobody outside and the run proceeds.

**As Halo-lab-Trypennie/trypennie#517 stands this command will exit 8 on real traffic**, because non Low leads
reach `/my-offers/result`. One of those two trypennie changes is needed first.

## What is counted

- **A lead is a submission, counted once**, keyed on the first 15 characters of
  its id (the key trypennie's hash reads, so both Salesforce id forms are one
  lead). A lead who comes back through the Automated Booking Link sends a second
  `booking_assignment` and is still one lead.
- **Only a lead with a `booking_assignment` event is in the comparison.** Booker
  events alone come from pages outside the split (`/offerportal`, `/portal`), and
  are counted and left out.
- **A lead seen under both providers** means the two pages disagreed about it. It
  is counted and left out of both halves.
- **Opened the booker**: `view_booker`, `navigate_to_booker`, or a booking.
  **Booked**: `complete_booking`, even when a `cancel_booking` follows: the rate
  is whether the booker converted the lead, and the Slate cross check reads Slate's
  bookings in every status so both sides count the same leads.
- **Bounce is "left without opening the booker"**, the booker level bounce, which
  reads the same way for both providers. GA4's own session bounce cannot be split
  by an event scoped parameter such as `booking_provider`.
- **The difference** is Slate minus cal.com, with a 95% interval (two proportion,
  unpooled standard error) and a two sided p value.
- **Not yet readable**: each half needs at least 100 leads, 10 bookings and 10
  leads who did not book (`MIN_LEADS_PER_HALF`, `MIN_OUTCOMES_PER_HALF`), or no
  finding is reported (L716).
- **Hash check**: with a percentage, the report counts Slate leads whose bucket
  says they should have had cal.com. Nonzero means the percentage moved, or the
  pilot was off, on some day in the range.

## Running it

```
PILOT_SPLIT_CSV=~/Downloads/pilot-split.csv PILOT_SPLIT_PERCENT=50 pnpm report:pilot-split
```

`PILOT_SPLIT_LIFT=0.02` also prints a days estimate at the volume and cal.com rate
the export measured. Before any data exists, planning mode estimates from given
numbers (rates as fractions, 0.12 for 12%):

```
PILOT_SPLIT_PLAN=1 PILOT_SPLIT_LEADS_PER_DAY=180 PILOT_SPLIT_PERCENT=50 PILOT_SPLIT_BASE_RATE=0.12 PILOT_SPLIT_LIFT=0.02 pnpm report:pilot-split
```

The estimate is the standard two proportion sample size (Fleiss, no continuity
correction) at alpha 0.05 two sided and power 0.8, with the halves allocated by
the percentage, and returns the days the smaller half needs to reach its number.
10% against 12% at an even split needs 3,841 leads a half.

**The Slate cross check.** With `SUPABASE_SECRET_KEY` and
`NEXT_PUBLIC_SUPABASE_URL` in `.env.local`, the command reads Slate's own routed,
real bookings over the export's dates (a day either side, since GA4 dates are in
the property's zone) and compares their `prefill` submission ids with the Slate
half's GA4 bookings: GA4 bookings with no Slate row (a tagging fault), Slate
bookings GA4 never saw (GA4 losses, which undercount the Slate half), and Slate
bookings outside the export. Without the key it says it was skipped.

## Exit codes

Only a comparison made exits 0. Every way of learning nothing exits on its own
code (L98, L11).

| exit | what it met |
|---|---|
| 0 | a comparison was made (planning mode: an estimate) |
| 1 | no `PILOT_SPLIT_CSV` here; nothing was read |
| 2 | the file is missing, empty, or has no header row |
| 3 | a required column is missing, named |
| 4 | a date or event count cannot be read, line named |
| 5 | `PILOT_SPLIT_PERCENT` is not a number from 0 to 100 |
| 6 | no `booking_assignment` event at all: the GTM tag is not sending it |
| 7 | no `xbc` column and no `PILOT_SPLIT_PERCENT`: the population cannot be checked |
| 8 | the export holds leads outside the pilot and nothing can remove them |
| 9 | one half has no leads |
| 10 | plenty of leads and not one booker event in the export |
| 11 | a half is under the minimum sample: not yet readable |
| 12 | planning mode is missing an input or was given one it cannot use |
| 13 | the comparison was made and the Slate cross check could not read Slate |

## Where the code lives

The judgement is `scripts/lib/pilot-split.ts` (pure), pinned offline by
`scripts/test-pilot-split.ts`, which produces every exit code above from a hand
written export. `slateBucket` is a copy of trypennie's, held to
`scripts/fixtures/pilot-split-buckets.json`, whose buckets were computed by
running trypennie's own function at the sha the file records (L26). **If
trypennie changes the hash, regenerate that fixture from their code**, never from
Slate's copy.

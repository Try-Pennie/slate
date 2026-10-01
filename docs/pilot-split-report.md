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

1. **GTM** (container `GTM-5WK9CS54`). A Data Layer Variable `DLV - xbc` on `xbc`,
   a Custom Event trigger `booking_assignment`, and a GA4 Event tag on it (Measurement
   ID `G-6LJE6E4XS8`, event name `booking_assignment`) sending `booking_provider`,
   `submission_id` and `xbc` from `DLV - booking_provider`, `DLV - submission_id`
   and `DLV - xbc`. The first two variables already exist. trypennie pushes the event
   on every load of both pages (Halo-lab-Trypennie/trypennie#517), and GA4 never sees
   it without this tag: the command exits 6. The booker events need nothing: the
   existing `GA4 Event - Cal Booking Funnel` tag already sends `booking_provider`
   and `submission_id`, and names each GA4 event after its step (`view_booker`,
   `complete_booking`), read off the container on 2026-09-30.
2. **GA4 Admin, Custom definitions.** Register three EVENT scoped custom
   dimensions, display names exactly `submission_id`, `booking_provider` and `xbc`,
   each on the parameter of the same name. Registration is not retroactive: only
   events after it carry the dimension.
3. **Explore, Free form.** Rows: Date, submission_id, booking_provider, xbc, Event
   name. Values: Event count. Filter: Event name matches regex
   `booking_assignment|navigate_to_booker|view_booker|reopen_booker|reload_booker|load_slots|complete_booking|cancel_booking|reschedule_booking|fail_booker_load`. Date range: only days `SlatePilotPercent__c` held one value. Set Show
   rows to its largest. (An export that also carries a `ga4_event_name` column
   still reads; the step is taken from it when it is set.)
4. **Share, Download file, CSV.** That file is `PILOT_SPLIT_CSV`. When a range is
   too long for one download, export a week at a time and pass every file: the
   command reads them together, joins a lead who appears in more than one, and
   refuses two files covering the same day (exit 15). A file whose rows land
   exactly on a GA4 row limit (100, 250, 500, 1,000, 2,500, 5,000, 10,000 or
   100,000) was probably cut off there and is refused (exit 14), because a cut off
   export under counts both halves without saying so (#2908).

## The population must be pilot leads only

`booking_assignment` fires for EVERY lead on those two pages, and a non Low lead
is labelled `cal.com`. An unfiltered export therefore puts High and Medium leads
into the control half, which is exactly the lead mix difference the split exists
to remove. There are two ways to exclude them, and the command refuses without
one:

- **An `xbc` column**, the way the setup above builds the export. trypennie sends
  `xbc` with `booking_assignment` (added to Halo-lab-Trypennie/trypennie#517 on
  2026-09-29). Leads whose XBC tier (its first digit) is not one of the pilot
  tiers are left out and counted. The tiers come from `PILOT_SPLIT_TIERS`
  (`SlatePilotTiers__c`'s format, `1;2;3;4;5`), or, when that is unset and
  Salesforce credentials are here, from `SlatePilotTiers__c` as it is NOW (#2946).
  Salesforce keeps no history of that field, so set `PILOT_SPLIT_TIERS` for an
  export from before a change. With neither, an export with an `xbc` column exits
  16 rather than guess Low.
- **`PILOT_SPLIT_PERCENT`.** A `cal.com` lead whose bucket is UNDER the percentage
  cannot be a pilot lead, so the hash finds those. It cannot find a non Low lead
  whose bucket is over the percentage, so when it finds any at all the command
  exits 8 with an estimate of how many more are hiding in the control half. This
  is the fallback for an export built without the `xbc` dimension, and on real
  traffic it will exit 8, because non Low leads reach `/my-offers/result`.

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

Several exports are separated by commas (`~/Downloads/week1.csv,~/Downloads/week2.csv`),
or name a folder and every `.csv` in it is read.

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

## What each booker offered (#2927)

A booking rate gap between the halves can come from what each system OFFERED rather
than from the booker: on 2026-09-30 cal.com's first time for a Low lead was the next
morning with 32 in the next day, while Slate's was that evening with 249. So the
report ends with a section saying, over the export's days, how many times each
system typically offered a Low lead in the next 24 hours, how long until its first
time, and in how many quarter hours Slate's first time came earlier.

The numbers come from the monitor lane, which every 15 minutes asks both systems,
read only, what a Low lead (bucket 112) would be offered and stores one row each in
`pilot_offer_samples` (`src/lib/monitor/pilot-offers.ts`). cal.com is asked through
its routing form's `calculate-slots` call, so it answers for the pool a Low lead on
the split pages is routed to, not the whole event; the call stores no response.
Slate is asked through its booker's own read of the bucket. A failed read is stored
as a failure with its reason and counted out loud in the report, never as zero
times. With no samples for the export's days the section says so rather than
reading as equal availability. It needs the Supabase key, like the cross check, and
never changes the exit code.

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
| 14 | an export ends exactly on a GA4 row limit, so it was probably cut off; export fewer days per file |
| 15 | two exports cover the same day, so its leads would be read twice |
| 16 | the export has an `xbc` column and no pilot tiers are known |

## Where the code lives

The judgement is `scripts/lib/pilot-split.ts` (pure), pinned offline by
`scripts/test-pilot-split.ts`, which produces every exit code above from a hand
written export. `slateBucket` is a copy of trypennie's, held to
`scripts/fixtures/pilot-split-buckets.json`, whose buckets were computed by
running trypennie's own function at the sha the file records (L26). **If
trypennie changes the hash, regenerate that fixture from their code**, never from
Slate's copy.

# Slate against cal.com on every tier (`pnpm report:pilot-compare`, #2946)

Does Slate book more applications than cal.com, and do more of the booked calls
actually happen? trypennie (#519, deployed 2026-10-01 15:46 UTC) sends each
application to Slate or cal.com by `slateBucket(submission id)` against
`SlatePilotPercent__c` (50) on the tiers in `SlatePilotTiers__c` (`1;2;3;4;5`).
This reads both halves from each system's own records, so it does not depend on
GA4, which saw well under half of what happened (#2941). `report:pilot-split`
(the GA4 per visitor read, `docs/pilot-split-report.md`) is a different
population and stays for the booker level bounce.

```
pnpm report:pilot-compare
PILOT_COMPARE_LIFT=0.03 pnpm report:pilot-compare      # size the days estimate for 3 points (default 0.02)
PILOT_COMPARE_REHEARSAL_START=2026-09-30 PILOT_COMPARE_REHEARSAL_SPAN_HOURS=6 pnpm report:pilot-compare
```

Needs `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_INSTANCE_URL`, `CALCOM_API_KEY`,
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env.local`. It writes
nothing anywhere. Email addresses and phones are read to match bookings, held in
memory, and never printed.

## The design (Dan, 2026-10-01, on #2946 and #2945)

- **The unit is an application**, a Salesforce `Submission__c`, keyed on the first
  15 characters of its id, which is exactly what trypennie hashes.
- **Intention to treat.** Every application is judged on the side its hash gave
  it, whatever system it booked on. A second, labelled row reads by the system that
  took the booking (not randomised), and leakage is counted by cause: the id the
  other system's booking carried, a contact match, or the Slate page (`source`).
- **A fixed span.** Applications made from 2026-10-02 00:00 ET are judged on what
  happened within 7 days of being made: a booking made in the span, a call held at
  a final start in the span. An application joins the cohort once its span plus 3
  hours has passed, on whole Eastern days, so numerator and denominator always
  cover the same days (L711). A booking whose final start falls after the span is
  booked, and its show is counted as not judged rather than as missed.
- **Matching.** Slate bookings carry the application id. A cal.com booking is
  matched by the `sfdc_submission_id` it carries, else by email AND phone (last ten
  digits) to the latest application made before it. Prior applications on more
  than one Lead are ambiguous, never a pick. Over 10% unmatched plus ambiguous
  refuses the run (#2945 measured 5.8%).
- **cal.com event types** counted as a lead booking: review, connect, call, terms,
  income, apply and meet. The others (the second call type, Client Sync, tests and
  demos) are counted by id and left out.
- **Reschedules collapse** on both systems. cal.com marks the old half `cancelled`
  with `rescheduledToUid` set, so that is a reschedule; a chain is made when its
  first link was made and judged at its last link's start. Slate reschedules in
  place.
- **A show** is ONE human Regal call (not the AI agent) of at least 300 s starting
  from 15 minutes before to 60 minutes after the final start, from
  `regal_call_outcomes` (#2944). Talk time is not summed across calls. A cancelled
  booking is not held.
- **Rates:** booked (per application), held calls per application, and held over
  booked. Booking and held per application use the two proportion interval in
  `scripts/lib/pilot-split.ts`; the show rate interval is cluster robust by advisor,
  with an advisor serving both systems as one cluster. Overall and per tier, each
  with a days needed estimate (the show rate one is a lower bound, since it ignores
  the clustering).
- **The split is ASSUMED, NOT CHECKED.** Salesforce keeps no history of
  `SlatePilotActive__c`, `SlatePilotPercent__c` or `SlatePilotTiers__c` and none will
  be turned on, so the report trusts that the split held at 50 on tiers 1 to 5 and
  says so on every run. What Salesforce holds NOW is printed, and a current value
  that contradicts the assumption exits 14 with the comparison still printed.
- **A readout date fixed once.** The first run proposes one (the window start plus
  the longer days estimate). Record it as `READOUT_DATE` in
  `scripts/lib/pilot-compare.ts`, in a commit, so nobody can move it by setting a
  variable. Before the first span closes a run is a PARTIAL look (exit 16); after
  that and before the readout date it is PROVISIONAL (exit 12), and from the
  readout date on the cohort stops growing.

## What it cannot see

- A change to the split inside the window (no history, above).
- A gap in the Regal call store in the MIDDLE of the window. The run refuses when
  shows were due before the store's first call, and when the store holds nothing
  over the span; a partial gap is the #2944 monitor's job, which pages under 80%
  written, and it reads as missed shows on both sides equally.
- Bookings Slate made through the API with no application id (counted, not
  matched).

## Partial look before the first full window (#2976)

Before any application's span has closed (the first whole day is judgeable from
2026-10-10 03:00 ET), a plain `pnpm report:pilot-compare` does not refuse: it
reports the booking and show rates over every application made since the window
opened, so the trend can be watched. It is not a readout and cannot be mistaken
for one:

- every line starts `[PARTIAL]`, and the run exits **16**, never 0, 11 or 12;
- it says how much of the way to the first full window it is, and how long the
  oldest and newest applications in it have had;
- it prints the rates so far, each with an EARLY 95% interval (#3073, Dan
  2026-10-03): "biased low, not a result" on the booking rate and held per
  application, which can still grow for applications already counted, and "early,
  not a result" on a show rate, which leaves calls still ahead out of both sides.
  A side under the readable minimum says "too few to estimate an early interval";
- it prints no verdict (never "Slate higher", "Slate lower" or "cannot be told
  apart"), no days estimate and no proposed readout date;
- the booking rate is biased low on both sides, since every application has had
  less than its 7 days, and the report says so beside the numbers;
- a show counts only once its call is due (the final start plus 60 minutes, plus
  the 3 hour grace for the call to reach the store); a booking whose call is still
  ahead is left out rather than read as a no show, which favours bookings made for
  soon after applying.

The refusals (no applications, one side empty, too many unmatched, the call store)
still refuse on their own codes, with every line labelled partial.

## Rehearsal

`PILOT_COMPARE_REHEARSAL_START` (an Eastern date) runs the same reads over earlier
days, with `PILOT_COMPARE_REHEARSAL_SPAN_HOURS` as the span. It proves the reads end
to end before the window has a closed span, is labelled REHEARSAL, and exits 13: its
days were not a 50/50 split on every tier. Run on 2026-10-01 over 2026-09-30 with a 6
hour span, every read completed (3,734 pilot tier applications, 718 cal.com bookings
matched by email and phone with 40 of 758 not tied, 5.3%), and the judgement ran to
the end. Its shows all read zero because the call store began on 2026-10-01, which
is why the store start check exists.

## Exit codes

Exits 1 to 10 and 15 refuse before any result, and 16 is a partial look (above), never a result. Once a comparison is printed, more
than one condition can hold, and the run exits on the first of these: **13**
(rehearsal, never a result), then **14** (settings now differ), then **11** (too few
on either headline rate), then **12** (provisional), then **0** (the readout). Every
condition that holds is still printed, whichever one names the run.

| exit | what it met |
|---|---|
| 0 | the readout: the fixed date is reached and the headline is readable |
| 1 | Salesforce, Supabase or cal.com credentials are missing here; nothing was read |
| 2 | nothing to judge yet: the window has not opened, or a rehearsal's span has not closed |
| 3 | Salesforce could not be read, including a short read |
| 4 | cal.com could not be read |
| 5 | Slate could not be read |
| 6 | the Regal call store could not be read |
| 7 | no application in a pilot tier was made in the cohort |
| 8 | one side holds no applications |
| 9 | too many cal.com bookings tied to no application |
| 10 | the Regal call store holds no call over the span, or began after shows were due |
| 11 | a side is under the minimum sample on the booking rate OR the show rate (100 units, 10 with and 10 without the outcome) |
| 12 | provisional: before the fixed readout date, or none is fixed yet |
| 13 | a rehearsal over days outside the window |
| 14 | what Salesforce holds now contradicts the assumed split |
| 15 | an input could not be read (`PILOT_COMPARE_LIFT`, the rehearsal values, `READOUT_DATE`), or a row carried a time that does not parse |
| 16 | partial: the window is open and no span has closed yet, so these are rates so far (until 2026-10-10 03:00 ET) |

## Where the code lives

The judgement is `scripts/lib/pilot-compare.ts` (pure), pinned offline by
`scripts/test-pilot-compare.ts` with hand written rows and no clock. The cal.com
read is the shared reader in `src/lib/calcom/upcoming-bookings.ts`
(`readCalcomBookingsCreated`), read a day and a status at a time with a 120 s page
and one retry, because a `past` listing's first page was measured at up to 117 s
over a week. Salesforce lists go through `querySoqlComplete`
(`src/lib/salesforce/rest.ts`), which refuses a read that ends short of the
`totalSize` it promised. The settings read is `src/lib/salesforce/pilot-settings.ts`,
shared with `report:pilot-split`, which now takes its tiers from it rather than a
hard coded Low.

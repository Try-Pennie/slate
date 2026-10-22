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
PILOT_COMPARE_BOOKING_UPDATE=1 pnpm report:pilot-compare   # bookings within 24 hours through yesterday (#3698)
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
- **The inline card is outside the split** (#3718). A landing page with the inline
  card always offers Slate, so an application with a Slate booking made through it
  (its stored link carried `layout=inline`) leaves the cohort on BOTH hash sides,
  with every booking it made, cal.com ones included. Dropping only the booking would
  leave a cal.com side application reading as one that never booked. The readout
  says how many applications it left out this way.
- **Development host bookings are test traffic** (#2974). A Slate booking on a real
  bucket whose recorded host page is not the production site (a localhost page,
  dev.trypennie.com), judged by `isTestSourceBooking` (`src/lib/monitor/offsite-origin.ts`),
  is left out as a booking, never as its application, and the readout counts them.
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
- **The split is CHECKED from stored readings, and assumed only where none can
  vouch for it** (#3641). Salesforce keeps no history of `SlatePilotActive__c`,
  `SlatePilotPercent__c` or `SlatePilotTiers__c` and none will be turned on (Dan,
  2026-10-01), so before #3641 the report could only trust that the split held
  at 50 on tiers 1 to 5. Now the monitor lane stores, every quarter hour, what
  Salesforce held, when it was read, and when the record holding it was last edited
  (`pilot_settings_samples`, `src/lib/monitor/pilot-settings-samples.ts`). The edit
  time is what does the work: a record not edited since the previous reading cannot
  have changed in between, however long the gap, and a first reading whose record
  was last edited before the window opened vouches for the days before readings
  began. So every run says one of:
  - `CHECKED`: every reading saw the assumed split and the record was not edited
    inside the window, up to the last reading;
  - `CHECKED IN PART`: every reading saw it, but the record was edited inside the
    window. Only the last edit is visible, so a change undone before it cannot be
    ruled out, and each edit is listed with the span it leaves unverified (from the
    reading before it, or the window's opening, to the edit). The 2026-10-12 edit at
    11:00 ET reads this way, leaving 2026-10-02 to that edit unverified;
  - `THE SPLIT CHANGED`: a reading saw something else, named with the readings that
    saw it, which exits **17** with the comparison still printed;
  - the old `ASSUMED, NOT CHECKED` line, when no reading succeeded over the window.

  After the last reading the split is assumed, and the run says so. Two samples
  served from one cached Salesforce read count as one reading, and a failed reading
  is counted and never read as a split. What Salesforce holds NOW is still printed,
  and a current value that contradicts the assumption exits 14.
- **A readout date fixed once.** The first run proposes one (the window start plus
  the longer days estimate). Record it as `READOUT_DATE` in
  `scripts/lib/pilot-compare.ts`, in a commit, so nobody can move it by setting a
  variable. Before the first span closes a run is a PARTIAL look (exit 16); after
  that and before the readout date it is PROVISIONAL (exit 12), and from the
  readout date on the cohort stops growing. **Fixed at 2026-10-24** (Dan,
  2026-10-12): the cohort is applications made from 2026-10-02 through 2026-10-23
  Eastern, and the first run that can be the readout is from 2026-10-31 03:00 ET,
  once the last of them has had its 7 days plus the 3 hour grace.

## By where the application came from (#3701)

About half the pilot tier applications are made on trypennie.com's own form
(`Submission__c.Source__c = 'trypennie.com'`) and about half are sent in by partners
(Engine, Borrow Better, Lead Economy, AmOne, TLG) whose leads apply and book on
trypennie.com/offerportal. Measured 2026-10-13 they move in opposite directions:
with a 24 hour booking window over Oct 5 to 12, form applications booked +3.2 points
on Slate's side and partner ones -1.5 points, which together read as no difference.
So every run also prints the same rate blocks per source, judged by the same rules,
after the tiers. They never change the exit: the headline stays the readout.

Partner applications are printed twice when the window opens before
`PORTAL_FIX_MS` (2026-10-04 16:03 ET), from the window start and from that instant
(Dan, 2026-10-13). Until then the offer portal chose its booker before the
Submission existed and so showed cal.com to partner leads on Slate's side; trypennie
#522 made it choose again once the form had created the Submission. A missing source
counts with partners and other sources (`sourceGroup`), so nothing drops out.

## What it cannot see

- A change to the split undone before a later edit of the record (only the last edit
  is visible, above), and anything after the last stored reading.
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

## Booking update (#3698)

`PILOT_COMPARE_BOOKING_UPDATE=1` answers "how are bookings going through yesterday"
without waiting for 7 day spans to close. Every application made since the window
opened whose 24 hours (plus the 3 hour grace) have passed is counted as booked when it
booked within those 24 hours. It prints:

- the booking rates, overall, per tier and per source, with intervals and a days
  estimate for the booking rate;
- how much a 24 hour window misses, measured on the newest cohort whose full 7 days
  have closed, per side (on 2026-10-13 it caught 97% of bookings on both sides), or
  "not measured yet" before one has, never a zero;
- the stored split check over the same window, exactly as the full report runs it.

It reads no calls and prints no held per application, show rate or readout date. Every
line starts `[UPDATE]` and it exits **18**, never 0, 12 or 16; a split change still
exits 17 and settings that differ now 14. It refuses before any application's 24 hours
have passed (exit 2) rather than showing rates so far, and refuses when combined with
`PILOT_COMPARE_REHEARSAL_START` or set to anything but `1` (exit 15).

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

Exits 1 to 10 and 15 refuse before any result (5 also when the stored readings of the split cannot be read), and 16 is a partial look (above), never a result. Once a comparison is printed, more
than one condition can hold, and the run exits on the first of these: **13**
(rehearsal, never a result), then **17** (a reading saw the split change), then
**14** (settings now differ), then **11** (too few
on either headline rate), then **12** (provisional), then **0** (the readout). Every
condition that holds is still printed, whichever one names the run.

| exit | what it met |
|---|---|
| 0 | the readout: the fixed date is reached and the headline is readable |
| 1 | Salesforce, Supabase or cal.com credentials are missing here; nothing was read |
| 2 | nothing to judge yet: the window has not opened, or a rehearsal's span has not closed |
| 3 | Salesforce could not be read, including a short read |
| 4 | cal.com could not be read |
| 5 | Slate could not be read: its bookings, or its stored readings of the split |
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
| 17 | a stored reading saw a split other than 50% on tiers 1 to 5 inside the window, so the comparison mixes leads split two ways |
| 18 | a booking update (`PILOT_COMPARE_BOOKING_UPDATE=1`): bookings within 24 hours through yesterday, never a readout |

## Where the code lives

The judgement is `scripts/lib/pilot-compare.ts` (pure), pinned offline by
`scripts/test-pilot-compare.ts` with hand written rows and no clock. The cal.com
read is the shared reader in `src/lib/calcom/upcoming-bookings.ts`
(`readCalcomBookingsCreated`), read a day and a status at a time with a 120 s page
and one retry, because a `past` listing's first page was measured at up to 117 s
over a week. Salesforce lists go through `querySoqlComplete`
(`src/lib/salesforce/rest.ts`), which refuses a read that ends short of the
`totalSize` it promised. The contact read (applications behind cal.com bookings that carry no id)
filters on `Email_SO__c`, which is not selective, so each 50 address batch is given
`CONTACT_READ_TIMEOUT_MS` (a minute) per attempt rather than the ordinary 10 s, and a
batch that still fails refuses the run naming which batch failed and how many were
read first (#3695). The settings read is `src/lib/salesforce/pilot-settings.ts`,
shared with `report:pilot-split`, which now takes its tiers from it rather than a
hard coded Low.

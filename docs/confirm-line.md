# The confirm line, shared across isolates (#3325)

## What it is for

Confirms for one time slot take turns (#3221, #3257, #3274): the first leads and
runs the whole confirm, the rest wait, and when the leader's verdict shows the slot
is full everybody waiting is answered "taken" without doing any work. Until #3325
that line lived in each isolate's memory, so it only coordinated confirms that
landed on the same isolate. In load run 37333201026 (2026-10-05) a hundred confirms
for one slot spread across many isolates, each formed its own line, about 52 leaders
ran the full path together, the database saturated, and nobody was booked.

The shared line is the same rules, hosted in ONE Durable Object that every isolate
reaches as the same instance. Correctness never rests on it: the bookings indexes
and verify on book still decide who gets a slot. The line is capacity and fairness,
so a crowd gets one booking per free advisor and fast "taken" answers.

## When a verdict is "full" (#3338)

A leader's verdict settles the confirms waiting behind it only when its whole tier
LADDER is spent: it booked the last advisor the ladder's LAST rung had free, or it
was refused after every rung (a lost insert race included, once nobody below the
rung it was lost on was free either). Sales ops decided on 2026-10-02 that a lead
whose tier has nobody free at confirm keeps their time with the next tier down, and
Dan settled on 2026-10-06 that a confirm in a crowd walks the ladder "Same as a
normal confirm". Before this a leader that booked the last advisor of ANY rung
told everybody waiting "taken" while the tier below had people free.

A refusal settles the line only where it is MARKED as proving the ladder spent
(`markLadderSpent` / `provesLadderSpent` in `orchestration.ts`, read by
`verdictForRefusal` and nowhere else), never because it is a `SlotUnavailableError`
(#3440, #3441). Two places mark one:

- **The end of an ordinary ladder walk**, when some rung it read had people on it
  and refused the time as taken (or was passed only for claims). Whichever rung came
  last names the error, so a ladder whose LAST rung is an empty bucket ends in
  `NoEligibleAgentsError`: it is marked all the same, so the crowd behind is told
  "taken" from one walk rather than each walking the whole ladder in turn, and the
  walker itself keeps the empty bucket answer, its routing record and its page
  (#3441). A ladder with nobody on ANY rung is not marked: no rung refused the time
  as taken, so "taken" would be a claim nothing measured (L11), and each confirm walks
  its empty rungs, which asks nobody at Google, to its own empty bucket answer.
- **A named link**, whose one advisor is its whole ladder.

Everything else that refuses a time never walked the ladder, so it settles nobody and
the next confirm walks: a booking API reschedule, which asks only the lead's own
bucket. The scenarios are the `#3440`, `#3441` and `#3837` cases in
`scripts/test-confirm-contention.ts`.

**A resumed reservation walks the ladder too** (#3837, Dan 2026-10-16). A lead's
retry after a cut off confirm resumes the reservation that confirm left
(`resumeReservation`), pinned to one advisor. When that advisor has been taken
since, the stale reservation and its calendar event are rolled back first, and the
lead then walks the ladder from the top for the same time exactly as a fresh
confirm does, with the same verdicts: booked below like anybody else, or, when the
whole ladder is spent, told the time is taken with a verdict that answers the crowd
behind it. Until #3837 the resumed lead was told "taken" outright (#3440 kept that
refusal from settling anybody else). The walk reserves under the same idempotency
key, so a third retry finds its booking or resumes its reservation.

The resume holds the reservation's **lease**, the one the reservation drain takes
(`processBookingReservations`), for its whole attempt, so the drain and a lead's
retry never both work one reservation. A retry that finds the lease held answers the
holder's booking if it has just finished, and otherwise refuses retryably
(`ReservationHeldError`, a 503 that pages nobody) without touching the reservation or
walking, since a walk would reserve under the same key and adopt the reservation
still standing. A claim that fails is the retryable outage, and a rollback that fails
throws its own error without walking, for the same reason; the lease is given back,
so the drain retries the row. Those cases are driven in
`scripts/test-booking-reservations.ts`.

So a leader that books the last advisor of a rung above the last reports "not
full", and the line's existing hand on makes the next confirm the leader. It walks
from the top like any confirm: the advisor just booked reads as busy in the write
through cache, so it drops that rung for one candidate read, and on a rung with
unclaimed advisors the #3257 hand on lets the confirms behind it lead at once, one
per unclaimed advisor. As #3338 shipped it, nothing about the line itself changed:
no new verdict field, no start rung, no protocol change, no release of the whole crowd
at once. #3489 since added a bounded release, a walk past claimed rungs and parking,
each in the section below, because the line served a walking crowd only one confirm
every two to three seconds. It is the same on the per isolate line and on the shared
line.

A confirm whose insert loses the race walks on down the same way, from the rung it
lost on, but only when what its budget has left covers what the attempt that lost
cost it. With less left it is told to retry (the dependency timeout, 503), and the
race tally counts it on its own row, `race_retry_budget` (#3442), so the daily race
whisper does not undercount losers on exactly the days budgets run tight.

Each lost race's rollback (its calendar event and its reservation) runs under a
cleanup allowance of its own while the confirm budget can still hold one (#3439).
The request's one shared allowance is sized for the end of a request, so a rollback
that opened it left a second race a few seconds later with nothing, and the lead was
told to retry while the next advisor was free. Nearer the end of the budget the
rollback shares that allowance as before, so the worst case stays 12 plus 2 seconds.

The next attempt reserves under the same idempotency key, and the reservation's
insert adopts any row already holding that key, so the rollback's delete is what
keeps it off the lost reservation, still pinned to the advisor who was just taken.
Since #3859 the delete checks its own answer (`dropLostReservation`). A refused delete
stops the confirm with the retryable outage (`ReservationRollbackError`, a 503 that
pages under `verify_on_book_outage`) and leaves the row pending for the reservation
drain; it used to be discarded, so the next attempt could adopt the stale row. A
delete that finds no row is not a failure: a concurrent confirm of the same lead, or
the drain after a lapsed lease, removed it first, which is the state the next attempt
needs, so the confirm goes on and the overlap is logged. The same holds for a resumed
reservation's walk (#3837) and the drain's own rollback, which retries on a later tick.

The honest limit, as #3338 left it: each step down cost the next confirm its reads
before the line, and the confirm booking a rung's last advisor held the line for its
whole confirm (it may yet fail and free that advisor, #3257). Since #3489 a confirm
that can walk hands the line on at once when it claims a rung's last advisor and a
rung is below (the section below). At a slow confirm's speed (about eight seconds,
most of it Google, as production ran on 2026-10-04; about 1.6s at the median since,
#3490) a crowd arriving together behind the top rung's last
advisor still cannot all book inside its 12 second budget, so the rest are told to
retry rather than "taken"; a lead arriving a few seconds behind the first books below.
Counted on /admin/routing beside the tier drops (`routing_trace.dropped_behind`).

Told to retry means nothing was started. Any confirm, a follower promoted late
above all, first asks whether its budget covers what its commit chain (the
reservation, the calendar event, the insert) costs, and starts none of it
otherwise (`src/lib/booking/commit-cost.ts`). A chain cut off part way would leave a
reservation the drain later finishes into a booking for a lead told it failed
(L12). The cost is measured, never typed: the slowest of this isolate's last 8
chains that committed inside their budget (reservation write to the insert's
answer) and are under 14 seconds old, and never less than the confirm's own slowest
Google call. The age bound is what stops one slow chain holding an isolate's later
confirms out for good, since a refused confirm records nothing (L465). In the simulation, a crowd of 100 at a slow
confirm's speed (8s): 1 booked, 99 told to retry, 0 told taken, 0 reservations or events left.

## Releasing the crowd, walking past claims, and parking (#3489)

Load run 37640583621 showed #3338's walk working and the line serving it one confirm
every two to three seconds, so a crowd's tier drop booked four of twelve. Three rules
were added, all in `makeConfirmQueue`, all optional on protocol 1 (an older client
leaves each field out, and the line keeps its rules from before). #3529's ladder release
was NOT safe the other way round, an older object beside a newer client, and is why the
client speaks protocol 2 (see "Versions" below):

- **The frontier and the release.** A confirm reading a rung names it on `claimFirst`
  (`ClaimPlace`), so its read becomes the line's frontier. Handing the line on releases
  one waiting confirm per advisor on the frontier nobody has claimed, each handed its
  advisor (`StartFrom`) and claimed for it, so two are never handed one. A released
  confirm reads that advisor alone through the pool's own resolver (`narrowTo`) and,
  when they cannot take the time, reads the rung in full. How an advisor's claim ended
  (`ClaimOutcome`) decides whether they go back on the frontier.
- **Walking past claims (`canWalk`).** To a confirm that can walk (a new booking's walk
  or a lost race's, never a reschedule, a move or a named link), a rung every candidate
  of which another confirm in flight has claimed is SPENT, and it walks on. Claiming a
  rung's last advisor hands the line on when a rung is below (`below`), so the confirms
  behind walk down at once rather than wait out the whole confirm.
- **Parking and the held verdict.** A walk that reached the bottom having skipped a rung
  only for claims PARKS (`park`): it ends its turn without a verdict and waits like a
  follower. A full verdict reported while claims are in flight is HELD (`pending`), and
  applied to everybody waiting when the last of them ends booked, answered with the
  settlement that booking read as it ended (who sits at the instant). Any claim ending
  in a way that may have left its advisor free (untried, unknown, lapsed) bumps the
  line's `epoch`, which discards the held verdict and lets one confirm read again. A claim
  ending booked, found busy by Google or lost to a booking already there frees nobody and
  moves nothing (#3529: load run 37822382352's burst 1 timed out a crowd because a walker's
  own lost races voided its walk). A confirm the line hands a lower rung inherits the epoch
  at which the confirm whose read it was handed first read, since that walk is what stands
  for the rungs above it. A walker that parks once every
  claim it skipped has already BOOKED (no claim in flight, the epoch unmoved since it
  met the first spent rung) leads again at once marked `spent`: its own walk proves the
  ladder spent, so it refuses with what it found rather than the next confirm walking
  the whole ladder again. A booking reads who is seated only when it saw a crowd.
- **The whole ladder handed out at once (#3529).** A walker's claim carries the reads of
  every rung below it from the same ladder read (`ClaimPlace.lower`, judged in memory, no
  request), and the line releases them in the same pass as its own rung, top rung first,
  each advisor once at the highest rung it is on. Load runs 37857243671 and 37863081340
  booked a crowd with 13 or 14 free across three rungs in waves, a rung at a time, each
  wave waiting about two seconds for a walker to claim the rung below; the last booking
  landed near ten seconds and the rest timed out. When the read covered every rung below
  (`lowerComplete`), the advisors on the deepest rung that brings somebody new are handed
  out marked `deepest`, and that rung then stands for the ladder's last in their full
  verdict, so the crowd is answered without a walk of the empty rungs. A handed confirm
  inherits the epoch of the read it was handed from, which vouches for its `unlessFreed`.
  Which confirm took the LAST advisor is the line's to say (`StartFrom.last`), never the
  advisor's place in the rung's read: round robin orders a read however it likes, and
  load run 37871606406 read tier one with a top rung advisor at its end, who was handed on
  the top rung, so no confirm on tier one stood at its read's end, nobody declared the
  time full, and 85 of 100 waited out the line after all 14 free advisors had booked.
- **A full verdict that a freed claim voids (#3529).** A booking on the ladder's last
  advisor does not prove the slot full when the walk skipped an advisor only for a
  claim, since that claim may have ended without a booking and freed them. Before #3529
  it was reported full anyway, and the line refused everybody waiting while an advisor
  was free. Now it is full only `unlessFreed`: the line applies it when no claim has
  ended unbooked since that confirm's first read through the line (its `epoch` then),
  which in a crowd is the usual case, and otherwise hands one confirm the turn to walk.
  A confirm that skipped a rung it never read vouches with the read that did see it: a
  confirm handed a lower rung inherits the epoch of the read it was handed from, and a
  walk down resumed below a rung it passed for claims keeps its own first read's, so
  either is full `unlessFreed` like any other; the line voids the verdict when it holds no
  read to vouch with, and then a walk that finds nobody parks rather than refusing. One judge,
  `claimsMayFree`, decides both the full verdict and whether a lost race has nowhere
  left to walk. A bucket move never walks past claims (`HeldTurn.move`), and a walk
  that stands asks whether the person already sits at the instant before refusing.

**One read for the whole ladder.** Each rung used to cost its walker seven to nine
database requests and each lower rung a bucket read, and request COUNT is what queues a
crowd (#3492). A walk now makes one (`BookingDeps.readLadderInputs`,
`ladder_candidate_inputs`, migration 0176): every rung's buckets, the org roster,
members, schedules, busy time, day counts and live holds over windows wider than any
rung's, the share rows and the business hours. Each rung is still judged by
`roundRobinCandidates`, from those rows narrowed to its own pool and window
(`src/lib/availability/ladder-inputs.ts`); a rung whose window falls outside the read's
is read on its own and logged. The verdicts the load model gives for the stack, burst
by burst, are asserted in `test-confirm-contention.ts` against the judge's bar.

Two limits on that one read (#3530). It is never trusted past `LADDER_READ_MAX_AGE_MS`
(two seconds, a quarter of a live check's deadline): a rung judged after the walk has
spent that long on the live checks above it is judged from a fresh read (stage
`ladder-reread`), so a lower rung never offers somebody who was booked to their cap, held
or made unbookable while the rungs above were being asked; a re-read that fails fails the
confirm, never falls back to the stale one. And one advisor's unreadable row no longer
fails every ladder: the reader drops that advisor WHOLE (never just the row, which could
make them look free), logs it on every read (`tag=ladder-inputs`) and the monitor lane
pages it (`ladder_advisor_unreadable`). A row naming nobody, or an org wide row, still
fails the read.

## Where the code is

| piece | file |
|---|---|
| the line's rules, the only implementation | `src/lib/booking/confirm-queue.ts` (`makeConfirmQueue`) |
| the async interface the confirm path uses, and the per isolate adapter | same file (`ConfirmLine`, `isolateLine`) |
| the protocol the object runs | `src/lib/booking/confirm-line-object.ts` |
| the object itself (a shell) | `worker/confirm-line.ts`, exported from `worker/index.ts` |
| the confirm path's client, every fallback named | `src/lib/booking/shared-confirm-line.ts` |
| the wiring to the runtime | `src/lib/booking/confirm-line-live.ts` |
| what pages, and what only logs | `src/lib/booking/confirm-line-alert.ts` |
| the switch | `src/lib/booking/shared-line-switch*.ts`, `booking_settings.shared_confirm_line` |
| the pool grouping snapshot, its directory and its reader (#3460) | `src/lib/booking/pool-grouping.ts` |
| publishing it, wired to the binding | `src/lib/booking/pool-grouping-live.ts`, `src/app/api/cron/recompute/route.ts` |

## The key

A line key is a GROUP and an instant. One object per group, one line per instant
inside it, because creating an object costs about 170ms and calling an existing one
about 13ms (measured below): an object per instant would create one on almost every
booking. The group is:

- `link:<userId>` for a named advisor's link, whatever code it came through;
- `ladder:<fingerprint>` when this server holds a fresh grouping of every rung of the
  code's fallback ladder into its pool (`src/lib/booking/line-key.ts`). A leader's
  "full" verdict means nobody in any rung of ITS ladder was free (since #3338 that is
  what the verdict says, see above), so it may settle
  only followers that would walk the same pools at every rung. Today 510, 511, 500
  and 501 share one; a bucket that gains a hand named member splits off by itself
  (Dan, 2026-10-05);
- `code:<code>` otherwise: a server holding no fresh grouping, or one whose grouping
  does not list the confirm's own code (a grouping read before the bucket existed,
  or a partial one, whose gaps cannot be trusted, #3460).

**Where the grouping comes from, and the invariant #3460 retired.** #3325 shipped "a
confirm never adds a read before its line": the grouping was looked at without
waiting (`peekPoolKey` in `slot-cache.ts`) and warmed after the response. Load run
37566700055 showed what that costs: most of each burst ran on servers holding
nothing, so a hundred confirms on 120 and 121 split across a `ladder:` line and both
codes' own lines, three leaders, and one slow losing leader timed out 41 followers.
#3355 (items 1 and 2, which #3460 supersedes) had already decided a confirm may WAIT,
within a short bound, for the grouping before its key. So it now does: see "The pool
grouping snapshot" below. `lineGroupOf` stays synchronous; the wait happens before
the orchestration builds the key, never inside it.

Accepted, and stated: for up to one minute after an admin edits a bucket's members,
a server holding the old grouping can put two codes whose ladders now differ in
one line, so a follower can be told "taken" while the edited bucket's new member is
free. The lead picks another time; nothing is double booked. The snapshot extends
nothing here: it is installed under the time its read STARTED, so a snapshot and a
local read of the same age expire at the same moment.

## The pool grouping snapshot (#3460)

The every minute recompute lane already reads the bucket list. It groups it by pool
and publishes `[code, pool digest]` for every code, with the time the read started,
to the **directory**: a reserved instance of this same class, named
`directory:pool-grouping:v<format>` (no new class, binding or migration). The directory
keeps its snapshot in the instance's own storage, not only its memory (#3479): the
platform hibernates an idle object with no timers after ten seconds and discards its
memory, so a memory only directory was empty for most of every minute, and load run
37601024392's bursts, each arriving about 48 seconds after the last publish, read
nothing. A put writes storage before it answers `stored`, a failed write is refused (so
the heartbeat below is not stamped), and a failed read is refused rather than answered
as an empty directory. A put stamped further in the future than the readers accept
(`POOL_GROUPING_FUTURE_TOLERANCE_MS`) is refused, and a stored one is read as none, so a
single bad clock cannot hold the directory against every honest put after it (#3483). It publishes
BEFORE taking its lock, because a tick that finds the lock held is skipped, and it
adds no read: the same list feeds the recompute. Any server's own read publishes too,
after the response, as a backup. A publish that landed stamps the `pool-grouping`
heartbeat, watched by `POOL_GROUPING_STALE_BOUNDS_MS` (Slack only, ten minutes), so a
publisher that stops is paged rather than every cold server quietly keying by code.

A confirm starts fetching the snapshot, alongside the shared line switch read (#3355
item 1), after the booking API's key authenticates (inside the authorizer, before its
ceilings) or after the booker's address passes its edge limiter. A bad key, or an
address past its minute, starts neither (L498). It waits for it in the service, before
the orchestration builds the key, at most `POOL_GROUPING_FETCH_MS` (500ms: #3325
measured a new object's first call at p95 323ms and worst 452ms), counted from that
point and not from when the fetch started, so the ceilings and the body read in between
overlap the fetch without spending the bound. One fetch per server
however many confirms ask, and a fetch older than the bound is never joined, because a
fetch started by a request that has since ended can be left pending for ever. A fetch a
request starts is kept alive past its response, so a confirm that joined it is never
stranded.

**What a caller over its ceiling can cause, stated.** Both reads start before the per
key and per address hourly ceilings answer, so a good key that those ceilings then
refuse with a 429 has started them too. That is bounded per server and never per
request: the switch is read at most once per server per 15 seconds (once per 5 while
the read is failing), coalesced; the snapshot is not fetched at all while the server
holds a fresh grouping, is fetched once however many ask, and is not fetched again for
`POOL_GROUPING_RETRY_MS` (one second) after a fetch that installed nothing. So a flood
of over ceiling requests costs each server about one switch read every 5 seconds and
two directory calls a second at most, what the same number of real confirms would
cost, and nothing more for each request it sends. `startConfirmPrelude` carries the
same statement beside the code, and the bookings route's tests send a burst of refused
requests to a cold server and count both.

Every refusal leaves the confirm on its code's own line, which is today's behaviour,
and over grouping is the one failure this must not have:

| what the directory answers | what the server does | `line_group_source` |
|---|---|---|
| a fresh snapshot, newer than what the server holds | installs it under its own read time | `snapshot` |
| nothing needed: the server already holds a fresh grouping | fetches nothing | `local` (or `snapshot` if that is where it came from) |
| a snapshot older than one minute | installs nothing | `stale` |
| no snapshot (a new instance before the next publish) | installs nothing | `absent` |
| an empty or partial snapshot, a malformed one, or an older object's refusal | installs nothing | `refused` |
| a snapshot of another format | installs nothing | `format-mismatch` |
| no answer within the bound | keys by code; an answer inside the fetch's own 2s give up still installs, for the next confirm | `timeout` |
| the call failed | installs nothing | `unreachable` |
| no binding (off the runtime) | fetches nothing | `unbound` |
| nothing: a fetch on this server installed nothing less than a second ago | fetches nothing, keys by code | `backoff` |
| a grouping that does not list the confirm's own code | keys by code | `own-code-missing` |

Two guards keep the snapshot from ever grouping differently from a local read:
**both routes derive their entries in one place** (`groupingEntriesOf`), and
`scripts/test-pool-grouping-reader.ts` builds the same ladder key both ways for all
sixty codes of a realistic roster, through the real object, reader, store and JSON. And
because deploys are gradual, so one build may install what another published, the
**format** is in the directory's name and the snapshot, and
`scripts/test-pool-grouping.ts` pins the derivation's sources and a fixture's digests
under each format, so changing the pool key, `listPoolBuckets`, the
ladder or the digest fails until the format is bumped.

**The gap, stated (L614).** The lane stamps a snapshot with its read's START, and a
server accepts it for one minute from then, the same minute a local read has. So in
each minute there is a short gap, between one snapshot expiring and the next landing
(cron lateness, the read, the put), in which a cold server meets a stale snapshot and
keys by code, said as `stale`. Widening the window to close it would extend the
staleness accepted above, so it was left as is and measured. #3529 closed it another
way: load run 37841835577's tier drop burst landed in a 77 second gap, the two codes of
its ladder formed two lines and raced each other, and three of twelve timed out. Now a
server whose directory answer is not fresh reads the grouping itself at once
(`readOwn`, the coalesced `warmPoolKeys` it already ran after the response), inside the
confirm's own wait, and keys by ladder; its `line_group_source` says `local`, as for any
grouping the server read itself. The same reads, earlier, under a local read's own minute,
so no staleness is extended. It starts as soon as the directory answers with nothing
fresh, or once the directory has not answered within its head start
(`POOL_GROUPING_OWN_READ_AFTER_MS`, 150ms), whichever comes first, and whichever of the two
lands a fresh grouping first answers (#3558). Load run 37952874789 is why: the directory
held nothing fresh and answered slowly, own reads started 0.1 to 1.2s in, and 56 of a
crowd's 100 confirms ran out of their wait and keyed by code.

Every confirm's `confirm answered` line carries `line_group_source`, its own wait for
the fetch (counted from its line key, so a fetch that answered during the ceilings reads
0) as `grouping_fetch_ms` and the snapshot's age as `grouping_age_ms`, and the load run's
burst breakdown reports, per burst, how many line keys came from the snapshot and why
the rest did not, with the spread of the wait.

## The switch, and which way everything fails

`booking_settings.shared_confirm_line`, on the admin Hours page, read once per
isolate per 15 seconds. A failed read is never cached as the answer: an isolate with
no good read uses the deployment default `SHARED_CONFIRM_LINE_DEFAULT`, `"on"` in
both the load test Worker and production (production since #3339). So while the stored
switch is off, a cold production isolate whose read failed takes the shared line until
its next read succeeds, about five seconds later.

**A failed read is counted, not only logged (#3339).** Every failed or late read is a
`tag=shared-line` log line carrying the error, and is counted on its isolate
(`src/lib/booking/shared-line-switch-alert.ts`); three inside a minute on one isolate
page `shared_line_switch_unreadable`, once per half hour, naming the deployment default
those confirms fell back to. It is an incident, like `confirm_line_unreachable`: one
failed read is never a page, and nothing on the confirm path could clear it. The
monitor lane's own read of the switch every tick is the ongoing measure: a lane that
cannot read it pages `monitor_step_failing:shared_line_left_off`, with an all clear.

**Left off after activation (#3339).** Once the line has been switched on, the monitor
lane pages `shared_confirm_line_left_off` when it has been switched off again for more
than a day (`src/lib/monitor/shared-line-left-off.ts`, the kill switch's pattern from
#2366), during the org's open hours, once a day while it stands, and clears when it is
switched back on. When it was activated, and when it was turned off, come from the
audit trail the admin action writes on every flip (`booking.settings`, immutable),
never a new column: the newest switch on, then the FIRST switch off after it, so
pressing off twice cannot restart the clock. Until the line has ever been switched on,
off is the expected state and says nothing, as in production before the switch is
first turned on. Turning it on
is a person's decision, on the admin Hours page (`/admin/business-hours`); the
deployment default being on does not turn it on.

Every confirm records how it was served, on its `confirm answered` log line:
`line` (`shared`, `isolate`, `fallback`), `line_reason`, `line_key` and `line_ms`
(the time the line added, waiting excluded). A lookahead that failed counts its own
time in `line_ms` (#3355 item 4): it is the first call on the booking path, and a
confirm that spent 1.5s on one that timed out used to report `line_ms` 0.

| what happened | what the confirm does | `line` / `line_reason` | pages? |
|---|---|---|---|
| switch read off | its isolate's line, as before | `isolate` / `off` | no |
| switch unread, default `"off"` | its isolate's line | `isolate` / `unread-default` | the failed reads, after 3 in a minute on one isolate |
| switch unread, default `"on"` (production and the load test since #3339) | the shared line, as if the switch read on | `shared` / `unread-default-on` (#3910), so it is told apart from a read on (`shared` / `ok`) | the failed reads, after 3 in a minute on one isolate |
| switch on, no binding | its isolate's line | `fallback` / `unbound` | after 3 in a minute on one isolate |
| `enter` refused or not answered in 1.5s | its isolate's line, and abandons the attempt | `fallback` / `reach-timeout`, `enter-error` | same |
| the object answered with something the client cannot read | its isolate's line, and abandons the attempt | `fallback` / `bad-answer` | same |
| the object is OLDER than the app (#3560) | its isolate's line at once, no re-entry, nothing to give back | `fallback` / `version` | same, and the page says to redeploy the line Worker |
| a deploy replaced the object | re-enters the new instance | `shared` / `gone` | never |
| a leader's call fails mid turn | carries on; the insert decides | unchanged | no |

## Timings, and why

A new lead must acknowledge within 1s and renew within 4s (every leader call, plus
a heartbeat every 1.5s), so an abandoned leader frees the line well inside a
follower's 10s wait. Followers poll in 1.5s long polls, so a deploy, which leaves
calls already held on the old instance until their own timeout, strands a follower
for at most one poll. The relations are pinned by `scripts/test-confirm-line-object.ts`.

The lead SENDS its ack at once and does not wait for the answer (#3355): nothing the
confirm does depends on it, since a `gone` only marks the turn detached, which every
later call checks. Waiting on it put a line object's round trip in front of every
confirm, 1.3s on an object fresh from a deploy (load run 37572839375). Nothing waits
on the ack at all, neither the confirm's start nor its report, and it is not counted
in `line_ms`.

A give back (`abandon`) is SENT the same way and never waited on (#3355 item 4). Every
one follows a call that failed or an answer nobody will collect, so it goes to the object
least likely to answer, and waiting on it put up to another second in front of the
isolate's line, or in front of the confirm's own answer when `release` sent it. It is
handed to `keepAlive`, which on the platform is `afterResponse`, so it is not cancelled
when the response goes out, and it is not counted in `line_ms`.

## Versions: an app and a line object from different builds (#3560)

Every message carries `v`, the protocol the CLIENT speaks, which says what it needs the
object to do. An object serves every client from `CONFIRM_LINE_OLDEST_PROTOCOL` to its
own `CONFIRM_LINE_PROTOCOL` and answers anything else `gone`, `why: "version"`, before
acting on it. Every object ever deployed has answered that way, so the client takes that
answer as "this object is older than me".

The two orders are not alike:

- **An older app beside a newer object** is what every deploy makes (the object Workers
  deploy first, then the app gradually) and what the app only rollback
  (`scripts/rollback-production.ts`) makes. The object keeps serving it: an older client
  leaves out fields it never knew, and the line keeps its rules from before for each.
- **A newer app beside an older object** happens only when the line Worker is rolled back
  on its own. Load run 37869019791 met it (app on 357e8cf9, line Worker on c51bcfae):
  every confirm in each refusal burst's first crowd waited about 11 seconds and was
  answered 503. The cause, reproduced offline by driving the current client against the
  object at c51bcfae: #3529's client decides the full verdict from marks only the newer
  object hands out (`StartFrom.last`, `deepest`). The older object accepted every message,
  ignored `lower` and `lowerComplete`, and handed out neither mark, so no confirm ever
  reported the ladder spent and the crowd waited out its whole wait. Nothing about it was
  refused, so nothing said anything was wrong.

Since #3560 the client speaks protocol 2, so an older object refuses it, and the client
uses its isolate's own line at once (`fallback` / `version`) and pages with the remedy:
redeploy the ConfirmLine Worker at the app's commit. That makes a line Worker rolled back
alone the same as the shared line switched OFF, rather
than an untested mix of two builds. It does not make a crowd book: on per isolate lines a
crowd for one slot books one advisor or none (load run 37333201026, and the load model in
`test-confirm-contention.ts`, which holds the older object order to exactly what the
switched off line gives). Only refusing to deploy the line older than the app keeps a
crowd served in that order.

**When to raise which.** Raise `CONFIRM_LINE_PROTOCOL` whenever the client starts relying
on something only the newer object does, even when an older object would accept every
field and ignore it. Raise `CONFIRM_LINE_OLDEST_PROTOCOL` only when the object can no
longer serve an older client, since a refused client uses its isolate's line for the whole
of a gradual deploy (run 37333201026). Optional fields whose absence only the CLIENT reads
(#3489's rung, outcome, `canWalk`, settlement and `park`) need neither.

**The deploy refuses that order (#3561).** Since #3838 shipped, a deploy refuses to put
a ConfirmLine Worker build in front of the live app when its `CONFIRM_LINE_PROTOCOL` is
lower than the app's (gradual deploy exit 27, `scripts/deploy-object-workers.ts` exit 3),
so a line older than the app is no longer something a deploy can make by accident. It
fails open, with a warning, when either side's protocol cannot be read, for example a
live version with no commit tag after `wrangler secret put`. A deliberate downgrade means
deploying the app alone first, then the older line. The exit codes are in `DEPLOY.md`.

## Waking a line before its confirm (#3775)

An object left idle for minutes is brought back by the platform on its next call, and
that call is slow: load run 34 measured 766ms wall and 7ms CPU on the first call after
15 idle minutes, on an object that writes nothing to storage, so the wait is the wake
and not the line's work. It landed on the first lead to confirm.

So `/api/availability` wakes the line the lead's confirm will join, after its response
(`wakeConfirmLineForCode`): a `wake` message the object answers with `{ ok: true }` and
nothing else. `makeLineWaker` does the cheapest checks first: at most once per bucket
code per server per `CONFIRM_LINE_WAKE_EVERY_MS` (a minute), then the switch and the
binding, so with the line switched off a read never works out which line it
would reach. Only then is the line chosen, by `lineGroupToWake` through the same
`codeLineGroup` the confirm keys on; a fresh server reads the grouping first, and one
that cannot be read or still does not settle the line wakes nothing, each said as
itself. It never throws; an object on a build from before the wake answers
`unknown op`, logged as a wake that did not land. A named link's line (`link:`) is not
woken.

## Traced calls (load test only, #3354)

Under SLATE_LOADTEST the route mints a trace for each confirm, and the client adds
it to every message with the stage it was sent in: `wait` until `enter` hands back a
turn, `turn` after. The object logs each traced call (`tag=confirm-line-object
msg="line call"`, with the op, trace and stage) and the runtime records the call's
`wallTime` on the same event, so the load run joins the object's side of a confirm to
the confirm's own `confirm answered` line (`line_trace`). Production confirms carry
no trace, so the object logs nothing for them. Nothing in the protocol depends on it:
an object that ignored both fields would answer every call the same.

## Tests

`test-confirm-queue.ts` (the rules), `test-confirm-line-object.ts` (the protocol,
every lost, late, repeated or outlived message, and the `wake` that changes nothing),
`test-confirm-line-wake.ts` (#3775: the waker's window and every outcome, reads arriving
together sending one wake, and `lineGroupToWake` reaching the line `confirmQueueKey`
keys on, a fresh server's grouping read first, and an unreadable one said as such), the
availability route test (a served code woken, a 404 not), `test-shared-confirm-line.ts` (the
client against the real host through a transport that can fail each message, or
swap the host for a deploy), `test-confirm-contention.ts` (fifty isolates: per
isolate lines leave dozens told to retry, one shared line answers the whole crowd;
since #3338 a crowd behind a rung's last advisor walking the ladder, on both lines,
at the slow speed (8s a confirm, #3221), with the one hop a spent ladder costs measured; and #3460's
burst on sibling codes across warm, cold and stale servers, which elects
three leaders keyed as main keys it and one once every server fetches the snapshot),
`test-pool-grouping.ts` (the snapshot, every refusal, the directory through the real
object, where each get says it answered from, and the format pin), `test-pool-grouping-reader.ts` (the server's grouping,
newest wins, the reader's bound counted from the line key, coalescing and backoff, and
the same key both ways for sixty codes), `test-unawaited-line-calls.ts` (no unawaited seat call or turn report; the lead's ack
is the one deliberate exception, see Timings),
`test-confirm-line-binding.ts` (bound, created and exported in production and the load
test, the deployed class logging a traced call, and serving the directory only on its
own path and, when the runtime names it, its own instance). #3560: the object suite
holds which client versions an object serves, the client suite an older object's
refusal (one enter, no re-entry, `version`, reported, from an enter, a lookahead or a
poll), and the contention suite a crowd against an older object answered exactly as the
same crowd is with the shared line off. #3355 item 4: the client suite holds every give
back sent without waiting and kept alive, and a failed lookahead counted in `line_ms`. #3489's rules are in the
queue suite (release, walk, park, held verdict, a walk that stands), the object suite
and the client suite (each field on the wire, an older peer's absence of it), and the
contention suite end to end (the burst bar under the load model, a walk read once). The
ladder read: `test-ladder-inputs.ts` (the reader refuses every unreadable section, drops
one advisor's unreadable row as that whole advisor and nobody else, the windows),
`test-ladder-read-staleness.ts` (a walk that outlived its read re-reads before the next
rung, a quick one does not, a failed re-read books nobody),
`test-ladder-dropped-advisors.ts` (the page, and its all clear only off a clean read), `src/lib/availability/ladder-reads.test.ts` (the same candidates, in the same
order, with no reads, as the live reads), and `verify-ladder-candidate-inputs-sql.ts`
(each section against the read it replaces, in a real Postgres).

Against production, `pnpm verify:confirm-line` (#3340) runs daily in
`burst-counter.yml` and stamps `verdict:confirm-line`: the confirm path's own client
against the live object, a follower refused after a full verdict, handed the lead
after a not full one, freed behind an unacknowledged lead, and nothing left held; the
ladder line's own behaviour (#3823): a waiting confirm released holding the advisor
nobody claimed, a full verdict HELD while another claim is in flight and then applied
with the last booking's settlement, and a claim reported found busy kept out while one
reported untried is handed back, so a line Worker deployed answering the old way fails
the proof before a crowd meets it; and
(#3460) the pool grouping directory storing a put, keeping the newest over an older
one, and holding a live grouping a cold server would install. It writes only its own
verification directory and only reads the live one. It cannot prove two isolates
share one object; only the load run can. Exit codes and
decisions: `docs/verify-commands.md`.

**What it holds the verification directory to (#3496).** That directory is touched only
by the proof, so its first call each day meets a cold start, which the live directory,
called every minute by the recompute lane, never does. The proof times that first call
and holds it to `POOL_GROUPING_FETCH_GIVE_UP_MS` (two seconds, the longest a server's own
fetch waits for the directory), and holds every call after it to `CONFIRM_LINE_CALL_MS`,
the live directory's real pattern. Before this, the first call was held to one call, and
the proof failed daily on a cold start that is about a second long. The measurements are
in `docs/cloudflare-platform-notes.md` ("An object idle for minutes"). A call that misses
its bound is watched for `PROBE_LATE_ANSWER_MS` and says when it really answered.

**What it proves about the directory surviving a sleep (#3481).** #3479 rests on a
platform guarantee the offline tests can show only with a stand in: the object's
storage outlives the hibernation that discards its memory, and a woken instance reads
it back. Load run 37610783404 showed it once, indirectly. The daily proof now shows it
every day, directly, on the real platform: on its own verification directory it puts
a grouping, confirms it is held, leaves the directory untouched for 20 seconds (twice
the platform's ten second window) and reads it again, up to three times. The
directory's get says where it answered from, `memory`, or `storage` on the one get
that loaded a woken instance's storage (an additive field: the reader takes `kind` and
`snapshot` alone, and the directory's protocol is unchanged). A pass is a read **from
storage** holding the grouping the probe put, which is a woken instance reading its
snapshot back. A read after the wait that lost the grouping fails on its own exit
(24). Every read answered from memory means the platform kept the object awake and
the probe never saw a wake, which is never a pass (exit 25, and no stamp). What it
still cannot prove is the LIVE directory's own sleeps: the live one is only read, so
the proof checks the mechanism on an instance of the same class rather than the
instance real confirms use.

## Measured before it was built (2026-10-05)

A throwaway Worker, deleted after, timed calls from inside an invocation:

| call | p50 | p95 |
|---|---|---|
| first call to a new object, same region | 171ms | 266ms |
| call to a warm object, same region | 11ms | 19ms |
| first call to a new object, cross country | 215ms | 323ms |
| call to a warm object, cross country | 53ms | 59ms |

An existing object re-woken after 90 to 180 seconds idle answered in about 55ms.
100 held calls on one object were all released by one call with no lag. A deploy
left 30 held calls on the old instance until their own 45s timeout while new calls
reached the new version about 6 seconds in. Full figures are on #3325.

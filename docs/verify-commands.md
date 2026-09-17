# The verify commands

The hand run `pnpm verify:*` commands, in full: what each one proves, how to run
it, what every exit code means, what it writes, and what its last live run
measured.

This is the detail behind the section "The `pnpm verify:*` commands: proving a
fail safe detector is not blind" in `AGENTS.md`, which carries the four rules the
whole family rests on. Read that first; this is the runbook, and it lives here
rather than in `AGENTS.md` because `AGENTS.md` is loaded into every session and
every character of it is paid on every request (#2393), while an exit code table
is needed on the day somebody runs the command.

Nothing here has been rewritten. Each section is the text that stood in
`AGENTS.md`, moved whole so the recorded decisions and the evidence behind them
stay where they can be found.

# A detector the roster cannot exercise (`pnpm verify:availability-truth`)

The availability-truth probe (#1315) asks whether the times Slate is OFFERING are
really free on the live calendars. It is built to fail safe: a calendar it cannot
read is scored `unverified` and it stays silent, because scoring Google's own
errors as drift would page about our cache every time Google had a bad minute.

That correct choice has a cost. **A probe whose calendar reads never succeed is
indistinguishable from a probe finding nothing wrong**, and production confirmed
the sharper version of that on 2026-08-11 (#1377): every tick since deploy
skipped with `why="bucket is offering no times to check"`, because 2 of 126 users
are bookable while the roster is dark before cutover (#1272), and the rotation
excludes the two test buckets that do have slots. The live half had never
executed once.

So the probe cannot prove itself from production traffic, and mocks cannot either
(L52: a fake agrees with our assumption about Google's interface by
construction). **`pnpm verify:availability-truth` is the proof.** It reads one
agent's calendar live and, from GOOGLE'S OWN ANSWER rather than from
`busy_blocks` (which is written by the very reads under test, L58), builds two
windows: one Google reports as occupied, one it reports as clear. It then asks
the probe's own `verifySlotLive` about each. Busy must come back `drift`, free
must come back `free`. **Both directions, or it proves nothing**: a one-sided
control is satisfied by a probe hard-wired to a single answer (L1).

It writes nothing and is deliberately NOT named `test-*.ts`, because that glob is
the offline unit suite and this one needs live Google plus the Supabase secret
key from `.env.local` / `.dev.vars`. Point it at an agent who has real meetings:

```
TRUTH_CONTROL_EMAIL=someagent@trypennie.com pnpm verify:availability-truth
```

Every way it can fail to build a control (an empty calendar, a calendar busy for
the whole horizon, an unreadable bound, a refused calendar) exits **non-zero**
with the reason. Finding nothing to check is never a pass (L98). Its decision
logic is pinned offline by `scripts/test-availability-truth-live-control.ts`.

**Re-run it before arming the probe (#1371), and after any change to the Google
read path or the delegated identity.** As of 2026-08-11 it passes against real
agents (37 and 38 live busy periods read, both directions correct), so
domain-wide delegation and cross-agent free/busy are confirmed working.

## The general case: a detector that has never once concluded (#1394)

That blindness is not specific to the truth probe. Any fail safe detector, one
that reports `unverified` / `skipped` / `insufficient` rather than guessing, can
sit permanently blind while looking healthy, because "nothing to report" and
"could not check anything" render the same in a dashboard and identically in
silence. The lane heartbeats cannot see it: they prove a lane RAN, and this lane
ran faithfully every five minutes for weeks.

So three detectors now carry a SECOND stamp, written only when they reach a
MEASURED verdict: `verdict:availability-truth`, `verdict:booking-failure-rate`
and `verdict:low-booking-volume`, in the same `lane_heartbeats` table the lane
watchdog already reads once per tick (so watching them costs no extra query on
the budget four cron lanes share). Which outcomes count is decided in one place,
`src/lib/monitor/verdict-freshness.ts`, and nothing else may stamp: `checked`
alone is not enough, because a sample too small to judge also reports `checked`.

They are judged by `VERDICT_STALE_BOUNDS_MS` with `neverIsStale` ON, because
"has never once reached a verdict" is the exact state the family exists to
notice. Bounds are set by each detector's longest LEGITIMATE silence: 24h for the
truth probe (about five passes of the bucket rotation), 4 days for the two
traffic fed checks (which are properly silent from Friday evening to Monday
morning). A blind detector re-pages daily rather than hourly, since before
cutover it can legitimately stay blind for days.

# Proving the burst counter answers (`pnpm verify:burst-counter`)

The same shape as the truth probe above, on the burst ceiling (#1564).

The monitor lane reports the burst counter missing from a deployment (#1558) by
resolving the `BURST_LIMITER` namespace as a **property read**, and it stops
there deliberately: asking the object whether it ANSWERS would create it, spend a
subrequest out of the invocation four cron lanes share, and give it an alarm to
clean up on every tick forever. The cost of that correct choice is that a counter
which is **bound but unreachable reads as fine**, and stays that way until one
caller crosses the escalation threshold, which before cutover could be months
away. Injected fakes cannot close it either: a fake agrees with our assumption
about the Durable Object by construction (L52).

**`pnpm verify:burst-counter` is the proof.** It reports a FIXED monitor key to
the real `BURST_LIMITER` object, reads the count back, reports it again, and
requires the count to have **RISEN inside one window**. Both halves, or it proves
nothing (L1): a counter hard wired to a single answer, or one that replies
without counting, satisfies a check that only asks whether it replied. It judges
on the COUNT and never on a substring of the output, because every failure the
deployment can report quotes the same binding name the success case does (L156).

It writes one count, against a key no real caller's `burstKey` can produce (the
argument for why lives in `src/lib/monitor/burst-counter-probe.ts`, and
`scripts/test-burst-counter-live-control.ts` walks the shipped `EDGE_LIMITERS`
table so a limiter that ever adopted that key space fails the build). The object
its own alarm deletes two windows after the last report.

A Durable Object is reachable only through a binding inside the Worker, so the
command's one step into the deployment is `POST /api/smoke/burst-counter`, a
key-authed endpoint on the same Bearer key as `/api/smoke/version` and
`/api/smoke/heartbeat`. The key it reports is a **constant in that route and is
never taken from the request**: a caller who could name the key could report
requests against a real lead's count and push them toward a ceiling.

```
BOOKING_API_KEY=<the key the deployment holds> pnpm verify:burst-counter
```

`SLATE_BASE_URL` picks the deployment (default prod). Finding nothing to check is
never a pass (L98): every way of learning nothing exits non-zero on **its own
code**, so a shell caller can branch on which one it met.

| exit | what it met | what to do |
|---|---|---|
| 0 | the count rose | nothing |
| 1 | no base URL or no `BOOKING_API_KEY` here | set them; nothing was attempted |
| 2 | no reply at all | check the base URL and that the deployment serves |
| 3 | a reply this command cannot read | something other than the endpoint answered |
| 4 | the key was refused | the deployment does not hold this key |
| 5 | the endpoint is disabled | the deployment has no booking API key configured |
| 6 | not found | the deployment predates this endpoint; deploy and re-run |
| 7 | the Worker could not read its own context | not a missing binding; a local dev server reads like this |
| 8 | `BURST_LIMITER` is not bound | a deploy shipped without the `durable_objects` block |
| 9 | bound, and the object did not answer | **the state the monitor lane cannot see**; the ceiling is failing open |
| 10 | it answered with no count | reachable, wrong reply shape: a code fault |
| 11 | the two readings fell in different windows | nothing is wrong; run it again |
| 12 | two readings in one window and it did not rise | it answers and does not count |

Like the truth probe, it talks to a live deployment, so it is deliberately NOT
named `test-*.ts`: that glob is the offline unit suite. Its decision logic is
pinned offline by `scripts/test-burst-counter-live-control.ts`, which drives every
refusal through hand written replies and asserts no two of them share a code or a
message.

## It runs DAILY, because asking people to re-run it did not work (#2392)

This section used to say, in bold, to re-run the command after any change to the
burst path (`src/lib/rate-limit-burst.ts`, `src/lib/rate-limit.ts`,
`worker/burst-limiter.ts`) or to the `BURST_LIMITER` binding in `wrangler.jsonc`.
Nothing enforced it. Between the command shipping on 2026-08-31 and this change
the path moved five times (`182d4b7d`, `81d3385c` and three `wrangler.jsonc`
edits) and not one of the five PR bodies mentions the command, because a rule that
lives only in a prompt is a hope (L27). The command had never run outside the
session that wrote it, which is a check that has never once concluded (L557).

**`.github/workflows/burst-counter.yml` runs it every day at 10:50 UTC**, and a
hand dispatch is the same run, so somebody who has just changed the burst path can
still get an answer now rather than tomorrow.

**It stamps `verdict:burst-counter`**, in the `VERDICT_STALE_BOUNDS_MS` family
(#1394), judged with `neverIsStale` ON: a proof that has never once concluded is
the exact state this issue was about, and the default leniency would make the
watch structurally unable to see it.

Two things about that stamp are the whole design:

- **Only a run that MEASURED whether the counter answers and counts may write it.**
  The command has thirteen endings and most of them mean it never got to ask: a
  refused key, a deployment older than the endpoint, a Worker that could not read
  its own context. Three endings conclude, and two of those are bad news: exit 9
  (bound and not answering) and exit 12 (answering and not counting) are definite
  readings of the thing under test, so they stamp AND are posted to Slack. Exit 8
  (nothing bound) deliberately does NOT stamp, although it feels like the most
  definite answer of all: the half this command exists to prove is the ANSWERING
  half, and a deployment with nothing bound never exercised it, so a stamp there
  would keep the verdict fresh for as long as the binding stayed missing. That case
  is already paged by the monitor lane's own presence read (#1558). The mapping is
  in `scripts/lib/burst-counter-run-outcome.ts`, one entry per exit code.
- **The bound is 52 hours and every part of it is derived** (L614): 24h of cadence,
  doubled so one dropped run does not page (GitHub drops scheduled runs, and on a
  daily cadence a drop costs the whole day), plus the 3h worst lateness this repo
  has measured, plus the job's own 10 minute timeout, because the stamp lands at
  the END of a run. `scripts/test-burst-counter-schedule.ts` re-derives all of it
  FROM the workflow file, so editing the cron or the timeout without revisiting the
  bound fails the build, and it also refuses a bound with days of slack in it.

There is deliberately **no gap filler** for a run GitHub drops, unlike the canary
and the parity sweep: the bound above survives a dropped run instead. A fourth
entry in `GAP_FILL_PASSES` (`src/lib/monitor/canary-trigger.ts`) is #2466's
question rather than this one's.

**The run speaks from the runner** (`scripts/notify-burst-counter.ts`, bare node
like the other alerters), which is the opposite of the choice `schedule-parity`
made. That one reports back into Slate because drift sits for days and so needs a
cooldown and an all clear, both of which need a memory a runner has none of. This
one is a rare fault somebody fixes the day they read it, so the message says what
silence means instead: it repeats once a day until a run passes, and a run that
passes says nothing.

# Proving an approved time off blocks (`pnpm verify:ooo-protection`)

The third command in this family, and the closest mirror of the truth probe two
sections up: that one asks whether the times Slate OFFERS are really free, this
one asks whether the times it has promised to PROTECT are really blocked (#1478).
Both rest on the same rule. Asking whether an approved time off is really
blocking the agent means asking GOOGLE, because everything Slate stores about it
was written by the very code under test (L58).

#1464 is what that costs. A busy block was deleted 31 seconds after it was
written, `ooo_requests.side_effects` went on reading `ok (slate fallback)` for
weeks, and both Slack messages read as healthy. Any check built on the stored
record would have agreed with them.

**Two reads, and both are required.** Google's free/busy alone cannot answer it,
because busy periods MERGE: a neighbouring meeting makes an oversized, mistimed
or entirely absent time off event read as a perfectly occupied window. So the
command reads the EVENT itself by the id Slate recorded, checks its start and end
against the request, and separately asks free/busy whether that window really
reads as occupied. Free/busy is asked over the agent's PRIMARY calendar only,
which is where Slate writes the event; counting another calendar's busy time
would let something unrelated to the request answer for it.

It WRITES NOTHING (no calendar, no database, no alert) and is deliberately not
named `test-*.ts`, because that glob is the offline unit suite and this needs
live Google plus the Supabase secret key from `.env.local` / `.dev.vars`.

```
pnpm verify:ooo-protection                                  # sweep
OOO_VERIFY_REQUEST_ID=<uuid> pnpm verify:ooo-protection     # one request
```

`OOO_VERIFY_INCLUDE_UNHANDLED=1` also checks the imported rows Slate never ran a
step for (#1485), which are excluded by default and counted out loud;
`OOO_VERIFY_TOLERANCE_MINUTES` (default 1) is how far an event bound may sit from
the record before the two are called different windows, and a value that is not a
number exits `tolerance-unreadable` rather than becoming a NaN every comparison
reads as a mismatch.

**Only `verified` passes, and every other outcome exits non-zero with its own
reason.** Finding nothing to check is never a pass (L98), and one message
answering for another is how a blind check reads as a healthy one (L11):

- `no-approved-future-requests`, `only-unhandled-requests`: the sweep had nothing
  it could check, for two different reasons.
- `request-not-found`, `request-not-approved`, `request-window-passed`,
  `request-unhandled`: a named request that cannot be the subject of this check,
  each said separately so nobody hunts for a typo that is not there.
- `event-never-recorded-window-free` / `-busy`, `event-gone-window-free` /
  `-busy`: no event covering the window, split by whether Slate ever held an id
  and by what free/busy said. The `-busy` pair still FAIL: an occupied window with
  no event of its own can be the neighbouring meeting.
- `event-window-uncovered`, `event-window-wider`, `event-window-unreadable`,
  `event-cancelled`, `event-marked-free`, `event-matches-but-window-free`: the
  event exists but does not prove the window is blocked.
- `calendar-refused`, `calendar-not-provisioned`, `calendar-unreadable`: the three
  ways a calendar read fails, each carrying its own instruction (see "Three ways a
  Google calendar can fail, not two" in `AGENTS.md`); `busy-unreadable`,
  `request-window-unreadable`, `no-agent`.

There is one SKIP, and it is deliberately neither proof nor damage.
`agent-deactivated` is an approved future window belonging to somebody who has
left the pool: nothing can be booked with them, and their Google account is
routinely unlicensed on the way out, so asking Google would report a provisioning
repair nobody should make. It is asked BEFORE the Google call rather than after,
so the run does not spend one. A skip is still not a pass: a run whose every
request was skipped exits `nothing-judged`, because judging nothing proves
nothing (L98). The point of the skip is that one departed agent must not leave the
sweep permanently red, which is how a check stops being read at all (L36).

Its decision logic is pinned offline by
`scripts/test-ooo-protection-live-check.ts`, which drives every one of those
verdicts through hand written fakes and fails if a declared verdict is one no case
can produce.

**As of 2026-08-31 a full sweep passes**: 24 approved future requests looked at,
22 verified against live Google, and 2 skipped as `agent-deactivated`. Those two
belong to one agent who left the pool on 2026-08-24, and before the skip existed
they came back `calendar-not-provisioned` (`403 notACalendarUser`), which is what
Google says for a revoked licence as well as for an account that never had one.
Reading that as a provisioning ticket would have sent somebody to re-license a
departed employee, and left the sweep red forever while they did not.

# Comparing Slate against cal.com (`pnpm verify:calcom-parity`)

The fourth command in the family above, and the one that only makes sense while
BOTH systems are live. During the parallel run (`docs/parallel-run-plan.md`)
Slate computes availability nobody can book while cal.com keeps taking every
lead. This is what turns that silence into a measurement (#1731, rebuilt as a
schedule comparison in #1754, membership added in #1911).

It asks TWO questions, together, because they are one question to whoever reads
the answer:

- **MEMBERSHIP: do the two systems hold the same roster?** Nothing reconciled
  them, so one could be six weeks ahead of the other with no signal. Slate
  deactivated an agent on 2026-07-21 and had no Low plus Beyond agent from that
  date, while cal.com went on routing her every Low plus Beyond lead for six more
  weeks (28 of 28 bookings), then removed her, leaving 11 upcoming calls with a
  host who no longer existed there.
- **HOURS: for every agent bookable in Slate, does cal.com hold the same week?**
  Nothing re-checked the 97 schedules imported on 2026-09-02, and five days later
  21 of 102 agents had drifted.

The hours half cannot see the membership half, which is why both are here: it
iterates the agents who ARE bookable in Slate, so somebody missing from Slate is
never in the loop, and a bucket empty in Slate but served by one person in
cal.com reads as ordinary under-offering.

**It is not a correctness check.** cal.com is the incumbent, not the source of
truth: a week both systems hold can be wrong in both. That question belongs to
`verify:availability-truth`, which asks Google. This one catches CONFIGURATION
drift, which is invisible from inside Slate alone.

## The slot comparison it replaced could never run

The first probe narrowed cal.com's answer to one bucket's agents with
`routedTeamMemberIds[]` on `GET /v2/slots`. That parameter does not exist on that
endpoint: it is a strict whitelist, so every spelling answers 400 and zero pins
answers 200 with the whole pool. It belonged to `/v2/slots/available`, which is
now 404. So the probe was merged, documented here with fifteen exit codes, and
structurally incapable of executing a single comparison. Re-measured live on
2026-09-07, still 400.

**The pin was the load-bearing capability and it was the last thing measured**,
which is the mistake worth not repeating. Both halves now rest on endpoints
measured before anything was built on them, and both were confirmed live first:
`GET /v2/organizations/{org}/users/{id}/schedules`, which the OOO dual-write
already exercises daily, and `GET /v2/organizations/{org}/teams/{team}/event-types`,
whose `hosts[]` names who can take a booking.

Two neighbouring paths that look right and are not, so nobody spends an
afternoon on them again: `GET /v2/event-types/{id}` answers 404 (use the
team-scoped listing), and `GET /v2/organizations/{org}/users/{id}/attributes`
answers 404, so **cal.com will not tell you a user's attribute values**. That is
why the check reads routing attributes from Slate, which takes them from
Salesforce, the same source cal.com does.

## Two design decisions, both made because the first live run misled somebody

**The hours comparison is EXACT**, which departs from what #1754 asked for. The
slot probe bucketed to the hour because the two systems carry different slot
intervals, durations and buffers, so demanding equal instants would have been red
from the day it shipped for reasons nobody should fix (L36). None of that applies
to a schedule: both sides store a weekday plus start and end minutes, so the
values compare directly, and hour bucketing would HIDE the commonest drift on
this roster rather than tolerate noise. Real windows sit on half and quarter
hours, and 09:00 against 09:30 opens the same hour.
`scripts/test-schedule-parity.ts` carries that as a control: patching the
comparison to bucket by the hour makes it fail.

**A difference that changes nothing a lead sees is ranked below every real
finding.** Two of them:

- A zone NAME that keeps the same clock. The first live sweep reported ten agents
  as `timezone-differs`, and every one was such a pair: nine `America/Denver`
  against `America/Boise`, one `America/New_York` against
  `America/Indiana/Indianapolis`. Sampled hourly over 400 days those differ on 0
  of 9,600 hours, while Denver against Phoenix differs on 5,711. One of the ten
  was hiding a genuine Saturday-for-Friday swap under the zone label.
- The nine admins, managers and team leads who host in cal.com and are correctly
  not bookable in Slate. Those rank LEVEL WITH AGREEMENT and cannot fail a run at
  all, because nothing will ever change them and a permanently red check is one
  nobody reads by the second week.

The second is an exemption, so it is NAMED (`DELIBERATELY_QUIET` in
`scripts/lib/calcom-parity-outcome.ts`) rather than achieved by leaving a verdict
out of a table (L129). It is enforced in the type as well as the list, so `tsc`
fails both a verdict that quietly has no exit code and an exemption for a verdict
nothing produces.

## Running it

```
pnpm verify:calcom-parity                                   # sweep the roster
PARITY_AGENT=someone@trypennie.com pnpm verify:calcom-parity  # one agent's hours
```

`CALCOM_API_KEY` is required, and so are the three Twilio variables that say who
cal.com withholds (`TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`,
`TWILIO_WORKSPACE_SID`, the same TaskRouter scoped key `verify:twilio-parity` uses).
The cal.com key is a wrangler secret on the deployment, so it has to
be in `.env.local` to run this. `CALCOM_ORG_ID` defaults to 19474,
`CALCOM_TEAM_ID` to 19546 (Loan Consultation), `CALCOM_EVENT_TYPE_ID` to 1314152
(the review event the landing pages use), and `CALCOM_PACE_MS` to 250. The pacing
is not cosmetic: cal.com meters the schedules endpoint hard and the first import
run met 429 on 89 of 103 agents without it. The retry ladder rides out a rate
limit on the server's own `Retry-After`, and is finite, because a read that
retries forever hangs the run (L110). `PARITY_AGENT` narrows the HOURS half only:
membership is a comparison of two whole rosters and means nothing scoped to one
person.

**Only agreement passes, and every other outcome exits on its own code.** Finding
nothing to compare is never a pass (L98), and the report says how many agents had
a week on BOTH sides, so "no differences" can never be read as "no problems" when
the real answer is that nothing was compared.

| exit | what it met |
|---|---|
| 0 | the two rosters agree and every agent holds the same week |
| 1 | no `CALCOM_API_KEY`, or no Twilio credentials, here; nothing was attempted |
| 2 | no bookable agents in Slate, or the named agent does not exist |
| 4 | cal.com did not answer (the org listing, or the team's event types) |
| 5 | cal.com answered with something unreadable |
| 6 | the event type is not on that team, or named no hosts at all |
| 7 | **Twilio could not be read**, so who cal.com withholds is unknown |
| 9 | a zone name differs and keeps the same clock |
| 10 | an agent bookable in Slate has no cal.com account |
| 11 | a cal.com account holds no schedule, or one with no windows set |
| 12 | **a bookable agent has no hours in Slate**, so they are offered nothing |
| 13 | cal.com would not answer for an agent (rate limit, or a refusal) |
| 14 | cal.com answered for an agent with a payload this cannot read |
| 15 | **hours differ** |
| 16 | **days differ** |
| 17 | **the timezone differs** |
| 21 | not bookable in Slate, hosts in cal.com, and no bucket's criteria can match them |
| 22 | a cal.com host with no Slate record at all |
| 23 | **bookable in Slate and not a cal.com host at all**, so Slate offers somebody the incumbent never routes to |
| 24 | **an agent Slate will not route who cal.com still can** |
| 25 | **somebody who has left Slate and can still be booked in cal.com** |
| 26 | **bookable in Slate while cal.com withholds them from every routed decision** |
| 27 | an hours, days or timezone difference on a week the AGENT set themselves, which the lane will not overwrite |

The ordering across the two halves lives in ONE table
(`OUTCOME_ORDER`), written out rather than folded together from the two halves'
own rank scales: the cross-family judgements are the interesting ones and should
be a decision somebody made, not an accident of two numbers picked months apart.
The sweep exits on its worst row, so one departed host among a hundred
agreements is the finding, and an agent wrong in two ways is named by the more
severe one while still carrying BOTH reasons.

**Being a host is not the same as being routable, and reading the host list alone was
wrong in both directions** (#2088). The event type's `hosts[]` says who CAN take a
booking; six of the seven live routing forms then carry `Redistribute Team (does not
equal) yes` on every route, so the pool cal.com actually routes to is narrower. Until
2026-09-08 that meant two agents Slate correctly held back were paged on daily (exit
24) while twelve agents Slate offers and cal.com never routes to read as agreement.
**The withheld set comes from Twilio** (#2153). cal.com will not report per-user
attribute values (`/organizations/{org}/users/{id}/attributes` answers 404 on both
API versions) and the routing forms give the condition without saying who satisfies
it, so the set was a hand-typed constant for two days, read out of the cal.com UI on
2026-09-08. Nothing maintained it, and by 2026-09-10 it was wrong in both directions:
Twilio tagged 22 people, 8 of whom it had never heard of, while 2 of its entries
carried no tag at all. The Pipedream job that reads those tags is what puts
`Redistribute Team = YES` on the cal.com member in the first place, so the command
reads the tags and needs `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` and
`TWILIO_WORKSPACE_SID` alongside the cal.com key. A Twilio read it cannot make is
**exit 7 and no comparison at all**: an empty withheld set turns every withheld agent
into agreement, which is the false agreement #2088 fixed. The run still says how many
withheld addresses cal.com no longer hosts, and that count now measures Twilio
against cal.com rather than a person's snapshot against cal.com.

Not `users.attributes.redistribute`, which is a different fact. That key is Slate's
record of whom IT took out of the bookable pool because of the tag, so an agent who
was already not bookable when the tag appeared is never marked: measured 2026-09-10
it covered 13 of the 22 tagged people, and using it would have reported the other 9
as routable.

**Exit 21 asks whether a bucket can match them, not whether they carry attributes**
(#2094). The looser question paged daily on an agent whose only attribute was
`{"role":"Sales"}`, which no bucket keys on. It is answered by calling the shipped
pool predicate over the live criteria (`matchableAgentIds`), and the run REFUSES with
exit 2 on a bucket list it could not read, because an empty one makes every agent look
unreachable and takes the whole roster half quiet.

The states where an agent cannot be compared each get their own code, on purpose:
"no cal.com account", "no schedule in cal.com", "the read failed" and "the payload
changed shape" send four different people to do four different things, and one
message answering for another is how somebody spends an afternoon on a rate limit
(L11).

An empty host list, or an event type that is not on the team, REFUSES the run
rather than reporting it. Either would otherwise turn every bookable Slate agent
into `bookable-not-hosting`: a hundred findings about one broken read.

## Where the code lives

Decision logic is pinned offline by `scripts/test-schedule-parity.ts`,
`scripts/test-roster-parity.ts`, `scripts/test-calcom-parity-outcome.ts` and
`scripts/test-calcom-roster.ts`, which drive every verdict, the retry ladder and
the default-schedule choice through hand written fixtures with no network and no
real clock. The reads it shares with `pnpm import:calcom-schedules` live in
`scripts/lib/calcom-roster.ts`, deliberately in one place: two copies of "who is
a bookable agent" drift, and the drift is silent in the worst direction, since
the command would then report agreement about a roster the importer never wrote
to.

## The daily lane CORRECTS the drift, it does not only report it (#2092)

`.github/workflows/schedule-parity.yml` runs `APPLY=1 pnpm import:calcom-schedules`
**before** it sweeps, so an hours, days or timezone difference is repaired by the
lane rather than paged to a person. Detection was automatic and repair was not,
and that gap cost something measurable: across three passes the roster went 97 out
of step, then 21 after five days, then 4 after one, because people actively edit
schedules in cal.com while it is still the system taking every real lead.

**The ordering is the change, not an implementation detail.** Applying first and
sweeping second means the message reports the state AFTER the repair, measured
independently by the sweep, rather than a subtraction computed from the writer's
own read-back. Sweeping first and applying second costs the same two cal.com
passes and leaves the report making a claim instead of taking a reading. It also
pages about drift that the apply has already fixed.

**What the lane will not write is the whole safety of it.**
`hoursOverwriteRefusal` (`scripts/lib/calcom-schedule-import.ts`) refuses any
schedule whose `availability_schedules.hours_source` is `agent`, and refuses a
source it does not recognise, so a writer added later defaults to leaving people's
hours alone. cal.com is the authority for these values ONLY while it is the system
people maintain, and an agent who has set their own week in Slate has stopped
being one of those people. That guard is also what retires this safely: once
agents set their own hours (#1454) every one of those rows is stamped `agent` by
construction and the import stops touching them, with nobody having to remember.

`admin`, `seed`, `calcom-import` and an UNSTAMPED row are all overwritable. Dan's
rule, 2026-09-10: "it just needs to not overwrite a changed hours. If I changed
them or another import changed them, that's fine." The unstamped case is not a
loophole, it is the roster: measured 2026-09-10, **79 of 90 bookable agents carry
no stamp at all**, because migration 0117 shipped six days after the import that
wrote them. Refusing those would leave the lane inert for 88 percent of the roster
while the daily page went on naming exactly the agents it would not fix (L662).

A difference the lane refuses to correct gets its OWN verdict,
`hours-set-by-agent`, classified `standing` so it is counted and named and never
pages. Without it, an agent who sets their own hours in Slate and differs from
cal.com would page every morning forever, which is how a check stops being read by
the second week (L36). It is produced by `reclassifyAgentOwnedHours`, deliberately
a separate step from `compareAgentSchedule`: the comparison answers "do the two
systems agree", which is a question about two weeks, and the reclassification
answers "is this ours to fix", which is a question about who wrote the Slate side.

**The alert says what the lane wrote**, and the remedy line depends on whether an
apply ran at all. `corrected` ABSENT means no apply happened (the step died, or
somebody swept by hand), so the message still names
`APPLY=1 pnpm import:calcom-schedules`. `corrected` present, including a zero,
means the import DID run, so naming that command would be a dead instruction
(L111) and the message says what is left needs a person instead. Those two are
kept apart on the wire, in `parseParitySweep`, and in the copy.

**This retires at cutover (#65)**, since it only means anything while both
systems are live. The hand-run command still finds what it finds on the day
somebody runs it; the scheduled lane is what makes it daily.

# Does Slate hold the same facts as cal.com's source? (`pnpm verify:twilio-parity`)

The sixth command in the family above, and the one that measures a divergence the
other five structurally cannot see (#2096).

**Slate and cal.com used to take the same routing facts from different systems, and
since #2152 they do not.** Slate read each agent's debt tiers and backend service
from Salesforce booleans (`LowDebt__c` and friends) while cal.com was fed the same
facts by a Pipedream job reading each **Twilio TaskRouter** worker's `teams` tags.
Nothing reconciled the two, so every agreement `verify:calcom-parity` reported rested
on somebody keeping them in step, and a divergence there looked like a Slate defect
while both syncs were working perfectly. Dan settled the seven agents they disagreed
about on 2026-09-09 (#2148) with a standing rule, "let's use twilio as the source of
truth", and #2152 put that rule in the sync instead of in a person's memory: the
hourly roster job reads the tags and writes `debt_team` and `backend_service` onto
`users.attributes` (`src/lib/twilio/sync.ts`). Salesforce keeps what Twilio does not
carry, which is the profile and manager of record (#2099).

**So this command agrees by construction about the facts Twilio owns**, and its
remaining job is roster MEMBERSHIP: a Twilio worker with no Slate row, a Slate row no
worker carries the address of, a duplicated worker, a tag nobody mapped. Those are
the states a shared source cannot make agree, and they are still worth a run.

The Twilio tag to attribute mapping is copied deliberately from the live Pipedream
workflow rather than invented (`TEAM_TO_DEBT_TIER` and `TEAM_TO_BACKEND` in
`src/lib/twilio/roster.ts`), so Slate stores what cal.com ACTUALLY receives. A tag
the mapping does not know is REPORTED rather than dropped, because a tier added in
Twilio would otherwise be invisible to the check written to notice drift, and
`scripts/test-routing-attribute-vocabulary.ts` holds the mapping against the routing
vocabulary in BOTH directions, so a tier no tag can produce (an agent who can never
hold it, and buckets that are permanently empty) fails the build.

**Three things the mirror does deliberately**, each measured against production
before it shipped on 2026-09-10, when 129 of 129 in scope rows had a Twilio worker
and two differed:

- A tag that has gone TAKES ITS VALUE WITH IT. A merge would leave an agent in a pool
  the source says they are not in, which is the failure the issue was opened about.
- A row Twilio holds NO worker for keeps its stored tiers and is written nothing at
  all. Silence about somebody is not a source saying their tiers are gone (L214),
  and emptying every pool an agent belongs to on a partial read is not recoverable.
  The count is reported as `withoutWorker`, because doing nothing is otherwise
  invisible.
- A FIRST debt tier makes somebody bookable, through the same activation gate the
  Salesforce half uses (#2071). The transition belongs to whoever writes the fact
  that causes it: a sync that wrote the tier and left the flip to the other half
  would detect nothing, because by the time that half read the row the tier would
  already be there, and "has a tier and is not bookable" is the shape of somebody an
  admin deliberately held back (L60). A refused activation keeps its pending mark and
  the Salesforce half retries it, so one intent has one owner.

**`Redistribute` is why it was written.** That tag means an agent should not be taking
booked calls at all (Dan, 2026-09-08), and it exists ONLY in Twilio: the Salesforce
User object carries 14 custom fields and none is this one, and cal.com will not report
per-user attribute values (`/organizations/{org}/users/{id}/attributes` answers 404 on
both API versions). So Twilio is the only place Slate can read it, and until this
command there was no way to see it from inside Slate at all.

**It writes nothing**: no Slate row, no Twilio worker, no cal.com attribute, no alert.
It is deliberately not named `test-*.ts`, because that glob is the offline unit suite
and this needs live Twilio plus the Supabase secret key from `.env.local`.

```
pnpm verify:twilio-parity
```

Needs `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` and `TWILIO_WORKSPACE_SID` in
`.env.local`. The key must be TaskRouter scoped; it is used as basic auth exactly as
the Pipedream job does.

**Only agreement passes, and it says how many addresses it compared**, because zero is
the shape of a broken read and never a healthy roster (L98). Every other outcome exits
on its own code, worst first.

| exit | what it met |
|---|---|
| 0 | Slate and Twilio agree on every address compared |
| 1 | no Twilio credentials here; nothing was attempted |
| 2 | no workers, no Slate users, or nothing with facts on both sides |
| 3 | Twilio did not answer, or refused the credentials |
| 4 | Twilio answered with something unreadable |
| 11 | in Slate and no Twilio worker carries their address, so cal.com is fed nothing for them |
| 12 | two or more Twilio workers share one address, and their tags were unioned to compare |
| 13 | a Twilio tag this mapping does not know |
| 14 | a Twilio worker with no Slate record at all |
| 16 | **the backend service differs** |
| 17 | **the debt tiers differ** |
| 18 | **carries Redistribute in Twilio and is still bookable in Slate** |
| 20 | **manager of record differs** |
| 21 | the team tag names somebody Slate has no user for |
| 22 | Twilio names a manager and Slate has nobody linked |
| 23 | Slate names a manager and the worker carries no team tag |
| 24 | one worker carries two or more team tags |

Exit 18 is ranked worst because it is the only finding here that misroutes a lead the
day it appears rather than being latent. The two Twilio configuration faults (12 and
13) rank BELOW every difference about a person on purpose, so a duplicated worker
cannot bury a real disagreement. The exit codes name the outcome and the ranking
decides which one names a run; they are two different questions, which is why the
numbers and the order do not match.

**Manager of record is compared, never moved (#2099).** Twilio carries manager
assignment as a `Team <Manager Name>` tag and Slate takes it from Salesforce's
`Agent_Manager__c`, which stays the recorded owner: the OOO approver chain is built
on it, and this notices a divergence rather than resolving one. Names are matched on
case and surrounding space. The five outcomes are separate because they send five
different people to do five different things, and the four about a person rank BELOW
every difference about what somebody can be routed for, since a wrong approver sends
a time off request astray and does not misroute a lead.

Two silences are agreement rather than findings. A worker carrying no team tag for
somebody Slate has no manager for is quiet, which is what keeps this off the twenty
workers who legitimately carry none: sixteen are managers and admins with no manager
of their own. And exit 21 fires only when the roster was actually supplied to check
against, because an unrecognised name is only unrecognised once somebody has looked.
The known-name set deliberately includes departed users, since a tag naming somebody
who left explains itself and is not a typo to hunt for.

Measured live 2026-09-09, with every other fact forced to agree so the manager half
is not masked by a higher ranked verdict: 128 agree and one finding, jlodato@, whose
Slate manager is Brad Lawrence and whose Twilio worker carries no team tag.

**Legal eligibility was retired outright (#2218).** Slate mirrored the `Legal
Eligible` and `Not Legal Eligible` tags onto `users.attributes` and compared them
here, on two exit codes. Dan retired the attribute on 2026-09-10: the ten bucket
criteria keyed on it matched zero bookable agents, so nothing routed on it and
nothing stores it now. The TAGS still exist in Twilio and still reach cal.com
through the Pipedream job; they are simply not Slate's business, and they arrive
here as ordinary unmapped tags.

A departed Slate agent ranks level with agreement and can never name a run: their
Twilio tags are not a disagreement about somebody taking calls.

Decision logic is pinned offline by `scripts/test-twilio-parity.ts`, which drives
every verdict, the tag mapping, the duplicate union and the ranking through hand
written fixtures with no network. Its control that matters: exit 18 must NOT fire once
Slate has the agent not bookable, or the check would report the fix as the fault.

**This does NOT retire at cutover**, unlike the rest of the family. Twilio stays the
place managers tag agents after cal.com is off, so this comparison becomes the way
Slate learns about `Redistribute` rather than a parallel-run check.

# Replaying real leads through Slate's ladder (`pnpm verify:router-replay`)

The seventh command in the family above, and the only measurement of Slate's
ROUTING that exists before cutover (#2240).

cal.com has taken every real lead for months. Slate has routed nothing, so there
is no traffic of its own to judge it by. But every cal.com routing form response
records both the code the lead carried and the agent cal.com chose, so the same
lead can be put to Slate and the two answers compared. That is what this does:
about 25,000 routed leads over 30 days, replayed through `resolveRequestedCode`,
`tierLadder` and the booker's own pool predicate.

**It is not a correctness check.** cal.com is the incumbent, not the source of
truth, and a lead both systems would send to the same person can be wrong in both.

## Three things it reports separately, because they are three different findings

**LADDER agreement** is the question only this command asks: given a host Slate
would route to, does Slate's ladder place them in the pool the lead asked for?
Measured live 2026-09-11: **100 percent of 119 leads in the primary window and 100
percent of 149 in the secondary**, one of which needed a rung dropped.

**The chance baseline** sits beside every rate, and without it the first number
means nothing. With the legal digit retired (#2218) the big pools hold most of the
roster: the measured baseline is **54 to 58 percent**, so a coin flip agrees more
than half the time and only the distance above it is evidence.

**ROSTER differences** are counted and reported and **cannot fail a run**. These
are leads cal.com routed to somebody Slate will not: 30 of 150 sampled in the
primary window, every one `host-not-bookable`, and **zero** in the 30 days before
it, which says the divergence is recent. `pnpm verify:calcom-parity` owns that
question and pages on it under exits 23 to 26, and a second command failing daily
on the same finding is how both stop being read (L36). What they must never do is
hide inside the agreement rate: folding them in put the first live headline at
89.6 percent, which reads as Slate routing leads differently when not one lead
disagreed about the ladder.

## What agrees by construction, and the report says so at the top

Since #2152 Slate's debt tiers and backend service come from the same Twilio tags
the Pipedream job feeds cal.com, so the ATTRIBUTES both systems route on are ONE
source. What is actually under test is everything downstream: the code resolution,
the tier ladder with its Beyond overflow, and the pool predicate. A reader told
only the agreement rate would take it as evidence about the half that was never in
doubt.

The attributes and pools are also TODAY'S while the leads are historical, which is
why the primary window starts on **2026-09-10**, the day the attribute source
became shared. The secondary window is the 30 days BEFORE that, never the 30 days
including it: two overlapping windows cannot be compared, because the second is
mostly the first.

## Three things the live runs changed, each caught by running it

- **The cap must be invisible to every rate.** A run is capped
  (`REPLAY_MAX_FETCH`, default 2,000) against a window of 25,000 leads, so most
  leads are never asked about. Folding those into the resolution rate made it a
  measurement of the cap: the first run reported "only 10.5 percent of leads had a
  readable host" when the truth was that 150 had been asked about and 139 agreed
  (L209). An unsampled lead now moves nothing and is counted out loud.
- **The sample must not be ordered by the reads.** Taking the head of a per form
  list put every resolved host in one form, so the by form table showed two forms
  with zero agreements rather than two forms nobody had asked about. Leads are
  sorted newest first across every form before the cap.
- **The budget is SPLIT between the two windows.** Newest first across 30 days
  spends every read inside the primary window, and the secondary was reported with
  exactly the primary's numbers: a copy wearing a second heading. Half the budget
  goes to leads older than the primary start, and a half with nothing left to ask
  about hands its remainder to the other.

## Running it

```
pnpm verify:router-replay
```

`CALCOM_API_KEY` is required (a wrangler secret on the deployment, so it has to be
in `.env.local`), plus the Supabase secret key. `CALCOM_ORG_ID` defaults to 19474,
`REPLAY_MAX_FETCH` to 2,000, `REPLAY_SINCE` to 2026-09-10, `REPLAY_CACHE` to a file
under `$TMPDIR`.

**`REPLAY_PACE_MS` defaults to 550 and the number was MEASURED**, not guessed:
cal.com answers `x-ratelimit-limit-default: 120` on a 60 second reset, so the
sustainable rate is two reads a second. At 100ms the responses listing met a 429
the retry ladder could not ride out, on the fourth of eight forms, and the run
correctly refused rather than reporting rates about whichever forms happened to
answer. Budget roughly ten minutes per thousand bookings, and run the first pull
outside business hours: the key is shared with the OOO dual-write.

A booking is cached under `$TMPDIR` and re-read when its start is still in the
future (it can move or be cancelled) or when the entry is more than two days old.
The cache holds host emails, times and status and **never the attendee**: the
lead's own details have no business in a file on a laptop.

**Only agreement passes, and every other outcome exits on its own code.** Finding
nothing to judge is never a pass (L98).

| exit | what it met |
|---|---|
| 0 | Slate's ladder places the leads cal.com routed |
| 1 | no `CALCOM_API_KEY` or no Supabase credentials here; nothing was attempted |
| 2 | no routed leads, no bookable agents, no buckets, or nothing judged |
| 3 | a Slate read failed, so the pools to compare against are not known |
| 4 | cal.com would not answer for the forms or their responses (a 429 here means the pacing is too fast) |
| 5 | too few of the leads it ASKED about had a readable host |
| 6 | too many leads fell to the catch-all, which is what a broken code lookup looks like |
| 7 | **the ladder disagrees** |
| 8 | not ONE booking could be read, which is a broken read rather than a thin sample |

Exit 6 is a ceiling rather than a curiosity: catch-all leads are excluded from the
agreement denominator, so a bug that pushed every lead into it would leave a tiny,
flattering sample behind and RAISE the headline. Exit 8 is kept apart from exit 5
because a wrong API version answers exactly like it for every uid, and calling that
"too few hosts resolved" sends somebody to look at the data.

Decision logic is pinned offline by `scripts/test-router-replay.ts`, which drives
every class, both rates and the whole exit table through hand written fixtures with
no network and no clock.

## It runs WEEKLY, and the cache is what makes that worth more than one run (#2263)

`.github/workflows/router-replay.yml` runs it every Monday at 13:20 UTC, an hour
after the parity sweep so the two cal.com consumers never pace against each other
on one key. Weekly rather than daily because a pass is roughly ten minutes per
thousand bookings on a key shared with the OOO dual write, and this retires at
cutover.

**The booking cache is persisted through `actions/cache`, and that is the half
that makes a schedule mean something.** A capped run reaches at most
`REPLAY_MAX_FETCH` bookings against roughly 25,000 routed leads, and the cache
accumulates backwards across runs, so repeated runs are what eventually cover the
window. A runner's `$TMPDIR` is gone when the job ends, so without it every
scheduled run would re-read the same newest leads and look identical every week
while covering no more of the window. The key carries the run id and
`restore-keys` picks up the newest previous entry; a fixed key would be written
once and then frozen at whatever the first run happened to read. The cache holds
host emails, times and status and never the attendee, by the command own design.

**It speaks from the runner**, which is a deliberate difference from
`schedule-parity`. That one is daily, so a finding that sits needs a cooldown and
an all clear, and both need a memory a runner has none of. At weekly cadence on
something that retires at cutover the condition machinery costs more than it buys:
one message a week at most, and only when there is something to say. Agreement
says nothing at all, because a weekly all-is-well is how the messages that matter
stop being read (L36).

**The heartbeat is stamped only on a USABLE verdict.** `agree` and `disagreement`
stamp `router-replay`; `nothing-judged`, `resolution-too-low` and
`catchall-too-high` are each a run that LOOKED and could not conclude, so they
report and leave the heartbeat to go stale against its 9 day bound. A blind
detector keeping its heartbeat fresh is exactly the state #1394 exists to notice.
The three states are told apart by the SUMMARY FILE the command writes when it
decides, so an absent file is evidence that the run died before deciding rather
than an inference from an exit code (L98). The decision lives in
`scripts/lib/router-replay-report.ts` and is pinned offline by
`scripts/test-router-replay-report.ts`.

**This retires at cutover (#65)** with the rest of the family: once Slate routes
the leads there is no second system to replay them through.

# Proving the booking kill switch really refuses (`pnpm verify:kill-switch`)

The eighth command in the family above, and the one whose subject fails CLOSED (#2365).

#2297 shipped the public booking kill switch and nothing had ever thrown it in
production. Every path was covered by tests and the setting was confirmed present in
the live database, but the PAUSED state had never once run against the deployed
Worker. That matters more here than it would for most features: this gate refuses the
booking when it cannot READ its own flag, so the fault nobody would see coming is the
one where it refuses EVERYTHING, and the only signal would be the booking failure rate
window firing under `booking_pause_unreadable` after real leads had been turned away.

**It creates no booking.** The gate sits ahead of body parsing, so a deliberately
malformed body answers 400 while open and 503 while paused, and the difference between
those two IS the gate. Nothing reaches the booking path in either half.

**Both directions or it proves nothing** (L1): a route hard wired to 503 satisfies a
check that only pauses, and one hard wired to 400 satisfies a check that only looks
while open. The 503 is then separated by the COPY it carried, compared against the
shipped `BOOKING_ERROR_COPY` builder rather than a pattern written in the command
(L41), because `booking_paused` and `booking_pause_unreadable` are both lead facing
sentences on the same status and one answering for the other would report the fault
this was opened about as a working switch (L11).

**It also asserts what the switch leaves ALONE**, which is half its design:
availability keeps answering while bookings are paused. Compared open against paused
rather than demanded to be non zero, because before cutover a real bucket legitimately
offers no times (#1272) and a check that demanded them would be red from the day it
shipped (L36).

**What it writes** is one column, twice: `booking_settings.public_booking_paused` on,
then off. The restore is in a `finally` and is tried twice, and a run that could not
restore exits non-zero and shouts, because what it leaves behind is PUBLIC BOOKING
STOPPED (L514, L515). It REFUSES to start at all when bookings are already paused:
finishing would turn them back on for somebody who stopped them on purpose.

```
pnpm verify:kill-switch
```

Needs the Supabase secret key from `.env.local` to flip the flag. `SLATE_BASE_URL`
picks the deployment (default prod) and `KILL_SWITCH_BUCKET` the bucket whose
availability is read (default `111`). **Not a test bucket**: SMOKE and SMOKE2 are
invisible without a bearer token (#396, #601), so an unauthenticated read of one 404s
in both halves and the run learns nothing about the half it is there to check. The
first live run did exactly that and reported the switch as having closed availability,
which was the command accusing its subject of a fault its own read had caused.

| exit | what it met |
|---|---|
| 0 | the switch refuses while on, takes the request while off, and leaves availability alone |
| 1 | no Supabase credentials, no settings row, or bookings already paused; nothing was attempted |
| 2 | **the flag is STILL ON**: public booking is stopped and a person must clear it |
| 3 | the switch was on and the booker took the request anyway |
| 4 | **the booker refused while the flag was OFF**, so it is turning leads away by itself |
| 5 | it refused with the copy it uses when it cannot READ its flag: the fail closed fault |
| 6 | availability stopped serving while paused, which the switch must not touch |
| 7 | no reply at all |
| 8 | the rate limiter answered first, so the gate was never reached; run it again |
| 9 | the booking route failed while the switch was off |
| 10 | this deployment has no public booking route |
| 11 | something this command cannot read answered |
| 12 | availability could not be read in EITHER half, so that half is unmeasured |

Exit 2 outranks every other finding, because it is the only one that goes on turning
real leads away after the command exits: a reader sent to investigate "the switch does
not refuse" while bookings are silently off has been sent to the wrong problem. Exit 12
is kept apart from exit 6 for the reason the first live run showed.

**Measured live 2026-09-16 against prod: PASSED.** A request reached the booker while
the flag was off, the same request was refused with the paused copy while it was on,
availability offered 319 times throughout, and the flag was confirmed back off by a
direct database read rather than by the command's own.

Decision logic is pinned offline by `scripts/test-kill-switch-live-control.ts`, which
drives every verdict, the ordering and the whole exit table through hand written
replies with no network and no database.

# Is the shadow run trustworthy today? (`pnpm verify:parallel-run-readiness`)

The fifth command in the family above, and the one to run right before the pilot
bookings (#2066). On 2026-09-07 answering "is the parallel run trustworthy today"
took a database query plus reading eight issues, because each precondition is
measured somewhere in Slate and nowhere together. This reads production, writes
nothing, and judges five things through the code that already owns each of them
(L107): no alert cooldown stretched above its default, the daily cal.com comparison
fresh and not reporting drift, nobody waiting to become bookable behind a refused
activation, every bookable agent's calendar present and hydrated to the booking
horizon (the hydration monitor's own judge), and no real bucket empty (the empty
bucket alarm's own eligibility predicate).

```
pnpm verify:parallel-run-readiness
```

**Only READY passes, and it says how many agents and buckets it measured**, because
zero of either is the shape of a broken read and never a healthy morning (L98). Every
other outcome exits on its own code, worst first, and lists every finding rather
than only the worst, so a reader is not sent to fix a cooldown while three buckets
have nobody in them. The judgement lives in `scripts/lib/parallel-run-readiness.ts`
and is pinned offline by `scripts/test-parallel-run-readiness.ts`.

| exit | what it met |
|---|---|
| 0 | READY |
| 1 | no Supabase credentials here; nothing was read |
| 2 | a section could not be read, so nothing beneath it is vouched for |
| 3 | zero bookable agents or zero real buckets: nothing was judged |
| 4 | **a real bucket has nobody to route to** |
| 5 | **a bookable agent has no calendar row**, so they read as free all day |
| 6 | a calendar is not hydrated to the booking horizon |
| 7 | an alert cooldown is stretched above its default |
| 8 | the cal.com comparison is reporting drift |
| 9 | the cal.com comparison has not reached a verdict inside its 30 hour bound |
| 10 | somebody is waiting to become bookable behind a refused activation |

A deliberately dropped check, so nobody adds it back by accident: a bookable agent
sitting on the seeded default week is NOT reported. The seeded week is also a real
week some agents genuinely keep, so the proxy would be a standing false finding;
telling the two apart needs the stamp #1753 asks for, and belongs there.

**It retires at cutover (#65)** with the rest of the family.

# Do the codes sharing one pool offer the same times? (`pnpm verify:pool-slot-parity`)

The rule this proves lives in AGENTS.md under "One availability compute per POOL,
not per bucket code", which is where a reader meets `PoolInput` and the recompute
lane. This is the command itself.
**`pnpm verify:pool-slot-parity`** is the proof, and it asks a question that
holds at any instant: do the codes that share a pool offer the same times? A
before and after diff of one code's slots cannot work, because the booking window
walks with the clock and nobody could tell that from a regression. It reads
production and the deployed app and writes nothing. Measured BEFORE this shipped:
59 of 60 codes across all 15 pools agreed (one code met the endpoint's 30 a
minute throttle). It paces itself to that throttle, sampling each pool's codes
together so the window cannot move between two codes about to be compared, so a
full sweep takes a few minutes. Exit codes are in
`scripts/lib/pool-slot-parity.ts`, pinned offline by
`scripts/test-pool-slot-parity.ts`; comparing nothing exits non-zero, never as a
pass (L98).


# Does production hold a table no migration created? (`pnpm verify:table-drift`)

Every table guard in this repo enumerates from the MIGRATION FILES: the RLS scan, the
grants scan (#2271), `applied-content.lock`. A table that exists only in the database is
exempt from all of them by construction, and invisibly, because a scan that never reached
it and a scan that found nothing wrong produce the same empty result (L96, L456, L98).
#2271's blanket `grant ... on all tables in schema public` reaches such a table while
nothing says whether its RLS is right.

`pnpm verify:table-drift` compares the two sides. It reads production and writes nothing.
The live list comes from PostgREST's own root document, so it needs no function added to
the database to ask a question about the database, and the declared list goes through the
repo's own `parseDeclaredTables`, so the two sides cannot disagree about what declared
means. Measured 2026-09-17: 41 live, 40 declared, one difference.

That one is `availability_rules_backup_1255`, the snapshot the roster hours backfill took
before rewriting every agent's week. It is RECORDED in `KNOWN_UNDECLARED_TABLES`
(`scripts/lib/table-drift.ts`) with a reason and the issue that removes it, rather than
excused by a filter: an entry whose table has since gone is reported as dead config, so a
record cannot outlive what it covers. Dropping a safety copy is somebody's decision, which
is why the command records it rather than acting.

Exits: 0 agreement, 1 no credentials, 2 nothing read (an empty list on either side is a
read or a parse that did not work, never a database or a repo with no tables), 3 the live
read failed, 4 a table nothing declared and nothing records, 5 a table the migrations
declare and production does not have, 6 a record covering a table that is gone. It exits on
its worst finding and reports every one, so a departed table cannot hide an undeclared one.
Decision logic is pinned offline by `scripts/test-table-drift.ts`.

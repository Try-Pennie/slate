# The verify commands

The hand run `pnpm verify:*` commands, in full: what each one proves, how to run
it, what every exit code means, what it writes, and what its last live run
measured.

The four rules the whole family rests on are in this file's own section, "The
rules the whole family rests on, in full", below: read that first. `AGENTS.md`
keeps a short form of them and the one line table of commands, under "The `pnpm
verify:*` commands: proving a fail safe detector is not blind". The runbook lives
here rather than in `AGENTS.md` because `AGENTS.md` is loaded into every session
and every character of it is paid on every request (#2393), while an exit code
table is needed on the day somebody runs the command.

Nothing here has been rewritten. Each section is the text that stood in
`AGENTS.md`, moved whole so the recorded decisions and the evidence behind them
stay where they can be found.

A sibling hand run command that reports rather than verifies,
`pnpm report:pilot-split` (Slate against cal.com booking rate across trypennie's
per lead split, #2898), has its runbook in `docs/pilot-split-report.md`, and
`pnpm report:pilot-compare` (the same question from Salesforce, Slate, cal.com and
the Regal call store, with show rate, #2946) has its in `docs/pilot-compare-report.md`.

## The rules the whole family rests on, in full

Moved out of `AGENTS.md` on 2026-10-15, where every character was loaded into
every session (#2393). `AGENTS.md` keeps the rules and the command table, and
points here; this is the full text as it stood, with the reasoning, the
incidents and the measurements behind it.

The hand run `verify:` commands all exist because of one shape. A detector built
to fail safe reports `unverified`, `skipped` or `insufficient` rather than
guessing, and a detector that has NEVER ONCE CONCLUDED renders exactly like one
finding nothing wrong: "nothing to report" and "could not check anything" are the
same silence, in a dashboard and in a heartbeat alike. #1377 is the measured
case. The availability truth probe skipped every tick from the day it deployed
because the roster was dark before cutover, the lane heartbeat went on proving
the lane RAN, and its live half had never executed once.

Four rules hold across all of them, and they are the part worth carrying into a
session:

- **Ask the outside system, never Slate's own record.** What Slate stores about a
  busy block, an approved time off or an agent's routing facts was written by the
  very code under test, so a check built on it agrees with the defect (L58).
  These read Google, cal.com, Twilio or the deployed Worker.
- **Only agreement passes, and finding nothing to check is never a pass** (L98).
  Every other outcome exits on its OWN code, because "no cal.com account", "no
  schedule in cal.com", "the read failed" and "the payload changed shape" send
  four different people to do four different things, and one message answering
  for another is how somebody spends an afternoon on a rate limit (L11).
- **A fake cannot stand in for the live system** (L52), which is why these are
  commands and not suites. They are deliberately NOT named `test-*.ts`: that glob
  is the offline unit suite, and these need live credentials from `.env.local`.
- **Their decision logic is pinned offline anyway.** Each one's verdicts, exit
  codes and ranking are driven through hand written fixtures by a
  `scripts/test-*.ts` sibling, so the rules are tested where no network exists
  and a live run is spent only on the thing a fixture cannot answer.

The blindness is not confined to these commands. Any fail safe check can sit permanently
blind while looking healthy, so several carry a SECOND heartbeat stamp on top of
the lane's, written only when they reach a MEASURED verdict
(`src/lib/monitor/verdict-freshness.ts`), judged with `neverIsStale` ON because
"has never once reached a verdict" is the exact state this family exists to
notice (#1394). Nothing else may stamp, and `checked` alone is not enough: a
sample too small to judge also reports `checked`. Which detectors stamp, and each
one's bound, are listed below.

**The detail for every one of them, each exit code table, what it writes, which
credentials it needs, what its last live run measured and the decisions behind
it, is in the sections below.** Read a command's section before running it, rather
than reasoning the flags out per command. Most of the family retires at cutover (#65),
since it only means anything while both systems are live; `verify:twilio-parity`
does not, because Twilio stays the place managers tag agents afterwards.

Two hand run REPORTS follow the same rules: `report:pilot-split` (GA4, per
visitor, `docs/pilot-split-report.md`) and `report:pilot-compare` (#2946, Slate
against cal.com booking and show rate on every tier from each system's own
records, intention to treat by hash side, `docs/pilot-compare-report.md`). The
second prints on every run that the 50 split is ASSUMED, not checked (Salesforce
keeps no history of the SlatePilot fields), and exits 0 only for the readout
on a date fixed in `scripts/lib/pilot-compare.ts`.

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
traffic fed checks (which are properly silent over the closed part of a weekend
and a holiday). A blind detector re-pages daily rather than hourly, since before
cutover it can legitimately stay blind for days.

A flat bound long enough to clear a weekend cannot see ONE open day without a
verdict, so the low volume alarm is also judged in OPEN business minutes on the
monitor lane (`src/lib/monitor/volume-verdict-gap.ts`, #2049): an hour of open
time with no verdict pages `low_volume_verdict_gap`, and the next verdict clears
it. #2049 itself was a misread weekday (the stamp it quoted was a Saturday), but
nothing would have said so had the gap been real.

The family has grown since those three, and the list of lanes and bounds is
`VERDICT_STALE_BOUNDS_MS` in `src/lib/monitor/health.ts` rather than this
paragraph. The newest is `verdict:below-lead-tier` (#2593), the check holding
each upcoming booking's pool tier against the lead's current Salesforce
`XBC__c`. It stamps only when it COMPARED at least one booking. It shipped
parked in `PARKED_VERDICT_DETECTORS` because on 2026-09-24 no real lead had an
upcoming booking in Slate, and was armed on 2026-09-30 (#2696) once the Low pilot
put real bookings in view.

`verdict:roster-coverage` (#1941) watches the roster coverage alarm (#1454). It
stamps on a gap list AND on an empty one, since a fully covered week is a
finding, and never on an unreadable roster, a gate skip or a missing week. Its
bound is six hours: it concludes on every monitor tick the week and roster are
readable, so the bound is a maintenance window over a failed read, the same
arithmetic as `verdict:ooo-protection` and `verdict:tier-staffing`.

Five more joined in #2798, one for each gated check the #1941 registry found
answering a failed read with a status of its own that paged nothing:
`verdict:availability-scan`, `verdict:calendar-window`, `verdict:offsite-origin`,
`verdict:awaiting-activation` and `verdict:regal-call-feed`. The last is shared
by the two Regal feed checks, which read one RPC on one tick, and is stamped only
when BOTH concluded. The availability scan stamps when it verified at least one
dead end or saw every bucket with none, never when every recompute came back null.
Each bound is six hours, the same maintenance window as roster coverage, because
each concludes on every tick its read works.

`verdict:busy-drift` (#1591) joined when the busy drift sampler was armed, report
only. It stamps on every tick that read both the live calendar and the cache for at
least one agent, drift or not, and never on an unreadable side or a sample where
every calendar errored. Its bound is six hours for the same reason as the five above.

`verdict:offered-nobody-free` (#3381) watches the served versus confirm check. It
stamps on every tick that judged at least one served time with the confirm's candidate
read, found free or not, and never on an unreadable pool list or marker set or a tick
whose every read failed. Six hours, like the tier staffing alarm.

`verdict:buffer-breach` (#3040) watches the check for two upcoming calls on one
advisor closer than the call type's buffers. It stamps on every tick that judged at
least one upcoming booking with an assigned advisor, breach or not, and never on a read
that returned none or only unassigned bookings, a skipped gate or a thrown read. Six
hours, like the two above.

`verdict:regal-call-outcomes` (#2944) watches the call outcome ratio: outcome rows
written to `regal_call_outcomes` against completed calls received, over two hours.
It stamps on a judged ratio (healthy or short) and never on a window with no calls
or too few to judge, so like `verdict:regal-calls` it is traffic fed and its bound
is four days, the longest legitimate silence being a weekend.

**A new gated check cannot join the monitor lane unwatched** (#1941).
`GATED_CHECK_VERDICT_COVERAGE` in `verdict-freshness.ts` is keyed on the checks
`monitorSetupGates` returns, so `tsc` names a new gate with no entry, and
`scripts/test-detector-verdict-registry.ts` enumerates the same keys at runtime.
Each entry is a lane (with a bound), a reasoned `exempt`, or a `pending` lane
naming the issue that adds it. The six that swallowed a failed read into a status
that paged nothing were given their lanes by #2798 (the list above), so none is
pending today. Checks that are NOT
gated, and detectors off the monitor lane, are outside that enumeration.

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

**Since #3416 the same object also holds the booking API's hourly ceilings**, sent
one hit per rule on EVERY booking API request rather than only past an escalation
threshold (`docs/cloudflare-platform-notes.md` has the why). Two consequences. An
object that is bound and not answering no longer waits for a hot caller to be
noticed: every booking API request, the smoke canary's included, fails open on it,
and five of them on one server inside ten minutes page `rate_limit_broken:bookapi:h`
(one alone is only a log line, #3670). But this command reports the burst
tracker's kind of request, not a hit, so what it proves live is that the object
answers and counts BURST reports; the hit's own arithmetic, and the object's
handling of it, are pinned offline by `scripts/test-exact-ceiling.ts`, which drives
the real `BurstLimiter` class around a fake storage.

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

# Proving the booking refusal alerts can build and send (`pnpm verify:refusal-alerts`)

`booking_api_ceiling`, `booking_api_credential` and `booking_api_list_read` (#1442,
#1450, #1709) ship ARMED, and so do the embed booker's `booking_embed_ip_cap`,
`booking_embed_contact_cap` and `booking_embed_honeypot` (#1727). Their floors are what
make arming safe, and the cost is that nothing has refused often enough to reach one:
the path from a recorded refusal to a built page has never run against the real store,
so the first firing would be during a real incident (L535, #1726).

**What it does.** It writes refusals into the daily tally (`bump_booking_api_outcome`,
through the same `outcomeTallyArgs` the routes use) under a MONITOR ONLY bucket,
`PROBE_BUCKET` in `scripts/lib/refusal-alert-live-control.ts`. That code is longer than
any bucket code a request may carry (`INPUT_LIMITS.code`) and than the raw body code the
booker records (cut to sixteen), so no request can produce it, and every row is marked
as test traffic, which every monitor's read leaves out. It reads the probe's row back
after a zero interval and after each of three intervals of writes, checks that
`booking_api_outcome_mix` carries every name through, reads the limiter's locked out
counts (a head count of `rate_limits`, no key read), and folds the readings through the
real failure rate window (`advanceWindow`) and the real judges with the SHIPPED
thresholds. Each API alert and the honeypot must move from a measured clear to paging
and build a sendable message; the two embed caps, which page on the limiter's own rows,
must be judged against the live count (driving them to paging would mean writing the
rows real leads are judged by). It deletes the probe's rows when it ends, on every
ending after the first write.

**What it does not do.** It posts nothing to Slack: the message is built and checked,
because sending would page the alerts channel about a verification and the transport is
the one every other alert uses daily. The interval clock is labelled, not waited for:
the window measures the delta between two readings, and the labels only count
intervals. It does not exercise the Worker's own cron tick, which runs the same judges
on the same rows.

**Run it** from the main checkout (it needs `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SECRET_KEY` from `.env.local`). It has not yet been run live: its first run
waits for Dan. Its decisions are pinned offline by
`scripts/test-refusal-alert-live-control.ts`.

| exit | what it met | what to do |
|---|---|---|
| 0 | every alert moved from clear to paging (or was judged against the live limiter) and built its message | nothing |
| 2 | no Supabase URL or secret here | run from the main checkout; nothing was attempted |
| 3 | the tally write was refused | read the error; the routes' recording would be refused the same way |
| 4 | the probe's row or the mix could not be read | read the error; the monitor's read would fail too |
| 5 | the row did not rise by exactly what was written | the write and the read disagree, or another run is writing beside this one |
| 6 | the mix RPC dropped a refusal name | **the window can never see that refusal**: compare the RPC with migration 0143 |
| 7 | a verdict did not move from a measured clear to paging | the judge or a threshold changed; read `api-refusal-signals.ts` |
| 8 | a paging verdict built no sendable message | a copy builder leaks a value; run `pnpm preview:alerts` |
| 9 | the limiter's locked out count could not be read | the embed caps would go unmeasured on every tick |
| 10 | everything passed and the probe's rows were left behind | harmless test rows; they move only the outcome panel's excluded test count |

# Proving the shared confirm line answers (`pnpm verify:confirm-line`)

The burst counter's shape, on the shared confirm line (#3325, #3340).

The confirm path falls back to its isolate's own line whenever the shared one
cannot be used, deliberately: correctness never rests on the line, the bookings
indexes decide. The cost is that a `CONFIRM_LINE` object which is **bound and does
not answer reads as healthy everywhere**. Every confirm quietly uses its own
isolate's line, and nothing says so until a crowd for one slot arrives, each
isolate forms its own line again, and the database saturates, which is load run
37333201026, the run the shared line was built after. Between load runs nothing
asked the object anything (L557), and a fake cannot stand in for it (L52).

**`pnpm verify:confirm-line` is the proof.** It calls `POST /api/smoke/confirm-line`,
which runs the probe (`src/lib/monitor/confirm-line-probe.ts`) inside the deployment
with the confirm path's OWN client (`makeSharedConfirmLine`) and its own transport
(`durableLineNamespace`), against the real object. Nine checks, each in both
directions and each on its own named outcome:

- **full**: B, queued behind A, is REFUSED as taken once A reports a full verdict,
  and receives A's settlement intact.
- **notFull**: B LEADS once A reports a not full verdict, within the report's own
  two calls (the client retries it once) of the report LEAVING A, so a hand on by the
  verdict is told apart from a lease running out. It is timed from the send, never from
  the report call's return, which a retry can delay past the lease.
- **abandoned**: A takes the lead and never acknowledges it (every call its client
  makes after the enter is lost), and B leads within the acknowledgement window
  rather than after the whole lease.
- **handedStart** (#3823): the ladder line of #3489. B, queued behind A, is RELEASED
  the moment A claims one of two advisors on a rung (naming its place), holding the
  other advisor and A's whole read of the rung. An object older than the ladder line
  hands it nothing (exit 26); one that hands it A's advisor puts two confirms on one
  person (exit 27).
- **heldVerdict** (#3823, #3489 step 3): B reports the ladder full while A's claim is
  still in flight, so the line must HOLD that verdict for C, waiting behind, for the
  report's own two calls (exit 28 when C is answered either way meanwhile), and apply it
  the moment A's claim ends booked, refusing C with the settlement A's end read rather
  than B's (exit 29).
- **claimOutcome** (#3823, #3489): A reports its claim found busy and B reports its own
  untried, and the next confirm must be handed B's advisor back and never A's (exits 30
  and 31). A reports busy without first saying `trying`, so the reported outcome is the
  only thing that can take its advisor off the line.
- **nothingHeld**: afterwards a newcomer on each instant the probe used leads at
  once, so leaving nothing held is measured rather than assumed. On an instant a full
  verdict settled (full's and heldVerdict's) the line may still remember it (#3570) and
  refuse the newcomer with that verdict's own settlement, which also shows nothing held.
- **directory** (#3460): the pool grouping DIRECTORY, the reserved instance of the
  same class the recompute lane publishes the pool grouping to (`src/lib/booking/pool-grouping.ts`),
  through the production directory transport (`durableGroupingDirectory`). On the
  probe's own directory, `directory:pool-grouping:verify`, a fresh put is stored and
  handed back and an older put is kept out, so newest wins is measured both ways. Then
  the LIVE directory is read, and only read, and must hold a grouping a cold server
  would install: this build's format, well formed, and read within three minutes,
  three of the recompute lane's publishes, so a run landing in one minute's gap
  between snapshots is never called stale. **What it holds the directory to**
  (#3496): the probe's own directory is touched only by this proof, so its first call
  of a run meets an object idle since the day before, a cold start, which took about a
  second on 2026-10-07. The live directory never meets that, because the recompute
  lane calls it every minute. So the check opens with one read of its own directory,
  held to the two seconds a server's own fetch of the grouping waits and timed, and
  holds every call after it to one call (1000ms), the live directory's real pattern.
  The pass detail prints the first call's time every day. A call that misses its
  bound says when it really answered, when it failed, or that it never did in the
  five seconds the probe watches it, so a cold object a few milliseconds slow is never
  read as a hung one.
- **directoryWake** (#3481): the directory still answers after the platform has put
  it to sleep. The platform hibernates an idle object after ten seconds and discards
  its memory, which is why #3479 keeps the snapshot in the object's storage; the
  tests can show that only with a stand in. So the probe puts a grouping of its own on
  its own directory, confirms it is held, then leaves the directory untouched for 20
  seconds (twice the window) and reads it, up to three times. Each get says where it
  answered from (`memory`, or `storage` on the get that loaded a woken instance's
  storage, an additive field readers ignore), and only a read **from storage**
  holding that grouping passes. Every read is a call, and a call resets the object's
  idle clock, so each spell is a whole one on its own: the probe's polling cannot keep
  the object awake. A read after the wait that has lost the grouping fails (exit 24).
  Every read answering from memory, or naming no source as an older directory does, is
  a wake the probe could not see, which is **never a pass** and never called a failure
  of storage either (exit 25). It runs last, so the line checks and the live read are
  never held behind its wait; a healthy run takes about 20 seconds longer for it.

It uses the shared line **whatever the stored switch says**: the switch decides
whether real confirms use it, and a probe that stood down while the switch is off
would prove nothing for exactly as long as nothing relies on the line.

**What it cannot prove, said plainly:** every participant runs inside the one
invocation that serves the request, so a pass shows the object answers and keeps
the line's rules, and **cannot prove that two isolates reach the same object**.
Only the load run, whose confirms spread across isolates, can show that.

It writes leads, tickets and verdicts on ONE object, the group
`monitor:confirm-line-verify`, which no real line key can name: a real group is
`link:`, `code:` or `ladder:` and the object is named from the whole group.
`scripts/test-confirm-line-live-control.ts` walks `confirmQueueKey`, the one place
the booking path builds a line key, with inputs chosen to try to reach it. The
group is a **constant in the route and nothing is taken from the request**, and
each run mints fresh instants, so two runs never meet. The directory check writes
only its own directory, `directory:pool-grouping:verify`, and only READS the live
one, so it can never put a grouping in front of a real confirm; the same walk shows
no real line key can name either directory.

```
BOOKING_API_KEY_CANARY=<the canary key the deployment holds> pnpm verify:confirm-line
```

`SLATE_BASE_URL` picks the deployment (default prod). Only every check passing passes
(L98), and every other ending exits on **its own code** with its own opening
sentence. When several checks fail, the worst names the run and the message still
lists every check's outcome.

| exit | what it met | what to do |
|---|---|---|
| 0 | every check answered as the line's rules say | nothing |
| 1 | no base URL or no `BOOKING_API_KEY_CANARY` here | set them; nothing was attempted |
| 2 | no reply at all, or none within three minutes | check the base URL and that the deployment serves |
| 3 | a reply this command cannot read | something other than the endpoint answered |
| 4 | the key was refused | the deployment does not hold this key |
| 5 | the endpoint is disabled | the deployment has no booking API key configured |
| 6 | not found | the deployment predates this endpoint; deploy and re-run |
| 7 | the Worker could not read its own context | not a missing binding; a local dev server reads like this |
| 8 | `CONFIRM_LINE` is not bound | a deploy shipped without the `durable_objects` entry |
| 9 | bound, and the confirm path's client fell back | **the state nothing else can see**; every confirm is on its isolate's line |
| 10 | the reply lacked a check or carried an unknown outcome | the deployed probe and this command disagree; deploy |
| 11 | the probe threw inside a check | a fault in the probe, not the object; read its detail |
| 12 | the first confirm on an unused slot was not given the lead | the object holds something it should not |
| 13 | a second confirm led beside the first | **the line excludes nobody**; a crowd would stampede |
| 14 | a full verdict did not refuse the waiting confirm | taken slots would each run the whole confirm |
| 15 | a not full verdict did not hand the lead on within the report's two calls | confirms for a slot with room are held up |
| 16 | an unacknowledged lead was freed only by its lease | the acknowledgement window is not enforced |
| 17 | an unacknowledged lead was never freed | one lost answer holds every confirm behind it |
| 18 | something the probe used was still held afterwards | the object keeps a line it should have dropped |
| 19 | the pool grouping directory did not answer | the grouping the lane publishes reaches no server |
| 20 | the directory did not keep a fresh grouping it was handed | nothing the lane publishes reaches a server |
| 21 | an older grouping replaced a newer one | a slow publisher could hand servers a stale grouping |
| 22 | the live directory holds no grouping | the recompute lane is not publishing; search `tag=pool-grouping` |
| 23 | the live grouping is one a server would refuse | another format, malformed, or older than three minutes |
| 24 | left idle past the hibernation window, the directory lost the grouping it stored | **the #3479 failure is back**: servers between publishes read nothing and key by code; the detail says whether it woke or stayed awake |
| 25 | every read after the idle wait answered from memory, or named no source | not a pass and not a finding: the platform kept the object awake, or the directory predates the field (deploy); the wake half was not measured |
| 26 | a confirm the ladder line should have released with an advisor got no lead, or a lead holding nothing | the line Worker answers as it did before #3489; redeploy it at the app's commit |
| 27 | a released confirm was handed something other than the advisor nobody had claimed | **two confirms can land on one advisor** in a crowd |
| 28 | with a claim in flight, a full verdict answered the waiting confirm at once | a crowd is refused or re-read on a verdict the claim could still overturn |
| 29 | a held full verdict was not applied, with the last booking's settlement, when that claim ended booked | a crowd behind a spent ladder reads it again for itself |
| 30 | an advisor reported found busy was handed out again | the line ignores how a claim ended |
| 31 | an advisor reported untried was not handed out again | a crowd can be turned away with an advisor free |

Its decision logic is pinned offline by `scripts/test-confirm-line-live-control.ts`,
which drives the probe against the real object host (`makeConfirmLineHost`) on a
virtual clock, plants a defect for every outcome a check can name, and asserts no
two endings share a code or an opening sentence.

## It runs DAILY, beside the burst counter's proof

**`.github/workflows/burst-counter.yml` runs it every day at 10:50 UTC**, as its own
`continue-on-error` step after the burst counter's, with its own summary file
(`confirm-line-summary.json`), its own bare node reporter
(`scripts/notify-confirm-line.ts`) and its own stamp, so neither proof's outcome
can stand in for the other's (L53).

**It stamps `verdict:confirm-line`**, in `VERDICT_STALE_BOUNDS_MS` with
`neverIsStale` ON, at the burst counter's 52 hours for the same derived reasons
(`scripts/test-confirm-line-schedule.ts` re-derives it from the workflow file).
**Only a run that measured how the object answers may stamp it**: exits 0, 9, 12
to 24 and 26 to 31 conclude, and every bad one of those is also posted to Slack. Exit 8 (nothing
bound) deliberately does not, because nothing exercised the answering half; the
daily message still says so and the lapsing stamp pages as a blind detector, so
nothing about it is quieter. Exit 25 (no wake seen) does not either, for the same
reason: a stamp there would keep the verdict fresh for as long as the platform kept
the directory awake, which is a detector that has stopped concluding. It ranks below
every real finding, so a run with one is named by that finding and still stamps. The
mapping is `scripts/lib/confirm-line-run-outcome.ts`.

# Proving the reroute on ineligibility (`pnpm verify:reroute-on-ineligibility`)

The automatic reroute (#3582, #3615) moves a booked call off an advisor Twilio demotes off a
pool the call needs. It acts only when Twilio narrows somebody, so a pipeline that had stopped
working would look exactly like a quiet month (L557, #1394), and fakes agree with our assumptions
about the database, the reassign and the calendars by construction (L52).

**`pnpm verify:reroute-on-ineligibility` is the proof, as a drill.** It calls
`POST /api/smoke/demotion-drill`, which runs `src/lib/booking/demotion-drill.ts` inside the
deployment, where Slate's own calendar credentials live, on the DRILL test bucket and the two smoke
test advisors only:

1. book a test call on the DRILL bucket, keyed on the made up `drill` tier both advisors carry;
2. take that tier off whoever got the call, exactly as a Twilio narrowing would;
3. run the real demotion decision (stamp, then sweep past the debounce, on an injected clock, so
   nothing waits), queue the real filtered sweep with what changed, and drain it under the lane's
   own lease;
4. require the call with the other advisor, the change recorded on the sweep, and an audit row;
5. move it back through the real move back, and require it back, audited, and pinned;
6. ALWAYS cancel the call and restore the advisor, and report a cleanup that failed OVER a pass.

The hourly Twilio sync never evaluates a test advisor, so the drill drives the same decision
functions the sync runs rather than the sync itself. The DRILL bucket and the drill tier come from
the smoke seed (`scripts/seed-smoke-test.ts`); a drill on a deployment that was never seeded exits
8 and says to run it. The drill's two audit rows a day are about test advisors, which the audit log
hides unless "Include test advisors" is ticked.

```
BOOKING_API_KEY_CANARY=<the canary key the deployment holds> pnpm verify:reroute-on-ineligibility
```

`SLATE_BASE_URL` picks the deployment (default prod). Only a pass exits 0, and every other ending
exits on its own code, listed in `scripts/lib/reroute-drill-run-outcome.ts`:

| exit | what it met |
|---|---|
| 0 | the call moved, was recorded and audited, and the move back held |
| 1 to 6 | the command could not ask (no key or URL, no reply, an unreadable reply, a refused key, no key on the deployment, no endpoint yet) |
| 7 | another drill was running |
| 8 | the DRILL bucket or its two advisors are not seeded |
| 9 | no free time on the DRILL bucket |
| 10, 11 | the booking path refused the test call, or it landed outside the drill (nobody demoted) |
| 12 to 20 | **the pipeline answered wrongly**: no stamp, no sweep, no change recorded, nothing queued, no move, no audit, the move back refused or did not land, or not pinned |
| 21 | the drill could not cancel its call or restore its advisor, before it judged anything |
| 22 | a step threw |
| 23 | the drill judged the pipeline and THEN could not clean up; what it judged is in the message |
| 24 | **not measured**: the smoke canary held the two test advisors for the whole 12 minute wait, so the drill never started (#4180) |

### It shares its two test advisors with the smoke canary (#4180)

The smoke canary's hourly full pass books on the same two advisors. On 2026-10-23 at 15:34 UTC
the two overlapped and BOTH failed: the drill's sweep found the other advisor busy with the
canary's bookings (exit 16) and the canary's sub event reschedule got a 409. So both hold one
server side lease over the advisors (`smoke_test_advisors` in `sync_locks`, through `acquireLease`,
terms in `src/lib/booking/test-advisor-lease-terms.ts`): the drill's endpoint for the drill's run,
the canary through `/api/smoke/test-advisor-lease` around its booking steps.

The server never waits. While the canary holds the lease the endpoint answers
`test-advisors-held` without starting, and the command asks again every 15 seconds for up to 12
minutes, which is past the lease's 10 minute TTL, so even a canary that died holding it has lost
it inside the wait. Still held at the bound is exit 24: the reporter posts nothing (Dan,
2026-10-23: a day the canary kept the drill off is not news) and nothing is stamped. The client half is
pinned by `scripts/test-test-advisor-lease-wait.ts`, the lease itself (a crashed holder's claim
lapses, release is idempotent, the two endpoints exclude each other) by
`src/lib/booking/test-advisor-lease.test.ts`. A shared GitHub concurrency group was rejected: a
third queued run cancels the pending one even with `cancel-in-progress: false` (L1020), and the
canary queues often, so the day's drill could be dropped without a word.

Its decision logic is pinned offline by `scripts/test-demotion-drill.ts`, which runs the drill over
a fake world built from the real decision functions and shows every failure reason can occur.

## It runs DAILY, beside the burst counter's proof

`.github/workflows/burst-counter.yml` runs it every day after the confirm line proof, with its own
summary file (`reroute-drill-summary.json`), its own bare node reporter
(`scripts/notify-reroute-drill.ts`) and its own stamp. The job's timeout is 30 minutes so a slow
drill, after its wait for the canary, is never cut off mid cleanup.

**It stamps `verdict:reroute-drill`**, at the burst counter's 52 hours for the same derived
reasons (`scripts/test-reroute-drill-schedule.ts` re-derives it from the workflow file). **Only a
run that exercised the pipeline may stamp it**: exits 0, 12 to 20 and 23 conclude, and every bad one of
those is posted to Slack. A drill that could not start, or could not clean up, does not stamp; its
message still says so daily, and the lapsing stamp pages as a blind detector. Exit 24 (the canary
held the advisors past the wait) does not stamp either, and posts nothing: only a run of such days
surfaces, when the lapsing stamp pages.

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

# Proving the activation gate's calendar reads (`pnpm verify:pool-entry`)

#2302 made the pool entry calendar read (`onboardIntoPool`,
`src/lib/google/pool-entry.ts`) the second half of the activation gate in
`src/lib/bookable/service.ts`, so a failure there REFUSES the flip. Every refusal
path is driven by hand written fakes, and a fake agrees with our assumption about
Google's interface by construction (L52). If the success path is broken in a way
the fakes cannot show, no agent can be made bookable at all, and the first sign
would be a new hire failing to activate with a page blaming their calendar
(#2316).

**Both directions, or it proves nothing** (L1). It runs the gate's two reads in
the order the gate runs them, the reachability probe (`checkActivationGate`) and
then `onboardIntoPool`, for two real accounts:

- a READABLE agent must be admitted by the probe and come back with EVERY calendar
  hydrated, judged by the same shipped predicate the gate uses
  (`poolEntryRefusal`, `src/lib/bookable/pool-entry-verdict.ts`), plus a stricter
  check that every calendar found was hydrated, so a gate that admits somebody
  with a calendar nobody read is its own finding (exit 17);
- an account with NO CALENDAR LICENCE (`403 notACalendarUser`) must be refused by
  the probe AS `google_not_provisioned`. A refusal as gone is the right answer to
  a different question and does not pass.

```
POOL_ENTRY_READABLE_EMAIL=someagent@trypennie.com \
POOL_ENTRY_UNPROVISIONED_EMAIL=someleaver@trypennie.com \
pnpm verify:pool-entry
```

Needs the Google service account creds and the Supabase secret key from
`.env.local` / `.dev.vars`. It is deliberately not named `test-*.ts`.

**What it writes, and why that is safe.** Nothing around the reads runs: no
alert, no `bookable_pending_since` mark, no bookable write, so it never flips
anybody. The probe only lists calendars. `onboardIntoPool` does write, so it is
run ONLY for an agent who is already bookable and active (exits 5 and 6 refuse
anybody else), where every write is a refresh the lanes make on their own
schedule: a watch renewal only if one is already due (the watch lane), a
re-bootstrap of the busy window (the hydration lane), and `last_synced_at` (the
sync lane). For the unlicensed account the pool entry read is never run, exactly
as the real gate never runs it once the probe refuses. A good unlicensed subject
is a recently departed agent, whose licence is routinely revoked on the way out;
Google answers the same 403 for a revoked licence as for one never given.

**Only a proof in both directions passes, and every way of learning nothing exits
on its own code.** When both directions fail, the readable one names the run,
since it is the one whose breakage stops every activation; both lines are printed
either way.

| exit | what it met |
|---|---|
| 0 | both directions proved |
| 1 | one or both emails not set; nothing was attempted |
| 2 | both emails name the same account, which cannot prove both directions |
| 3 | the Slate users table could not be read |
| 4 | no Slate user has the readable email |
| 5 | the readable agent is not bookable, so onboarding them is refused |
| 6 | the readable agent has been deactivated |
| 7 | no Slate user has the unprovisioned email |
| 10 | the readable agent's account has no Calendar licence |
| 11 | Google refused the readable agent's account outright (gone) |
| 12 | the probe could not reach the readable agent twice running; run it again |
| 13 | the pool entry read threw for the readable agent |
| 14 | the pool entry read found no calendars for the readable agent |
| 15 | a readable agent's calendar failed to hydrate |
| 16 | the activation budget ran out before every calendar was attempted |
| 17 | **the shipped gate admits a result with a calendar neither hydrated nor failed** |
| 20 | **the probe REACHED the account named as unlicensed**, so the gate would let it through its first half |
| 21 | the unlicensed account was refused as gone rather than as not provisioned |
| 22 | the probe could not reach the unlicensed account twice running; run it again |

Its decision logic is pinned offline by `scripts/test-pool-entry-live-control.ts`
(`scripts/lib/pool-entry-live-check.ts`), which drives every outcome through hand
written fixtures, asserts no two outcomes share an exit code or a message, and
fails if a declared outcome is one no case can produce.

**Re-run it after any change to `onboardIntoPool`, the reachability probe, the
hydration path or the delegated identity.** As of 2026-09-24 it passes: the
unlicensed direction on a departed agent (403, refused as
`google_not_provisioned`), the readable direction on a bookable agent with a busy
calendar (1 of 1 calendar hydrated to the horizon, watch current). Naming a
licensed agent as the unlicensed one exits 20, which is the live half of the
control.

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

## The slot comparison it replaced, and the form of it that does work

The first probe narrowed cal.com's answer to one bucket's agents with
`routedTeamMemberIds[]` on `GET /v2/slots`. That parameter does not exist on that
endpoint: it is a strict whitelist, so every spelling answers 400 and zero pins
answers 200 with the whole pool. It belonged to `/v2/slots/available`, which is
now 404. So the probe was merged, documented here with fifteen exit codes, and
structurally incapable of executing a single comparison. Re-measured live on
2026-09-07, still 400.

**That does NOT mean cal.com cannot be asked what it would offer one agent.** This
section used to conclude exactly that, and it was wrong: it was true of the two
forms above and of nothing else. A third form, measured live on 2026-09-16
(#2471), answers 200 for one person:

```
GET /v2/slots?eventTypeSlug=<the agent's personal event type slug>&username=<their cal.com username>&organizationSlug=trypennie
cal-api-version: 2024-09-04
```

Three conditions, each measured rather than assumed:

- `organizationSlug` is required. The same call without it answers 404.
- The agent needs a PERSONAL event type, and not all have one: 2 of 6 sampled
  answered 404 for that reason. A 404 counted as "no slots" reads exactly like a
  fully booked calendar, so anything built on this must refuse a non-200 rather
  than count it (L11, L98).
- The team event type (1314152) cannot stand in for it. Its slots are the union
  across every host, so one agent with no free time can never empty a day.

It was used by hand to verify #2417. No command runs it yet: whether to build the
slot level comparison #1731 originally wanted on top of it is still open in
#2471. It would see what the schedule comparison cannot (an override, a booking,
a buffer, a booking window), because it asks what a lead would actually be
offered rather than comparing the weekly schedule that feeds it.

**The pin was the load-bearing capability and it was the last thing measured**,
which is the mistake worth not repeating, and the conclusion drawn from it was
then never re-measured either, which is the same mistake pointing the other way.
Both halves now rest on endpoints
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

**A difference that changes nothing a lead sees never fails a run.** Two of them:

- A zone NAME that keeps the same clock is AGREEMENT, and says nothing at all
  (#2030). The first live sweep reported ten agents as `timezone-differs`, and
  every one was such a pair: nine `America/Denver` against `America/Boise`, one
  `America/New_York` against `America/Indiana/Indianapolis`. Sampled hourly over
  400 days those differ on 0 of 9,600 hours, while Denver against Phoenix differs
  on 5,711. It then shipped as a lesser verdict of its own, which still printed
  nine lines and still exited 9, until Dan's call on 2026-09-07: "if it has no
  actual difference, like it's the same clock time but cal.com defines it as a
  different timezone than slate in words, I don't care about that. That should be
  silent." Only the clock is compared, by the same judge the hours picker and the
  hours save path use (`zonesKeepSameClock`, #2128), so a Denver against Phoenix
  difference is still exit 17. An agent with an alias zone AND a real difference
  is reported for the real difference alone.
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
retries forever hangs the run (L110). **Then every agent cal.com still refused
with a 429 is read ONCE more, after the sweep** (#3963): five of seven daily runs
before that ended with exactly three agents unmeasured, a different three each
day, each having climbed the whole ladder inside the burst that caused the
refusal. The second pass waits one minute first (cal.com meters keys per minute),
or cal.com's own `Retry-After` when that is longer, capped at five minutes, and a
second refusal stays `calcom-unreachable` exactly as before. Nothing but a 429 is
read again. The run prints a `note:` line saying how many were read again and how
many answered, so `calcom-unreachable: N` in the summary still means what it
always meant: agents nobody could read. `pnpm import:calcom-schedules` shares the
same rule (`readEachWithSecondRead` in `scripts/lib/calcom-roster.ts`), so its
"skipped, transient" count is also what is left after the second read.
`PARITY_AGENT` narrows the HOURS half only:
membership is a comparison of two whole rosters and means nothing scoped to one
person.

**Only agreement passes, and every other outcome exits on its own code.** Finding
nothing to compare is never a pass (L98), and the report says how many agents had
a week on BOTH sides, so "no differences" can never be read as "no problems" when
the real answer is that nothing was compared.

| exit | what it met |
|---|---|
| 0 | the two rosters agree and every agent holds the same week (a zone spelled differently that keeps the same clock counts as the same week) |
| 1 | no `CALCOM_API_KEY`, or no Twilio credentials, here; nothing was attempted |
| 2 | no bookable agents in Slate, or the named agent does not exist |
| 4 | cal.com did not answer (the org listing, or the team's event types) |
| 5 | cal.com answered with something unreadable |
| 6 | the event type is not on that team, or named no hosts at all |
| 7 | **Twilio could not be read**, so who cal.com withholds is unknown |
| 9 | retired by #2030 (it was a zone name that keeps the same clock, now agreement); never reused |
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
| 23 | **bookable in Slate, in a routing pool, and not a cal.com host at all**, so Slate offers somebody the incumbent never routes to |
| 24 | **an agent Slate will not route who cal.com still can** |
| 25 | **somebody who has left Slate and can still be booked in cal.com** |
| 26 | **bookable in Slate and in a routing pool, while cal.com withholds them from every routed decision** |
| 27 | an hours, days or timezone difference on a week the AGENT set themselves, which the lane will not overwrite |
| 28 | **bookable in Slate and in no routing pool**, and cal.com does not route to them either, so neither system offers them; the fix is their debt tier in Twilio |
| 29 | **bookable in Slate and in no routing pool while cal.com still routes them leads**, so at cutover they get none; the fix is their debt tier in Twilio |

**Exit 23 and exit 28 are split on whether a pool reaches the agent** (#3963). The
bookable flag alone does not make Slate offer anybody: on 2026-10-20 an agent was
bookable with `{"role":"Sales"}` as their only attribute and no `bucket_members`
row, matched no bucket, and was reported as somebody "Slate offers and cal.com does
not list at all". Both halves of that were wrong about Slate, and the remedy it
implied (cal.com's host list) was the wrong system. Whether a pool reaches them is
asked through the shipped pool predicate (`matchableAgentIds`, which calls
`agentIdsFromPool`, the same one the recompute lane and `/admin/tiers` use), never
an attribute check written beside it. It applies whether cal.com does not list them
(once exit 23) or withholds them (once exit 26). A bookable agent cal.com DOES route
to and no pool reaches used to read as agreement, because the routable check came
first; it is exit 29 now, with its own words, since "neither system offers them"
would be false there.

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

Since #2724 the roster sync ALSO mirrors the tag itself, as
`users.attributes.redistribute_tagged`, for every tagged worker whatever their
bookable state (removed with the tag, left alone for a row Twilio holds no worker
for). That is what the Regal call detector reads to exempt a Redistribute agent.
This command still reads Twilio directly, because agreeing with a value the sync
wrote would be the sync checking itself (L58). Measured 2026-09-25 before shipping:
19 workers tagged, the mark covered 17, the mirrored tag covers all 19 and marks
nobody untagged.

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

The roster's availability rules are read PAGED (#2416). They are one row per
agent per weekday window, 793 on 2026-10-02 and past PostgREST's 1,000 row page at
the 200 agent target, and an unpaged read returns the first page with no error:
every agent whose rules fell past it would come back holding a shorter week, so
this command would exit 16 about days that are not missing and the importer would
diff a week it never fully loaded. `scripts/test-calcom-roster.ts` drives the
loader against a fake that truncates exactly as PostgREST does, at exactly one
page, one rule past it, and a full week each at the target.

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
`hoursOverwriteRefusal` (`src/lib/calcom/schedule-import.ts`) refuses any
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

**The activation gate imports one agent's week too (#2627)**, the moment the
calendar gate admits them and before the bookable write
(`src/lib/bookable/activation-hours.ts`), through the same `planImportedWeek` and
`writeImportedWeek` this lane uses. Its rule is STRICTER than this one: it replaces
only a week `isUnsetHours` calls the seed (stamped `seed`, or unstamped and still
shaped exactly like the org default, zone included), so an admin who set somebody's
hours and then pressed Activate does not watch them change in the same click. Every
cal.com failure leaves the seeded week, logs its own `reason`, and activates anyway;
this daily run is the repair for anything it could not bring across.

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
| 1 | no Supabase credentials or no settings row; nothing was attempted |
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
| 13 | bookings were ALREADY stopped, so the run stood down without testing anything |
| 14 | the pause flag could not be written, so the paused half never ran; nothing is left stopped |
| 15 | **skipped**: now is inside the org's business hours or within 30 minutes of them, so nothing was paused |
| 16 | the org's business hours could not be read, so nothing was paused |

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

Exits 13 and 14 were split off the credentials exit and the no-reply exit by #2493,
because on a schedule they mean something the codes they shared never did: 13 is a
deployment where somebody has deliberately stopped bookings and finishing the run would
start them again for them, and 14 is a database write problem rather than an unreachable
deployment. Neither is a pass and neither is a fault (L11, L98).

Exits 15 and 16 are the clock check #3920 added, which runs before anything is read or
written. It reads the org's LIVE hours and closed dates (`business_hours`,
`business_hours_exceptions`), judges the current instant on the org's clock through
`windowOnDate`, and stands down inside an open window or within 30 minutes either side of
one. Thirty, because it is larger than the job's whole ten minute timeout, so nothing that
can separate the check from the pause reaches the open window, and the night left is still
eleven hours. Hours it cannot read stand down too (16), because a skipped night costs one
missing verdict and a wrong guess costs real leads. A hand run is checked the same way. The
rule is `scripts/lib/kill-switch-clock.ts`, driven by `scripts/test-kill-switch-clock.ts`.
## It runs NIGHTLY, and outside the hours the org advertises (#2493)

The command had run exactly once, in the session that wrote it, which is the state
`verify:burst-counter` was in when #2392 found the burst path had moved five times with
nobody re-running the proof. A rule that lives only in a prompt is a hope (L27), and a
check that has never once concluded is measuring nothing (L557). So this takes the same
answer that issue took, with ONE difference the schedule has to carry.

**Running this command STOPS public booking for about two seconds.** A recurring
automated pause is cheap before cutover and expensive after it, so
`.github/workflows/kill-switch.yml` runs overnight, outside the org's advertised 08:00 to
20:00 Monday to Saturday in BOTH offsets the Eastern clock takes.

**The declared time is not when it runs** (#3920, L386). Declared at 07:10 UTC, GitHub
started it 262 to 570 minutes late on every one of its last 32 runs (measured 2026-10-19,
median 383), which is 7:32 AM to 12:40 PM Eastern: it paused live booking every morning.
The other daily crons here show the same delay at every hour, so it is GitHub's queue. The
cron is now **01:40 UTC** (21:40 EDT, 20:40 EST), which puts this workflow's measured delays
between about 02:00 and 07:10 Eastern in summer time (01:00 to 06:10 in winter), and the command checks the clock itself before pausing (exits
15 and 16 above), so a delay past that skips rather than refusing leads.
`scripts/test-kill-switch-schedule.ts` sweeps the cron plus every delay up to 570 minutes, on
every day of a year, through that same clock check against `SEEDED_BUSINESS_HOURS`, with
the old 07:10 cron as its control, so a schedule edited back into business hours fails the
build. There is no later re-attempt for a skipped night: #3320's re-dispatch pattern is not
built yet.

That is the residual risk, stated rather than implied: a lead who posts a booking inside
those two seconds is answered with the paused copy, which tells them to try again
shortly. The two options not taken are recorded here so nobody re-opens them by accident.
Running it on a deploy that touches the kill switch path covers the change that breaks it
and not the change somewhere else that breaks it, and it is exactly the "somebody has to
have thought about it" rule that failed for the burst counter. Leaving it hand run and
recording that in this file is a rule that lives only in a prompt, which is where this
started. A hand dispatch is still the same run the schedule makes, so somebody who has
just changed the kill switch path gets an answer now rather than tonight.

**It stamps `verdict:kill-switch`**, in the `VERDICT_STALE_BOUNDS_MS` family (#1394),
judged with `neverIsStale` ON, because "has never once concluded" is the exact state
this issue was about. Two things about that stamp are the whole design:

- **Only a run that MEASURED whether the gate refuses and releases may write it.** Six
  endings conclude and ten do not, and the interesting ones are the bad verdicts that
  DO stamp: a booker that takes a booking while paused, one that refuses while open, and
  one refusing with the cannot-read copy are all definite readings of the thing under
  test, so they stamp AND are posted to Slack. `notRestored` deliberately does NOT stamp
  although it is the loudest thing in the table: it is judged before anything else the
  run found, so the gate's own behaviour may never have been reached. Nor does exit 13,
  because a run that stood down tested nothing. The mapping is in
  `scripts/lib/kill-switch-run-outcome.ts`, one entry per exit code, and the guard walks
  `KILL_SWITCH_EXIT` so a seventeenth ending cannot inherit somebody's guess.
- **The bound is 58 hours and every part of it is derived** (L614): 24h of cadence,
  doubled so one dropped run does not page, plus the 9h30m worst lateness measured on this
  workflow (re-measured for #3920, up from the 3h first recorded), plus the job's own 10 minute timeout,
  because the stamp lands at the END of a run. A skipped night (exit 15 or 16) stamps
  nothing either, so three in a row are past the bound and page. There is deliberately no
  gap filler, matching the burst counter.

**The run speaks from the runner** (`scripts/notify-kill-switch.ts`, bare node like the
other alerters): it repeats once a night until a run passes, and a run that passes says
nothing.

# Public booking stopped and left that way (#2366)

The kill switch above is visible on the admin Overview, which helps whoever looks.
Nothing raised a hand at whoever does not, and the failure is ordinary: somebody stops
bookings at 2am to contain a problem, fixes the problem, and does not flip it back. Slate
then takes zero bookings while every other signal reads healthy, because everything else
IS healthy. What eventually notices is the low booking volume alarm, and it reports a
DROUGHT, which sends a reader to the funnel, the embed and the availability cache, none
of which is wrong.

`public_booking_stopped` is the notice, raised by the monitor lane's `booking_pause` step
(`src/lib/monitor/booking-pause.ts`). Four decisions in it are worth knowing.

**It is a CONDITION, so it carries an all clear**, hung off a tick that READ the flag and
found it false, never off a tick that merely did not speak (#1134, #1152). A tick holding
under the threshold clears nothing either: bookings are stopped, which is not a healthy
reading whatever the threshold says.

**It is not a fault, and the copy says so.** Somebody pulled that switch deliberately, so
the message says how long it has stood and asks whether it is still meant to be off.
There is no auto unpause and there should not be: a switch that lifted itself would start
taking bookings again in the middle of the incident it was thrown for, which is worse
than being forgotten. L523 asks for an expiry AND visibility on a hand set suppression;
visibility is the half that helps here.

**How long is too long is DERIVED.** `PAUSE_NOTICE_AFTER_MS` is
`LOW_VOLUME_WINDOW_MINUTES.long`, the low volume alarm's long window, read from that
constant rather than restated (L41, L401). It is the longest span Slate already treats as
long enough to say something about bookings not happening, so a notice firing sooner
would call a stretch too long while the alarm beside it called the same stretch ordinary.
At that mark the two arrive together and this one names the cause the volume alarm
structurally cannot see. The span is WALL CLOCK from the moment the switch was set, not
counted in open hours: counting only advertised time would delay the morning notice about
a 2am pause by the whole threshold, which is the exact case this exists for. What the
org's hours decide is when the notice is SPOKEN, and a week the lane could not read errs
toward speaking, because the fact is fully measured and only the choice of a civil hour
is unknown.

**The clock comes from a column of its own, maintained by the database.**
`booking_settings.public_booking_paused_at` (migration 0131) is stamped by a trigger at
the transition into stopped, never by application code. Not `updated_at`, which is shared
with the other columns on that single settings row, so editing the horizon would push the
pause clock forward. Not the admin action either: the control posts the STATE it wants
rather than toggling, so two admins reacting to one incident both press stop and a writer
that set the stamp unconditionally would restart the clock each time; and `pnpm
verify:kill-switch` and hand SQL write the flag too. One writer at the layer every path
shares (L593). A paused row with NO stamp is spoken about rather than waited out, because
there is no clock to wait.

The monitor's reader (`readPublicBookingPauseState`) THROWS on a read error, which is the
deliberate difference from the booking path's reader beside it: the step boundary reports
it under `monitor_step_failing` and the lane renders `unreadable`, so a run that could not
measure never looks like one that measured and found the switch off (L98).

# Is the shadow run trustworthy today? (`pnpm verify:parallel-run-readiness`)

The fifth command in the family above, and the one to run right before the pilot
bookings (#2066). On 2026-09-07 answering "is the parallel run trustworthy today"
took a database query plus reading eight issues, because each precondition is
measured somewhere in Slate and nowhere together. This reads production, writes
nothing, and judges each precondition through the code that already owns it (L107):
no alert cooldown stretched above its default, the daily cal.com comparison fresh
and not reporting drift, nobody waiting to become bookable behind a refused
activation, every bookable agent's calendar present and hydrated to the booking
horizon (the hydration monitor's own judge), no debt tier and no real bucket empty
(the empty bucket alarm's own eligibility predicate), every bookable agent on a week
somebody set (#1753, `agentsOnUnsetHours`), and trypennie's key proven from
production. The exit table below is the list; `scripts/test-readiness-exit-table.ts`
fails when a code in `READINESS_EXIT` has no row in it, or a row names no code.

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
| 3 | zero bookable agents, zero debt tiers or zero real buckets: nothing was judged |
| 4 | **a debt tier has nobody assigned at all** |
| 12 | **a real bucket has nobody to route to** |
| 5 | **a bookable agent has no calendar row**, so they read as free all day |
| 6 | a calendar is not hydrated to the booking horizon |
| 13 | **trypennie key never seen from production** (see below) |
| 7 | an alert cooldown is stretched above its default |
| 14 | **low volume alarms armed** and a real booking in 7 days carried no `source`, or a Low page has recorded none carrying its own (see below) |
| 15 | **low volume alarms armed** and a federal holiday in the next 90 days carries no business hours exception |
| 16 | **low volume alarms armed** and no real booking in 7 days, so page sources are unmeasured |
| 8 | the cal.com comparison is reporting drift |
| 9 | the cal.com comparison has not reached a verdict inside its 30 hour bound |
| 10 | somebody is waiting to become bookable behind a refused activation |
| 11 | a bookable agent is on working hours nobody set |
| 19 | **cal.com is marked retired** on /admin/alerts (#2875), so the parallel run is over and nothing was judged |

The rows are in the order the run is judged, worst first, which is not the order of
the numbers: a code names an outcome and the order decides which one names a run.
The table was two outcomes and a renumbering behind the code until #2717, so the
authority is `READINESS_EXIT` and `READINESS_ORDER` in the judge.

**Exits 14 to 16, the low volume alarms' arming preconditions (#2767).** The tier
and per page low volume alarms (#1956, #2738) rest on two facts nothing else checks.
The per page alarm counts each Low page by `bookings.source` (#2072), so a page whose
links carry no `?source=` records every booking as `not-given` and, once armed, pages
every 30 minutes as a page that stopped booking. And both alarms judge an hour by the
org's business hours, date exceptions included, so a holiday with no exception is an
ordinary open day to them: the per page replay (#2738) paged the Follow Up page eight
times on Labor Day 2026-09-07. So the run reads, through the alarm's own reads, whether
every real booking inside the alarm's own `PAGE_SEEN_LOOKBACK_DAYS` (7) carried its
source and each Low page recorded one of its own, and whether every US federal holiday date in the next
90 days, the observed weekday of a weekend holiday included, carries an exception
(closed, or open because Pennie works that day, either being a decision) or falls on
a weekday the org never opens. No real booking in the lookback is **unmeasured**
(exit 16), never a pass. The holiday calendar is `src/lib/booking/us-federal-holidays.ts`,
pinned against published dates by `scripts/test-us-federal-holidays.ts`.

**Whether the sources are recorded is the alerts page's rule, not a second one
(#2796).** The run judges it through `pageSourceStatus`, the status Admin, Alerts
shows in place of the per page floors, which reads `bookingSourcesRecorded` in
`src/lib/monitor/page-volume.ts`: a lookback with even ONE untagged booking is not
recorded well enough, because that booking can be the missing one of a page that
stopped, and the armed alarm holds such a page rather than paging it. The run used to
be satisfied once every page had recorded one booking of its own, so on the same
bookings it could print READY while the alerts page said "source not recorded".
Exit 14 now covers both: bookings with no source (in the alerts page's own sentence),
or, with every booking tagged, a page that recorded none.

**They gate ARMING, not the shadow run, and that decides where they rank.** While
`monitor_alert_config.low_volume_armed` is false they are printed under a "Before
arming the low volume alarms" heading after the verdict and never change the exit,
so a READY day is not held red by an alarm nobody has switched on, and a failed read
of one is reported there too rather than as exit 2. Once the switch is on they are
findings like the rest, ranked just below a muted alarm (exit 7) and below every
finding that affects a lead: an armed alarm paging falsely is the other way an alarm
stops being read, and neither turns anybody away. An UNSET switch counts as on,
because it falls through to the deployment's `BOOKING_VOLUME_ALERT_ARMED`, which
this command cannot read. **Run it, and read that heading, before ticking the switch
on under Admin, Alerts.**

**Exit 13, trypennie's key (#2717).** trypennie's confirmed page reads every Slate
booking with its own key (#2645), so a key missing from their production
environment ends every pilot booking on their not found page. The booking API's
authorizer records, per caller and per host, the last successful request in
`api_caller_seen` (migration 0140): written on a caller's first success from a
host and refreshed at most once an hour per isolate, deferred past the response,
so a booking pays nothing for it. The host is the request's `Origin`, else the
origin of its `Referer`, never the path. The gate passes when, within
`PARTNER_KEY_MAX_AGE_DAYS` (7), the key has authenticated from
`https://trypennie.com` or `https://www.trypennie.com`, OR from a server call that
named no host, and the READY line says which of the two it passed on. It fails,
on one exit with its own sentence each, when the key never authenticated, was seen
only from localhost or a private address, only from another host (a preview), or
last from a passing kind longer ago than the bound.

**Why a server call passes (Dan, 2026-09-25).** trypennie's lookup is a server to
server call, which sends neither header, so demanding a named production host
would keep the gate red against a working key. A browser on localhost or a preview
names its host and still fails. What this accepts, deliberately: a trypennie
developer calling with the production key from their own server satisfies it too.
The same fact is shown on `/admin/booking-outcomes`, judged by the same function
(`judgePartnerKey`, `src/lib/booking/caller-seen.ts`).

**A hand run probe with a partner's key must send `X-Slate-Probe: <why>` (#2868).**
A probe from a script or curl names no host either, so unmarked it reads exactly as
trypennie's server lookup and turns this exit green by itself (L58). A marked call is
served exactly as an unmarked one and recorded under `probe:<caller>` (for example
`probe:trypennie`) with its real host kind, so the key it used stays visible. This
command reads only `BOOKING_API_CALLERS` and `judgePartnerKey` reads only the named
caller's rows, so a probe row never proves anything; the admin card reads the
`probe:` names too and lists them apart under "Slate's own probes".
This replaces the old workaround of sending a localhost `Origin`, which kept the probe
out of the proof only by making it look like a developer's browser.

**Exits 17 and 18 are retired (#2865).** They judged the shared booking key: 17 read
calls arriving on it from trypennie's production site as trypennie holding the wrong
key (#2819), and 18 reported it being sent from a browser (#2822). The shared key is
gone. Regal has its own key, and the value trypennie was given sits in trypennie's
own `_2` slot, so a call with it is recorded as `trypennie` and exit 13 answers the
whole question. The numbers stay unused so an old log never reads as a new finding.
Rows the shared key left in `api_caller_seen` are never read: every read asks for
the callers the authorizer knows.

**Exit 8 names who drifted (#2089).** "The comparison is reporting drift" sent the
reader to `pnpm verify:calcom-parity`, a four minute sweep, to learn it was two
Saturdays, at the moment this command exists for. So the daily lane keeps its
`parity-summary.json` as the run's `parity-summary` artifact (7 days), and while the
drift alert is firing this command fetches it with `gh` and names each paging
difference in the alert's own words, worst first, four names per kind and a count of
the rest, with the run link. It reads the summary through the endpoint's own
`parseParitySweep` and `classifyParitySweep`, so it cannot call something drift that
the page would not. The heartbeat records no run id, so the run is paired by time:
it must have FINISHED just after the stamp it wrote (`pickParityRun`), never merely
be the newest. Every way of not getting the names (no `gh`, no access, no paired
run, no artifact, a refused summary) keeps exit 8 and says why nobody is named,
because the drift itself was measured either way.

**Exit 11, a bookable agent on hours nobody set (#1753, #2080).** It was left out of
the first cut on purpose, because the only test then was "is this week shaped like
the seeded default", and the seeded week is also a real week some agents keep. Since
#2080 every schedule carries `hours_source`, so the check names an agent whose week
was written by the seed, or an unstamped row still shaped exactly like the org
default, through `agentsOnUnsetHours`, the same judge the daily alert uses. It has no
grace period here, unlike the alert: this is run at a chosen moment before real
leads are sent, and an agent seeded yesterday is offered on coincidence hours just
the same. It ranks last, because the agent IS offered on a plausible week.

**It retires at cutover (#65)** with the rest of the family, and since #2875 it
says so itself: once cal.com is marked retired on /admin/alerts it exits 19 with a
`RETIRED:` line, and that verdict outranks every other section it read, rather than holding red for ever on a
comparison that has stopped by design. A retired setting it cannot read is an
unreadable section (exit 2), never a pass.

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

# Proving the advisor link names in a real database (`pnpm verify:agent-link-names`)

#3026 gave every advisor link a readable name, `/book/advisor/rdaboub`, and every
promise about that name lives in SQL (migration 0155): it is derived from the email
username, a clash gets the lowest free numbered variant (`rdaboub2`), two concurrent
inserts of one username never collide, a deleted user leaves the name reserved, a name is
never renamed or handed to someone else, and no name can be shaped like the 64 hex token
older links carry. The offline suite has no database, and a mocked client agrees with
whatever it is told (L52), so none of that can be shown there.

`pnpm verify:agent-link-names` starts a throwaway Postgres in Docker, lays down the slice
of the schema the migration reads, applies the migration file verbatim, and drives every
one of those promises, the concurrent insert included, with a positive control beside each
CHECK refusal so a broken statement cannot pass as a refusal. It writes nothing outside
the container and removes it on the way out. No Docker is exit 2, never a pass (L98); any
failed check is exit 1.

**Re-run it after any change to migration 0155's functions or to `agent_link_names`.**
It does not touch production. That the app and the database agree on the name's shape is
pinned offline by `scripts/test-agent-link.ts`, which reads the migration's CHECKs.

# Proving the sign in domain gate against the real auth server (`pnpm verify:auth-domain-hook`)

#3082: Supabase Auth used to create an account for ANY Google account, and the
`trypennie.com` check ran only in the OAuth callback, after the account and a signed in
session already existed. Migration 0159 adds a `before_user_created` auth hook,
`public.before_user_created_domain_gate`, which Supabase Auth calls before it creates any
account by any provider, and which refuses every email whose domain is not exactly
`trypennie.com`. The offline suite (`scripts/test-auth-domain-hook.ts`) holds the
migration, `supabase/config.toml` and `GOOGLE_HOSTED_DOMAIN` together as text; it cannot
show that the auth server calls the function and honours its refusal, and a mock would
agree with whatever it was told (L52).

`pnpm verify:auth-domain-hook` starts Supabase's own Postgres image and Supabase's own
auth server (GoTrue) in Docker, applies the migration verbatim, registers the hook the way
`config.toml` does, and signs up through the auth API: an outside address, a subdomain
(`@evil.trypennie.com`) and a suffix lookalike (`@trypennie.com.evil.com`) are each
refused with 403 and leave no `auth.users` row; a mixed case `trypennie.com` address is
created; and, as the control, the same outside address signs up with the hook switched
off, so the refusals are the hook's. It also checks that `anon` and `authenticated` cannot
execute the function and `supabase_auth_admin` can. It signs up by email because that is
the route an API call can drive without a browser; the hook runs for every provider,
Google included.

It writes nothing outside its own containers and removes them on the way out. No Docker,
or a container that will not start, is exit 2, never a pass (L98); any failed check is
exit 1. Measured 2026-10-03 with `supabase/postgres:17.6.1.175` and `gotrue:v2.196.0`:
all checks passed. **Re-run it after any change to migration 0159's function.** It does
not touch production: the hosted hook is registered in the dashboard (DEPLOY.md, "Staff
sign in: Google only").

# Proving the activation import's guard in a real database (`pnpm verify:replace-user-schedule-guard`)

#2702: the activation gate imports an agent's cal.com week only when their stored week is
still the seeded default, and it used to decide that with a read and then write
separately, so an admin save landing between the two was overwritten with nothing said.
Migration 0157 moves the condition into the write: `replace_user_schedule` gained a six
argument form taking `p_only_if_source`, which locks the schedule row, compares its
`hours_source` against the source the caller read (null meaning still unstamped), and
raises SQLSTATE `SL409` before writing anything when they differ. The import reports that
as its own reason, `hours-changed-during-import`, rather than as a failed write. Every
part of that is decided by Postgres (the row lock, the null compare, the code, the
rollback, which of two concurrent writers wins), and a fake agrees with whatever it is
told (L52).

`pnpm verify:replace-user-schedule-guard` starts a throwaway Postgres in Docker, lays down
the slice of the schema the functions read, applies migrations 0117, 0129 and 0157
verbatim, and checks: both forms exist with a pinned search_path; a matching source
writes; every mismatch, a null in either direction and a missing row each refuse with
`SL409` and leave the week untouched; the five argument form still overwrites any source;
and two real concurrent sessions in both orders. An admin save committing while the import
waits on the row makes the import refuse; an admin save arriving while the import holds
the row waits and then wins. Removing the `for update` from the migration makes the first
of those fail (checked 2026-10-02), so the race case is not satisfied by luck. It writes
nothing outside the container and removes it on the way out. No Docker is exit 2, never a
pass (L98); any failed check is exit 1.

**Re-run it after any change to `replace_user_schedule` or `replace_availability_rules`.**
It does not touch production. The client half, that the activation import passes the
source it read and maps `SL409` to its own reason, is pinned offline by
`scripts/test-import-write.ts` and `scripts/test-activation-hours.ts`.

# Proving the reroute hold in a real database (`pnpm verify:reroute-holds-sql`)

#3247 (phase 1 of #3244, rerouting a booking into a corrected bucket): migration 0166
adds `reroute_holds`, a trigger on `bookings` that refuses an active booking landing on a
held advisor's window, `place_reroute_hold`, `claim_reroute_hold`, and a bucket aware
`reassign_booking_swap` that moves (or keeps) the agent, rewrites the bucket and trace,
consumes the hold and records a `rerouted` routing decision in one transaction. All of
it is decided by Postgres: the advisory lock per agent, the buffered clash rule, the
SQLSTATE the booker reads as a lost race, and the grants under the platform's default
privileges (L714). A fake agrees with whatever it is told (L52).

`pnpm verify:reroute-holds-sql` replays every migration into the `supabase/postgres`
image and checks, both directions everywhere: a booking, a reassign or a reschedule onto
a held advisor's window is refused as `23P01` with constraint `reroute_hold`, while the
same write on another advisor, exactly one buffer away on either side, after the hold
expires (set by writing `expires_at` in the past, never by sleeping) or after the held
booking is cancelled all succeed; every placement and claim refusal returns its own word;
a claim with two seconds left extends to the two minute confirm lease; a lead reschedule
during the hold refuses the confirm; a move needs a claimed hold, consumes it, keeps
`allow_double_book` false and stays under the overlap constraint; a second confirm returns
the first result; a keep corrects only the bucket and trace; the seven argument swap is
still the plain reassign; and no browser role can execute any of the functions. Since
#3248 (migration 0167) it also proves the hold's busy block: placing a hold writes one
`hold` block for the held advisor at the call's window, replacing, consuming or
cancelling removes it in the same transaction, and an expired hold's block waits for
`prune_expired_reroute_hold_blocks` (the self heal lane's every minute sweep, watched by
the `reroute-hold-sweep` heartbeat), which names the advisors it freed and keeps the
hold row. It writes
nothing outside the container. No Docker is exit 2, never a pass (L98); any failed check
is exit 1. It runs in the DB replay workflow with the other `verify-*-sql.ts` suites.

**Re-run it after any change to `reroute_holds`, its trigger or functions, or
`reassign_booking_swap`.** The refusal words are held in one vocabulary,
`src/lib/db/reroute-hold-refusals.ts`, which `scripts/test-reroute-hold-refusals.ts`
compares against the migration's function bodies in both directions.

# Proving a reroute end to end on production (`pnpm verify:reroute-live`)

#3251 (phase 5 of #3244). The Docker suite above proves the hold in a database with
nothing on the other side of it. This drives the REAL service code against
production: the applied functions and trigger, Google moving a calendar event, the
hold's busy block appearing and going, the booker's candidate list skipping a held
advisor, and a real daily cap count. Only in the test world, so no real advisor is
held or booked and no webhook leaves (L58, L52).

It books on SMOKE and SMOKE2 as well as `PARTNER`, which is the one deliberate
departure from "a live test books PARTNER" (#2760), and it is forced: a reroute
cannot cross event types (the database refuses `event_type_mismatch`), `PARTNER` has
its own, and SMOKE and SMOKE2 share the event type every real bucket uses, so they
are the only pair a held MOVE can be proved between. All three are `is_test`, so
the reasons #2760 exists (no webhook, no monitor reading it as a lead) hold for
each. `PARTNER` carries the only daily cap (8), so its keep is what proves the cap
check leaves the booking itself out of the count.

The run, at a start two to seven days ahead where Google says both test advisors
are clear: a last resort keep (B1 lands on smoketest2@, who is not in SMOKE2, whose
only advisor is busy), a held move (that advisor freed, SMOKE2 holds smoketest@, the
booker leaves them out, the confirm moves the event, a second confirm answers the
same), a plain keep into SMOKE, a keep in `PARTNER` against its cap, and a test call
into 512 refused `across_worlds` with nobody held. Then every call is cancelled and
the run proves nothing is left: no active call, no unconsumed hold, no hold block,
no live calendar event.

```
REROUTE_LIVE_APPLY=1 REROUTE_LIVE_ACTOR_EMAIL=<admin address> pnpm verify:reroute-live
```

It WRITES to production, hence the flag, and acts as a named admin (any rank from
admin up, judged by `atLeast`), who is recorded on each hold and history row. Run it
from a checkout of current main holding `.env.local`. It refuses any start whose five minute budget
would reach the smoke canary's window (three minutes before to eight after `:00` and
`:30`), when the canary may be booking the same advisors, so only starts from eight
to twenty one minutes past each mark go ahead.

| exit | what it met |
|---|---|
| 0 | every step landed and nothing is left |
| 1 | no flag, no acting admin, or no credentials; nothing was attempted |
| 2 | inside the canary's window; nothing was attempted |
| 3 | the test buckets or advisors are not as it expects; nothing was attempted |
| 4 | no start in the next week where both test advisors are clear |
| 5 | a test call could not be booked |
| 6 | **a reroute step did not land as expected**, named |
| 7 | **cleanup left something behind**, named |
| 8 | a test advisor's calendar could not be read |
| 9 | cleanup could not read whether everything is gone, so nothing is vouched for |

**Last run, 2026-10-05 01:48 UTC: exit 0**, all 23 steps at 2026-10-07 15:00 UTC.
The first attempt that night is what moved the run off `PARTNER` for the moves
(`event_type_mismatch`) and found #3281: Google answers a read of a deleted event
with `status: "cancelled"`, which Slate's `eventExists` reads as present, so the run
judges a gone event itself until that is fixed. Its pure decisions (the canary
window, the starts tried, when a start is clear, one code and message per outcome)
are pinned offline by `scripts/test-reroute-live-check.ts`.

**Re-run it after any change to the reroute path** (`src/lib/booking/reroute.ts`,
the reroute wiring in `service.ts`, `findRerouteTarget`, or migrations touching
`reroute_holds` or `reassign_booking_swap`).

# Proving Marcia's Salesforce Lead contact fill (`scripts/verify-marcia-lead-fill-live.ts`)

#4006. #4001 fills a Marcia move's missing name, email or phone from the lead's
earlier Slate bookings and then the Salesforce Lead (`attendeeFor` in
`src/lib/mcp-booking/operations.ts`), the Lead read bounded at 2.5 seconds. Every
suite drives that read through fakes, so this proves it once against the real org,
from the DEPLOYED Worker, the way Marcia reaches it.

It signs its own TEST tokens with Marcia's token key (the same HS256 key Marcia's
Pipedream signer holds), read from the file `MARCIA_TOKEN_KEY_FILE` names, or from
`MARCIA_TOKEN_KEY_A`, and never printed. Nobody needs to read the key into a
transcript: the operator points the variable at the private file that holds it. A
test token routes every call to `PARTNER`, so no webhook, no Regal text and no
monitor counts it (#2760).

The run, in order, stopping before any write at the first problem:

1. reads the Lead from Salesforce here: it must hold an Email and a Phone (or
   MobilePhone), and the Email must be a `@trypennie.com` address, because the
   moved and cancelled invites go to whatever the fill writes;
2. reads Slate: no earlier TEST booking of the lead may hold an email or a phone
   (the move would fill from it before asking Salesforce, and prove the wrong
   source), and the lead may hold no active call in either world;
3. asks the deployed booking MCP (`slate-booking-mcp.trypennie.dev`) for times,
   books one test call HERE with a name only (a net new Marcia book needs all three
   on the token), then moves it through the MCP with a token carrying no name,
   email or phone;
4. reads the moved booking and passes only if its email and phone are the Lead's
   (compared here, never printed). With step 2 holding, Salesforce is the only place
   they could have come from. The slate Worker also logs, by field name only, `a
   lead's missing contact fields were looked up` with `from_salesforce`.

Then, always, it cancels the test call and reads back that it is cancelled. It refuses
to start inside the smoke canary's window, since the partner bucket is smoketest@'s.

```
VERIFY_MARCIA_FILL_APPLY=1 VERIFY_MARCIA_LEAD_ID=<00Q lead id> MARCIA_TOKEN_KEY_FILE=<path> node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/verify-marcia-lead-fill-live.ts
```

Run it from a checkout of current main holding `.env.local` (Supabase and Salesforce
credentials). It is not a `pnpm` alias yet, because the alias must also be named in
`AGENTS.md`'s command table, which is the main session's to edit.

| exit | what it met |
|---|---|
| 0 | the move filled the Lead's email and phone, and the test call is cancelled |
| 1 | no flag, no lead id, no usable token key, or no credentials; nothing attempted |
| 2 | inside the canary's window; nothing attempted |
| 3 | the Lead cannot prove it (missing, no email or phone, email outside Pennie); nothing booked |
| 4 | Slate holds the lead's details or a call already, so the Lead would never be asked; nothing booked |
| 5 | the Lead could not be read from here; nothing booked |
| 6 | find_times did not offer two times on `PARTNER`; nothing booked |
| 7 | **the booking MCP refused a call**, named by code (`token_signature_invalid` means the key is not production's, and pages `marcia_token_refused`) |
| 8 | the test call could not be booked |
| 9 | **the move landed without the Lead's email and phone**: the fill did not come from Salesforce (a timed out or refused read logs `a lead contact lookup failed`) |
| 10 | cleanup left the test call active, named: cancel it by hand |
| 11 | cleanup could not read the test call's status, named |
| 12 | Slate's bookings for the lead could not be read, so whether they answer first is unknown; nothing booked |
| 13 | the move landed but the moved booking could not be read back, so the fill is unmeasured (the call is still cancelled) |
| 14 | the run itself failed in a way no step expected, named |

A cleanup problem (10, 11) wins the exit code, and its message still says what the
run had found before cleanup.

Its pure decisions (which leads can prove it, when Slate answers first, the verdict by
field, the token's claims, reading the MCP's answer, one code per outcome) are pinned
offline by `scripts/test-marcia-lead-fill-check.ts`. **Not yet run live.**

# Proving the advisor photo refresh (`pnpm verify:advisor-photos`)

The daily `advisor-photos` lane (#3027) reads every active person's photo from the
Google Workspace directory and keeps the bytes in `advisor_photos`. Its offline
suites drive every outcome through fixtures, which agree with whatever they are told
about Google (L52), so the command runs the SAME refresh function against the live
directory and database with every write taken out. It therefore applies every guard
the lane applies, the known placeholder hash, the repeated image floor and the flip
guard, and prints what a real run would gain, change, lose and refuse.

```
pnpm verify:advisor-photos
```

It needs the Supabase secret key and the Google service account from `.env.local` /
`.dev.vars`. The subject is `DIRECTORY_ADMIN_SUBJECT` from the environment when set,
otherwise the value `wrangler.jsonc` deploys, so it checks the account production
uses. It writes nothing.

Only a run that read the directory and at least one photo, with nothing held for a
person, passes; finding nothing is never a pass (L98). Exits: 0 pass, 1 no subject, 2
Slate's tables unreadable (before the migration is applied, this one), 3 Google
refused the subject, 4 the directory listing did not answer, 5 every photo read
failed, 10 the flip guard would refuse, 11 a repeated image would be held, 12 a Slate
person is not in the directory, 13 some reads failed, 14 the run reached its ten minute
time limit before reading everybody. Decision logic is pinned
offline by `scripts/test-advisor-photos-verify.ts`.

## How the photos work, and what was measured
Every face Slate draws (the lead's manage page, the roster, an agent's page, the
account menu, the reminder's contact card) comes from ONE resolver,
`resolveAdvisorPhoto` in `src/lib/advisor-photos/resolve.ts`, through ONE component,
`AdvisorAvatar` (initials when there is no photo or it will not load, #2612). The
daily `advisor-photos` lane (04:17 UTC, retried at 10:17 only when the first run
reached no verdict) reads `photos.get` from the Workspace directory as
`DIRECTORY_ADMIN_SUBJECT`, a wrangler var that must be an ADMIN (as an agent the call
answers 403), and keeps the bytes in `advisor_photos`, served at
`/advisor-photo/{sha256}` from Slate's own origin. Three things that were measured
and are easy to get wrong:

- **A 200 is not proof of a photo.** Google serves its grey silhouette placeholder as
  an ordinary image to some accounts. It is held by hash in `KNOWN_PLACEHOLDER_SHA256`
  (`core.ts`), and any image three or more people hold is not written for newcomers
  and is reported, so a NEW placeholder is caught too. A real picture several people
  share (the Pennie logo, measured 2026-10-20) is exempt by hash through
  `KNOWN_SHARED_IMAGE_SHA256` beside it, and is stored for everybody (#3959). The
  held page names that list as the remedy once the image has been looked at.
- **`thumbnailPhotoUrl`'s host says nothing.** #2600 treated `lh3.google.com` as a
  placeholder; 27 accounts there hold real uploads. That rule is deleted.
- **`users.avatar_url` is a fallback, never a picture to draw.** It is the sign in
  photo, used only while the directory has not been read. A measured "no photo" hides
  it. `scripts/test-advisor-photo-reads.ts` fails a surface that reads it raw, and a
  read of `advisor_photos` outside `store.ts` or of its bytes outside the two serving
  readers.

`advisor_photos` is NOT mirrored to Snowflake: a photo is presentational and the
warehouse has no question it answers. Rows of deactivated users are deleted by the
lane. Prove the live half with `pnpm verify:advisor-photos` (it writes nothing).

`pnpm verify:advisor-photos-sql` is its database half: it applies migration 0156 to a
throwaway Postgres in Docker and proves the base64 round trip (bytes read back hash to
what was written), every check constraint, row level security and the revoke from the
browser roles (against a control table the default privileges do reach), and the
cascade on a deleted user. With no Docker it exits 2, UNMEASURED.

**Run it after applying migration 0156 and before trusting the first morning run,
and again after the subject changes** (Dan moves it to a non human admin mailbox at
rollout).

# Proving the audit log hash chain in a real database (`pnpm verify:audit-chain-sql`)

#3090: `audit_log` refuses UPDATE, DELETE and TRUNCATE (0089), but a role with DDL
rights can switch that trigger off, edit a row and switch it back on with nothing to
show for it. Migration 0160 chains every row to the one before it: a BEFORE INSERT
trigger stamps `chain_seq` and `chain_hash` (SHA-256 of the previous hash plus the row's
content) under a row lock on `audit_log_chain_head`, and the monitor lane's
`audit_chain` step re-walks the chain a page at a time, recomputing every hash in the
Worker (`src/lib/monitor/audit-chain.ts`), and pages `audit_log_chain_broken` on a break.

The two halves must produce the same bytes, and the offline suite cannot see the
database's. So this command starts a throwaway Postgres in Docker, lays down the slice
of the schema 0160 reads plus the 0089 triggers, applies 0160 VERBATIM, and proves:

- the backfill chains existing rows oldest first, and the Worker's recomputation agrees
  with every hash, read back the way PostgREST renders rows, in three time zones;
- the trigger chains new rows and overwrites anything a caller supplied;
- six concurrent writers, a rolled back insert and a refused insert leave the sequence
  with no fork and no gap;
- the append only guard still refuses an UPDATE, and the web roles can neither execute
  the functions nor read the two new tables;
- a second run of the migration changes nothing;
- each break the walk names (an edited row, a deleted row, a chain recomputed after an
  edit, rows cut off the end) is caught by the walk itself over the real rows, with a
  control showing the recomputed chain verifies when nothing is anchored;
- a machine write's audit row (#3542, Marcia's `details.channel`, null actor, 00Q id
  and test mark) is chained, and editing only its `details.channel`, with the append
  only trigger off for that one transaction, is caught as an altered row.

It also measures the vector in `scripts/lib/audit-chain-vector.ts`, which
`scripts/test-audit-chain.ts` pins offline, so an encoding change on either side fails
the build. It writes nothing outside the container, which it removes. With no Docker it
exits 2, UNMEASURED.

**Run it after any change to migration 0160's functions or to `audit-chain.ts`.**

# Replaying every migration into an empty database (`pnpm verify:migration-replay-sql`)

#3099: until this existed the migrations had been replayed from empty once, on a
preview branch on 2026-09-02, and RLS and grants were checked only as text, so a
migration leaning on state production already holds (a role, a grant, a snapshot
table a backfill left behind) could merge unnoticed.

It starts the `supabase/postgres` image in Docker, which carries the platform's roles
and its DEFAULT GRANTS (every table `postgres` creates in `public` is granted to anon
and authenticated the moment it exists, L714), and refuses to judge anything on an
image without them (exit 2, UNMEASURED, like a missing Docker), since a refusal
measured there would be a missing grant rather than RLS. Every public table must
still hold the browser INSERT grant except those in `BROWSER_GRANT_EXEMPT`, each
with its reason (`advisor_photos` from 0156, and the two audit chain tables from 0160), and on every
other table only an RLS refusal counts. It creates the CLI's history table, applies every `NNNN_*.sql` as
`postgres`, one transaction per file with the history row `db push` writes, and then
checks: every version reads back through `applied_migration_versions()`; every public
table has RLS on; the only policy a browser role can use is the allowlisted self read
(`BROWSER_POLICY_ALLOWLIST` in `scripts/lib/migration-replay.ts`, each entry with its
reason); as anon and authenticated an insert into every public table is refused; a
signed in user reads their own row and nobody else's and can neither update nor
delete it; no SECURITY DEFINER function in public is executable by a browser role;
service_role, which the Snowflake export reads with, reads every `MIRROR_TABLES`
table and `export_cursor`; and pet_reader reads `pet_export.closed_days` and nothing
in public.

```
pnpm verify:migration-replay-sql
```

A migration that does not apply to an empty database is reported by file name with
Postgres's error, and is a real finding: fix it in a NEW migration, never by editing
an applied one. With no Docker it exits 2, UNMEASURED. It writes nothing outside the
container. `MIGRATION_REPLAY_PG_IMAGE` overrides the pinned image and
`MIGRATION_REPLAY_DIR` the directory, the latter only so a planted control can be
replayed from a scratch copy.

**It runs in CI**, with the other `scripts/verify-*-sql.ts` suites, in
`.github/workflows/db-replay.yml`: on a pull request touching anything they read, and
nightly, where a failure posts to Slack. A suite exiting 2 fails the job there. The
path gate is checked against the suites' real import graph by
`scripts/test-db-replay-workflow.ts`, so an import the gate misses fails `pnpm test`
and names the file to add (L88).

As of 2026-10-03 all 161 migrations replay from empty in about 6 seconds and every
check passes. Seen failing on planted controls: a migration altering
`availability_rules_backup_1255` (a table only production holds), a browser policy
on bookings, RLS turned off on one table, a SECURITY DEFINER function granted to anon,
a grant revoked from bookings with no recorded reason, and a plain
`postgres:17-alpine` image with no default grants (exit 2).

# Proving the lookup by idempotency key uses its index (`scripts/verify-idempotency-key-index-sql.ts`)

#3863: the reservation resume reads the newest booking on a key in ANY status
(`findLatestBookingByIdempotencyKey`, #3847). The only index on the column used to be
0010's partial unique index over active bookings, which a read with no status
predicate cannot use, so the lookup scanned all of `bookings`. Migration 0185 adds a
plain index on `bookings (idempotency_key)`.

A text scan can say the index exists (`scripts/test-idempotency-key-index.ts`, in
`pnpm test`); only the planner can say it is used. This suite replays every migration
BEFORE 0185 into the `supabase/postgres` image, seeds 12,000 bookings (production held
10,586 on 2026-10-16), and reads the plan of the lookup's exact PostgREST shape, as a
custom plan with the key as a literal and as a generic plan with it as a bind
parameter. Both must be a sequential scan there: that is the control proving the
check can fail. It then applies 0185 verbatim in one transaction, as `db push` runs a
file, and both plans must reach `bookings_idempotency_key_idx` with the key as the
index condition. Sequential scans stay ON throughout, so the index wins on cost.

It also shows why 0185 is not `CONCURRENTLY`: a concurrent build run in a single
transaction is refused (`cannot run inside a transaction block`), so such a migration
would not apply through `db push` at all. The plain build over 12,000 rows took about
50ms.

```
node --experimental-strip-types scripts/verify-idempotency-key-index-sql.ts
```

No Docker is exit 2, UNMEASURED. It runs in the DB replay workflow with the other
`verify-*-sql.ts` suites. Seen failing on a planted control, 0185 with its index
removed: six assertions failed, every plan a sequential scan.

# Proving the booking pace readings are written once (`scripts/verify-capacity-fill-sql.ts`)

#4102: the capacity-fill lane saves a reading per page day every half hour through
`record_capacity_fill` (migration 0198). What makes a rerun harmless is decided by
Postgres, not the lane: the function writes only when the org's latest snapshot is still
the one the run read (`p_prev_read_at`) and the run's half hour is later than it, under a
per org transaction lock; readings insert on conflict do nothing; snapshots move only
forward. The offline suite (`scripts/test-capacity-fill.ts`) drives a fake of exactly
that, which agrees with whatever it is told (L52).

This suite replays every migration into the `supabase/postgres` image and drives the
function: the first run writes; a rerun of the same half hour with other numbers writes
nothing and leaves every row as it was; a run that read an older snapshot writes nothing;
the next half hour writes and moves only the days it carries, including a day whose
snapshot was older than the org's latest; another org is untouched; a reading written
without its snapshots is never rewritten; a reading with neither taken nor a reason, both,
or off the half hour is refused; two concurrent runs leave one set of readings with
exactly one told it wrote; RLS is on and neither `anon` nor `authenticated` can run the
function or read a row.

```
node --experimental-strip-types scripts/verify-capacity-fill-sql.ts
```

No Docker is exit 2, UNMEASURED. It runs in the DB replay workflow with the other
`verify-*-sql.ts` suites. Seen failing on six planted breakages of 0198, one at a time:
no lock (both racers told they wrote), no snapshot check, no later half hour check,
readings overwritten, the latest snapshot read across orgs, and EXECUTE left to the
browser roles.

#4103 (migration 0199) adds the pace and estimate columns the day cards read, and
`capacity_fill_pattern`. The suite also proves: every pace and estimate column is stored as
sent; a readings missed pace without its return time, a return time on a measured pace, an
estimate at a time with no time, and a state or method the card cannot read are each refused;
the pattern holds one cell per day position and half hour, all days together and per weekday,
from readings measured over exactly one half hour (a reading after a gap is left out), leaves
out readings before its since instant and never reaches another org; neither browser role can
run it. Seen failing with the half hour filter and the return time check taken out of 0199.


# Proving when cal.com was marked retired is recorded (`scripts/verify-calcom-retired-at-sql.ts`)

#3896: the cal.com anchor under the learned low volume floors retires
`ANCHOR_OVERLAP_WEEKS` after `monitor_alert_config.calcom_retired_at`, and only the database
writes that date: migration 0203's backfill and its trigger. The offline suites read the
migration's text and drive the reader with dates handed to it.

This suite replays every migration before 0203 into the `supabase/postgres` image, marks
cal.com retired with a history of presses in the audit log, applies 0203, and then drives the
switch exactly as `setCalcomRetired`'s upsert does. It proves: the backfill takes the last move
into retired, not the first press or a repeat; while retired, a repeat press and a save of
another setting keep the stamp, a date written by hand is kept (so it can be corrected) and a
null is refused; putting cal.com back clears it and a date written while live is refused; a
retire stamps the moment of the press, or the date the same write names; a first write of the
row stamps or leaves null by its state; the function is invoker run with `search_path` pinned.

```
node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/verify-calcom-retired-at-sql.ts
```

No Docker is exit 2, UNMEASURED. It runs in the DB replay workflow with the other
`verify-*-sql.ts` suites.

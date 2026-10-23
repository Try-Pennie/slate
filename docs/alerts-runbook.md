# You were paged. What now?

One procedure per FAMILY of alert, because the diagnosis clusters even though the keys
do not: a stale lane is one procedure whichever lane it is, and every Google
reachability alert is one procedure with three branches (#1047).

There are close to ninety alert keys, and a hand-written stanza for each would rot, starting with the
ones nobody has ever been paged by, and a runbook section that is wrong is worse than a
missing one because somebody follows it at 7am. So the key-to-family map lives in code
(`src/lib/notify/alert-runbook.ts`) and a guard checks both directions: every alert has
a procedure here, and no procedure exists for nothing.

## Before anything

1. **Read the alert.** The copy names the condition in plain language and, where there
   is one, the action. It is built to be read on a phone (`pnpm preview:alerts` renders
   every message), so it is not a summary of a longer thing: it is the thing.
2. **Ask whether it says it MEASURED something.** Several checks report "could not
   read" rather than guessing, and that is a different problem from the condition they
   watch for. A message saying it could not measure is about the read, not the subject.
3. **Check the site is up**, once, before diagnosing anything specific:
   `GET /api/health` (200 or a 503 naming the stale lane) and
   `GET /api/health/availability` (200, or 503 when the booker is offering nothing).
4. **Ask whether it is a reminder** (#3801). A condition that has not changed is said
   again once a day (hourly for one costing leads right now), and the repeat carries
   "Reminder: still true after ..." on the line under the severity lead (#1825).
   Anything without that line is new: a new subject
   (an appointment, an agent, a pool, a lane) or a measured value that got worse.
5. **Look for an all-clear.** Conditions send one when they clear
   (`docs/../src/lib/notify/alert-catalog.ts` classifies each key), so a page from an
   hour ago may already be over. Incidents never send one: they are finished events.

Logs: `npx wrangler tail` for anything in the last few hours, because the query API can
run hours behind (#1533). Filter on `tag=` (see `docs/cloudflare-platform-notes.md`).

---

## A lane or schedule has gone quiet

Keys: `cron_lane_stale:*`, `monitor_step_failing:*`, `completion_sweep_failing`,
`webhook_retry_sweep_failing`, `demo_auto_cancel_failing`, `sync_staleness`, `detector_parked`, `detector_unpark:*`,
`migration_version_lag`, `volume_count_unreadable`, `audit_write_failed`.

**What fired it.** A lane stamps a heartbeat on every run and one has not stamped
inside its bound (about 3x its cadence). Or a detector has not reached a measured
verdict in far longer than its longest legitimate silence, which is a different thing
from a lane that has stopped: the lane ran and could not conclude. Or the lane is
running perfectly and one JOB on it has stopped producing, which is
`monitor_step_failing:*` and the two sweep failure keys: there the heartbeat is
fresh, and nothing but these would say so.

The two daily time off lanes carry FOUR stamps between them (#2543), in pairs. A
page on `ooo-approvals` or `ooo-digest` means the cron is not reaching the route at
all, so start at `worker/cron-routes.ts` and `wrangler.jsonc`. A page on
`ooo-approvals-report` or `ooo-digest-nudge` means the route is firing and the work
is not finishing, so start at the tail. The approvals report catches up its own gap
from a watermark when it next runs, so the missed mornings are still recoverable.

`cron_lane_stale:log-shipping` (#3182) is not a lane: it is the receipt the tail worker
hands Slate each time Better Stack accepts a cron tick's records, and it means log
history has stopped reaching Better Stack. Nothing about the site is wrong. Start at
`npx wrangler tail slate-log-tail`, which logs every dropped batch by reason and every
receipt that did not land; DEPLOY.md, "When records stop arriving", maps each reason to
its fix. If the page says shipping was NEVER confirmed, the usual cause is a tail worker
not redeployed since the receipt shipped (`npx wrangler deploy -c wrangler.log-tail.jsonc`).

**First checks.**
- The Cloudflare dashboard's cron triggers: did the schedule fire at all?
- `npx wrangler tail`, attach, and wait one cadence. A lane that is running logs a
  cycle line every tick.
- `GET /api/health` names the stale lane in its 503 body.
- For `migration_version_lag`: has a migration been committed and not applied? That is
  the usual cause, and `docs/migrations-runbook.md` is the fix.

**Fix or escalate.** A lane that is not firing is a platform-level problem (a bad
deploy, a Cloudflare incident): redeploy, and check the deploy actually landed
(`GET /api/smoke/version`). A lane that fires and throws is a code problem: the tail
shows the error. Each lane runs as its own placed invocation (#3693), but a lane that
fell back to in process (`<lane>_via=in_process` on the `lane timings` line) shares the
cron's invocation budget, so a slow one can starve its neighbours
(`docs/cloudflare-platform-notes.md`).

---

## The booker is offering nothing, or too little

Keys: `empty_tier:*`, `bucket_slots_stale`, `availability_booked_solid`,
`availability_data_anomaly`, `availability_drift:*`, `fallback_covered_availability`,
`thin_tier_staffing`, `tier_fallback_deep:*`, `no_eligible_agents:*`,
`low_booking_volume`, `booking_failure_rate`, `booking_failure_burst_ended`,
`booking_failure_volume`, `booking_budget:*`, `calendar_window_uncovered`,
`booker_unstaffed:*`, `public_booking_stopped`, `booking_race_contention`,
`booking_race_bound_hit`, `pool_nearly_full`, `roster_filling_up`, `busy_cache_drift`, `offered_nobody_free`,
`smoke_canary_failed:*`, `booking_embed_ip_cap`, `booking_embed_contact_cap`,
`booking_embed_honeypot`.

**What fired it.** Something between the roster and the cache means a lead sees fewer
times than they should, or none. The alerts are deliberately split by CAUSE, because
"booked solid" is a staffing fact and "data anomaly" is a bug, and they call for
opposite responses (#570).

**`roster_filling_up` is good news with a decision attached, not a fault** (#2590). The
whole roster's call capacity over the next two days leads can book is booked at or over
the nearly full line an admin sets on Team capacity (`booking_settings.capacity_nearly_full_pct`,
85 by default). The share is Team capacity's own (calls that still fit against what the
shifts could hold, out and not syncing advisors left out), measured every half hour by the
capacity history lane (`src/lib/monitor/roster-fill.ts`). The two days are the booker's,
so from 6 PM New York time they are tomorrow and the next open day, while the Team capacity
page still shows today first (#4064, #3949). What to do: follow the notice's Team capacity
link to see which days and advisors are full, and decide with whoever runs ad spend whether to
turn it down. It posts again only when the share climbs another five points, otherwise once
a day, and clears on a measured reading under the line. To change when it fires, move the
line on Team capacity. Silence can also mean the lane could not measure: look for
`tag=capacity-history msg="roster fill"` with `status="unmeasured"`.

**`smoke_canary_failed:*` is the booking canary failing against production** (#3801). The
key is the pass, `dry` (every 30 minutes) or `full` (every 6 hours), and the message names
the checks that failed and links the run. The workflow hands the failure to the Worker,
which posts it at once when a check is newly failing and otherwise once a day; a clean run
of that pass posts the all-clear (a clean full pass clears both). If the Worker could not
be reached the workflow posts the same message itself, so a post with no all-clear to
follow can mean the Worker is down: check `GET /api/health` first.

**`booking_embed_ip_cap`, `booking_embed_contact_cap` and `booking_embed_honeypot` are
the booker's OWN limits turning people away** (#1727). The two caps page on how many
DISTINCT addresses, or emails and phones, the limit is refusing at once, read from the
limiter's rows, never on how many requests it refused: one bot reusing one identity
trips the contact cap on every request, and that is the cap working. So the first
question is who the keys belong to. Read `tag=booking-rate-limit msg="throttled"` with
the scope the page names (`"hourly"` or `"contact"`): many unrelated addresses that
each booked a few times is real traffic and the repair is the rule the page names in
`src/lib/rate-limit-core.ts`; a few addresses sending the same shape is a bot and needs
nothing. The honeypot page means the hidden field was filled across several intervals.
Nobody can see that field, so it is either a script (the trap is absorbing it) or the
field has become visible or autofillable and real leads are being refused with a
generic error: check whether bookings dropped in the same hour, and if they did, check
the booker's form before anything else. All three clear on their own once the
condition ends. Their floors come from a measured week of traffic in
`src/lib/monitor/embed-refusal-thresholds.ts`.

**`empty_tier:*` is about a whole DEBT TIER, not a bucket** (#2505). It fires when
Low, Medium, High, Very High or Ultra High is offering no booking time on any of the
days the booker shows a lead (the next offered open days, #3559: three unless changed
on the Hours page, #3922), and it says which of
the two reasons it is: nobody is
assigned to the tier at all (a hiring or Twilio tag repair), or the tier has agents
and none of them has an opening (a schedule, a calendar or a capacity repair). A
bucket or a backend inside a tier that is still offering times is deliberately NOT
reported: since #2486 the ladder tries every bucket in the tier before dropping
one, so those leads are served.

**`offered_nobody_free` is the opposite direction: a bucket is serving a time nobody in
its own pool is free for** (#3381). The monitor lane judges a few served times every five
minutes with the confirm's own candidate read, remembers one it finds nobody free for,
and pages only if it is still served that way a recompute freshness window later, so a
calendar change the lane has not reached yet never pages. The page names the bucket, the
time, how long, and which path wrote the stored row (`written_by`, #3381).

- Read the Worker logs for `msg="offered time nobody is free for"` and the matching
  `msg="slots served"` line. A row whose writer recomputed it AFTER the first sighting
  and still offers the time is a compute that disagrees with the confirm: compare what
  that writer feeds the compute against the candidate read. A row that has not been
  recomputed since is the lane falling behind, and `bucket_slots_stale` says so too.
- It clears once every remembered time has been taken off or judged free.

**`booker_unstaffed:*` means a real customer arrived and was shown nothing**
(#2158). It is a narrower witness than `empty_tier:*`: that one measures the tier
whether or not anybody is looking, and this one fires because somebody was, on the
one bucket they opened. Before cutover almost nobody is, so treat this as the more
urgent of the two.

- Staff the bucket, or take its link out of use. Nothing else clears it, and the
  customer who triggered it has already gone.
- It is throttled to one per bucket per half hour, so the count in Slack is not the
  count of customers who met it.

**`booking_race_contention` and `booking_race_bound_hit` are leads colliding on one
time** (#2838). Since #2281 a confirm that loses the overlap race is handed to the next
free advisor in the same bucket, up to three times, before the lead is asked to pick
another time. The whisper is the day's share of confirms that lost one, sent when it is
above about 1.8 percent, the most the busiest tier's measured traffic could produce even
if every lead picked the same time (`src/lib/monitor/race-contention.ts` derives it).
The page is one lead refused at the bound, sent the moment it happens. Look at the day's
bookings whose `routing_trace` carries `race_lost`, by start time and bucket: many
leads on one time points at a replayed link or a burst from one source, which is a
question for the booking ceiling; races spread across many times points at slow
confirms widening the race. Refused confirms made no booking, so they are only in the
logs (`tag=booking msg="confirm lost the overlap race and was refused"`).

**`public_booking_stopped` is the one cause in this family that is not a fault**
(#2366). Somebody threw the kill switch on purpose and it has been on longer than the
incident lever is meant to be held for, so the booker is refusing every new booking by
design. It is first in this section for a reason: while it stands, `low_booking_volume`
reports the same silence as a drought and sends a reader after a funnel problem that is
not there, so **check the switch before anything else here**. The Overview and the admin
business hours page both show it, and starting booking again is what ends the notice; if
it is still meant to be off, nothing needs doing and the notice repeats while it stands.

**`booking_failure_rate` pages only while failures are still happening** (#3275). It
needs both the last 180 minutes over 20% failed AND the last 30 minutes holding more
failures than a clean run allows, and it says "Still failing" and when the window's
failures were recorded (ET). It stands down only when the last 30 minutes hold at least
5 attempts with no more than 5% failed, so a quiet half hour clears nothing. A burst
that had already stopped when the window crossed the line arrives instead as
`booking_failure_burst_ended`, once, worded as past: nothing to stop, but the same
investigation of what refused people, in `/admin/booking-outcomes` over the times it
names.

**A proven lost race never pages** (#3797, Dan 2026-10-16). A time refused at the cached
free check whose advisor was free when the lead's list was computed, and was taken by a
booking or a calendar event written since, is tallied on its own row
(`race_since_offer`), outside the attempts and the failures both pages count and outside
the people they name; the pages say how many were counted apart. Only a time offered when
it was never free still counts as `slot_unavailable`, so when that code leads it really is
the availability cache to start with. A confirm that carried no `computed_at`, one that
could not be judged, and one handed a list a refusal had already proven stale all count as
before. The verdict is on `routing_decisions.offer_verdict`.

**`booking_failure_volume` is the fast page beside the share** (#3276). It fires when 10
or more booking attempts fail in the last 30 minutes (the last six five minute ticks),
whatever share of traffic that is, so a run of refusals pages within minutes rather than
waiting for three hours of successes to be outweighed (on 2026-10-04 it would have paged
at 7:50pm ET, 55 minutes before the share did). It says whether it looks like a sell out
(times offered and refused at confirm, `slot_unavailable`) or Slate failing (errors and
timeouts, named by code). The people it names are a floor: a confirm answered behind
another in a crowd records nobody. It stands down on the same measured clean half hour as
the share, never when the count drops under ten.

**`booking_budget:*` is the month, not the minute** (#3179). Half of what the booking
success (98.5%) or availability (99.5%) target in `docs/slo.md` allows this month has been
spent. Nothing is necessarily failing now: read `/admin/booking-outcomes` over the month
for which error codes spent it. Ordinary contention (`slot_unavailable`) spends only the
success budget; a server fault spends both, and is the one to chase first. It clears on
its own when the month turns over.

**First checks.**
- Is public booking stopped? The admin Overview says so in a row of its own, and
  `public_booking_stopped` names how long it has been. Everything below is a different
  question.
- `GET /api/health/availability`: 503 with `staffedBuckets` tells you whether the
  fleet or one tier is empty. `staffedBuckets: null` means it could not measure, which
  is its own answer (#1629).
- `/admin/tiers` for the depth per tier, and `/admin/bucket-availability` for what a
  bucket is actually offering.
- Is this staffing or code? Booked solid and thin tier staffing are staffing. Data
  anomaly, stale slots and drift are not.

**Fix or escalate.** Staffing: the pool needs more bookable agents in that tier, which
is a decision for whoever owns the roster, not a code fix. Stale slots: check the
recompute lane is running (family above). Drift: the cache disagrees with Google, so
run `pnpm verify:availability-truth` against a real agent and read what Google says.

---

## A sweep cannot keep up

Keys: `completion_sweep_saturated`, `reconcile_cancelled_saturated`,
`reconcile_missing_saturated`, `deletion_drain_saturated`, `pending_event_deletions`,
`recompute_headroom`, `cron_budget_headroom`.

**What fired it.** A per-tick budget was exhausted with work still waiting. This is not
a failure: each of these sweeps is bounded on purpose so it cannot eat the invocation
budget its neighbours need. It means the backlog is growing faster than the bound
drains it.

**First checks.**
- Is it a spike or a trend? One saturated tick after a bulk operation is expected. Every
  tick for an hour is not.
  `recompute_headroom` already applies that test itself (#2021): it pages only once the
  lane has been behind for longer than the freshness window (5 minutes running) and says
  it is over only after it has kept up for as long again, so one of these means the
  lane, not a wobble, and the thing to read is #2022.
- What is in the backlog? The alert names the table and the count.
- `cron_budget_headroom` (#3141) is the invocation rather than one sweep: some tick in
  the last day used more than 60s of CPU, half the 120s ceiling Cloudflare kills it at.
  It is read hourly from the Worker logs' CPU time for each scheduled invocation,
  and the page names each schedule with its max and p99. Which lane spent it is under
  `tag=cron msg="lane timings"` for the ticks named. A page dated before 2026-10-04 was
  the old WALL time version, which was switched off because waiting is not CPU; the
  first measured day under the line clears it.
- Is the work itself failing, so nothing ever leaves the queue? That is a different
  family (a side effect that did not complete, below).

**Fix or escalate.** A one-off spike drains on its own; do nothing. A trend means the
bound is now wrong for the volume, which is a deliberate change to a constant, with the
subrequest budget in mind. A backlog that never drains means the work is failing, not
that the budget is small.

---

## Google cannot be reached for an agent

Keys: `sync_failures`, `watch_lapse`, `bookable_blocked:*`, `bookable_unverified:*`,
`verify_on_book_outage`, `verify_on_book_calendars_read`, `hydration_all_failing`,
`pending_event_deletions_refused`, `google_calendar_breaker_open`, `owner_alert_skips`,
`refused_advisor_left_pool:*`.

**`refused_advisor_left_pool:*`** (#3700) says Slate has already taken one advisor out
of the pool, because Google refused every calendar they hold, `gone` or
`not-provisioned`, for over an hour (`REFUSED_POOL_EXIT_AFTER_MS` in
`src/lib/bookable/refused-pool-exit.ts`) on several reads. The sync lane decides it, on
a tick where that advisor's read failed again. Archiving an account in the Workspace,
which offboarding does, is the usual cause. The advisor is not departed: `bookable` is
false and `bookable_pending_since` is stamped, so the hourly roster run retries their
activation and the activation gate refuses them until every calendar reads. That
refusal posts `bookable_blocked:*` once for the episode, not on every hourly retry,
and again only when the reason changes: the retry knows the episode by the pool exit's
audit row (`via: calendar-refused`, `pending_since` equal to the row's current mark).
`agents_awaiting_activation` names them once past its four hour grace and then
reminds daily, as any condition does. If they have left, nothing is needed: the Salesforce reap departs them and
the retries stop. If they have not, restore the account (the branches below), and they
come back on the next hourly run. To keep them out for good, press "Stop trying to make
them bookable" on their profile, which clears the mark. If the note says a pool now has nobody bookable, check
`/admin/tiers` for where those leads go.

**`owner_alert_skips`** (#2436) says more than a fifth of the last week's owner alerts
(the "previously pitched" event on the owning advisor's calendar, #2371) were skipped
because the calendar is `gone` or `not-provisioned`, across at least three advisors.
The calls are booked; what is missing is the alert. The rows are `owner_alert_events`
written in the last 7 days with a `skip_reason`; group them by `user_id` to see whose
accounts to fix, then follow the `gone` or `not-provisioned` branch below. One advisor
alone never pages, and the all clear needs a measured week back under the line.

**What fired it.** A calendar read failed, repeatedly, for one agent or for many. Or,
for `pending_event_deletions_refused` (#2577), a queued calendar event DELETE was
refused with a definitive status, so the drain stopped retrying it on that pass: the
row sits in `pending_event_deletions` at the give-up count with `last_error` naming the
kind, and the cancelled meeting is still on that agent's calendar until the account
below is fixed and the event removed by hand. The drain asks Google once per calendar
in a pass: once one row is refused, the calendar's other queued rows are settled the
same way without a call of their own, and their `last_error` says they were not tried
(#1630). This page is only ever about an owner who is still active, or one Slate could
not read: Google answers a licence offboarding REVOKED with the same
`403 notACalendarUser` it gives one never granted, so a calendar whose owner has left
goes out as `pending_event_deletions_departed` on the info channel instead, under
"Something was measured and is only worth knowing" below.

**The branch that decides everything** is the failure's classification, and the alert
carries it (`gone`, `not-provisioned`, `transient`):

- **`not-provisioned`** (`403 notACalendarUser`): the account has never been given
  Calendar. Retrying can never fix it and nothing is wrong with the credentials. A
  Workspace admin has to give that person Calendar. Expect this for a new hire who
  reached Slate before their Google provisioning completed.
- **`gone`** (any other 4xx): a credential or membership repair. The account was
  removed from the Workspace, or delegation was revoked. Either fix the account or take
  them out of the pool.
- **`transient`** (5xx, timeout, rate limit): usually self-heals. If EVERY agent is
  failing, it is not the agents: check domain-wide delegation and the service account,
  because `hydration_all_failing` is the shape that means the credential itself broke.
- **`google_calendar_breaker_open`** (#3134): Google itself stopped answering (five
  transient failures in a row), so Slate is holding Calendar calls back and trying one
  every 30 seconds. Check Google's status page before anything in Slate. Bookings answer
  "try again in a moment" until it closes, and the all-clear arrives on its own when a
  probe call is answered.

**Fix or escalate.** One agent, `gone` or `not-provisioned`: a person action, and
`bookable` should go false until it is done, or the rotation spends its budget retrying
a hopeless account. Since #3700 Slate does that itself after an hour
(`refused_advisor_left_pool:*` above), so turning them off by hand only saves that hour. Everyone at once: the delegation. Never branch on `kind === "gone"`
in code (see `AGENTS.md`).

---

## A booking side effect did not complete

Keys: `outbox_drain_stuck`, `outbox_all_handed_off`, `reservation_drain_stuck`,
`reservation_created_owed`, `booking_event_insert`, `busy_block_write_through`, `reconcile_busy_blocks`,
`reconcile_missing_busy_blocks`, `creation_orphan_events`,
`reassign_intent_dropped`, `reschedule_pin_dropped`, `reschedule_invite_stranded:*`, `reschedule_lock_outage`,
`stale_phone_invite:*`, `phone_correction_unsent:*`, `webhook_dead:*`, `webhook_event_no_subscriber`,
`handoff_channel_unset`, `handoff_undelivered`, `bookable_trait_unrecorded:*`,
`booking_follow_up_left_to_drain`, `booking_invite_moved:*`, `booking_invite_resized:*`,
`booking_invite_check_failed:*`, `booking_invite_launch_sweep`.

**What fired it.** A booking exists and something that should have followed it did not:
a calendar invite, a busy block, a webhook to Regal. **A real customer is affected**,
which is what makes this family different from the ones above.

**First checks.**
- The alert names the rows. `booking_outbox.last_error` is the diagnosis for a stuck
  drain; `webhook_deliveries.last_error` for a dead endpoint.
- Is it one booking or all of them? One is a data or a Google problem for that booking.
  All is a broken code path, and the deploy that shipped it is the thing to look at.
- For `webhook_event_no_subscriber`: this is a configuration gap, not a fault. A new
  event type ships inert until the live endpoint's `events` array names it (#1459), and
  that is a database update, not a deploy.
- For `handoff_channel_unset` and `handoff_undelivered`: a booking is waiting on a
  person in sales (a duplicate Slate would not cancel, an owner move it refused) and
  the notice has not reached them (#2367). The rows are in `booking_handoffs`;
  `last_notify_error` says why the last post failed. Unset means the handoff channel
  on `/admin/alerts` is blank; undelivered with a channel set is usually the Slate app
  not being in that channel. Nothing is lost while it waits: the lane retries every
  tick and the page clears once each open handoff has been posted.
- For an `outbox_drain_stuck` whose `last_error` names `reassign:owner_notice`: that is
  the Slack notice telling the sales side a lead went to the advisor who owns them
  (#2372), and it is the one member of this family where **no customer is affected**.
  The move itself, the calendar invite and the `booking.reassigned` webhook are all
  separate steps and have already completed; only the announcement is outstanding. The
  cause is almost always the same as `handoff_undelivered`, since it posts to the same
  channel: the Slate app is not in it. A BLANK handoff channel does not reach here at
  all, because the step records that in the log and completes rather than retrying.

- For `booking_follow_up_left_to_drain` (#3267): over the last hour, more than a tenth
  of the confirms that made a booking answered the lead before the work after their
  save had finished (at least 3 of at least 10, or half of a quieter hour), so the
  reservation drain is finishing it. **The leads are booked**; what waits is usually
  their `booking.created` webhook to Regal, or the reservation's own delete. First
  check `reservation_drain_stuck` is not also firing: if the drain is finishing them,
  the cause is the confirm path being slow, and the Worker log line "the booking
  committed and the work after it did not finish" names each booking and the error
  that cut it off. It clears on a measured clean half hour of confirms. The healthy
  rate is zero: none in the 2,933 bookings of the week before it shipped.

- For `reservation_created_owed` (#3847): a booking committed more than a day ago and
  Regal has never been sent its `booking.created`, most often because the booked bucket
  no longer resolves (#3516). The reservation is the only record that the send is owed,
  so retention keeps it rather than deleting it after a day, and this pages once a day
  until it goes. `booking_reservations.last_error` says why. Either restore the bucket
  and set the reservation's `attempts` to 0 (past 50 the drain no longer retries it),
  so the drain sends the webhook and deletes the reservation itself, or tell Regal about
  the booking by hand and then delete the reservation. It clears only on a sweep that
  read every candidate and found none owed; a sweep whose read fails neither pages nor
  clears, and its error is in the Worker log under `tag=booking`. The full sequence is
  in `docs/dr-runbook.md`, "How long a reservation is kept".

- For `phone_correction_unsent:*` (#1512): a lead corrected their number on the manage
  page and the `booking.contact_updated` delivery was never recorded, so nothing retries
  it. The booking and the advisor's invite already hold the new number; Regal's contact
  profile still has the old one as primary. Read the number off the booking and set it
  primary on the lead's Regal profile. The Worker log line under `tag=manage-contact`
  ("phone correction not recorded for downstream") carries the underlying error.

- For `bookable_trait_unrecorded:*` (#2085): an agent's bookable state changed and the
  delivery telling Regal was never recorded, so nothing retries it and **no customer is
  affected yet**. The change itself is saved. Run `pnpm backfill:bookable-trait` to send
  every agent's current value again (a re-run always sends); the Worker log line under
  `tag=bookable-trait` carries the underlying error.

- For `reschedule_pin_dropped` and `reschedule_invite_stranded:*` (#757, #3924): a
  reschedule crashed before it saved its new time, so the booking is still at its
  original time. An in place move PATCHes the lead's invite (emailing them) before it
  saves, so the abandoned pin sweep reads the invite and, when it is at the crashed
  move's time, moves it back to the booked time, emailing the lead again; the dropped
  post counts those. `reschedule_invite_stranded:*` is one booking whose invite it
  could NOT put back: Google refused, the invite was gone, the booking or invite could
  not be read, or the invite was at a third time Slate never wrote (the post says
  which). Until a person acts the lead's invite may say a time Slate does not hold.
  Reschedule the call in Slate to the time the lead wants (which moves the invite and
  tells the lead), or have the advisor put the invite back.
- For `booking_invite_moved:*` (#3919): an advisor moved a booking's invite in Google
  Calendar and Slate did NOT put it back, because it was the booking's second move, the
  call starts within 30 minutes, Google refused the revert, or (#3925) Slate found the
  move on a full read of the calendar (a bootstrap, an expired sync token, or the daily
  rotation) and so cannot tell when it happened (the post says which, and Google's short
  reason). The advisor and their manager of record were DMed where the post says so; a
  move found on a full read DMs nobody. A cancel that deletes the invite while Slate is
  putting it back is Slate's own change and is not posted. Until a person acts, the advisor is blocked at both the booked and the
  moved time and the lead still holds the booked time in Slate, its reminders and
  Regal. Act on the booking page the post links: reschedule the call in Slate to the
  time the advisor wants (which also moves the invite and tells the lead), reassign it,
  or have the advisor move the invite back. A post saying the advisor "could not be
  messaged" after a successful revert only needs somebody to tell them call times
  change in Slate. Every change is recorded in `booking_invite_changes`.
- For `booking_invite_resized:*` (#3919): the advisor changed only when the invite
  ends. Nothing needs doing; it is posted so its frequency can be seen.
- For `booking_invite_check_failed:*` (#3919): an invite out of step with its booking
  could not be checked (a database or Google read failed, the reason is in the post),
  so it was neither put back nor anybody told. It is deliberately not allowed to fail
  the calendar sync, which would stop all of that advisor's meetings being cached. Both
  times stay blocked; handle the booking as a `booking_invite_moved:*` post, and look
  at the Worker log under `tag=invite-move` if several arrive.
- For `booking_invite_launch_sweep` (#3919): the one launch report from
  `pnpm sweep:moved-invites --apply`, listing invites that were already out of step
  when Slate started watching. None were put back; handle each like a
  `booking_invite_moved:*` post.
- None of the four is ever raised for a smoke test booking (#3930), meaning the
  canary's and the hand run tests' bookings (an `is_test` bucket, read by
  `bookingTestFlags`). The live handler still judges, records and puts back a test
  booking's invite as usual, and it and the check failed page replace the advisor DM,
  the manager DM and the post with the Worker log line `test booking invite change
  not alerted` under `tag=invite-move`, which names the booking and what was
  withheld. The launch sweep puts nothing back for any booking; it records and blocks
  a test booking's invite like the rest, leaves it out of the message, and prints its
  id instead.

**Fix or escalate.** The outbox retries with backoff and gives up at a cap, so a row
past the cap needs the underlying cause fixed and then a re-drain. An orphaned calendar
event or a missing busy block is repaired by the self-heal sweep once the cause is
gone. A double book (`external_double_book`) is the one to treat as urgent: two people
believe they have the same slot, and somebody has to talk to one of them.

---

## Time off cover or protection is in doubt

Keys: `ooo_coverage_gap`, `ooo_coverage_gap_later`, `ooo_coverage_stop`,
`coverage_needs_human`, `inactive_agent_bookings`, `ooo_protection_lost`,
`ooo_busy_block_fallback`, `ooo_calcom`, `ooo_calcom_unprotected`,
`ooo_calendar_create`, `ooo_agent_calendar`, `ooo_manager_calendar`.

**What fired it.** Either somebody is off and their appointments have nobody covering
them, or a time off window that Slate promised to protect may not actually be blocked.

**First checks.**
- `/admin/ooo` for the request, its status, and what its side effects recorded.
- For anything about PROTECTION, do not trust the stored record: it was written by the
  code under test. Run `OOO_VERIFY_REQUEST_ID=<uuid> pnpm verify:ooo-protection`, which
  asks Google for the event AND for free/busy, because busy periods merge and a
  neighbouring meeting can make an absent event look like a perfectly blocked window
  (#1464).
- For coverage: are the appointments still assigned to the person who is off?

**Fix or escalate.** A missing calendar block is re-created by re-running the approval's
side effects. A coverage gap is a decision about who takes those appointments, which the
admin coverage panel does. `coverage_needs_human` means the automatic reassign declined
on purpose and is waiting for somebody. It counts each call once, only once the sweep
that gave up on it has finished (or 30 minutes after the give up, for a sweep that is
still running), and only while the call is still with the agent that sweep was moving
it off. A call stranded after a page pages again straight away rather than waiting out
the cooldown, so the newest page always carries the whole count (#3303).

---

## The roster or routing data is wrong

Keys: `agent_sync_failures`, `agents_without_routing`, `agents_without_schedule`,
`roster_coverage_gap`, `roster_coverage_upcoming_gap`, `salesforce_user_id_conflicts`,
`salesforce_manager_ambiguous`,
`misroute:*`, `rr_ordering_degraded`, `reassign-unknown-reason-code`,
`booker_empty_reason`, `schedule_parity_drift`, `agents_on_unset_hours`,
`booking_offsite_origin:*`, `ladder_advisor_unreadable`.

**What fired it.** Slate's picture of who works here, who they report to, or what they
are eligible for disagrees with Salesforce, or with itself.

**First checks.**
- Salesforce is the source of truth for the roster and for `manager_id`; Slate cannot
  fix those, only report them. A conflict or an ambiguity needs fixing THERE.
- `/admin` for the agent list, `/admin/agents/<id>` for one agent's attributes and hours.
- An agent with no schedule is expected before go-live (every agent sets their own hours
  at cutover) and is a real problem after it.

**`schedule_parity_drift` is the one that compares Slate against cal.com** (#2031), so
it is answered differently from the rest of this family. It fires from the daily
`schedule-parity` workflow and names the agents whose hours, days, timezone or pool
membership the two systems disagree about, while both are live and cal.com is still
taking every real lead.

- For an hours, days or timezone difference, cal.com is the system those agents have
  actually been maintaining, so it is the better source: run
  `APPLY=1 pnpm import:calcom-schedules`, which is idempotent and reports what it
  changed. That fixed all 21 differences on 2026-09-07.
- For a roster difference (somebody who has left Slate and can still be booked in
  cal.com, or the reverse) there is no command. Salesforce is the source for both, so
  a divergence means one side's sync has stalled, and a person decides which.
- Reproduce or check it by hand with `pnpm verify:calcom-parity`, which exits on a
  different code per finding.

**`agents_on_unset_hours`** (#1753) names bookable agents whose week is still the
seeded default nobody chose: since migration 0117 every writer of a week records
itself (`hours_source`), and a week the seeding wrote, or a pre stamp week still
shaped exactly like the org default, is this finding. Fix by importing their real
hours (`APPLY=1 pnpm import:calcom-schedules`) or setting them under the agent's
hours; the same daily sweep clears it.

**`booking_offsite_origin:*`** (#2715) names one booking on a REAL bucket whose host
page declared an origin that is not the production site (`PRODUCTION_ORIGINS` in
`src/lib/monitor/offsite-origin.ts`): localhost, a preview or staging host, or an
address Slate cannot read. It is almost always somebody testing on a real code, and
the advisor and the lead's reminder texts are live. Open the link and cancel it unless
the lead is real. Tests belong on the public test bucket (#2660), which never pages.
The origin is what the host declares, so a real lead on a misconfigured page reads the
same way; that is why it pages rather than refuses.

**`ladder_advisor_unreadable`** (#3530) names bookable advisors every confirm is
leaving out, because a row the confirm reads to judge them could not be read: their
profile (an empty email, no teams), a bucket membership, their hours or a time zone
nobody recognises, or a busy time, hold or count on their calendar. The confirm drops
the WHOLE advisor rather than the bad row, because a missing busy time or hold would
make them look free and get them booked over a call they already have, so the leads
are safe and the advisor gets no calls. The page names what to correct; the read is
`ladder_candidate_inputs` (migration 0176) and the rules are `ladderInputsFrom`
(`src/lib/availability/ladder-inputs.ts`), whose `ladder-inputs` log line on each
confirm names the exact section and field. Correct the record (under the agent's page,
or in Salesforce for a roster field) and the next five minute pass clears it. A zone
Postgres itself rejects is the one case this cannot name: once that advisor has a call
in the days the read counts, the count inside the read fails for everybody, which
pages as confirms failing rather than as this. The schedule writer refuses such a zone
(`IANAZone.isValidZone`), so only a row written around it can do that.

**Fix or escalate.** Data problems go to whoever owns the Salesforce record.
`misroute` and `rr_ordering_degraded` are Slate's own routing reporting something it
did not expect, which is a code question: read the routing decision log for the booking
named.

---

## Two calls on one advisor sit inside the buffer

Keys: `booking_buffer_breach`.

**What fired it.** Two upcoming active calls on one advisor sit closer than the call
type's buffers allow: the later one starts less than the larger of the earlier call's
after buffer and the later call's before buffer after the earlier one ends, or the two
overlap (#3040). Neither call carries `allow_double_book`, and neither is in a test
bucket. The advisor goes straight from one lead to the next with no time to write up
the first, and an overlap means one lead will be kept waiting.

**What it is not.** Every offer and every confirm judges the buffered window, so a
breach is not an ordinary booking. A forced reassign (the manager picker, the demotion
move back, the contact owner reassign) stacks a call on a busy advisor on purpose and
sets `allow_double_book`; those pairs are counted as `forced` in the monitor's result
(`bufferBreach.forced` and `bufferBreach.forcedPairs` in the `/api/cron/monitor`
response, and the `buffer breaches` log line) and never page.

**Check a pair.** The page names both bookings by id and links each one.
- Open both. Confirm they are on the same advisor, both active, and at the times the
  page says.
- Compare each booking's `created_at` with when the call type's buffer last changed
  (`/admin/event-types`, and the `event_type.gap` row in `audit_log`). **The usual
  cause is a buffer raised after the bookings existed**: the 57 pairs behind #3040 were
  all booked while the buffers were 0 and 0, before a hand edit (which left no audit
  row) made them 10 and 10. Nothing moves a booking when a buffer is raised, so every
  pair made under the old value breaches the new one until it passes.
- The other usual cause is a forced move that did not mark itself: a reassign or a hand
  edit that put a call on a busy advisor without `allow_double_book`. The routing trace
  on the booking page (`reassignments`) says whether the call was moved.
- A pair that fits neither, created after the buffer last changed and never moved, is a
  booking path that skipped the buffer: a code fault. Keep both ids and file it.

**Fix or escalate.** Move one call of each pair to another time or another advisor
from its booking page, or leave a pair the manager wants stacked and accept the daily
reminder until it passes. The page clears by itself once a measured tick finds no
breach. If it pages on the first tick after a buffer was raised, the whole list is the
bookings made under the old value: decide with the sales manager whether to move them
or let them pass.

---

## The warehouse mirror or an erasure is in doubt

Keys: `snowflake_healthcheck`, `snowflake_reconcile_drift`, `snowflake_erasure_residual`,
`snowflake_erasure_residual_test`, `snowflake_purge_sql_broken`, `retention_skipped:*`.

**What fired it.** The archival mirror disagrees with Supabase, or contact data somebody
asked us to delete is still in the warehouse.

**First checks.**
- `GET /api/admin/snowflake-check` (admin) proves the login, host, key pair and grants
  end to end. If that fails, nothing else in this family will make sense.
- For drift: the reconcile lane counts rows per table both sides and names the table. A
  single stranded row counts, deliberately, with no tolerance.
- For a residual: the erasure audit names the booking. Remember the export watermark: a
  row written with an older timestamp than `export_cursor` is never fetched again, which
  is the usual cause of a stranded row (`docs/migrations-runbook.md`, "Backfilling a
  mirrored table").

**Fix or escalate.** A residual is a compliance matter with a clock on it (45 days from
the request), so it escalates rather than waits: `docs/pii-erasure-runbook.md` has the
procedure, and `POST /api/admin/erasure-purge` is the automated half. Drift from a
backfill is fixed by rewinding that table's cursor, in the same change as the write.

---

## A limit or a guard is not working

Keys: `edge_limiter_unusable`, `rate_limit_broken:*`, `rate_limit_refund_broken:*`,
`rate_limit_unidentified:*`, `confirm_line_unreachable`.

**What fired it.** A control that is supposed to bound something has stopped bounding
it. Every limiter here fails OPEN, so the page means requests are being served
UNMETERED, not that anybody is being turned away.

`rate_limit_broken` and `rate_limit_refund_broken` never page on one request (#3670):
one count that could not be made is only a `tag=rate-limit` log line. They page when
five in one area fail on one server inside ten minutes, and the page says that count.
It is not a statement that the limit is down across the deployment; that is
`edge_limiter_unusable`, which the monitor lane measures and clears.

**First checks.**
- Is the binding there? A deploy without the `ratelimits` block or the
  `durable_objects` block silently removes the ceiling.
  `pnpm verify:burst-counter` proves the burst counter answers AND counts, and its exit
  codes name which of the twelve things it met.
- `rate_limit_unidentified` means requests arrived with no client address, which behind
  Cloudflare should be impossible: something is in front of us that should not be.
- `confirm_line_unreachable` means confirms could not use the shared confirm line and fell
  back to each server's own line (#3325). Bookings still go through and nothing can be
  double booked; a crowd for one time may be answered slowly. Read `tag=confirm-line` for
  the reason (`unbound` is a deploy without the `CONFIRM_LINE` binding), and the
  `line_reason` on `confirm answered` lines for how many confirms it touched. Turning the
  switch off on the admin Hours page stops the attempts. `docs/confirm-line.md` has the rest.

**Fix or escalate.** A missing binding is a deploy fix. Treat an unmetered public path
as time-sensitive rather than urgent: nothing is broken for a customer, and nothing is
stopping an abusive caller either.

---

## The audit log was changed after it was written

Keys: `audit_log_chain_broken`.

**What fired it.** Every `audit_log` row carries `chain_seq` and `chain_hash`, the hash of
the previous row's hash and its own content, written by a trigger when the row is
inserted (migration 0160, #3090). The monitor lane re-walks the whole chain a few hundred
rows a tick, from the first row to the last and round again, and this page means the walk
met one of four things: a row whose content no longer matches its hash (`altered`), a
sequence that skips (`missing`), a hash at the last fully verified row that has changed
because the chain was recomputed after an edit (`rewritten`), or a chain that now ends
before that row (`truncated`). `audit_log` refuses UPDATE, DELETE and TRUNCATE (0089), so
none of these happens by accident: something with DDL rights switched that guard off.

**First checks.**
- Do not repair the row and do not re-run anything that rewrites hashes. The broken
  chain is the evidence.
- Take a copy of `audit_log`, `audit_log_chain_head` and `audit_log_chain_verify` as they
  are now.
- The page names the entry and its row id. Compare that row against the Snowflake
  mirror (`audit_log` there, merged on `id`), which holds the row as it was exported and
  is outside the reach of a role that can only change this database.
- Find who disabled or dropped the `audit_log` triggers: the database logs, and which
  credentials hold DDL rights.

**Fix or escalate.** This is a security incident and escalates at once. Once it has been
investigated, there are two ways to end the page. If the original rows can be put back
exactly as written (from the mirror), the next complete walk verifies and sends the all
clear. If they cannot, the chain has to be re-anchored by deliberately accepting the
trail as it now stands: recompute the hashes from the first changed row with the
database's own `audit_log_chain_link`, move `audit_log_chain_head` to match, and delete
the single `audit_log_chain_verify` row so the next walk starts with nothing anchored.
That is a decision about the record, so it is made by whoever owns the incident and
written down with the reason, never done to make the page stop.

---

## A sign in was refused as a different person

Keys: `sign_in_google_account_mismatch:*` (one per Slate account).

**What fired it.** Slate finds a staff member's account by email address, and an
address can be given to somebody new. So once an account has signed in, Slate keeps
Google's permanent id for that Google account (`users.google_sub`, which Google never
reuses) and refuses any later sign in with that address from a DIFFERENT Google
account (#3526). This page means one such sign in, or one live session, was refused.
Nobody was let in, and nothing on the account was changed. A person refused at sign
in was sent back to the sign in page, which told them this Google account is not the
one their Slate account belongs to and to ask a Slate admin to link a new one.

The rule is `judgeGoogleIdentity` (`src/lib/auth/google-identity.ts`). It runs at sign
in (`src/lib/provision.ts`, before anything is written to the row) AND on every request
(`realCurrentUser` in `src/lib/auth.ts`), because a session can reach a row without
the sign in page ever running, by exchanging the sign in code with Supabase directly.
The accounts it compares are the Google identities Supabase keeps for the auth user,
never `user_metadata`, which the person holding a session can rewrite. An account with
no stored id yet is armed at its next sign in, with one exception that is refused even
then: an auth user holding two Google accounts.

**First checks.**
- Find out who the person was. The page names the address; the Worker log line
  (`msg="refused a different google account"`, `tag=auth-callback` at sign in or
  `tag=auth` on a later request) carries the Slate account id and the reason.
- A reason of `several-accounts` means two Google accounts are attached to one sign
  in: almost always somebody new signing in with that address on top of its owner's
  sign in. Treat it like a different account, and find out who the second one is.
- A reason of `no-account-id` means Supabase handed over no Google identity at all.
  One is odd; several for different people means sign in is broken for everybody who
  has signed in before, which is an outage: read `googleAccountIdsOf` and what
  `supabase.auth.getUser()` returns for `identities`.

**Fix or escalate.**
- **The same person on a new Google account** (a rehire, or an account Pennie
  recreated): an admin opens their page in Slate (`/admin/agents/<id>`, the id is in
  the log line), opens the closed section at the bottom, and presses **Link a new
  Google account** under Account status, then confirms. That deletes their old
  Supabase sign in (ending every session on it) and forgets the old id (audited as
  `agent.google_relinked`, never the id itself), and their next sign in creates a
  fresh one holding only the new account, which is recorded. The control shows only
  to an admin who outranks them, never on the admin's own page, and only while an
  account is on record. If it says the old sign in could not be removed, nothing was
  changed: press it again.
- **Someone new who was given a departed person's address**: do NOT link it. Linking
  hands them the old account's role, bookings and calendar, which is the thing this
  guard exists to stop. The departed person's account needs deactivating, and the new
  person needs an account of their own, which today means a code or data change:
  escalate to whoever looks after Slate.
- **Nobody Pennie recognises**: treat it as an attempt to use an address that is not
  theirs and tell whoever runs Pennie's Google Workspace.

This is an incident: it never sends an all clear, because the refusal is already over
when the page is sent.

---

## The booking API is refusing its caller

Keys: `booking_api_ceiling`, `booking_api_credential`, `booking_api_list_read`,
`retired_booking_key:*` (one per retired key and kind of host), `duplicate_cancel_unavailable`,
`duplicate_cancel_refused`.

**`duplicate_cancel_unavailable` and `duplicate_cancel_refused`** (#2377) judge the last
24 hours of `POST /api/bookings/cancel-duplicate`, each answer counted in
`booking_api_outcome_daily` under a `duplicate_cancel_*` outcome outside the booking
failure share. Neither speaks until the day holds 40 calls. `unavailable` is more than a
fifth answered 503: read `tag=duplicate-cancel msg="incomplete"` for the stage, and note
that `rpc` with `booking_id="null"` is the journey sending no usable id, which Regal has
to fix, not Slate. `refused` is more than three tenths refused for a person (no other
call, the named call is the newest, an identity conflict): the open
`booking_handoffs` rows of kind `duplicate-unresolved` name the bookings, and a share
this high usually means the journey is naming the wrong booking. Each ends on six
measured hours back under its line.

**What fired it.** Slate is turning its own integration away. Note this is the opposite
of the limiter section above: those controls fail OPEN, so a page there means requests
are being served unmetered. Here somebody is actually being refused, and if the caller
is the automated booker then every lead in those requests was refused too.

The first three are deliberately kept out of the booking failure share, because
`attempts` there is every recorded outcome summed and putting a noisy caller's volume in
that denominator would make a real outage look proportionally smaller while it is
happening. They are measured against their own totals instead, which is why they page on
their own keys.

**First checks.**
- `booking_api_ceiling` names which ceiling and its current limit. Decide first whether
  the caller is the real booker or something abusive: the log line
  `tag=booking-api reason=throttled_key` carries the key and the scope on every trip. If
  it is the real booker, the ceiling is wrong for its volume and the repair is a number
  in `src/lib/rate-limit-core.ts`.
- `booking_api_credential` has two causes and they are different repairs. A rejected key
  is a stale or rotated secret at the CALLER, so compare the key it holds against the
  Worker's (one key per caller since #2645, so check that caller's own). A missing key is our own deployment: no booking API key is set, so every
  call is refused, and the fix is a secret plus a redeploy. The alert says which one.
- `booking_api_list_read` means the bookings table could not be read for the list
  endpoint. The caller is refused and retries the same cursor, so nothing is lost, but
  its sync has stalled. The same table is on the booking write path, so check whether
  bookings are still completing.

- `retired_booking_key:*` (#2879) means a request presented a key Slate RETIRED, so it
  was refused, and the message names which retired key (its label, never the value),
  the host and the route. The host is the lead: the production site means a partner's
  live environment still holds it, a call that named no host means a server or a
  script. It pages once per retired key per kind of host per cooldown, so two retired
  keys from the same host each page. Every presentation is logged as `tag=booking-api msg="retired key
  presented"` with the same fields, so the log shows every call, not only the one
  that paged. The repair is at the caller: give it its own key (`docs/booking-api.md`
  section 2). It is an incident, so it never sends an all clear; it goes quiet once
  nobody presents the key for a cooldown.

- `marcia_booking_failed:*`, `marcia_token_refused:*` and `marcia_gateway_refused`
  (#3543) are Marcia's booking MCP endpoint, which is not deployed yet. Every failed
  Marcia write pages, expected refusals included (plan decision 11): the key names the
  operation and the code, and the text says whether it was refused as designed
  (`slot_taken`, `move_not_offered`, `lead_daily_cap`, `lead_has_booking`,
  `lead_contact_missing`) or failed. `lead_contact_missing` is a net new booking whose
  token lacked the lead's name, email or phone: Marcia is told which and asks the lead;
  a run of them means Regal is not passing those fields to Marcia's signer.
  One kind pages once per 15 minutes; the rest are in the log under `tag=mcp-booking`,
  with the full error. A run of `marcia_token_refused:*` means Marcia's signer and
  Slate disagree about the token: check her signer against
  `src/lib/mcp-booking/machine-token-fixtures.json`, which both are held to.
  `marcia_gateway_refused` saying the secret is missing is our deployment (set
  `MCP_BOOKING_GATEWAY_SECRET`, DEPLOY.md); saying a call arrived without it means
  something other than `McpBookingGateway` reached the internal route, which should be
  impossible and is worth a look at once. All three are incidents with no all clear.

**Fix or escalate.** A missing secret and a rejected key are both time-sensitive once
the automated booker is live: leads are being refused for as long as it lasts. A ceiling
trip is a capacity decision rather than a fault, so it can wait for someone who can
choose the number. The first three clear on their own once the condition ends and
say so. The retired key page never sends an all clear, because nothing Slate can
observe says the holder stopped: it simply goes quiet once nobody presents the key.

---

## An unexpected fault was reported

Keys: `internal_error:*`, `boundary_error:*`, `csp_violation:*`, `opaque_script_errors:*`.

**What fired it.** A route threw something nobody predicted. The alert carries a short
human reason; the full text, with the stack, is in the log (never in the alert, #1133).

**First checks.** The alert names the route as its context. `npx wrangler tail` for the
last few hours, or filter the logs on that `tag=`. One occurrence with a plausible
cause (a Google blip, a lost race) may need nothing. A route failing every request is a
deploy to revert.

**`csp_violation:*` (#2575).** A browser refused something on a Slate page under the
enforced content security policy. The report says one resource was blocked (or some
code or styling stopped), never whether the page looked any different. The key is the
violated directive. Read the redacted reports with `tag=csp-report`: the `blocked` and
`document` fields say what and where. If it started with a deploy and the blocked thing
is Slate's own (a new script, image host or connection), the policy in `src/lib/csp.ts`
is missing it: add that one source to that one directive, never widen the directive to
make the page quiet. If it is something Slate never loads, the policy did its job, and
the question is how it got onto the page. A browser extension's own refusals, report
only reports, a third-party font with no named source (#3417) and the Google product
logo an add-on draws beside a phone number (`img-src`, host `fonts.gstatic.com`, path
under `/s/i/productlogos/`, #3699) are logged with `paged=false` and never page. That
logo is logged with no named source, and also when the named source is a Slate page
script (the page's own origin, under `/_next/static/`, #4063): Chrome credits a load to
whatever script is running when it fires, so a named source does not prove Slate asked
for it. Every other refused image, and the logo credited to any other source, still pages.

**`opaque_script_errors:*` (#3323).** Browsers at several different addresses (five or
more in fifteen minutes, `OPAQUE_BURST_THRESHOLD` in `src/lib/api/boundary-count.ts`)
reported `Script error.` with no file, no position and no stack on the named page. A
browser sends exactly that when the script that threw came from another site: an
extension, a translator, an app's built in browser injecting its own code. Slate serves
its own bundles from its own origin, so its own faults never look like this. A single
one is logged and never pages; the key is the surface.
- Read the lines with `tag=client-errors` and `msg="opaque cross origin script error"`
  for the window. Each carries `user_agent`: the question is whether they share one
  browser (one in app browser, one extension's host browser) or are spread across many.
- One browser in common: open the page in that browser (for an in app browser, open the
  booking link from inside that app) and try to book. If the booker works, the script
  is noisy but harmless and nothing needs doing; if it fails, the fault is real for
  every lead in that browser and worth a fix or a note to whoever owns the link.
- Spread across many browsers at once, starting with a deploy: something Slate now
  loads is being treated as another origin (a script or chunk served from a different
  host). Check the deploy and the `csp_violation:*` lines in the same window.
- A burst that never recurs needs nothing. There is no all clear, because a quiet
  window is also what nobody opening the page looks like.

---

## A merge has not shipped, or CI cannot run

Keys: `main_not_deployed`, `ci_runs_refused`.

**What fired it.** Something between merging and running is not working, and both of
these are invisible from every other surface: the pull request is merged, the issue is
closed, and `/api/health` is green because the previous version is serving perfectly
well. The monitor lane compares the commit the live Worker was stamped with against
main's tip, and reads whether the newest completed run's jobs executed anything.

**First checks.**
- `main_not_deployed` names both commits and links the run. A run that was CANCELLED
  never reaches the deploy job, and main only self corrects when another merge follows,
  so the last merge of a burst can sit undeployed indefinitely. A run that reported
  SUCCESS and is still not being served is a different fault: look at the deploy job
  inside that run before re-running anything.
- `ci_runs_refused` means the jobs concluded failed having executed zero steps, so
  there is no log to open. Read the annotation on any job in the linked run, which is
  shown on neither `gh pr checks` nor the checks list on the pull request. A failed
  payment, an exhausted spending limit, or a runner that could not be allocated all
  look like this.

**Fix or escalate.** For a cancelled deploy, re-run the deploy job on the named run or
push to main again; either carries the tip live and the page clears on the next tick.
For a refusal, the remedy is on the GitHub account rather than in this repo, and it
needs somebody with billing access. While a refusal lasts, nothing server side is
watching main at all: `main-push-guard.yml` and `merge-gap.yml` are themselves
workflows, so treat a direct push or a red merge during that window as unguarded and
check it by hand afterwards.

**What it speaks for (#3802).** The smoke canary is an Actions workflow too, so a
refusal stops it. While `ci_runs_refused` is firing, the canary's stale lane pages
(`smoke-canary`, `smoke-canary-full`, `verdict:availability-latency`) do not post: the
refusal page names them instead, and their staleness is still judged and recorded
(`alert_folded:<key>` in `alert_state`). Once CI runs again each one gets its own
bound to report in; a lane still quiet after that pages as its own problem, because
the refusal no longer explains it. A lane that was already paging before the refusal
keeps paging as usual. The table is `ALERT_FOLDS` in `src/lib/notify/alert-folds.ts`.

---

## A dependency advisory was found

Not a monitor lane key: this one is posted by the daily GitHub workflow
`.github/workflows/dependency-audit.yml` (#3092, #3093), which audits the lockfile
every day whether or not anybody pushed. Its wording is built in
`scripts/lib/dependency-audit-report.ts`.

**The patch target.** Decided by Dan on 2026-10-03: **a high or critical advisory is
patched by the next working day after the daily audit flags it.** The alert states
that target in every finding, so it arrives with the page. Moderate advisories in
production dependencies are written to the run summary and do not page; they are
picked up with the next ordinary dependency bump.

**First checks.** Open the linked run. The production audit (`--prod
--audit-level=high`) names what ships to the Worker; the full tree audit
(`--audit-level=critical`) names the build and deploy toolchain, which runs with the
Cloudflare deploy token. The package path in the advisory says which direct
dependency pulls it in.

**Fix or escalate.** Bump or replace the package on a fresh branch, and let the
pre-push gate and CI run the same audits. Where no fixed version exists yet, record the
advisory in `pnpm.auditConfig.ignoreGhsas` in `package.json`, with its reason and the
issue that will remove it in the note above the audit step in `ci.yml`, rather than
leaving the daily run red: a run that is red
every day stops being read. A run that says it could not finish an audit found
nothing either way; re-run it.

---

## The database is running low on memory

Keys: `db_saturation` (the page), `db_saturation_warn` (the whisper).

**What fired it.** The Supabase database instance itself is memory pressured (#3588), not
a query, a lane or anything inside Slate. On 2026-10-10 committed memory sat at ~92% of
its ceiling with heavy swap, CPU was 4%, and Postgres query execution looked idle, so
every query based check read healthy while `/api/availability` slowed from ~60ms to a
median of 653ms and a p95 of 1874ms that leads felt. This check reads the database's
committed memory and swap straight from Supabase's privileged metrics endpoint, so the
class pages on the cause rather than on the latency symptom. The page fires when
committed memory is at or over 90% of its ceiling for two consecutive ticks; the whisper
fires one step earlier, when committed memory is over 80% or swap use is over 10%.

**First checks.** The alert itself carries the two figures (committed percent and swap
percent); that is the first read, not any Slate log. Confirm it against the Supabase
dashboard's database health view. Sustained swap use is abnormal for this database, so
the whisper's swap line is low (10%), and it is worth acting on even below the page.

**Fix or escalate.** The repair is infrastructure, not code: scale the database instance
up (more memory) or shed load. There is nothing to fix in Slate. The page is a condition
and clears itself once committed memory falls fully back under the 80% warning line (it
deliberately holds through the 80 to 90% band so it does not flap); the whisper is an
info and simply stops once the reading is healthy. If instead
`monitor_step_failing:db_saturation` is what paged, the check could not READ the metrics
(a wrong credential's 4xx, a renamed metric, or a dead endpoint), so follow the quiet
lane family above: the memory figure is unknown, not healthy, until the read is fixed.

---

## Something was measured and is only worth knowing

Keys: `rate_limit_blocked:*`, `ooo_agent_dm`, `ooo_approvals_digest`,
`ooo-digest-unreachable:*`, `ooo-digest-unrouted-unreachable`, `ooo_undo`,
`embed_origin_mismatch`, `cron_cpu_not_configured`, `pending_event_deletions_departed`,
`owner_notice_withheld`.

**`owner_notice_withheld`** (#2440) says, at most once a week, how many owner reassign
notices in the last seven days never reached the sales side because no handoff channel
was set. The reassigns themselves went through and are in each booking's history; only
the courtesy notice is missing. Each one is recorded on its outbox row as
`withheld: "no_handoff_channel"` on the `reassign:owner_notice` step, so the list is
`booking_outbox` rows whose `steps` contain that pair (the Snowflake mirror keeps them
after the 30 day prune). Set the channel on `/admin/alerts` and the count stops growing.

**`pending_event_deletions_departed`** (#1630) says Slate could not remove old invites
from the calendar of somebody who has left, because offboarding removed their Google
Calendar licence. It names who left and when, and, where Slate could read it, how many
of those calls were moved to other advisors. No account needs fixing: the rows stay in
`pending_event_deletions` at the give-up count as the record. Slate reads the owner's
`users.deactivated_at` to decide this, and a read that fails sends the ordinary
`pending_event_deletions_refused` page rather than claim a departure it did not see.
Each pass sends at most one of these on a 30 minute cooldown, so rows a still running
offboarding sweep queues after the first notice can go unnamed; the table holds every
one of them.

**`cron_cpu_not_configured`** (#3141) says, once a day, that the Worker has no
`CF_ANALYTICS_TOKEN`, so nothing is reading cron CPU and nothing will page about it. It
is a decision waiting to be made rather than a fault. DEPLOY.md's secrets block says how
to create the token; the line stops on the first hourly tick after it is set.

**`embed_origin_mismatch` is the one here with a job attached, and the job is not
ours** (#2641). A page embedding the booker told it to report to one address while
the browser says a different one framed it, typically `www.` against the bare
domain, or a preview or staging deploy with the production address typed in. The
browser drops every message sent to the wrong address, so on that page the booking
box keeps its fallback height and the host's success redirect never fires. Bookings
still complete inside the box, which is why it is info. The fix is on the host:
pass `window.location.origin` as `parentOrigin`. Every report is in the Worker logs
with its pair (`tag=client-errors msg="embed origin mismatch"`), and the message is
sent at most once a day however many leads meet it.

**What fired it.** Nothing that needs action. These are classified `info` in the
catalog, which means they exist so that a thing which happened is on the record, and
they never send an all-clear because there is no condition to end.

**What to do.** Read it and carry on. If one of these is arriving often enough to be
noise, that is worth fixing at the source rather than muting: an alert channel that
contains things nobody acts on is how a real page gets skimmed past.

---

## Adding an alert

Give it a family in `src/lib/notify/alert-runbook.ts` and, if none of the above fits,
write the section here first. `scripts/test-alerts-runbook-coverage.ts` fails a key with
no procedure, because an alert nobody has written a procedure for is one somebody will
be paged by at 7am with nothing to read.

**Not done here, deliberately:** the alert messages do not carry a link to this file.
The audit suggested one, and the reason against it is the reader: these are read on a
phone, mid-incident, where a link into a private repo is friction, and the copy already
names the condition and the action. Adding a line to 87 copy builders (which is what it
would take, since `pnpm preview:alerts` must render exactly what ships) is a large
change for a click. If a page ever arrives that a reader could not act on without this
file, that is the evidence to revisit it.

Moved out of `AGENTS.md` on 2026-10-15, where every character was loaded into
every session (#2393). `AGENTS.md` keeps the rule and points here; this is the
full text as it stood, with the reasoning, the incidents and the measurements
behind it.

### Every post opens with a severity lead (#1825)

The dispatcher puts one line in front of everything it posts, so a page and a whisper
never look alike, even with the info channel falling back to the alerts channel (it does
whenever no info channel is set on `/admin/alerts` or in `SLACK_INFO_CHANNEL`). The rule
is `severityOf` in `src/lib/notify/severity-lead.ts`: an all-clear opens with
**Resolved.**, a `sendThrottledInfo` whisper or an info key with _FYI, no action needed
now._ (italic), an urgent condition (`URGENT_CONDITION_KEYS`) with **URGENT: leads are
affected now.**, and every other page with **Needs attention.** A copy builder never
writes its own lead, and `pnpm preview:alerts` prints each state under the lead it ships
with.

### Condition vs incident: which alerts get an all-clear (#1151)

Every alert key Slate can send is classified in **`src/lib/notify/alert-catalog.ts`**
as one of three things, and the classification decides whether it may ever send a
recovery notice:

- **condition**: an ongoing state that is true until something changes it (a lane
  is quiet, a mirror has drifted, retention is stopped, an endpoint is
  dead-lettering). Someone reads the page and then needs to know when it is over,
  so a condition **must** have a `resolveAlert` (or `resolveRecovered`) on the
  same key.
- **incident**: a finished event with no healthy state to observe (this booking's
  event insert failed, this reassign was abandoned, this request 500'd). An
  all-clear here would say "the thing that already happened has stopped
  happening", which is noise. An incident carries **no** recovery and records why.
- **info**: a `sendThrottledInfo` whisper that never needed action, so it must
  never resolve either.

The test that decides it: **if this cleared, what would the all-clear SAY?**

`scripts/test-alert-recovery-coverage.ts` checks the catalog against the code both
ways: every key the code sends is classified and on the right channel, every
condition really resolves, no info or incident does, and no catalog entry names a
key nothing sends (so a rename cannot leave a stale classification looking like
coverage). A key the scanner cannot read is a hard failure; declare it with
`// alert-key: <key or prefix:*>` on or above the call.

One shape defeated that scanner for three releases and is worth knowing (#1400).
A pure check sends through an injected seam (`deps.notify(SOME_KEY, ...)`) and the
route wires the dispatcher in. If the wiring is an ARROW
(`notify: (key, ms, text) => sendThrottledAlert(key, ms, text)`) that arrow is a
call whose key cannot be read, and an unannotated opaque site is a hard failure,
so it was always covered. If the wiring is a bare REFERENCE
(`notify: sendThrottledAlert`) it is not a call at all, produced no site, and the
key was invisible: **nine keys** lived in that gap, eight with no catalog entry
and one (`sync_staleness`) paging with no way to say it had ended. Both forms are
scanned now, and both require an `// alert-key:` declaration at the wiring.

Two rules that fall out of this, both of which have already been violated once:

- **Hang the all-clear off the MEASURED healthy result, never off "we did not
  alert this run".** A run that skipped, threw, or could not read its signal
  measured nothing and must clear nothing (#1134, #1152). Every module that
  resolves must prove that silent path; `scripts/test-all-clear-failure-coverage.ts`
  enforces it.
- **Use `resolveRecovered` from an every-minute lane** when clearing several keys:
  it settles them all with one `alert_state` read instead of one per key, on a
  subrequest budget four cron lanes share.

### Alert copy never carries a raw error (the `// alert-text-ok:` convention)

An alert is read on a phone, mid-incident, by someone deciding whether to act.
On 2026-07-28 a sync-failure page arrived as eight lines of Google's
pretty-printed JSON, cut off mid-word at `"mess` by a fixed-width slice (#1133).
The one fact worth having, a `503 backendError` that was already self-healing,
was buried in it.

**The alert carries a short human reason; the LOG carries the full text.**
Cloudflare stores every console line with the `Error` serialized, so nothing is
lost by keeping the body out of Slack, and `log.error(tag, fields, err)` is how
you get it back.

One formatter, `src/lib/notify/error-text.ts`:

```ts
shortFailureReason(row.last_sync_error)  // string | null, for a stored error
shortErrorReason(err)                    // string, for a caught unknown
```

It returns the status plus the machine reason for an HTTP failure
(`503 backendError`), and otherwise collapses the text to ONE line and truncates
on a word boundary, so a reader never gets a half word.

`scripts/test-alert-error-text.ts` (#1135) fails the build on a raw error
interpolated into `sendThrottledAlert` / `sendThrottledInfo` / `resolveAlert`
copy. It follows one hop through a local `const`, because the worst instance
built the string a line earlier and passed the name; it does NOT follow more
than that, and says so. The escape hatch, for a value that is already short and
human (a reason string we built ourselves), is `// alert-text-ok: <why>` on or
directly above the line.

Prefer pointing at where the detail lives over pasting any of it:
`Diagnose via booking_outbox.last_error; rows: ...` is the pattern to copy.

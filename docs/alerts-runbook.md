# You were paged. What now?

One procedure per FAMILY of alert, because the diagnosis clusters even though the keys
do not: a stale lane is one procedure whichever lane it is, and every Google
reachability alert is one procedure with three branches (#1047).

There are 87 alert keys. Eighty-seven hand-written stanzas would rot, starting with the
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
4. **Look for an all-clear.** Conditions send one when they clear
   (`docs/../src/lib/notify/alert-catalog.ts` classifies each key), so a page from an
   hour ago may already be over. Incidents never send one: they are finished events.

Logs: `npx wrangler tail` for anything in the last few hours, because the query API can
run hours behind (#1533). Filter on `tag=` (see `AGENTS.md`).

---

## A lane or schedule has gone quiet

Keys: `cron_lane_stale:*`, `monitor_step_failing:*`, `completion_sweep_failing`,
`webhook_retry_sweep_failing`, `sync_staleness`, `detector_parked`, `detector_unpark:*`,
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
shows the error. Four lanes share one invocation budget, so a lane that got slow can
starve its neighbours (`docs/cloudflare-platform-notes.md`).

---

## The booker is offering nothing, or too little

Keys: `empty_tier:*`, `bucket_slots_stale`, `availability_booked_solid`,
`availability_data_anomaly`, `availability_drift:*`, `fallback_covered_availability`,
`thin_tier_staffing`, `tier_fallback:*`, `tier_fallback_deep:*`, `no_eligible_agents:*`,
`low_booking_volume`, `booking_failure_rate`, `calendar_window_uncovered`,
`booker_unstaffed:*`, `public_booking_stopped`.

**What fired it.** Something between the roster and the cache means a lead sees fewer
times than they should, or none. The alerts are deliberately split by CAUSE, because
"booked solid" is a staffing fact and "data anomaly" is a bug, and they call for
opposite responses (#570).

**`empty_tier:*` is about a whole DEBT TIER, not a bucket** (#2505). It fires when
Low, Medium, High, Very High or Ultra High is offering no booking time before the
end of the next working day, and it says which of the two reasons it is: nobody is
assigned to the tier at all (a hiring or Twilio tag repair), or the tier has agents
and none of them has an opening (a schedule, a calendar or a capacity repair). A
bucket or a backend inside a tier that is still offering times is deliberately NOT
reported: since #2486 the ladder tries every bucket in the tier before dropping
one, so those leads are served.

**`booker_unstaffed:*` means a real customer arrived and was shown nothing**
(#2158). It is a narrower witness than `empty_tier:*`: that one measures the tier
whether or not anybody is looking, and this one fires because somebody was, on the
one bucket they opened. Before cutover almost nobody is, so treat this as the more
urgent of the two.

- Staff the bucket, or take its link out of use. Nothing else clears it, and the
  customer who triggered it has already gone.
- It is throttled to one per bucket per half hour, so the count in Slack is not the
  count of customers who met it.

**`public_booking_stopped` is the one cause in this family that is not a fault**
(#2366). Somebody threw the kill switch on purpose and it has been on longer than the
incident lever is meant to be held for, so the booker is refusing every new booking by
design. It is first in this section for a reason: while it stands, `low_booking_volume`
reports the same silence as a drought and sends a reader after a funnel problem that is
not there, so **check the switch before anything else here**. The Overview and the admin
business hours page both show it, and starting booking again is what ends the notice; if
it is still meant to be off, nothing needs doing and the notice repeats while it stands.

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
`recompute_headroom`.

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
`pending_event_deletions_refused`.

**What fired it.** A calendar read failed, repeatedly, for one agent or for many. Or,
for `pending_event_deletions_refused` (#2577), a queued calendar event DELETE was
refused with a definitive status, so the drain stopped retrying it on that pass: the
row sits in `pending_event_deletions` at the give-up count with `last_error` naming the
kind, and the cancelled meeting is still on that agent's calendar until the account
below is fixed and the event removed by hand.

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

**Fix or escalate.** One agent, `gone` or `not-provisioned`: a person action, and
`bookable` should go false until it is done, or the rotation spends its budget retrying
a hopeless account. Everyone at once: the delegation. Never branch on `kind === "gone"`
in code (see `AGENTS.md`).

---

## A booking side effect did not complete

Keys: `outbox_drain_stuck`, `outbox_all_handed_off`, `reservation_drain_stuck`,
`booking_event_insert`, `busy_block_write_through`, `reconcile_busy_blocks`,
`reconcile_missing_busy_blocks`, `creation_orphan_events`, `external_double_book:*`,
`reassign_intent_dropped`, `reschedule_pin_dropped`, `reschedule_lock_outage`,
`stale_phone_invite:*`, `webhook_dead:*`, `webhook_event_no_subscriber`,
`handoff_channel_unset`, `handoff_undelivered`.

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
on purpose and is waiting for somebody.

---

## The roster or routing data is wrong

Keys: `agent_sync_failures`, `agents_without_routing`, `agents_without_schedule`,
`roster_coverage_gap`, `salesforce_user_id_conflicts`, `salesforce_manager_ambiguous`,
`misroute:*`, `rr_ordering_degraded`, `reassign-unknown-reason-code`,
`booker_empty_reason`, `schedule_parity_drift`, `agents_on_unset_hours`.

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

**Fix or escalate.** Data problems go to whoever owns the Salesforce record.
`misroute` and `rr_ordering_degraded` are Slate's own routing reporting something it
did not expect, which is a code question: read the routing decision log for the booking
named.

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
  is the usual cause of a stranded row (`AGENTS.md`, the backfill convention).

**Fix or escalate.** A residual is a compliance matter with a clock on it (45 days from
the request), so it escalates rather than waits: `docs/pii-erasure-runbook.md` has the
procedure, and `POST /api/admin/erasure-purge` is the automated half. Drift from a
backfill is fixed by rewinding that table's cursor, in the same change as the write.

---

## A limit or a guard is not working

Keys: `edge_limiter_unusable`, `rate_limit_broken:*`, `rate_limit_refund_broken:*`,
`rate_limit_unidentified:*`.

**What fired it.** A control that is supposed to bound something has stopped bounding
it. Every limiter here fails OPEN, so the page means requests are being served
UNMETERED, not that anybody is being turned away.

**First checks.**
- Is the binding there? A deploy without the `ratelimits` block or the
  `durable_objects` block silently removes the ceiling.
  `pnpm verify:burst-counter` proves the burst counter answers AND counts, and its exit
  codes name which of the twelve things it met.
- `rate_limit_unidentified` means requests arrived with no client address, which behind
  Cloudflare should be impossible: something is in front of us that should not be.

**Fix or escalate.** A missing binding is a deploy fix. Treat an unmetered public path
as time-sensitive rather than urgent: nothing is broken for a customer, and nothing is
stopping an abusive caller either.

---

## The booking API is refusing its caller

Keys: `booking_api_ceiling`, `booking_api_credential`, `booking_api_list_read`.

**What fired it.** Slate is turning its own integration away. Note this is the opposite
of the limiter section above: those controls fail OPEN, so a page there means requests
are being served unmetered. Here somebody is actually being refused, and if the caller
is the automated booker then every lead in those requests was refused too.

Each of the three is deliberately kept out of the booking failure share, because
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
  Worker's. A missing key is our own deployment: `BOOKING_API_KEY` is not set, so every
  call is refused, and the fix is a secret plus a redeploy. The alert says which one.
- `booking_api_list_read` means the bookings table could not be read for the list
  endpoint. The caller is refused and retries the same cursor, so nothing is lost, but
  its sync has stalled. The same table is on the booking write path, so check whether
  bookings are still completing.

**Fix or escalate.** A missing secret and a rejected key are both time-sensitive once
the automated booker is live: leads are being refused for as long as it lasts. A ceiling
trip is a capacity decision rather than a fault, so it can wait for someone who can
choose the number. All three clear on their own once the condition ends.

---

## An unexpected fault was reported

Keys: `internal_error:*`.

**What fired it.** A route threw something nobody predicted. The alert carries a short
human reason; the full text, with the stack, is in the log (never in the alert, #1133).

**First checks.** The alert names the route as its context. `npx wrangler tail` for the
last few hours, or filter the logs on that `tag=`. One occurrence with a plausible
cause (a Google blip, a lost race) may need nothing. A route failing every request is a
deploy to revert.

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

---

## Something was measured and is only worth knowing

Keys: `rate_limit_blocked:*`, `ooo_agent_dm`, `ooo_approvals_digest`,
`ooo-digest-unreachable:*`, `ooo-digest-unrouted-unreachable`, `ooo_undo`,
`beyond_overflow_rate`.

**`beyond_overflow_rate` is the one here that names a consequence** (#2228). It is
the daily count of Beyond leads taken by an Achieve agent because no Beyond agent
was free, and it is info rather than a page because Beyond is being retired as a
backend service (Dan, 2026-09-13), so a small Beyond pool is deliberate and
staffing is not the fix. The part worth reading is the sentence about Colorado and
West Virginia: Achieve does not lend in either, so an overflowed lead in one of
them has been booked with somebody who cannot place them. Slate holds no state for
the lead and says so rather than guessing, so quantifying it means looking those
bookings up in Salesforce.

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

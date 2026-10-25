# The monitor lane: shared reads, containment and step failures

How the monitor lane keeps one failing read or check from taking out the
rest, and how a contained failure still reaches a person.

Moved out of `AGENTS.md` on 2026-10-15, where every character was loaded into
every session (#2393). `AGENTS.md` keeps the rule and points here; this is the
full text as it stood, with the reasoning, the incidents and the measurements
behind it.

## The monitor lane's shared setup reads

Every check on the monitor lane runs inside its own boundary (`steps.run`, #1281),
and since #1395 so does every SHARED READ at the top of the handler: the bucket
list, the cached slot rows, the org's business hours, the agents' working hours,
the booking horizon, and (#2773) the monitor alert settings. A throw in one of those used to end the tick before a
single check ran, taking out the availability probe and the cal.com override
sweep, neither of which needs most of them.

The part that matters is the FALLBACK. Each contained read resolves to **null**,
never to an empty or default value, because a default would let a check answer
confidently instead of skipping: zero buckets makes the whole ladder look like a
dead end, an empty week does the same (#1296), no working-hours rules makes every
agent look off shift, and a guessed horizon has the scan compare a probe against a
row computed over a different window and call the difference drift (#216).

The settings read is the one with a second fallback, and it is still not the
defaults: every armed switch defaults to OFF, so resolving a failed read to them
silently disarmed half the lane (#2773). A failure falls back to the LAST KNOWN
settings in the isolate while the step still fails (so a sustained outage pages),
and with none known the checks whose decision to page is a switch or a floor stand
down through the gates. Cooldowns alone fall to the coded values, because a
cooldown only paces an alarm that already decided to fire; lanes needing nothing
else use `loadMonitorCooldowns`, which never throws.

Which check depends on which read lives in ONE pure place,
`src/lib/monitor/setup-gates.ts` (`monitorSetupGates`), node-tested with each read
turned off one at a time and asserting both directions. Two guards keep it honest,
both in `scripts/test-monitor-step-coverage.ts`: a handler-level `const x = await`
outside `steps.run` fails the build (so a sixth read is covered by construction),
and each gated check must consult its gate rather than a hand-rolled condition.

### Containment REPORTS now, it does not only log (#2382)

Containment removed a signal and did not replace one. A step that threw was caught,
named in the cycle log line, and the lane stamped its heartbeat anyway, so a check
that failed on every tick for a month went unreported: Cloudflare logs have no
alerting on top of them and nothing in `src/lib` read `steps_failed`. Before #1281
the same throw killed the tick, the heartbeat lapsed, and the watchdog paged one
`monitor` bound later.

`judgeMonitorSteps` (`src/lib/monitor/step-failure.ts`) keeps a per step
consecutive-failure streak off `steps.outcomes()` and pages on
`monitor_step_failing:<step>` after `MONITOR_STEP_FAILING_TICKS`. That number is
DERIVED from `LANE_STALE_BOUNDS_MS.monitor`, four ticks at today's values, so the
replacement is never slower than the lapsed heartbeat it replaces. The all clear
takes the same streak the other way (L160), and a step the tick never RAN moves
neither: "we did not see it fail" is not a measured healthy result. A failing
`setup_*` read also names the checks it took down, asked of `monitorSetupGates`
rather than listed again.

### A step that ran and measured nothing counts as neither (#3955)

"Never ran" is not only a step missing from the tick. Most gated checks consult
their gate INSIDE their step, the hourly cross system check returns `not-due` on
eleven ticks in twelve, and the volume checks return early while the org is closed.
Each of those used to be recorded as a healthy run, which broke both directions of
the streak (L792): a step paged for failing was all cleared "running again" after
four ticks of a shut gate or a closed evening, and a check throwing on every one of
its hourly runs never paged at all, its idle ticks resetting the count between runs.

So a step that stands down answers through the context the runner hands it,
`return step.unmeasured(value)`, and `judgeMonitorSteps` moves neither streak for
an unmeasured run (a throw is always measured). A step whose WORK is slower than the
lane's tick also declares its cadence in `MONITOR_STEP_CADENCE_MS`
(`src/lib/monitor/step-failure.ts`), read from the check itself, so its streak is
counted in its own runs inside a window sized for them: the fixed `rate_limit_hit`
window is sized for five minute ticks and expires before a second hourly run
arrives. Such a step pages on its second failing run, and the copy counts runs and
hours rather than ticks. `scripts/test-monitor-step-coverage.ts` requires every
step whose opening consults a gate to answer the shut gate through `unmeasured`.

**The judgement is deliberately NOT a `steps.run` step**, which is why it carries a
named exemption in `scripts/test-monitor-step-coverage.ts`: containing the reporter
behind the fault it reports is the same defect one level up. It runs BEFORE
`recordHeartbeat("monitor")`, so a fault nobody predicted inside it lapses the stamp
and pages, exactly as an uncontained throw did.

**`lane_watchdog` is the widest case**, since the dead man's switch for every other
lane is itself one of these steps. `alertOnStaleLanes` returns
`{ judged, stale }` rather than a bare list (an empty list is what a healthy fleet
returns AND what a failed heartbeat read returned, L215), and the monitor lane
stamps `verdict:lane-watchdog` only on `judged: true`, so a watchdog that threw or
could not read goes stale like any other detector that has stopped concluding.

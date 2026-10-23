// Repo invariant (#525): the scheduled booking-smoke canary workflow keeps all of
// its pieces. This is glue in YAML that nothing else exercises, and a canary that
// silently loses a piece (stops stamping its heartbeat, stops alerting on failure,
// drops a schedule) is worse than none: it reads as a healthy safety net while
// covering nothing. A plain text scan asserts each required piece is present.
//
// Run: node --experimental-strip-types scripts/test-smoke-canary-workflow.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { LATENCY_RECHECK_DELAY_MS } from "./lib/latency-slo.ts";
import { TEST_ADVISOR_LEASE_EXIT } from "./lib/test-advisor-lease-client.ts";

const ROOT = join(import.meta.dirname, "..");
const wf = readFileSync(join(ROOT, ".github", "workflows", "smoke-canary.yml"), "utf8");

// --- triggers: two schedules + manual dispatch ---
assert(/^on:/m.test(wf), "has an `on:` trigger block");
// #1493 (Dan, 2026-10-16): the full pass runs HOURLY, on the hour, now that real
// leads book through Slate, and the dry tick fills the half hour between, so the
// canary still reports every 30 minutes.
assert(/cron:\s*"30 \* \* \* \*"/.test(wf), "schedules the dry-run tick at half past each hour");
assert(/cron:\s*"0 \* \* \* \*"/.test(wf), "schedules the hourly full pass");
assert(!/cron:\s*"0 \*\/6 \* \* \*"/.test(wf), "the old six hourly full pass schedule is gone");
assert(!/cron:\s*"\*\/30 \* \* \* \*"/.test(wf), "and so is the every 30 minute dry schedule, which would also fire on the hour");

// #1436: the step that decides which pass to run compares `github.event.schedule`
// against a HAND-COPIED cron string. If the schedule above were ever retimed and
// that literal not updated with it, the comparison would silently never match, the
// full pass (the only automated proof a booking can be made, rescheduled and
// cancelled) would stop running, and the dry tick would keep the smoke-canary
// heartbeat fresh the whole time. The separate smoke-canary-full heartbeat (#982)
// would eventually go stale and page, which is the compensating control, but the
// two strings have to agree in the first place (L41: never maintain a copy beside
// its source of truth without checking they match).
{
  const crons = [...wf.matchAll(/cron:\s*"([^"]+)"/g)].map((m) => m[1]!);
  assert(crons.length >= 2, `the on: block declares ${crons.length} schedules`);
  const compared = [...wf.matchAll(/\$SCHEDULE"\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
  assert(compared.length > 0, "the mode step really compares the schedule (it is not dead code)");
  const orphans = compared.filter((c) => !crons.includes(c));
  eq(
    orphans,
    [],
    "every cron string the mode step compares against is one this workflow actually schedules",
  );
}
assert(/workflow_dispatch:/.test(wf), "can be run on demand (workflow_dispatch)");

// --- never cancel a canary mid-teardown ---
assert(
  /cancel-in-progress:\s*false/.test(wf),
  "concurrency does not cancel a run in flight (a half-run full pass leaves real bookings)",
);

// --- both smoke passes, in their intended modes ---
assert(/SMOKE_DRY_RUN_ONLY:\s*"1"/.test(wf), "runs the side-effect-free dry-run tick");
assert(/SMOKE_STRICT:\s*"1"/.test(wf), "runs the full pass in strict mode (any skip is a failure)");
assert(/scripts\/smoke-booking-api\.ts/.test(wf), "invokes the booking smoke");
assert(/scripts\/smoke-reschedule\.ts/.test(wf), "invokes the reschedule smoke on the full pass");

// --- liveness: stamps the canary heartbeat only on success ---
assert(/\/api\/smoke\/heartbeat/.test(wf), "stamps the smoke-canary heartbeat endpoint");
{
  // The heartbeat step must be gated on success, so a failed run does NOT stamp
  // (else a broken canary would look alive to the watchdog).
  const heartbeatStep = wf.slice(wf.indexOf("Stamp canary heartbeat"), wf.indexOf("Slack alert on failure"));
  assert(
    /if:\s*success\(\)/.test(heartbeatStep),
    "the heartbeat stamp is gated on success() so a failed run does not look alive",
  );
}

// --- #982: the FULL pass stamps its OWN heartbeat, so a silently-dropped hourly
// full run is not masked by the 30-min dry tick keeping smoke-canary fresh. ---
{
  const fullStamp = wf.slice(wf.indexOf("full-pass canary heartbeat"), wf.indexOf("Slack alert on failure"));
  assert(
    /full-pass canary heartbeat/.test(wf),
    "has a dedicated full-pass heartbeat stamp step (#982)",
  );
  assert(
    /lane=smoke-canary-full/.test(fullStamp),
    "the full-pass step stamps the smoke-canary-full lane",
  );
  // Gated on the full pass AND success, so only a passing full run stamps it and
  // the dry tick never does.
  assert(
    /steps\.mode\.outputs\.full == '1'/.test(fullStamp) && /if:\s*success\(\)/.test(fullStamp),
    "the full-pass stamp is gated on success() and the full pass only",
  );
}

// --- alerting: any failure pages via Slack ---
{
  const alertStep = wf.slice(wf.indexOf("Slack alert on failure"));
  assert(/failure\(\)/.test(alertStep), "the alert step fires on failure()");
  assert(/scripts\/notify-smoke-failure\.ts/.test(alertStep), "the alert posts via notify-smoke-failure.ts");
  assert(/SLACK_BOT_TOKEN/.test(alertStep), "the alert step has the Slack token");
  // #1598: the canary's own steps need the install, this one does not. Comment lines
  // are stripped first, because the step now EXPLAINS why it carries no alias hook and
  // a match on the raw text would be answered by the sentence about the thing rather
  // than by the thing (L103). What the script actually reaches is proven by walking its
  // import graph in scripts/test-dependency-free-scripts.ts; this only pins the wiring.
  const alertCode = alertStep
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert(
    !/register-paths/.test(alertCode),
    "the alert step runs on bare node, so it does not need the install to have worked",
  );
}

// --- #1047: a continue-on-error check must still reach the alerter -------------
{
  // The latency step cannot fail the JOB: a latency budget is the classic source of a
  // flapping alert, and failing the job would skip the heartbeat stamp below, paging
  // the lane watchdog for a slow read. The consequence is that `failure()` is false
  // when it trips, so the alert step has to consult its outcome explicitly, or a
  // regression is written to the failure log and reported to nobody, which is the
  // silent-check shape this repo exists to avoid.
  const latencyStep = wf.slice(wf.indexOf("Availability latency"));
  assert(latencyStep.length > 0, "the canary has a latency step");
  assert(
    /continue-on-error:\s*true/.test(latencyStep.slice(0, 400)),
    "the latency step cannot fail the job",
  );
  assert(/id:\s*latency/.test(latencyStep.slice(0, 400)), "and it has an id to consult");
  assert(
    /scripts\/smoke-latency\.ts/.test(latencyStep),
    "and it runs the latency script",
  );
  assert(
    /SMOKE_FAILURE_FILE/.test(latencyStep.slice(0, 700)),
    "and records its reason through the shared failure log, so the alerter names it",
  );

  const alertIf = wf.slice(wf.indexOf("Slack alert on failure"), wf.indexOf("Slack alert on failure") + 400);
  assert(
    /steps\.latency\.outcome == 'failure'/.test(alertIf),
    "the alert step consults the latency step's outcome, since failure() cannot see it",
  );

  // #1006: the browser check, the same shape and for the same reasons. A real
  // browser against the public internet is the other classic source of a flapping
  // check, and one that failed the JOB would stop the heartbeat below being
  // stamped, which would page the lane watchdog for a slow page load.
  const embedStep = wf.slice(wf.indexOf("Embed render check"));
  assert(embedStep.length > 0, "the canary has an embed render step");
  assert(
    /continue-on-error:\s*true/.test(embedStep.slice(0, 400)),
    "the embed step cannot fail the job",
  );
  assert(/id:\s*embed/.test(embedStep.slice(0, 400)), "and it has an id to consult");
  assert(
    /scripts\/smoke-embed-render\.ts/.test(embedStep),
    "and it runs the embed render script",
  );
  assert(
    /SMOKE_FAILURE_FILE/.test(embedStep.slice(0, 900)),
    "and records its reason through the shared failure log, rather than a second alerting path",
  );
  // FULL PASS ONLY. This is a private repo, so a real browser on every 30 minute
  // tick is roughly 48 billed runs a day against 4 for the same class of fault,
  // and an embed regression arrives with a deploy rather than drifting in.
  // #1493: the full pass went hourly and the browser check did NOT go with it. Its
  // reason above is unchanged (an embed regression arrives with a deploy), so it
  // stays on every sixth full pass, flagged by the mode step, and so do the two
  // browser setup steps, which are most of its billed minutes.
  assert(
    /steps\.mode\.outputs\.embed == '1'/.test(embedStep.slice(0, 400)),
    "the embed check runs only when the mode step flags the six hourly embed pass",
  );
  for (const name of ["Cache the browser", "Install the browser"]) {
    const step = wf.slice(wf.indexOf(name), wf.indexOf(name) + 300);
    assert(/steps\.mode\.outputs\.embed == '1'/.test(step), `${name} runs only on the embed pass`);
  }
  {
    const modeStep = wf.slice(wf.indexOf("id: mode"), wf.indexOf("Booking smoke (dry-run health tick)"));
    assert(/embed=1/.test(modeStep) && /embed=0/.test(modeStep), "the mode step sets the embed flag both ways");
    assert(/% 6/.test(modeStep), "on every sixth hour of the day");
    assert(/DISPATCH_MODE" = "full"[\s\S]*embed=1|embed=1[\s\S]*DISPATCH_MODE" = "full"/.test(modeStep), "and on a manual full dispatch");
  }
  assert(
    /steps\.embed\.outcome == 'failure'/.test(alertIf),
    "the alert step consults the embed step's outcome too, or its failures are recorded and read by nobody",
  );
  // The bucket, which is the thing that shipped wrong. Every OTHER canary step
  // drives the hidden SMOKE bucket with a bearer token (#396), and a BROWSER
  // cannot send one, so the booker correctly refuses that bucket and the check
  // false-pages every full pass. Measured against the real deployment on
  // 2026-09-02. Neither variable may come back to this step.
  // Comment lines stripped, or this reads the comment ABOVE the run line that
  // explains these two must not be here and fails on the prose banning them
  // (L518, which this suite met on its own first run).
  const embedEnv = embedStep
    .slice(0, embedStep.indexOf("run:"))
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert(
    !/BOOKING_API_KEY/.test(embedEnv),
    "the embed step carries no API key: a browser cannot send one, and its presence invites the hidden test bucket back",
  );
  assert(
    !/SMOKE_BUCKET/.test(embedEnv),
    "and no SMOKE_BUCKET, which would point the browser at a bucket the booker refuses",
  );
  // Overlay control, which is what proves the sweep rather than the regex: put the
  // two variables back into the REAL step in memory and require the same predicate
  // to catch it. A check that only ever sees a clean file cannot tell a working
  // guard from one whose slice quietly stopped matching (L98).
  {
    const sabotaged = embedEnv.replace(
      "SMOKE_FAILURE_FILE:",
      "BOOKING_API_KEY: ${{ secrets.BOOKING_API_KEY }}\n          SMOKE_BUCKET: SMOKE\n          SMOKE_FAILURE_FILE:",
    );
    assert(
      /BOOKING_API_KEY/.test(sabotaged) && /SMOKE_BUCKET/.test(sabotaged),
      "overlay control: the guard catches the API key and the test bucket coming back",
    );
  }

  // And the script's own default is a real bucket, not the hidden one. Read from
  // the source, because the workflow being clean says nothing about what the
  // script falls back to when nothing is set.
  {
    const src = readFileSync(join(ROOT, "scripts/smoke-embed-render.ts"), "utf8");
    const fallback = /SMOKE_EMBED_BUCKET \|\| "([^"]+)"/.exec(src);
    assert(fallback !== null, "the embed check has a readable default bucket");
    assert(
      fallback![1] !== "SMOKE",
      `the default bucket is a real one, not the bearer-gated test bucket (got "${fallback?.[1]}")`,
    );
  }

  // The browser has to be there before the step that drives it, and cached, or the
  // download is paid on every full pass forever.
  assert(
    wf.indexOf("playwright install") < wf.indexOf("Embed render check"),
    "the browser is installed before the step that drives it",
  );
  assert(
    /path:\s*~\/.cache\/ms-playwright/.test(wf),
    "and cached, so the download is not paid on every run",
  );

  // And the heartbeat must still stamp when only latency tripped: the canary DID run
  // and the funnel DID work, so a stale-lane page would be a second, wrong alarm for
  // one cause.
  const stamp = wf.slice(wf.indexOf("Stamp canary heartbeat"));
  assert(
    /if:\s*success\(\)/.test(stamp.slice(0, 300)),
    "the heartbeat is gated on success(), which a continue-on-error step leaves true",
  );
}

// --- #1700: the latency check stamps a verdict whenever it MEASURED, pass or fail ---
{
  // Before this, a latency step that stopped getting usable readings said "not
  // measured" every 30 minutes and exited 0, which reads exactly like a healthy pass.
  const title = "Stamp the latency verdict";
  const at = wf.indexOf(title);
  assert(at > 0, "the canary has a step stamping the latency verdict");
  const step = wf.slice(at, wf.indexOf("\n      - name:", at + 1));
  const code = step
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert(
    /steps\.latency\.outputs\.measured == '1'/.test(code),
    "it is gated on the latency step reporting a MEASURED reading, never on the step merely running",
  );
  // always(): a custom `if` without a status function gets success() ANDed in, and a
  // confirmed regression is a measured verdict whose own step failed. Whether the check
  // concluded and whether the read was fast are two facts (L53).
  assert(/always\(\)/.test(code), "it runs even when the latency step itself failed on a real regression");
  assert(
    /lane=verdict:availability-latency(?![\w:-])/.test(code),
    "and it stamps the availability latency verdict lane",
  );
  assert(
    wf.indexOf("Availability latency (read path)") < at,
    "and it comes after the latency step whose output it reads",
  );
  // Overlay control: a gate that dropped the measured condition must be caught by the
  // same predicate, or the assertion above could be passing on the comment (L1).
  assert(
    !/steps\.latency\.outputs\.measured == '1'/.test(code.replace("steps.latency.outputs.measured == '1'", "true")),
    "overlay control: removing the measured gate is caught",
  );
  // The step's timeout has to hold the recheck: two batches and the pause between.
  const timeout = Number(/timeout-minutes:\s*(\d+)/.exec(wf)?.[1]);
  assert(
    Number.isFinite(timeout) && timeout * 60_000 > LATENCY_RECHECK_DELAY_MS + 5 * 60_000,
    `the job timeout (${timeout} min) leaves room for the latency recheck pause on top of a normal run`,
  );
}

// --- #4180: the full pass books only while it holds the smoke test advisors' lease ---
{
  // The daily reroute drill books on the same two test advisors. On 2026-10-23 they overlapped
  // and both failed, so the full pass takes one server side lease first, and a run that could
  // not get it is NOT MEASURED: it books nothing, stamps nothing, clears nothing, and pages
  // nobody. (A shared concurrency group was rejected: a third queued run cancels the pending one.)
  const stepAt = (name: string): string => {
    const at = wf.indexOf(`- name: ${name}`);
    assert(at !== -1, `the step "${name}" is where this expects it`);
    const next = wf.indexOf("\n      - name:", at + 1);
    return next === -1 ? wf.slice(at) : wf.slice(at, next);
  };
  const codeOf = (step: string) =>
    step
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
  const take = codeOf(stepAt("Take the smoke test advisors' lease (full pass only)"));
  assert(/id:\s*lease/.test(take), "the lease step has an id the booking steps read");
  assert(/scripts\/smoke-test-advisor-lease\.ts take/.test(take), "and runs the lease client's take");
  assert(/steps\.mode\.outputs\.full == '1'/.test(take), "on the full pass only: the dry tick books nothing, so it cannot collide");
  assert(/SMOKE_FAILURE_FILE/.test(take), "and a lease it could not ask for is recorded for the alerter to name");
  // The not measured exit becomes `held=0` and a clean step, never a failure.
  const mapped = /-eq\s+(\d+)/.exec(take)?.[1];
  eq(Number(mapped), TEST_ADVISOR_LEASE_EXIT.notMeasured, "the step treats exactly the not measured exit as not a failure");
  assert(/held=0/.test(take), "and records that it holds nothing");

  const leaseAt = wf.indexOf("Take the smoke test advisors' lease");
  for (const name of ["Booking smoke (full strict pass)", "Reschedule smoke (full pass only)"]) {
    const step = codeOf(stepAt(name));
    assert(wf.indexOf(`- name: ${name}`) > leaseAt, `${name} comes after the lease is taken`);
    assert(/steps\.lease\.outputs\.held == '1'/.test(step), `${name} books only while the lease is held`);
  }
  {
    // Overlay control: a booking step without the gate is caught by the same predicate (L1).
    const full = codeOf(stepAt("Booking smoke (full strict pass)"));
    assert(
      !/steps\.lease\.outputs\.held == '1'/.test(full.replace(" && steps.lease.outputs.held == '1'", "")),
      "overlay control: a booking step that dropped the lease gate is caught",
    );
  }

  const release = codeOf(stepAt("Release the smoke test advisors' lease"));
  assert(/scripts\/smoke-test-advisor-lease\.ts release/.test(release), "the release step runs the lease client's release");
  assert(/always\(\)/.test(release), "whatever the booking steps did, so a failed pass never holds the drill off until the TTL");
  assert(/steps\.lease\.outputs\.held == '1'/.test(release), "and only when this run holds the lease");
  assert(/steps\.lease\.outputs\.token/.test(release), "handing back the token it was given");
  assert(/continue-on-error:\s*true/.test(release), "and a release that fails cannot turn a clean run red (the TTL frees it)");
  assert(
    wf.indexOf("- name: Release the smoke test advisors' lease") > wf.indexOf("- name: Reschedule smoke (full pass only)"),
    "released after the last booking step",
  );

  // A not measured full pass stamps neither heartbeat and reports no clean run.
  const NOT_MEASURED_GUARD = "(steps.mode.outputs.full == '0' || steps.lease.outputs.held == '1')";
  for (const name of ["Stamp canary heartbeat (success only)", "Report a clean canary run"]) {
    assert(codeOf(stepAt(name)).includes(NOT_MEASURED_GUARD), `${name} skips a full pass that never got the lease`);
  }
  assert(
    /steps\.lease\.outputs\.held == '1'/.test(codeOf(stepAt("Stamp full-pass canary heartbeat (full pass success only)"))),
    "the full pass heartbeat stamps only a pass that held the lease and booked",
  );
}

// --- preflight: skip quietly until the key is configured (no alert spam) ---
{
  assert(/id:\s*pre/.test(wf), "has a preflight step");
  assert(
    /configured=1/.test(wf) && /configured=0/.test(wf),
    "preflight reports whether BOOKING_API_KEY is configured",
  );
  // Every working step (smoke, heartbeat, alert) is gated on configured == '1',
  // so an absent key makes the run a clean no-op instead of failing and paging.
  const gated = wf.split("\n").filter((l) => /steps\.pre\.outputs\.configured == '1'/.test(l));
  assert(
    gated.length >= 5,
    `smoke, heartbeat, and alert steps are gated on the preflight (found ${gated.length})`,
  );
}

finish();

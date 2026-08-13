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

const ROOT = join(import.meta.dirname, "..");
const wf = readFileSync(join(ROOT, ".github", "workflows", "smoke-canary.yml"), "utf8");

// --- triggers: two schedules + manual dispatch ---
assert(/^on:/m.test(wf), "has an `on:` trigger block");
assert(/cron:\s*"\*\/30 \* \* \* \*"/.test(wf), "schedules the ~30-min dry-run tick");
assert(/cron:\s*"0 \*\/6 \* \* \*"/.test(wf), "schedules the 6h full pass");

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

// --- #982: the FULL pass stamps its OWN heartbeat, so a silently-dropped 6h
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
  assert(/if:\s*failure\(\)/.test(alertStep), "the alert step fires on failure()");
  assert(/scripts\/notify-smoke-failure\.ts/.test(alertStep), "the alert posts via notify-smoke-failure.ts");
  assert(/SLACK_BOT_TOKEN/.test(alertStep), "the alert step has the Slack token");
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

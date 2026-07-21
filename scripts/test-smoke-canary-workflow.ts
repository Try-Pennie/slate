// Repo invariant (#525): the scheduled booking-smoke canary workflow keeps all of
// its pieces. This is glue in YAML that nothing else exercises, and a canary that
// silently loses a piece (stops stamping its heartbeat, stops alerting on failure,
// drops a schedule) is worse than none: it reads as a healthy safety net while
// covering nothing. A plain text scan asserts each required piece is present.
//
// Run: node --experimental-strip-types scripts/test-smoke-canary-workflow.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const wf = readFileSync(join(ROOT, ".github", "workflows", "smoke-canary.yml"), "utf8");

// --- triggers: two schedules + manual dispatch ---
assert(/^on:/m.test(wf), "has an `on:` trigger block");
assert(/cron:\s*"\*\/30 \* \* \* \*"/.test(wf), "schedules the ~30-min dry-run tick");
assert(/cron:\s*"0 \*\/6 \* \* \*"/.test(wf), "schedules the 6h full pass");
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

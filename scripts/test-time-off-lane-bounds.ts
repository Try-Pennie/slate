// The two daily time off lanes are watched, and their bounds are DERIVED (#2543).
//
// Until now neither lane appeared in any bounds map, so a lane that stopped firing
// was watched by nothing at all: `worker/cron-routes.ts` fires each of them twice a
// day, cron has no retries, and the only record of a run was a 200 nobody reads.
//
// The bound has to clear the longest LEGITIMATE silence each stamp has, and that
// silence is a property of the SCHEDULE rather than a number somebody picked
// (L614). The pending digest is weekday only, so its real gap is the weekend: Friday
// afternoon to Monday morning is about three days, and a bound reasoned from "daily,
// so a day plus slack" would page every Sunday for ever, which is how an alert stops
// being read (L36).
//
// So this re-derives the gap from the shipped cron expressions and the shipped time
// gates, and holds each bound between it and it plus a ceiling: a bound below the gap
// cries wolf, and one far above it notices nothing.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-time-off-lane-bounds.ts
import { CRON_ROUTES } from "../worker/cron-routes.ts";
import { TIME_OFF_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import { isApprovalsDigestTime } from "../src/lib/ooo/approvals-digest.ts";
import { isDigestTime } from "../src/lib/ooo/digest.ts";
import {
  OOO_APPROVALS_ATTEMPT_LANE,
  OOO_APPROVALS_REPORT_LANE,
  OOO_DIGEST_ATTEMPT_LANE,
  OOO_DIGEST_NUDGE_LANE,
} from "../src/lib/ooo/time-off-lanes.ts";
import { parseWeekdayField } from "./lib/cloudflare-cron-weekday.ts";
import { assert, finish } from "./lib/harness.ts";

const HOUR = 60 * 60_000;

/** The most slack a bound may carry over the gap it has to clear. */
const MAX_SLACK_MS = 12 * HOUR;

/**
 * Every instant a cron expression fires, over a fixed two year span.
 *
 * A FIXED span rather than one anchored on the clock, so this suite means the same
 * thing under `SLATE_CLOCK_SHIFT` as it does today (#2503). Two years so both of a
 * year's clock changes fall inside it, twice.
 *
 * The parser covers the shape these crons actually use (a literal minute, a literal
 * hour, `*` for day and month, `*` or day names for weekday) and REFUSES anything else,
 * because a cron it silently failed to understand would contribute no fires and the
 * gap would come back looking comfortable (L98).
 */
function firesUtc(cron: string): number[] {
  const parts = cron.trim().split(/\s+/);
  assert(parts.length === 5, `cron "${cron}" has five fields`);
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  assert(/^\d+$/.test(min) && /^\d+$/.test(hour), `cron "${cron}" has a literal minute and hour`);
  assert(dom === "*" && mon === "*", `cron "${cron}" fires every day of every month`);
  // Read through the same parser the weekday guard uses (#2814). This used to read
  // `1-5` as Monday to Friday on the 0 = Sunday convention, while Cloudflare counts
  // 1 = Sunday and ran it Sunday to Thursday, so this suite derived a gap for a
  // schedule that was not the one running. The parser refuses numbers outright.
  const days = parseWeekdayField(dow);
  assert(days !== null, `cron "${cron}" has a weekday field this can read (names or *, never numbers)`);
  const out: number[] = [];
  const start = Date.UTC(2026, 0, 1);
  for (let day = 0; day < 730; day++) {
    const at = start + day * 24 * HOUR;
    const d = new Date(at);
    const wd = d.getUTCDay();
    if (!days?.has(wd)) continue;
    out.push(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(hour), Number(min)));
  }
  return out;
}

/** Every fire of every cron expression driving `route`, in order. */
function firesForRoute(route: string): number[] {
  const crons = Object.entries(CRON_ROUTES)
    .filter(([, v]) => (Array.isArray(v) ? v.includes(route) : v === route))
    .map(([cron]) => cron);
  assert(crons.length > 0, `${route} is scheduled by at least one cron expression`);
  return crons.flatMap(firesUtc).sort((a, b) => a - b);
}

function widestGap(fires: number[]): number {
  assert(fires.length > 10, `enumerated ${fires.length} fires, enough to measure a gap`);
  let worst = 0;
  for (let i = 1; i < fires.length; i++) worst = Math.max(worst, fires[i]! - fires[i - 1]!);
  return worst;
}

function holds(lane: string, gapMs: number, what: string) {
  const bound = TIME_OFF_STALE_BOUNDS_MS[lane];
  assert(typeof bound === "number", `${lane} has a staleness bound at all`);
  assert(
    bound! > gapMs,
    `${lane}'s bound (${Math.round(bound! / HOUR)}h) clears ${what} (${Math.round(gapMs / HOUR)}h), so ordinary silence cannot page`,
  );
  assert(
    bound! - gapMs <= MAX_SLACK_MS,
    `${lane}'s bound is within ${MAX_SLACK_MS / HOUR}h of ${what}, so it still notices a lane that stopped (slack ${Math.round((bound! - gapMs) / HOUR)}h)`,
  );
}

// --- the approvals report -----------------------------------------------------
{
  const fires = firesForRoute("/api/cron/ooo-approvals");
  holds(OOO_APPROVALS_ATTEMPT_LANE, widestGap(fires), "the longest gap between cron fires");
  // The report stamp is written only by the run that passes the 7am ET gate, so its
  // legitimate silence is the gap between GATED fires. Asked of the shipped
  // predicate rather than restated here, or the two would drift (L41).
  const gated = fires.filter((ms) => isApprovalsDigestTime(ms));
  holds(OOO_APPROVALS_REPORT_LANE, widestGap(gated), "the longest gap between 7am ET runs");
  // A positive control on the filter itself: one fire a day, not zero and not two.
  assert(
    gated.length > 700 && gated.length <= fires.length / 2 + 2,
    `exactly one approvals fire a day passes the 7am ET gate (${gated.length} of ${fires.length})`,
  );
}

// --- the pending digest -------------------------------------------------------
{
  const fires = firesForRoute("/api/cron/ooo-digest");
  const attemptGap = widestGap(fires);
  assert(
    attemptGap > 48 * HOUR,
    `the digest's widest gap is a weekend, not a day (${Math.round(attemptGap / HOUR)}h)`,
  );
  holds(OOO_DIGEST_ATTEMPT_LANE, attemptGap, "the weekend gap between cron fires");
  const gated = fires.filter((ms) => isDigestTime(ms));
  // The nudge must land on every weekday in New York and never at the weekend
  // (#2814: the schedule ran Sunday to Thursday, so Friday never got one).
  const etDays = new Set(
    gated.map((ms) => new Date(ms).toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" })),
  );
  assert(
    [...etDays].sort().join(",") === "Fri,Mon,Thu,Tue,Wed",
    `the 9am ET nudge runs Monday to Friday and no other day (got ${[...etDays].sort().join(", ")})`,
  );
  holds(OOO_DIGEST_NUDGE_LANE, widestGap(gated), "the weekend gap between 9am ET runs");
  assert(
    gated.length > 500 && gated.length <= fires.length / 2 + 2,
    `exactly one digest fire a weekday passes the 9am ET gate (${gated.length} of ${fires.length})`,
  );
}

// --- the stamps the routes write are exactly the stamps the map watches --------
{
  // A stamp with no bound LOOKS like monitoring while nothing watches it (#1123),
  // and a bound for a stamp nobody writes pages for ever with no remedy. The names
  // come from the constants the routes themselves use, so a rename on either side
  // fails here rather than quietly disabling the switch.
  const written = [
    OOO_APPROVALS_ATTEMPT_LANE,
    OOO_APPROVALS_REPORT_LANE,
    OOO_DIGEST_ATTEMPT_LANE,
    OOO_DIGEST_NUDGE_LANE,
  ].sort();
  const watched = Object.keys(TIME_OFF_STALE_BOUNDS_MS).sort();
  assert(
    watched.join(",") === written.join(","),
    `the bounds map watches exactly the stamps the routes write (watched: ${watched.join(", ")}; written: ${written.join(", ")})`,
  );
}

finish();

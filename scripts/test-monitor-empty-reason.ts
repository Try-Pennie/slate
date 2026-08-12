/**
 * #1420: noticing when the booker cannot work out why a week is empty.
 *
 * #1414 gave the booker a third empty-window state. When the server returns a
 * window with no times and cannot say WHY, the lead reads "We could not work out
 * what is available right now" with a retry, which is honest and is exactly what
 * keeps the fault invisible to us: nothing pages, nothing records a verdict, and
 * the funnel simply gets quieter. An unclassifiable window and a quiet day look
 * identical from the inside (#1394).
 *
 * The measurement point is the thing to get right. Counting it on the availability
 * READ would only ever conclude when a lead is present, and before cutover there
 * are none, so the detector would ship blind and stay blind, which is the very
 * shape #1394 was filed about. The classifier's inputs are the org's business
 * hours and the booking horizon, and the monitor lane already holds both on every
 * pass, so it can ask the REAL classifier the same question with no traffic at
 * all.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-monitor-empty-reason.ts
 */
import {
  BOOKER_EMPTY_REASON_KEY,
  EMPTY_REASON_STREAK_KEY,
  EMPTY_REASON_STREAK_WINDOW_S,
  formatEmptyReasonAlert,
  formatEmptyReasonRecovery,
  runEmptyReasonCheck,
} from "../src/lib/monitor/empty-reason-health.ts";
import { explainEmptyWindow } from "../src/lib/availability/empty-reason.ts";
import { CRON_ROUTES } from "../worker/cron-routes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
/** A Monday to Friday week, 9 to 5, in the shape loadBusinessHours returns. */
const OPEN_WEEK = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  start_minute: 9 * 60,
  end_minute: 17 * 60,
}));
const HOURS = { zone: ZONE, rules: OPEN_WEEK };
/** A Wednesday, so the four day window lands on open days. */
const NOW = Date.parse("2026-08-12T14:00:00Z");

// ------------------------------------------------- the shared classifier

// The route and the lane must ask ONE function, or the lane can only ever confirm
// its own reimplementation of what the booker does (L107).
{
  const ok = explainEmptyWindow({ hours: HOURS, horizonDays: 4, nowMs: NOW });
  assert(ok.reason !== null, "a readable week and horizon produce a reason");
  eq(ok.blockedBy, null, "and nothing is reported as blocking it");

  const noHours = explainEmptyWindow({ hours: null, horizonDays: 4, nowMs: NOW });
  eq(noHours.reason, null, "an unreadable week cannot be explained");
  assert(
    /business hours/.test(noHours.blockedBy ?? ""),
    `and the blocker names the week (got: ${noHours.blockedBy})`,
  );

  const noHorizon = explainEmptyWindow({ hours: HOURS, horizonDays: null, nowMs: NOW });
  eq(noHorizon.reason, null, "an unreadable horizon cannot be explained either");
  assert(
    /horizon/.test(noHorizon.blockedBy ?? ""),
    `and the blocker names the horizon (got: ${noHorizon.blockedBy})`,
  );

  // Both at once names both. Naming one sends the reader back for a second tick to
  // discover the rest, which is the same reasoning monitorSetupGates already holds.
  const neither = explainEmptyWindow({ hours: null, horizonDays: null, nowMs: NOW });
  assert(
    /business hours/.test(neither.blockedBy ?? "") && /horizon/.test(neither.blockedBy ?? ""),
    `both unreadable inputs are named (got: ${neither.blockedBy})`,
  );

  // A zone the clock cannot read is its own cause: the week READ fine, so telling
  // the reader it could not be read would send them to the wrong screen (L11).
  const badZone = explainEmptyWindow({
    hours: { zone: "Mars/Olympus", rules: OPEN_WEEK },
    horizonDays: 4,
    nowMs: NOW,
  });
  eq(badZone.reason, null, "a week whose zone the clock cannot read blocks the explanation");
  assert(
    badZone.blockedBy?.includes("Mars/Olympus") === true,
    `and the blocker names the zone (got: ${badZone.blockedBy})`,
  );
  assert(
    !/could not be read/.test(badZone.blockedBy ?? ""),
    "and does NOT report it as a failed read: the week read perfectly well, and saying " +
      "otherwise sends whoever is holding the pager to the wrong screen (L11)",
  );
}

// ------------------------------------------------------ the lane check

interface Sent {
  key: string;
  text: string;
}

function harness(overrides: { streakHit?: boolean } = {}) {
  const alerts: Sent[] = [];
  const resolved: Sent[] = [];
  let streakCalls = 0;
  let cleared = 0;
  return {
    alerts,
    resolved,
    cleared: () => cleared,
    streakCalls: () => streakCalls,
    deps: {
      streak: async () => {
        streakCalls++;
        return overrides.streakHit ?? true;
      },
      clearStreak: async () => {
        cleared++;
      },
      notify: async (key: string, _ms: number, text: string) => {
        alerts.push({ key, text });
      },
      resolve: async (key: string, text: string) => {
        resolved.push({ key, text });
        return true;
      },
      cooldownMs: 60_000,
    },
  };
}

// A readable config: the booker can explain an empty week, so this tick has a
// MEASURED healthy verdict and may clear the page (#1152).
{
  const h = harness();
  const res = await runEmptyReasonCheck({
    inputs: { hours: HOURS, horizonDays: 4, nowMs: NOW },
    ...h.deps,
  });
  eq(res.status, "explains", "a readable config reports that the booker can explain");
  eq(h.alerts.length, 0, "and pages nobody");
  eq(h.resolved.length, 1, "and clears any standing page off that measured reading");
  eq(h.resolved[0]?.key, BOOKER_EMPTY_REASON_KEY, "on the one key");
  eq(h.cleared(), 1, "and resets the streak, so a later blip starts from one again");
}

// Unreadable, and it has persisted. This is the page.
{
  const h = harness({ streakHit: true });
  const res = await runEmptyReasonCheck({
    inputs: { hours: null, horizonDays: 4, nowMs: NOW },
    ...h.deps,
  });
  eq(res.status, "blind", "an unreadable config reports that the booker cannot explain");
  eq(h.alerts.length, 1, "and pages");
  eq(h.alerts[0]?.key, BOOKER_EMPTY_REASON_KEY, "on the one key");
  assert(
    h.alerts[0]?.text.includes("business hours") === true,
    "and the page says which input it could not read",
  );
  eq(h.resolved.length, 0, "and clears nothing, because nothing was measured healthy");
}

// The FIRST unreadable tick stays quiet. A single failed read is an ordinary
// database blip; paging on one would be the alert that cries wolf (L36), and the
// issue asks for a REPEATEDLY unclassifiable window.
{
  const h = harness({ streakHit: false });
  const res = await runEmptyReasonCheck({
    inputs: { hours: null, horizonDays: null, nowMs: NOW },
    ...h.deps,
  });
  eq(res.status, "blind", "a single unreadable tick is still reported as blind");
  eq(h.alerts.length, 0, "but does not page on its own");
  eq(
    h.resolved.length,
    0,
    "and must not clear either: a tick that could not read its signal concludes nothing in " +
      "EITHER direction (#1152)",
  );
  eq(h.streakCalls(), 1, "the tick is counted, so a second one reaches the threshold");
}

// Both directions, or a check wired to one answer passes the case above while
// being wrong for every other one (L1).
{
  const blind = harness();
  await runEmptyReasonCheck({ inputs: { hours: null, horizonDays: 4, nowMs: NOW }, ...blind.deps });
  const fine = harness();
  await runEmptyReasonCheck({ inputs: { hours: HOURS, horizonDays: 4, nowMs: NOW }, ...fine.deps });
  assert(
    blind.alerts.length === 1 && blind.resolved.length === 0,
    "the blind config pages and clears nothing",
  );
  assert(
    fine.alerts.length === 0 && fine.resolved.length === 1,
    "and the readable one clears and pages nothing",
  );
}

// A flaky Slack must never fail the monitor tick or take out the checks after it.
{
  const res = await runEmptyReasonCheck({
    inputs: { hours: null, horizonDays: 4, nowMs: NOW },
    streak: async () => true,
    clearStreak: async () => {},
    notify: async () => {
      throw new Error("slack is down");
    },
    resolve: async () => true,
    cooldownMs: 60_000,
  });
  eq(res.status, "blind", "a failed send still returns the verdict rather than throwing out");
}

// ------------------------------------------------------------- the copy

{
  const page = formatEmptyReasonAlert("the org's business hours could not be read");
  assert(page.length > 0, "the page has text");
  assert(
    /closed/i.test(page) && /booked|taken|full/i.test(page),
    "and says what the lead is NOT being told, which is the cost of the fault",
  );
  assert(
    page.includes("the org's business hours could not be read"),
    "and carries the specific blocker rather than a generic failure",
  );
  assert(!/—|–/.test(page), "no dashes as punctuation (copy rule)");
  assert(!page.startsWith("Slate"), "and it does not open with the word Slate (preview guard)");

  const clear = formatEmptyReasonRecovery();
  assert(clear.length > 0, "the all-clear has text");
  assert(!/—|–/.test(clear), "no dashes there either");
  assert(clear !== page, "and it is not the page repeated back");
}

// The streak key and the alert key are separate constants: one throttles the
// COUNTING and one throttles the SENDING, and sharing them would make clearing the
// streak also clear the page.
eq(
  BOOKER_EMPTY_REASON_KEY === EMPTY_REASON_STREAK_KEY,
  false,
  "the alert key and the streak key are distinct",
);

// The streak window has to outlast the lane's own interval, or two genuinely
// consecutive ticks land in DIFFERENT windows, each looks like the first, the
// threshold is never reached and the page can never fire at all. Checked against
// the real schedule rather than a number written here, so moving the lane between
// crons cannot silently disarm this (L41).
{
  const forMonitor = Object.entries(CRON_ROUTES).find(([, routes]) =>
    (Array.isArray(routes) ? routes : [routes]).includes("/api/cron/monitor"),
  );
  assert(forMonitor !== undefined, "the monitor lane is on a cron schedule");
  const minutes = /^\*\/(\d+) /.exec(forMonitor![0]);
  assert(minutes !== null, `the monitor cron is an every-N-minutes expression (${forMonitor![0]})`);
  const intervalS = Number(minutes![1]) * 60;
  assert(
    EMPTY_REASON_STREAK_WINDOW_S >= intervalS * 2,
    `the streak window (${EMPTY_REASON_STREAK_WINDOW_S}s) comfortably outlasts the lane's ` +
      `${intervalS}s interval, so two consecutive ticks reach the threshold`,
  );
}

finish();

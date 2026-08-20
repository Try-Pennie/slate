// Pure logic for the low-booking-volume alert (#370): which time windows are
// below their expected floor, and the business-hours gate (Eastern, DST-aware)
// that keeps it from firing overnight/weekends when low volume is normal. Run:
//   node --experimental-strip-types scripts/test-monitor-booking-volume.ts
import {
  isBusinessHours,
  lowVolumeBreaches,
  formatLowVolumeAlert,
  runLowVolumeCheck,
  VOLUME_ALERT_KEY,
  VOLUME_COUNT_UNREADABLE_KEY,
  type BusinessHoursConfig,
  type VolumeWindow,
} from "../src/lib/monitor/booking-volume.ts";
import { assert, finish } from "./lib/harness.ts";

/** Em/en dash detector built from escapes: writing the characters themselves
 *  would trip the repo's own copy lint on this very file. */
const DASHES = new RegExp("[\\u2013\\u2014]");

/**
 * The org's real stored week: Monday to SATURDAY, 08:00 to 20:00 Eastern (#1298).
 *
 * This fixture used to be a hand-written weekdays 1 to 5 window, matching a second
 * hardcoded copy of the org's hours that lived beside the alert. It is now the shape
 * the hours are actually stored in, and the Saturday case below is the day the alarm
 * was blind for.
 */
const CFG: BusinessHoursConfig = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    start_minute: 8 * 60,
    end_minute: 20 * 60,
  })),
  exceptions: [],
};

// --- isBusinessHours (Eastern, DST aware) ---
{
  assert(isBusinessHours(Date.UTC(2026, 5, 23, 23, 0, 0), CFG), "summer 19:00 ET weekday -> business hours (ET not UTC)");
  assert(isBusinessHours(Date.UTC(2026, 0, 6, 0, 30, 0), CFG), "winter 19:30 EST weekday -> business hours (DST aware)");
  assert(!isBusinessHours(Date.UTC(2026, 5, 21, 16, 0, 0), CFG), "SUNDAY -> outside (the org's one closed day)");
  assert(!isBusinessHours(Date.UTC(2026, 5, 23, 7, 0, 0), CFG), "overnight ET -> outside");

  // #1298: the day the alarm was blind for. The org is open on Saturday, so a
  // Saturday with no bookings is a real finding rather than an expected quiet.
  assert(
    isBusinessHours(Date.UTC(2026, 5, 20, 16, 0, 0), CFG),
    "SATURDAY noon ET -> inside: the org is open, so the volume alarm watches it",
  );
  // #1363: a date the org has closed is NOT business hours, whatever the weekday
  // says. This is the loudest possible way to be wrong about a quiet day: paging
  // that bookings have dried up on a day the office is deliberately shut.
  const holiday: BusinessHoursConfig = {
    ...CFG,
    exceptions: [
      { on_date: "2026-06-20", is_open: false, start_minute: null, end_minute: null, note: "shutdown" },
    ],
  };
  assert(
    !isBusinessHours(Date.UTC(2026, 5, 20, 16, 0, 0), holiday),
    "a CLOSED date reads as outside hours, so the alarm stays quiet rather than paging about a shut day",
  );
  assert(
    isBusinessHours(Date.UTC(2026, 5, 19, 16, 0, 0), holiday),
    "and the day before it is watched exactly as before",
  );
  // The other direction: a date opened against the weekly pattern IS watched, or
  // the one day somebody deliberately staffed would be the one nobody checked.
  const openSunday: BusinessHoursConfig = {
    ...CFG,
    exceptions: [
      { on_date: "2026-06-21", is_open: true, start_minute: 10 * 60, end_minute: 14 * 60, note: null },
    ],
  };
  assert(
    isBusinessHours(Date.UTC(2026, 5, 21, 16, 0, 0), openSunday),
    "a Sunday opened by date is watched, in its own window",
  );
  assert(
    !isBusinessHours(Date.UTC(2026, 5, 21, 19, 0, 0), openSunday),
    "and that window closes when it says it does, not when the weekday's would",
  );

  // And the window really does close on Saturday evening, so this is a window and
  // not an "always open at weekends" mistake in the other direction.
  assert(
    !isBusinessHours(Date.UTC(2026, 5, 21, 3, 0, 0), CFG),
    "Saturday 23:00 ET -> outside, so Saturday is a WINDOW and not an open-ended day",
  );

  // An empty week is shut everywhere, which is a legitimate stored answer and is
  // why the caller must skip rather than pass an empty list for a read it could
  // not make: that would silence the alarm instead of reporting it unmeasured.
  const closedOrg: BusinessHoursConfig = { zone: "America/New_York", rules: [], exceptions: [] };
  assert(
    !isBusinessHours(Date.UTC(2026, 5, 23, 16, 0, 0), closedOrg),
    "an org with no stored windows is shut, even at what would be midday",
  );
}

// --- lowVolumeBreaches ---
{
  const windows: VolumeWindow[] = [
    { label: "30 min", count: 0, floor: 10 }, // breached
    { label: "120 min", count: 50, floor: 40 }, // healthy
  ];
  const out = lowVolumeBreaches(windows);
  assert(out.length === 1 && out[0].label === "30 min", "flags a window whose count is below its floor");
  assert(!out.some((w) => w.label === "120 min"), "ignores a window at or above its floor");
  assert(lowVolumeBreaches([{ label: "30 min", count: 10, floor: 10 }]).length === 0, "count exactly at the floor is NOT a breach");
  assert(lowVolumeBreaches([]).length === 0, "no windows -> no breaches");
}

// --- formatLowVolumeAlert ---
{
  const msg = formatLowVolumeAlert([{ label: "30 min", count: 0, floor: 25 }]);
  assert(msg.includes("0") && msg.includes("30 min") && msg.includes("25"), "alert states the count, window, and expected floor");
  assert(!/[\u2013\u2014]/.test(msg), "alert uses no em/en dashes (copy rule)");
}

// --- runLowVolumeCheck (#1158): the paging DECISION, extracted from the cron
// route so the gates (business hours, armed) and the failure path (a count read
// that fails must claim nothing, never zero) are pinned by tests. ---

/** A weekday 14:00 ET instant, squarely inside business hours. */
const BUSINESS_NOW = Date.UTC(2026, 5, 23, 18, 0, 0);
/** A Saturday, outside business hours. */
// #1298: SUNDAY, the org's one closed day. This fixture used to be a Saturday, back
// when the alarm carried its own weekdays 1 to 5 copy of the opening hours. Saturday
// is an OPEN day, so using it as the closed case is what made a whole blind day look
// deliberate.
const CLOSED_DAY_NOW = Date.UTC(2026, 5, 21, 18, 0, 0);

function harness(overrides: {
  counts?: Record<string, number | null>;
  /** Counts for the RETRY, when it should answer differently from the first go. */
  retryCounts?: Record<string, number | null>;
  countThrows?: boolean;
  notifyThrows?: boolean;
  nowMs?: number;
  armed?: boolean;
  floors?: { floor30: number; floor120: number };
  unreadableFiring?: boolean;
  settleThrows?: boolean;
}) {
  const notified: { key: string; cooldownMs: number; text: string }[] = [];
  const resolved: { key: string; text: string }[] = [];
  const logged: Record<string, unknown>[] = [];
  const countCalls: string[] = [];
  const attempts = new Map<string, number>();
  /** How many times the batched all-clear seam was called: it must be at most one
   *  per tick, because it costs an alert_state read on a shared budget. */
  let settleCalls = 0;
  const run = () =>
    runLowVolumeCheck({
      nowMs: overrides.nowMs ?? BUSINESS_NOW,
      businessHours: CFG,
      countSince: async (sinceIso: string) => {
        countCalls.push(sinceIso);
        if (overrides.countThrows) throw new Error("bookings read failed");
        const minutes = String(
          Math.round(((overrides.nowMs ?? BUSINESS_NOW) - Date.parse(sinceIso)) / 60_000),
        );
        const nth = (attempts.get(minutes) ?? 0) + 1;
        attempts.set(minutes, nth);
        // `in` rather than `??`: a configured null means "read failed" and must
        // reach the check as null, not collapse to 0.
        const counts = nth > 1 && overrides.retryCounts ? overrides.retryCounts : overrides.counts ?? {};
        return minutes in counts ? counts[minutes] : 0;
      },
      floors: overrides.floors ?? { floor30: 5, floor120: 20 },
      armed: overrides.armed ?? true,
      cooldownMs: 30 * 60_000,
      notify: async (key: string, cooldownMs: number, text: string) => {
        if (overrides.notifyThrows) throw new Error("slack down");
        notified.push({ key, cooldownMs, text });
      },
      notifyCountUnreadable: async (key: string, cooldownMs: number, text: string) => {
        if (overrides.notifyThrows) throw new Error("slack down");
        notified.push({ key, cooldownMs, text });
      },
      resolveRecovered: async (recovered: { key: string; text: string }[]) => {
        settleCalls++;
        if (overrides.settleThrows) throw new Error("alert_state unreachable");
        resolved.push(...recovered);
        return overrides.unreadableFiring ? recovered.map((r) => r.key) : [];
      },
      log: (fields: Record<string, unknown>) => logged.push(fields),
    });
  return { run, notified, resolved, logged, countCalls, get settleCalls() { return settleCalls; } };
}

// Outside business hours: no reads, no alert, explicit status.
// Sunday, which is the only day of the week the org is shut.
{
  const h = harness({ nowMs: CLOSED_DAY_NOW });
  const res = await h.run();
  assert(res.status === "outside-hours", "outside business hours the check does not run");
  assert(h.countCalls.length === 0, "outside business hours no booking counts are read");
  assert(h.notified.length === 0, "outside business hours nothing is alerted");
}

// Healthy volume: checked, no breach, no alert, counts logged.
{
  const h = harness({ counts: { "30": 9, "120": 40 } });
  const res = await h.run();
  assert(res.status === "checked" && res.breaches.length === 0, "healthy counts above the floors are no breach");
  assert(h.notified.length === 0, "healthy volume sends no alert");
  assert(
    h.logged.some((f) => f.count_30m === 9 && f.count_120m === 40 && f.below_floor === 0),
    "the log line carries both counts and a zero breach count",
  );
}

// Breach while armed: pages once with the shared key and the settings cooldown.
{
  const h = harness({ counts: { "30": 1, "120": 40 } });
  const res = await h.run();
  assert(res.status === "checked" && res.breaches.length === 1, "a count below its floor is a breach");
  assert(h.notified.length === 1, "an armed breach pages exactly once");
  assert(h.notified[0]?.key === VOLUME_ALERT_KEY, "the page uses the shared alert key");
  assert(h.notified[0]?.cooldownMs === 30 * 60_000, "the page uses the injected cooldown");
  assert(h.notified[0]?.text.includes("30 min") === true, "the page names the breached window");
}

// Breach while disarmed: counted and logged, never paged.
{
  const h = harness({ counts: { "30": 1, "120": 40 }, armed: false });
  const res = await h.run();
  assert(res.status === "checked" && res.breaches.length === 1, "a disarmed breach is still reported in the result");
  assert(h.notified.length === 0, "a disarmed breach never pages");
  assert(h.logged.some((f) => f.armed === false), "the log line says the alarm is disarmed");
}

// THE FAILURE PATH (#1158): a failed count read must claim nothing. Before the
// extraction a read error became count 0, which is below any real floor, so an
// unreadable bookings table would have paged "0 bookings" off a query that never
// ran (the #1134/#1152 class, on the paging side).
{
  // Dan (2026-08-05): a failed count should "retry at once and page if the retry
  // fails". A read failure is a DATABASE problem, so the page must never be the
  // low-volume one: dressing it as a booking drought sends the reader to the
  // funnel instead of the query (#1158's reasoning).
  const h = harness({ counts: { "30": null, "120": 40 }, retryCounts: { "30": 7, "120": 40 } });
  const res = await h.run();
  assert(res.status === "checked", "a retry that succeeds gives the tick a real verdict");
  assert(h.notified.length === 0, "and pages nothing, because nothing was actually wrong");
  assert(
    h.countCalls.filter((c) => c.includes("T17:30")).length === 2,
    "the failed window is re-read exactly once",
  );
  assert(
    h.countCalls.filter((c) => c.includes("T16:00")).length === 1,
    "and the window that SUCCEEDED is not re-read: the retry lands on a subrequest budget four cron lanes share",
  );
}
{
  const h = harness({ counts: { "30": null, "120": 40 } });
  const res = await h.run();
  assert(res.status === "count-unreadable", "two failed attempts is its own outcome, not a low volume reading");
  assert(h.notified.length === 1, "and pages, so a persistently broken count surfaces inside the tick");
  assert(
    h.notified[0].key === VOLUME_COUNT_UNREADABLE_KEY,
    "on its OWN key, never the low-volume one",
  );
  assert(
    /count|read|quer/i.test(h.notified[0].text),
    "and the copy sends the reader to the query rather than to the funnel",
  );
  assert(!DASHES.test(h.notified[0].text), "no dashes in alert copy");
  assert(!h.notified[0].text.startsWith("Slate"), "an alert never opens with the word Slate");
}
{
  // The arm switch exists so the ramp cannot cry wolf about VOLUME. An unreadable
  // query is not a volume claim, so it pages either way.
  const h = harness({ counts: { "30": null, "120": null }, armed: false });
  const res = await h.run();
  assert(res.status === "count-unreadable", "a disarmed probe still reports the unreadable count");
  assert(h.notified.length === 1, "and still pages: a broken query is not a volume claim");
}
{
  // The condition owes the reader an end (#1151), hung off a MEASURED read.
  const h = harness({ counts: { "30": 9, "120": 40 }, unreadableFiring: true });
  const res = await h.run();
  assert(res.status === "checked", "a clean tick is checked");
  assert(
    h.resolved.some((r) => r.key === VOLUME_COUNT_UNREADABLE_KEY),
    "and clears the unreadable-count page",
  );
  assert(h.resolved[0].key === VOLUME_COUNT_UNREADABLE_KEY, "on the same key it paged on");
  assert(!DASHES.test(h.resolved[0].text), "no dashes in the all-clear either");
}
{
  const h = harness({ counts: { "30": null, "120": 40 } });
  await h.run();
  assert(
    h.resolved.length === 0,
    "a tick that could not read the count clears nothing: an all-clear may only hang off a measured result",
  );
}
{
  const h = harness({ nowMs: CLOSED_DAY_NOW, unreadableFiring: true });
  await h.run();
  assert(
    h.resolved.length === 0,
    "outside business hours nothing is read, so nothing is cleared either",
  );
}

// A count reader that THROWS (instead of returning null) must not kill the tick.
{
  const h = harness({ countThrows: true });
  const res = await h.run();
  assert(res.status === "count-unreadable", "a throwing count read is unreadable, after its retry");
  assert(
    h.notified.length === 1 && h.notified[0].key === VOLUME_COUNT_UNREADABLE_KEY,
    "and pages on the unreadable key, never as a false zero",
  );
}
{
  const h = harness({ counts: { "30": null, "120": 40 }, notifyThrows: true });
  const res = await h.run();
  assert(
    res.status === "count-unreadable",
    "a throwing notify is swallowed and the check still reports the unreadable count",
  );
}

// A flaky Slack must never fail the monitor tick (matches the other checks).
{
  const h = harness({ counts: { "30": 0, "120": 0 }, notifyThrows: true });
  const res = await h.run();
  assert(res.status === "checked", "a throwing notify is swallowed and the check still reports");
}

// --- the low-volume all-clear (#1390) -----------------------------------------
// `low_booking_volume` was the one paging key with no recovery path at all: a
// reader woken about a booking drought was never told when it ended. It is a
// CONDITION (volume comes back, and the same lane re-measures it every 5 minutes),
// so it owes an ending, and that ending must hang off a count that was actually
// READ (#1152), never off "we did not page this run".
{
  const h = harness({ counts: { "30": 9, "120": 40 } });
  const res = await h.run();
  assert(res.status === "checked", "a measured healthy tick reports checked");
  const keys = h.resolved.map((r) => r.key);
  assert(keys.includes(VOLUME_ALERT_KEY), "a measured reading above both floors offers the volume all-clear");
  assert(
    keys.includes(VOLUME_COUNT_UNREADABLE_KEY),
    "and still offers the count-readable notice, in the SAME settle call",
  );
  const text = h.resolved.find((r) => r.key === VOLUME_ALERT_KEY)?.text ?? "";
  assert(/no action is needed/i.test(text), "the volume all-clear closes the loop");
  assert(!DASHES.test(text), "the volume all-clear has no dashes");
  assert(
    !/undefined|NaN|\[object Object\]/.test(text),
    "the volume all-clear renders no placeholder leak",
  );
}

// One read, not two. Both all-clears go through a single settle call, because
// this lane shares a subrequest budget with three others and asking per key is
// how #1134 got expensive.
{
  const h = harness({ counts: { "30": 9, "120": 40 } });
  await h.run();
  assert(h.settleCalls === 1, "both keys are settled in ONE call, so the healthy tick costs one read");
}

// A tick that measured a BREACH must not also clear the very page it is sending.
{
  const h = harness({ counts: { "30": 0, "120": 0 } });
  await h.run();
  assert(
    h.notified.some((n) => n.key === VOLUME_ALERT_KEY),
    "a breach still pages",
  );
  assert(
    !h.resolved.some((r) => r.key === VOLUME_ALERT_KEY),
    "a breaching tick clears nothing about volume",
  );
}

// The failure paths, which are the point. Each of these measured NOTHING about
// volume, so none may announce that volume recovered.
{
  const weekend = harness({ nowMs: CLOSED_DAY_NOW });
  await weekend.run();
  assert(
    !weekend.resolved.some((r) => r.key === VOLUME_ALERT_KEY),
    "outside business hours nothing is cleared: the tick read no counts at all",
  );

  const unreadable = harness({ counts: { "30": null, "120": null } });
  const res = await unreadable.run();
  assert(res.status === "count-unreadable", "two failed reads report count-unreadable");
  // Nothing AT ALL, in either key: a tick that could not read its own count has
  // measured nothing, so it cannot announce that anything recovered (#1152).
  assert(
    unreadable.resolved.length === 0,
    "a count that could not be read clears nothing (it is the false zero #1158 removed)",
  );

  const threw = harness({ countThrows: true });
  await threw.run();
  assert(
    !threw.resolved.some((r) => r.key === VOLUME_ALERT_KEY),
    "a reader that threw clears nothing about volume",
  );
}

// A disarmed tick still clears an outstanding page. The arming switch (#575)
// exists so the ramp cannot cry wolf about volume; it is not a reason to leave a
// page that was delivered while armed hanging forever after someone disarms it.
{
  const h = harness({ counts: { "30": 9, "120": 40 }, armed: false });
  await h.run();
  assert(
    h.resolved.some((r) => r.key === VOLUME_ALERT_KEY),
    "a healthy reading offers the all-clear even while disarmed",
  );
}

// A settle that throws must not take down the tick.
{
  const h = harness({ counts: { "30": 9, "120": 40 }, settleThrows: true });
  const res = await h.run();
  assert(res.status === "checked", "a failed settle still returns the measured result");
}

finish();

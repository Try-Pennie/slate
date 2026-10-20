/**
 * The words of the daily busy minute check (#3124), as pure builders so
 * `pnpm preview:alerts` renders exactly what ships.
 *
 * Minutes are named in ET, the zone everybody reading the channel works in; the days
 * they are counted on are UTC days (see `busy-minutes.ts`), which the alert says once.
 * No raw error ever reaches these: a refused cal.com page is named by its status and
 * the form's name, both short and written by cal.com's own API, and the detail of a
 * failed Slate read is in the Worker logs under tag=busy-minutes.
 */
import { formatSlotDay, formatSlotTime } from "../booking/slot-label.ts";
import { BUSY_DAYS_TO_ALERT, BUSY_WINDOW_DAYS, type BusyMinute, type BusyVerdict, type UnmeasuredReason } from "./busy-minutes.ts";

type Measured = Extract<BusyVerdict, { kind: "measured" }>;

const ZONE = "America/New_York";

function whenEt(atMs: number): string {
  const iso = new Date(atMs).toISOString();
  return `${formatSlotDay(iso, ZONE)} at ${formatSlotTime(iso, ZONE)} ET`;
}

/** "9 on Wed, Oct 15 at 11:30am ET (4 on Slate and 5 on cal.com)". */
function minuteLine(m: BusyMinute, calcomCounted: boolean): string {
  const split = calcomCounted ? ` (${m.slate} on Slate and ${m.calcom} on cal.com)` : "";
  return `${m.total} on ${whenEt(m.atMs)}${split}`;
}

function counted(v: Measured): string {
  return v.calcomCounted
    ? "cal.com's routed responses and Slate's routed bookings, added minute by minute"
    : "Slate alone, since cal.com is marked retired";
}

/** The bar is outgrown: a busy minute on `BUSY_DAYS_TO_ALERT` or more days of the window. */
export function loadBarOutgrownAlert(v: Measured): string {
  const days = v.crossingDays.map((d) => `• ${minuteLine(d.busiest, v.calcomCounted)}`).join("\n");
  return (
    `Routed bookings reached ${v.threshold} or more in a minute on ${v.crossingDays.length} of the last ${BUSY_WINDOW_DAYS} days ` +
    `(UTC days), more than a tenth of the booking load run's bar of ${v.barPerMinute} a minute, so the bar no longer sits ten times over real traffic. ` +
    `Counted from ${counted(v)}. Each day's busiest minute:\n${days}\n` +
    `Raise the booking load run's bar (LOAD_RUN_BOOKINGS_PER_MINUTE in src/lib/load-bar.ts) to ten times the busiest minute, ` +
    `and rerun the booking load run at the new bar (#3124).`
  );
}

/** A measured week with fewer than `BUSY_DAYS_TO_ALERT` busy days. */
export function loadBarOutgrownRecovery(v: Measured): string {
  const peak = v.busiest ? ` The busiest minute was ${minuteLine(v.busiest, v.calcomCounted)}.` : "";
  return (
    `Routed bookings reached ${v.threshold} or more in a minute on ${v.crossingDays.length} of the last ${BUSY_WINDOW_DAYS} days, ` +
    `under the ${BUSY_DAYS_TO_ALERT} that would mean the booking load run's bar of ${v.barPerMinute} a minute needs raising.${peak}`
  );
}

function reasonText(r: UnmeasuredReason): string {
  switch (r.kind) {
    case "slate-unreadable":
      return "Slate's own bookings could not be read (the routed_bookings_per_minute read failed or answered in a shape it does not know; the Worker logs under tag=busy-minutes have the detail)";
    case "calcom-unreadable":
      return r.status === 0
        ? `cal.com's routing form responses could not be read: the request never answered${r.formName ? ` for "${r.formName}"` : ""}, so the read was partial`
        : `cal.com answered ${r.status} for the routing form responses${r.formName ? ` of "${r.formName}"` : ""}, so the read was partial` +
            (r.status === 429 ? " (its rate limit, shared with everything else using the key)" : "");
    case "calcom-empty":
      return "cal.com answered with no routed lead in the whole window while it is not marked retired. If cutover has happened, mark cal.com retired on /admin/alerts; if not, its responses are not reaching this read";
    case "calcom-not-configured":
      return "this deployment holds no cal.com key while cal.com is not marked retired, so cal.com's half, most of the traffic before cutover, could not be read";
    case "calcom-retired-unknown":
      return "whether cal.com is retired could not be read, so it is not known whether cal.com's half belongs in the count";
    case "calcom-bad-stamp":
      return "a routed cal.com response carried a creation time that is not a time, so a booking would have been left out of its minute";
    case "nothing-counted":
      return "neither Slate nor cal.com held a single routed booking in the window, which is a read gone wrong rather than a quiet week";
  }
}

/** A run that could not count, on the day's last attempt. */
export function loadBarUnreadAlert(reasons: readonly UnmeasuredReason[]): string {
  const lines = reasons.map((r) => `• ${reasonText(r)}.`).join("\n");
  return (
    `The daily count of routed bookings a minute could not count the last ${BUSY_WINDOW_DAYS} days, so it is not known whether the ` +
    `booking load run's bar still sits ten times over the busiest minutes. What stopped it:\n${lines}\n` +
    `It counts again early tomorrow morning ET (#3124).`
  );
}

/** The next measured run after a could not count page. */
export function loadBarUnreadRecovery(): string {
  return "The daily count of routed bookings a minute is counting again, so the check on the booking load run's bar is back (#3124).";
}

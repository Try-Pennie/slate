// Semi-monthly pay-period boundaries (#305): equal-share fairness resets on the
// 15th and 25th, in America/New_York. The window [start, end) a given instant
// falls into. DST-correct (boundaries are local wall-clock midnight, not a fixed
// UTC offset), so we assert by converting the returned ms back to ET.
import { DateTime } from "luxon";
import { payPeriod } from "../src/lib/availability/roundrobin.ts";

const TZ = "America/New_York";
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else console.log("ok:", msg);
};

const et = (ms: number) => DateTime.fromMillis(ms, { zone: TZ });
const ms = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis();
// Assert a boundary instant is the given local date at wall-clock midnight.
const isMidnight = (boundaryMs: number, y: number, m: number, d: number, label: string) => {
  const b = et(boundaryMs);
  ok(
    b.year === y && b.month === m && b.day === d && b.hour === 0 && b.minute === 0,
    `${label}: ${b.toISO()} is ${y}-${m}-${d} 00:00 ET`,
  );
};

// Mid-month (15th..24th) -> [15th, 25th) this month.
{
  const p = payPeriod(ms("2026-06-19T12:00:00"), TZ);
  isMidnight(p.startMs, 2026, 6, 15, "day 19 start");
  isMidnight(p.endMs, 2026, 6, 25, "day 19 end");
}
// Late month (>=25th) -> [25th this month, 15th next month).
{
  const p = payPeriod(ms("2026-06-26T09:00:00"), TZ);
  isMidnight(p.startMs, 2026, 6, 25, "day 26 start");
  isMidnight(p.endMs, 2026, 7, 15, "day 26 end (long stretch into next month)");
}
// Early month (<15th) -> [25th prev month, 15th this month).
{
  const p = payPeriod(ms("2026-06-10T23:00:00"), TZ);
  isMidnight(p.startMs, 2026, 5, 25, "day 10 start (prev month)");
  isMidnight(p.endMs, 2026, 6, 15, "day 10 end");
}
// Year rollover: early January -> [Dec 25 prior year, Jan 15).
{
  const p = payPeriod(ms("2026-01-05T08:00:00"), TZ);
  isMidnight(p.startMs, 2025, 12, 25, "Jan 5 start (Dec 25 prior year)");
  isMidnight(p.endMs, 2026, 1, 15, "Jan 5 end");
}
// Exactly on a boundary instant belongs to the period it opens (>=).
{
  const p = payPeriod(ms("2026-06-15T00:00:00"), TZ);
  isMidnight(p.startMs, 2026, 6, 15, "exactly 15th 00:00 -> opens the [15th,25th) window");
}
// DST spring-forward (US 2026-03-08) and fall-back (2026-11-01): a boundary in
// those months must still land on local midnight, not be off by an hour.
isMidnight(payPeriod(ms("2026-03-20T12:00:00"), TZ).startMs, 2026, 3, 15, "March DST: 15th boundary");
isMidnight(payPeriod(ms("2026-11-20T12:00:00"), TZ).startMs, 2026, 11, 15, "Nov DST: 15th boundary");

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

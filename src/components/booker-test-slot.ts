/**
 * Test fixture helper: an offered slot at a fixed local hour in the zone the
 * booker will SHOW (#2310). Imported only by component tests.
 *
 * The booker, the manage page and the admin panel offer a time only inside the
 * lead's calling window (08:00 to 20:00 in the displayed zone). Fixtures used to
 * be built as `now + N days` at whatever time the suite happened to run, or with
 * `setHours` on a machine Date, so whether the fixture was offered at all
 * depended on the hour and on the machine's zone: green locally, red in CI (which
 * runs in UTC, which the booker resolves to Eastern). Building the slot from the
 * booker's own zone resolution at a fixed daytime hour removes both (L130, L504).
 */
import { DateTime } from "luxon";

import { deviceTimeZone, resolveZone } from "@/lib/booking/timezones";

export function bookerSlotIso(daysAhead: number, hour = 12, zone?: string): string {
  const z = zone ?? resolveZone(deviceTimeZone()).id;
  const iso = DateTime.now()
    .setZone(z)
    .plus({ days: daysAhead })
    .set({ hour, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO();
  if (!iso) throw new Error(`bookerSlotIso: could not build a slot in ${z}`);
  return iso;
}

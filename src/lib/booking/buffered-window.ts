/**
 * Dependency free on purpose: the availability truth probe (#2991) has no app
 * imports so its suite runs on bare node, and it must judge the SAME window the
 * booking path does rather than a copy of the arithmetic.
 */
/**
 * The span a live free check must find clear: the call plus the event type's
 * buffer before and after. It is the same window `bookableSlotReason` judges the
 * cached busy time over, so a meeting that reached the calendar after the cache
 * was read cannot land a call back to back with it at the last check either.
 * Every live check that places a booking on an advisor goes through this, and
 * so does the probe that audits the times Slate offers.
 */
export function bufferedWindow(
  eventType: { buffer_before_min: number; buffer_after_min: number },
  startIso: string,
  endIso: string,
): [string, string] {
  const MIN = 60_000;
  return [
    // parse-ok: both bounds come from bookingWindow's toISOString, so they parse.
    new Date(Date.parse(startIso) - eventType.buffer_before_min * MIN).toISOString(),
    // parse-ok: as above.
    new Date(Date.parse(endIso) + eventType.buffer_after_min * MIN).toISOString(),
  ];
}

/**
 * The floors behind the embed booker's own refusal signals (#1727), DERIVED from a
 * recorded measurement of production rather than typed by hand.
 *
 * The three refusals are the booker's hourly address cap, its per contact cap and
 * its hidden bot trap. Each is kept out of the booking failure share (counting a
 * bot there dilutes what a real outage has to move), and each is judged on its own
 * in `api-refusal-signals.ts`. This module holds only the numbers, the measurement
 * they came from, and the one function that turns the second into the first, so
 * the offline suite asserts the SHIPPED floors are what the measurement derives
 * (L63) and a re-measurement changes them in one place.
 *
 * ## Why the two caps count PEOPLE, not trips
 *
 * The tally Slate already has counts EVENTS: one row per refused request. A volume
 * cannot tell the one case that matters from the one that does not. A single bot
 * reusing one fake identity trips the per contact cap on every request after its
 * fifth, so it produces a steady run of trips in every interval; forty leads each
 * tripping once produce the same total. Only the first is abuse the cap exists to
 * stop. So the caps are judged on how many DISTINCT keys the limiter is refusing,
 * which is the robust option and the one the issue anticipated the counter cannot
 * express.
 *
 * It needs no new storage. The limiter already keeps one row per key per window
 * (`rate_limits`, migration 0024) whose count goes on rising past the limit, so a
 * key whose CURRENT window started inside the last window length and whose count is
 * over the limit is a key being refused right now. Counting those rows is a distinct
 * count of locked out addresses, or of locked out email and phone keys, read from
 * the limiter's own decision state rather than from a second record of it (L58).
 *
 * What that reading CAN express: how many addresses, and how many contact keys, are
 * locked out at the moment of the read. What it CANNOT: (1) an identity refused late
 * in a window that has since expired drops out until it is hit again, so it is a
 * picture of who is locked out now rather than of everyone refused in the last hour;
 * (2) one person can hold two contact keys (an email and a phone), so a single bot
 * can show as two, which is why the floor sits above two; (3) many real leads behind
 * ONE address (a mobile carrier's shared address) read as one address, so the
 * address cap's signal is blind to the case where the address cap is wrong for a
 * shared address; (4) the limiter rows carry no test marker, so a tester locking
 * themselves out counts, which the floor of three keeps from paging on its own.
 *
 * The honeypot is the opposite: no person can fill a field they cannot see, so every
 * trip is a script and the VOLUME is the measurement. It pages on a volume floor and
 * on persistence across intervals, like the credential and list signals.
 */

/**
 * What production looked like when the floors were set. Every figure is read off
 * the live system; how each was read is beside it, so the next measurement can be
 * taken the same way (L316).
 */
export interface EmbedRefusalMeasurement {
  /** The day the reading was taken (ET). */
  measuredOn: string;
  /** Hours of Worker logs read, each queried as its own one hour window because a
   *  wider one is sampled. */
  hoursObserved: number;
  /** `tag=booking msg="confirm answered"` lines over those hours: one per confirm. */
  confirmsObserved: number;
  /** The busiest single hour of confirms. */
  peakHourlyConfirms: number;
  /** `tag=booking-rate-limit msg="throttled"` lines in the busiest hour, per cap. A
   *  refusal of a distinct key needs at least one throttle, so this bounds how many
   *  keys were ever locked out in an hour from above. */
  peakHourlyThrottles: { address: number; contact: number };
  /** `tag=booking-honeypot` lines in the busiest hour. */
  peakHourlyHoneypot: number;
  /** Keys over their limit in a live window at the moment of measurement, read from
   *  `rate_limits` as the monitor reads them. */
  lockedOutAtMeasure: { addresses: number; contactKeys: number };
}

/**
 * Measured 2026-10-16 (ET) over the 167 hours from 2026-10-10 02:00Z to 2026-10-17
 * 01:00Z, every hour queried on its own against a `tag=recompute` control that was
 * present in every one (46 to 147 lines an hour). The tally agrees on the volume:
 * 394 to 521 attempts a day across the eight days to 2026-10-16. Over the whole
 * period not one throttle of any cap was logged and not one honeypot trip: the only
 * `tag=booking-rate-limit` lines were five `retry after a taken time` passes, which
 * are admissions. At the moment of measurement 453 address rows and 904 contact
 * rows were in `rate_limits` and none was over its limit, the highest count on
 * either being 1.
 */
export const MEASURED_EMBED_REFUSALS: EmbedRefusalMeasurement = {
  measuredOn: "2026-10-16",
  hoursObserved: 167,
  confirmsObserved: 3394,
  peakHourlyConfirms: 59,
  peakHourlyThrottles: { address: 0, contact: 0 },
  peakHourlyHoneypot: 0,
  lockedOutAtMeasure: { addresses: 0, contactKeys: 0 },
};

/**
 * The most keys ONE source can lock out on its own, which is structural rather than
 * measured. One host is one address. One attendee carries at most two contact keys
 * (`contactRateKeys`: an email and a phone), and a bot that holds its phone while
 * rotating emails, or the reverse, can trip both over a run. A floor at or below
 * these would page on one abuser, which is the cap doing its job.
 */
export const SINGLE_SOURCE_LOCKOUTS = { addresses: 1, contactKeys: 2 } as const;

/**
 * The share of the busiest hour's leads that, locked out at once, means the cap is
 * wrong for real traffic rather than shaping abuse. One lead in twenty: at the
 * measured peak that is three people, which no single source can produce.
 */
export const LOCKOUT_SHARE_OF_PEAK_HOUR = 0.05;

/**
 * Honeypot trips that, in one window, are worth a person looking at: a tenth of the
 * busiest hour's confirms. Below it a script is a background cost the trap already
 * absorbs; above it either a campaign is working through the booker or the field has
 * become reachable by real leads, who are refused with a generic error.
 */
export const HONEYPOT_SHARE_OF_PEAK_HOUR = 0.1;

/** Separate five minute intervals the honeypot trips must span, the same
 *  persistence the credential and list signals ask for, so one burst never pages. */
export const HONEYPOT_MIN_INTERVALS = 3;

export interface EmbedRefusalThresholds {
  /** How far back the trip volume reaches: the failure rate window's own length. */
  windowMs: number;
  /** Addresses locked out at once by the hourly address cap that page. */
  addressLockoutFloor: number;
  /** Contact keys locked out at once by the per contact cap that page. */
  contactLockoutFloor: number;
  /** Honeypot trips in the window that page, together with the intervals below. */
  honeypotMinTrips: number;
  honeypotMinIntervals: number;
}

/**
 * Turn a measurement into floors. Each floor is the largest of three things, so it
 * clears all of them: what one source can produce alone, what the measured
 * background reached plus one, and the share of the busiest hour above.
 */
export function deriveEmbedRefusalThresholds(
  m: EmbedRefusalMeasurement,
  windowMs: number,
): EmbedRefusalThresholds {
  const share = Math.ceil(m.peakHourlyConfirms * LOCKOUT_SHARE_OF_PEAK_HOUR);
  const addressBackground = Math.max(m.peakHourlyThrottles.address, m.lockedOutAtMeasure.addresses);
  const contactBackground = Math.max(m.peakHourlyThrottles.contact, m.lockedOutAtMeasure.contactKeys);
  return {
    windowMs,
    addressLockoutFloor: Math.max(SINGLE_SOURCE_LOCKOUTS.addresses + 1, addressBackground + 1, share),
    contactLockoutFloor: Math.max(SINGLE_SOURCE_LOCKOUTS.contactKeys + 1, contactBackground + 1, share),
    honeypotMinTrips: Math.max(
      m.peakHourlyHoneypot + 1,
      Math.ceil(m.peakHourlyConfirms * HONEYPOT_SHARE_OF_PEAK_HOUR),
    ),
    honeypotMinIntervals: HONEYPOT_MIN_INTERVALS,
  };
}

/** What the monitor lane judges with: the measurement above, over the same hour the
 *  booking API refusal signals and the failure rate window use. */
export const SHIPPED_EMBED_REFUSAL_THRESHOLDS: EmbedRefusalThresholds = deriveEmbedRefusalThresholds(
  MEASURED_EMBED_REFUSALS,
  60 * 60_000,
);

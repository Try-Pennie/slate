/**
 * The decisions the load run's preflight and its ceiling control make (#2244),
 * separated from the live scripts that make them so each is testable with no
 * deployment and no database.
 */

/**
 * Whether an event id came from the load test STUB rather than from real Google.
 *
 * This is the most expensive thing in the whole run to get wrong. If
 * `SLATE_LOADTEST` is not on for the deployment, six hundred bookings become six
 * hundred real calendar events and six hundred real invitations to addresses that
 * do not exist, on agents' real calendars. So it is checked before the run starts,
 * by SHAPE, against the two shapes the stub can produce:
 *
 * - the pinned client id, returned verbatim (`slate` plus a sha256 hex), which is
 *   what `createEvent` answers with when Slate supplies an id, exactly as real
 *   Google does;
 * - `lt-evt-...`, which the stub mints when no client id was supplied.
 *
 * A real Google id is a base32-ish string of its own choosing and matches neither.
 * The check is deliberately POSITIVE (does it look like the stub) rather than
 * negative (does it look like Google): a negative check passes on any id whose
 * shape nobody anticipated, and the direction that fails safe here is refusing an
 * id we do not recognise.
 */
export function stubShapedEventId(eventId: string): boolean {
  const id = eventId.trim();
  if (id === "") return false;
  if (/^lt-evt-[0-9a-z]+-[0-9a-z]+$/.test(id)) return true;
  // The pinned client id: `slate` plus the 64 hex characters of a sha256.
  return /^slate[0-9a-f]{64}$/.test(id);
}

/** What one per-address ceiling control run proves. */
export interface CeilingVerdict {
  /** 1-based position of the first refusal, or null when nothing was refused. */
  firstRefusedAt: number | null;
  /** Requests that never reached the deployment at all. */
  unreachable: number;
}

/**
 * Read the ceiling control's statuses.
 *
 * A transport fault is counted as UNREACHABLE and never as a refusal. Counting it
 * as one would report the ceiling working when the control never reached the
 * deployment, which is the whole failure this control exists to rule out (L98).
 */
export function ceilingVerdict(statuses: readonly number[]): CeilingVerdict {
  const at = statuses.findIndex((s) => s === 429);
  return {
    firstRefusedAt: at === -1 ? null : at + 1,
    unreachable: statuses.filter((s) => s === 0).length,
  };
}

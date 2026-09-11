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

/** What `/api/smoke/version` said about the deployment the run is about to drive. */
export type LoadtestModeVerdict =
  | { ok: true; commit: string | null }
  | { ok: false; why: string };

/**
 * Whether a deployment has said it is in load test mode (#2242).
 *
 * Asked BEFORE the preflight writes anything, and it is not a duplicate of the
 * event-id check above: that one can only speak AFTER a booking has been made, so
 * if the flag is off, its own control booking was already a real calendar event
 * with a real invitation sent. This asks first. The two also measure different
 * things, which is why both stay: this reports what the deployment BELIEVES about
 * itself, the event id reports what it actually DID, and a build whose flag is set
 * while the stub is never reached fails the second and passes this (L345).
 *
 * Four refusals rather than one, because they send four different people to four
 * different places (L11). An ABSENT field in particular is not `false`: it is a
 * deployment predating the field, and reading it as "not in load test mode" sends
 * somebody to check a variable that is set correctly.
 */
export function loadtestModeVerdict(
  status: number,
  body: unknown,
): LoadtestModeVerdict {
  if (status !== 200) {
    return {
      ok: false,
      why:
        `/api/smoke/version answered ${status}, so whether this deployment is in load test mode ` +
        `could not be established. Nothing was written.`,
    };
  }
  // A body that is not an object at all is what `.json()` gives for a plain text
  // error page answered with a 200, and `in` THROWS on a string or a null. An
  // uncaught throw here would abort the preflight with a stack trace instead of a
  // reason, which is the one thing this check exists to produce.
  const payload: { loadtest?: unknown; commit?: unknown } =
    typeof body === "object" && body !== null ? (body as { loadtest?: unknown; commit?: unknown }) : {};
  if (!("loadtest" in payload)) {
    return {
      ok: false,
      why:
        "/api/smoke/version reports no loadtest field at all, so this deployment predates the " +
        "check rather than having answered no. Deploy the current commit with --env loadtest " +
        "and re-run.",
    };
  }
  if (payload.loadtest !== true) {
    return {
      ok: false,
      why:
        `this deployment reports loadtest=${JSON.stringify(payload.loadtest)}. SLATE_LOADTEST is ` +
        `not set on it, so a run would make six hundred REAL calendar events and send six ` +
        `hundred real invitations. Deploy with --env loadtest.`,
    };
  }
  return { ok: true, commit: typeof payload.commit === "string" ? payload.commit : null };
}

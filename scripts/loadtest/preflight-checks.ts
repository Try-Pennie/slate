import { normalizeCommit } from "../stamp-build-info.ts";

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

/** What `/api/smoke/version` said about a deployment the FAULT leg is about to drive.
 *
 *  A refusal says whether WAITING could change it (#2261). A redeploy does not
 *  take effect the instant wrangler exits: the fault leg asked two seconds after
 *  its own deploy and was answered by the version already serving, which reports
 *  no faults and is built from the SAME COMMIT, so the commit check could not tell
 *  the two apart either. Propagation is worth waiting out; a missing endpoint, a
 *  refused key or a deployment that is not in load test mode never resolves
 *  itself, and polling one of those just spends the deadline before saying what it
 *  could have said at once. */
export type FaultModeVerdict =
  | { ok: true; faultPct: number }
  | { ok: false; why: string; retriable: boolean };

/**
 * Whether a deployment is really running the fault percentage the leg asked for
 * (#2262).
 *
 * This is the whole integrity of the fault leg. The bar it feeds is "zero 5xx with
 * Google failing ten percent of reads", and a deployment that never received the
 * setting fails no reads at all: it answers every request perfectly and satisfies
 * the bar without one fault having happened, which is indistinguishable from a
 * path that degraded beautifully (L98). Telling wrangler to set a variable is not
 * the same as the deployment running with it, so the leg asks the deployment.
 *
 * The COMMIT is checked too, because the fault leg redeploys: a redeploy that
 * silently served the previous version would have the run judge a build nobody
 * drove. It is compared only when the caller knows which commit it deployed.
 */
export function faultModeVerdict(
  status: number,
  body: unknown,
  wanted: { faultPct: number; commit?: string },
): FaultModeVerdict {
  const mode = loadtestModeVerdict(status, body);
  if (!mode.ok) {
    // A 5xx is the deployment being momentarily unwell, which a redeploy causes
    // and which passes; every other refusal here (a wrong key, a missing endpoint,
    // a build that is not in load test mode) is a state waiting cannot change.
    return { ok: false, why: mode.why, retriable: status >= 500 && status <= 599 };
  }
  const payload =
    typeof body === "object" && body !== null ? (body as { faultPct?: unknown }) : {};
  if (typeof payload.faultPct !== "number") {
    return {
      ok: false,
      why:
        "/api/smoke/version reports no faultPct number, so whether this deployment injects faults " +
        "at all could not be established. Nothing was driven.",
      retriable: false,
    };
  }
  if (payload.faultPct !== wanted.faultPct) {
    // Three causes, three messages, because they send three different people to
    // three different places (L11). The two extremes are the ones that matter and
    // they are opposite mistakes: a leg that wanted faults and got none, and a
    // pass that wanted none and is about to measure somebody else's.
    if (wanted.faultPct > 0 && payload.faultPct === 0) {
      return {
        ok: false,
        why:
          `this deployment reports faultPct=0 and the leg was configured for ${wanted.faultPct}. ` +
          `It would fail no reads at all, answer every request perfectly, and satisfy the "no 5xx ` +
          `under fault" bar with no faults at all having been injected.`,
        // The commonest shape of a redeploy that has not landed yet.
        retriable: true,
      };
    }
    if (wanted.faultPct === 0 && payload.faultPct > 0) {
      return {
        ok: false,
        why:
          `this deployment is still injecting faults at ${payload.faultPct} percent, left over ` +
          `from a fault leg that was never restored (a run dispatched with teardown off does ` +
          `that). A steady pass against it would count those faults as the path's own 5xx. ` +
          `Redeploy with --env loadtest and no --var, then re-run.`,
        // A restore that has just been deployed lands the same way a fault deploy
        // does, so this is worth waiting out too.
        retriable: true,
      };
    }
    return {
      ok: false,
      why:
        `this deployment reports faultPct=${payload.faultPct} and the leg was configured for ` +
        `${wanted.faultPct}, so a pass against it measures a percentage nobody asked for.`,
      retriable: true,
    };
  }
  if (wanted.commit !== undefined) {
    // Compared through the STAMPER'S OWN shortening, never as equality (#2261).
    // `scripts/stamp-build-info.ts` writes the first twelve characters of the sha
    // into the bundle, and the workflow hands this leg `github.sha`, which is all
    // forty. So the deployment answers `660c7aacae82` to a caller holding
    // `660c7aacae82658b8947ca923237f5de2932d8f3`, an equality check calls that a
    // redeploy that never landed, and because the mismatch is classified as
    // propagation it then waits out the whole deadline before saying so. One
    // derivation, taken from the code that does the stamping (L70).
    let want: string;
    try {
      want = normalizeCommit(wanted.commit);
    } catch {
      return {
        ok: false,
        why:
          `the fault leg was told it deployed "${wanted.commit}", which is not a commit sha, so ` +
          `whether the redeploy landed cannot be established.`,
        retriable: false,
      };
    }
    if (mode.commit !== want) {
      return {
        ok: false,
        why:
          `this deployment is serving commit ${mode.commit ?? "unreported"} and the fault leg ` +
          `deployed ${want}, so the redeploy has not taken effect.`,
        retriable: true,
      };
    }
  }
  return { ok: true, faultPct: payload.faultPct };
}

/**
 * How long to keep asking a freshly redeployed Worker, and when to stop (#2261).
 *
 * A deploy does not take effect the instant wrangler exits. The fault leg asked
 * two seconds after its own and was answered by the version already serving,
 * which reports no faults. The COMMIT could not catch it either: both builds come
 * from the same commit, so the one discriminator the check had was blind to
 * exactly this.
 *
 * Bounded, because a read that retries forever hangs the run rather than failing
 * it (L110), and the deadline is the thing that turns "not yet" into "never".
 */
export const FAULT_PROPAGATION_DEADLINE_MS = 180_000;
export const FAULT_PROPAGATION_POLL_MS = 5_000;

export type PollStep =
  | { action: "accept"; faultPct: number }
  | { action: "wait"; waitMs: number; why: string }
  | { action: "give-up"; why: string };

/**
 * What to do with one reading, given how long we have been asking.
 *
 * Pure over the verdict and the clock, so the whole ladder is driven in a test
 * with no deployment, no network and no real waiting (the test speed rules): the
 * elapsed time is passed in rather than measured.
 *
 * A give-up on a RETRIABLE verdict says how long it waited, because "the deploy
 * had not landed after three minutes" and "this deployment is not in load test
 * mode" send different people to different places (L11).
 */
export function faultPollStep(
  verdict: FaultModeVerdict,
  elapsedMs: number,
  deadlineMs: number = FAULT_PROPAGATION_DEADLINE_MS,
  pollMs: number = FAULT_PROPAGATION_POLL_MS,
): PollStep {
  if (verdict.ok) return { action: "accept", faultPct: verdict.faultPct };
  if (!verdict.retriable) return { action: "give-up", why: verdict.why };
  if (elapsedMs >= deadlineMs) {
    return {
      action: "give-up",
      why:
        `${verdict.why} Still true ${Math.round(deadlineMs / 1000)}s after the deploy, so this is ` +
        `not propagation: the deploy did not take, or something else is serving this address.`,
    };
  }
  return { action: "wait", waitMs: pollMs, why: verdict.why };
}

/**
 * The second booking a guard probe plants, given the first one's window (#2274).
 *
 * The preflight already plants an IDENTICAL window and requires the database to
 * refuse it, which proves `bookings_active_slot_uniq`. That says nothing about
 * `bookings_active_no_overlap`, and the two are not the same guarantee:
 * appointments are longer than the grid they are offered on (20 minutes every 10
 * in production), so the booking that actually caused #2274 had a DIFFERENT start
 * ten minutes later, which uniqueness cannot see.
 *
 * So the overlap probe shifts the window by HALF its own length: far enough that
 * the start differs, so the unique index cannot be the thing that refuses it, and
 * near enough that the ranges still overlap. Deriving the shift from the window
 * rather than hard coding ten minutes keeps it correct if the seeded event type
 * ever changes duration (L401).
 *
 * Returns null when the window is unreadable or has no length, because a zero
 * length range overlaps nothing: planting one would be refused by nothing and the
 * probe would report the constraint missing when it is present and correct.
 */
export function overlappingProbeWindow(
  startIso: string,
  endIso: string,
): { startIso: string; endIso: string } | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const lengthMs = end - start;
  if (lengthMs <= 0) return null;
  // Half a window, rounded to a whole minute so the planted row looks like a real
  // booking rather than one landing on a second nobody's grid produces.
  const shiftMs = Math.max(60_000, Math.round(lengthMs / 2 / 60_000) * 60_000);
  if (shiftMs >= lengthMs) return null; // a window too short to overlap a shifted copy
  return {
    startIso: new Date(start + shiftMs).toISOString(),
    endIso: new Date(end + shiftMs).toISOString(),
  };
}

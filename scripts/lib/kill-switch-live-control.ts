// The decision logic behind `pnpm verify:kill-switch` (#2365), kept apart from the
// live IO so every refusal it can reach is driven offline by
// `scripts/test-kill-switch-live-control.ts`, where no deployment exists.
//
// WHY THE COMMAND EXISTS. #2297 shipped the public booking kill switch and nothing
// has ever thrown it in production. Every path is covered by tests and the setting
// is confirmed present in the live database, but the PAUSED state has never once
// run against the deployed Worker. That matters more here than it would for most
// features, because this gate deliberately fails CLOSED: it refuses the booking
// when it cannot read its own flag. So the fault nobody would see coming is the
// one where it refuses EVERYTHING, and the only signal would be the booking
// failure rate window firing under `booking_pause_unreadable` after real leads had
// already been turned away.
//
// HOW IT ASKS WITHOUT CREATING A BOOKING. The gate sits ahead of body parsing, so
// a deliberately malformed body answers 400 while open and 503 while paused, and
// the difference between those two IS the gate. Nothing is booked either way.
//
// BOTH DIRECTIONS OR IT PROVES NOTHING (L1). A route hard wired to 503 satisfies a
// check that only pauses; one hard wired to 400 satisfies a check that only looks
// while open. Finding nothing to check is never a pass (L98), so every way of
// learning nothing exits non-zero on its own code, and no two share one (L11).

/**
 * One code per outcome. 1 is deliberately absent: the command exits 1 before
 * anything is read or written when it has no credentials, so nothing here may
 * share it and be mistaken for a finding.
 */
export const KILL_SWITCH_EXIT = {
  ok: 0,
  /** The flag is still ON. Public booking is stopped and a person must fix it. */
  notRestored: 2,
  /** The switch was on and the booker took the request anyway. */
  doesNotRefuse: 3,
  /** The switch was OFF and the booker refused: it is turning leads away by itself. */
  refusesWhileOpen: 4,
  /** It refused, because it could not READ its flag. The fail closed fault. */
  refusedUnreadable: 5,
  /** Availability stopped serving while paused, which the switch must not touch. */
  availabilityClosed: 6,
  /**
   * Availability could not be read in EITHER half, so that half of the design was
   * never checked. Kept apart from `availabilityClosed` because the command's own
   * read failing is not the switch closing anything, and a message may claim only
   * what its check measured (L11). Still not a pass: the run did not finish its
   * job (L98).
   */
  availabilityUnmeasured: 12,
  noAnswer: 7,
  rateLimited: 8,
  serverError: 9,
  endpointMissing: 10,
  unreadableReply: 11,
  /**
   * Somebody had ALREADY stopped public booking, so the run stood down without
   * testing anything (#2493).
   *
   * Its own code rather than the credentials exit, because on a schedule the two
   * mean opposite things: one is a machine that was never set up, and this one is a
   * deployment where the switch is deliberately on and finishing the run would turn
   * it back on for whoever stopped it. It is never a pass, because nothing was
   * measured (L98), and never a fault either.
   */
  alreadyPaused: 13,
  /**
   * The pause flag could not be written, or did not read back as set, so the paused
   * half never ran (#2493).
   *
   * It used to share `noAnswer`, which reads as the deployment being unreachable and
   * sends somebody to check the base URL when the real problem is the database write
   * (L11). Nothing is left stopped either way.
   */
  flagNotSet: 14,
  /**
   * The run started inside the org's business hours, or within the margin
   * either side of them, so it stood down before pausing anything (#3920).
   *
   * The cron sits in the small hours, and GitHub started it 4.5 to 9.5 hours late on
   * every run for a month, so the two second pause landed on live booking every
   * morning. A SKIP rather than a fault: the check doing its job. Never a pass,
   * because nothing was measured (L98), so it leaves the verdict unstamped and a run
   * of them reaches the staleness bound.
   */
  insideBusinessHours: 15,
  /**
   * The org's business hours could not be read, so whether pausing was safe could not
   * be judged and nothing was paused (#3920). Fail safe toward NOT stopping booking.
   * Its own code rather than the skip's, because a read that failed and a check that
   * worked send a reader to do different things (L11).
   */
  hoursUnreadable: 16,
} as const;

/** What one POST to the public booking route produced. */
export type ProbeReply =
  /** A 400: the gate let the request through and the body parser rejected it. */
  | { kind: "reached-parser" }
  /** A 503: the gate refused. `copy` is the lead facing sentence it carried. */
  | { kind: "refused"; copy: string }
  | { kind: "rate-limited" }
  | { kind: "server-error"; detail: string }
  | { kind: "endpoint-missing" }
  | { kind: "no-answer"; detail: string }
  | { kind: "unreadable-reply"; detail: string };

/** What one GET of the availability endpoint produced. */
export interface AvailabilityReading {
  ok: boolean;
  /** Times offered, or null when the read did not succeed. */
  slots: number | null;
}

export type KillSwitchVerdict =
  | { ok: true; exitCode: 0; message: string }
  | { ok: false; exitCode: number; message: string };

/**
 * Turn one HTTP reply into an outcome.
 *
 * Judged on the STATUS, never by looking for words in the body. Both things a 503
 * can mean here are lead facing sentences, and the 400 the parser returns is a
 * generic "Invalid request" that the honeypot also returns, so a substring match
 * would let one answer for another (L156, L184). The two meanings of a 503 are
 * separated by the COPY it carried, which is compared against the shipped builder
 * by the caller rather than by a pattern written here (L41).
 */
export function readProbeReply(status: number, bodyText: string): ProbeReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    // Not fatal on its own: a 404 or a platform error page is HTML, and the
    // status still says something worth acting on. The status cases below get
    // their turn before this is called unreadable.
    parsed = null;
  }
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { error?: unknown };
  const copy = typeof body.error === "string" ? body.error : "";

  if (status === 400) return { kind: "reached-parser" };
  if (status === 503) return { kind: "refused", copy };
  if (status === 429) return { kind: "rate-limited" };
  if (status === 404) return { kind: "endpoint-missing" };
  if (status >= 500) return { kind: "server-error", detail: `${status}${copy ? `: ${copy}` : ""}` };
  return { kind: "unreadable-reply", detail: `${status}${copy ? `: ${copy}` : ""}` };
}

export interface KillSwitchRun {
  /** The probe sent with the flag OFF. It must reach the body parser. */
  whileOpen: ProbeReply;
  /** The probe sent with the flag ON. It must be refused. */
  whilePaused: ProbeReply;
  /**
   * Whether the refusal carried the PAUSED copy rather than the unreadable one.
   *
   * Decided by the caller against the shipped copy builder, so this module holds
   * no second copy of a lead facing sentence to drift from it (L41).
   */
  pausedCopyIsPauseCopy: boolean;
  availabilityOpen: AvailabilityReading;
  availabilityPaused: AvailabilityReading;
  /** Whether the flag was put back. False means public booking is STILL stopped. */
  restored: boolean;
}

/** The sentence a run that could not put the flag back has to leave behind. */
export function restoreFailureMessage(): string {
  return (
    "PUBLIC BOOKING IS STILL PAUSED. This command turned the kill switch on and could " +
    "not turn it back off, so the embed is refusing every new booking right now. Clear " +
    "it from the admin business hours page, or set booking_settings.public_booking_paused " +
    "to false for id 1, and confirm the booker takes a request again before walking away."
  );
}

/**
 * The verdict for one run.
 *
 * ORDERED, and the order is the point. A stranded flag leads whatever else the
 * run found, because it is the only outcome here that goes on turning real leads
 * away after the command exits: a reader sent to investigate "the switch does not
 * refuse" while bookings are silently off has been sent to the wrong problem.
 */
export function judgeKillSwitchRun(run: KillSwitchRun): KillSwitchVerdict {
  const fail = (exitCode: number, message: string): KillSwitchVerdict => ({ ok: false, exitCode, message });

  if (!run.restored) return fail(KILL_SWITCH_EXIT.notRestored, restoreFailureMessage());

  // The OPEN half first: it is the half that says whether the gate is refusing
  // everything, which is the fault this command was written for.
  const open = run.whileOpen;
  if (open.kind === "no-answer") {
    return fail(KILL_SWITCH_EXIT.noAnswer, `The deployment did not answer at all (${open.detail}), so nothing was measured.`);
  }
  if (open.kind === "endpoint-missing") {
    return fail(KILL_SWITCH_EXIT.endpointMissing, "This deployment has no public booking route, so there is no gate to ask about.");
  }
  if (open.kind === "rate-limited") {
    return fail(
      KILL_SWITCH_EXIT.rateLimited,
      "The rate limiter answered before the gate did, so the switch was never reached. Wait a minute and run it again.",
    );
  }
  if (open.kind === "server-error") {
    return fail(KILL_SWITCH_EXIT.serverError, `The booking route failed while the switch was OFF (${open.detail}), so nothing was measured.`);
  }
  if (open.kind === "unreadable-reply") {
    return fail(KILL_SWITCH_EXIT.unreadableReply, `Something this command cannot read answered (${open.detail}).`);
  }
  if (open.kind === "refused") {
    return fail(
      KILL_SWITCH_EXIT.refusesWhileOpen,
      "The booker REFUSED a request while the kill switch was off, so it is turning leads away on its own. " +
        "This is the fail closed fault: check that booking_settings can be read.",
    );
  }

  // The PAUSED half.
  const paused = run.whilePaused;
  if (paused.kind !== "refused") {
    return fail(
      KILL_SWITCH_EXIT.doesNotRefuse,
      "The kill switch was ON and the booker took the request anyway, so the switch does not stop public bookings.",
    );
  }
  if (!run.pausedCopyIsPauseCopy) {
    return fail(
      KILL_SWITCH_EXIT.refusedUnreadable,
      "The booker refused while paused, but with the copy it uses when it CANNOT READ its flag rather than the paused copy. " +
        "It is failing closed on an unreadable setting, which refuses every lead whether or not anybody paused bookings.",
    );
  }

  // What the switch must leave ALONE. Compared open against paused rather than
  // demanded to be non zero: before cutover a real bucket legitimately offers no
  // times (#1272), and a check that demanded them would be red from the day it
  // shipped for a reason nobody should fix (L36).
  const a = run.availabilityOpen;
  const b = run.availabilityPaused;
  // Asked BEFORE the accusation: a read that failed in both halves is this
  // command failing to look, not the switch closing anything. The first live run
  // (2026-09-16) reported exactly that accusation while the real cause was asking
  // about a key gated test bucket and being 404ed both times.
  if (!a.ok && !b.ok) {
    return fail(
      KILL_SWITCH_EXIT.availabilityUnmeasured,
      "Availability could not be read either before or during the pause, so whether the switch leaves it alone is " +
        "UNMEASURED. The switch itself was proven in both directions. Point KILL_SWITCH_BUCKET at a bucket this " +
        "command can read without a bearer token.",
    );
  }
  if (!b.ok) {
    return fail(KILL_SWITCH_EXIT.availabilityClosed, "Availability stopped answering while bookings were paused. The switch must close only the booking write.");
  }
  // The mirror of the case above: it did not answer BEFORE the pause but did
  // during it. Nothing about the switch is shown by that either.
  if (!a.ok) {
    return fail(
      KILL_SWITCH_EXIT.availabilityUnmeasured,
      "Availability did not answer before the pause, so there is no reading to compare the paused one against.",
    );
  }
  if (a.ok && (a.slots ?? 0) > 0 && (b.slots ?? 0) === 0) {
    return fail(
      KILL_SWITCH_EXIT.availabilityClosed,
      `Availability offered ${a.slots} times before the pause and none during it. The switch must close only the booking write.`,
    );
  }

  const measuredAvailability = a.ok && (a.slots ?? 0) > 0;
  const availabilityNote = measuredAvailability
    ? `availability still offered ${b.slots} times while paused`
    : "availability answered while paused, though the bucket offered no times either way, so that half is unmeasured";
  return {
    ok: true,
    exitCode: KILL_SWITCH_EXIT.ok,
    message:
      "The kill switch works in both directions: a request reached the booker while it was off, the same request was " +
      `refused with the paused copy while it was on, and ${availabilityNote}. The flag is back off.`,
  };
}

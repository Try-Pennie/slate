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

/**
 * How many multiples of the ceiling the control sends (#2275).
 *
 * It used to send exactly `ceiling + 1`, all at once, and require the last to be
 * refused. Cloudflare's own documentation says the Rate Limiting API "is
 * permissive, eventually consistent, and intentionally designed to not be used as
 * an accurate accounting system", and that there is "a unique limit per Cloudflare
 * location". Asking a deliberately permissive, eventually consistent counter to
 * refuse ONE marginal request out of a simultaneous burst is close to the least
 * likely thing it will do, so the bar could not conclude by construction (L1).
 *
 * An overshoot is what makes a refusal something the counter must produce rather
 * than something it might. The exact crossing point is deliberately never
 * asserted: an eventually consistent counter does not have one.
 */
export const CEILING_CONTROL_OVERSHOOT = 3;

/** How many writes the control sends against a given ceiling. */
export function ceilingControlSize(ceiling: number): number {
  return Math.max(1, Math.ceil(ceiling * CEILING_CONTROL_OVERSHOOT));
}

/**
 * How far below the configured ceiling a refusal may start before the ceiling is
 * called tighter than configured.
 *
 * The run PACES itself at the ceiling, so a limiter that really refuses at a third
 * of it would make every other number about the run wrong. Permissiveness only
 * ever errs the other way, so there is no matching upper bound.
 */
export const CEILING_TIGHTNESS_FLOOR = 0.5;

/** Every conclusion one control run can reach. Exactly one of them is a pass. */
export const CEILING_CONCLUSION = {
  /** Allowed for roughly the ceiling, then refused. The only pass. */
  applies: "applies",
  /** Nothing was sent at all. */
  nothingSent: "nothing-sent",
  /** Nothing reached the deployment. */
  neverReached: "never-reached",
  /** The key was rejected, which happens BEFORE either limiter. */
  notAuthorized: "not-authorized",
  /** The application refused every request, so the ceiling never had a chance to. */
  appRefusedEverything: "app-refused-everything",
  /** The control found no bookable slot to aim at, so it sent nothing. */
  noSlot: "no-slot",
  /**
   * The deployment could not read the caller's address, which the per address
   * ceiling DECLINES to judge (#1557), so it can never refuse this control.
   */
  callerUnidentified: "caller-unidentified",
  /** The writes were counted against several addresses, so none of them saw the ceiling. */
  severalAddresses: "several-addresses",
  /** No response said which address it was keyed on, so the premise is unmeasured. */
  addressUnmeasured: "address-unmeasured",
  /** Everything was allowed, well past the ceiling. */
  neverRefused: "never-refused",
  /** Refusals began far below the configured ceiling. */
  tighter: "tighter-than-configured",
} as const;

export type CeilingConclusion = (typeof CEILING_CONCLUSION)[keyof typeof CEILING_CONCLUSION];

/**
 * The address `clientIp` reports for a caller it cannot identify.
 *
 * Copied as a literal rather than imported, because this file is reached by the
 * node suite with no `@/` alias, and the value is a string on the wire anyway: it
 * arrives here as whatever the deployment stamped on the header, not as the
 * constant. `scripts/test-loadtest-ceiling-control.ts` pins the spelling.
 */
export const CONTROL_UNIDENTIFIED_IP = "unknown";

/** One request the ceiling control made, and what the deployment said about it. */
export interface CeilingAttempt {
  /** The HTTP status, or 0 for a request that never reached the deployment. */
  status: number;
  /**
   * The address the deployment says it keyed the ceiling on, read from the
   * `x-loadtest-seen-ip` echo (#2243), or null when the response carried none.
   *
   * REQUIRED, with no default, because the whole control rests on every write
   * landing on ONE address and nothing measured that (L70). A default would let
   * the verdict go on assuming the premise it exists to check.
   */
  seenIp: string | null;
}

/** What one per-address ceiling control run proves. */
export interface CeilingVerdict {
  sent: number;
  /** Passed the limiter and reached the handler (any status but 0, 401 and 429). */
  allowed: number;
  /** Refused by a limiter. */
  refused: number;
  /** Reached the handler and was refused by the APPLICATION, not by a ceiling. */
  appRefused: number;
  /** Rejected at authentication, before either limiter ran. */
  unauthorized: number;
  /** Never reached the deployment at all. */
  unreachable: number;
  /** 1-based position of the first refusal, or null when nothing was refused. */
  firstRefusedAt: number | null;
  /** The distinct addresses the deployment reported keying on, sorted. */
  addresses: string[];
  /** Attempts the deployment answered without being able to identify the caller. */
  unidentified: number;
  /** Attempts whose response carried no address echo at all. */
  unreported: number;
  conclusion: CeilingConclusion;
  /** The sentence a reader acts on. One per conclusion, never shared (L11). */
  detail: string;
}

/**
 * Read the ceiling control's statuses.
 *
 * The classification is the fix. The previous version counted only 429 as a
 * refusal and 0 as unreachable, and everything else as allowed, so 61 consecutive
 * 409s from the application rendered exactly like a healthy unthrottled control
 * and the run reported "the ceiling is not applying" about a ceiling that was
 * working (measured: the same run's steady pass was refused four times by it).
 *
 * Where each status sits is decided by WHERE the handler makes that decision:
 *   401  `authenticateBearer`, BEFORE either limiter, so the counter never saw it
 *   429  a limiter refused it
 *   0    never reached the deployment
 *   any other status  it passed both limiters and reached the handler, so it WAS
 *        counted, whatever the handler then did with it
 */
export function ceilingVerdict(
  attempts: readonly CeilingAttempt[],
  ceiling: number,
): CeilingVerdict {
  const statuses = attempts.map((a) => a.status);
  const sent = statuses.length;
  const at = statuses.findIndex((s) => s === 429);
  const refused = statuses.filter((s) => s === 429).length;
  const unreachable = statuses.filter((s) => s === 0).length;
  const unauthorized = statuses.filter((s) => s === 401).length;
  const counted = statuses.filter((s) => s !== 0 && s !== 401 && s !== 429);
  const allowed = counted.filter((s) => s >= 200 && s < 300).length;
  const appRefused = counted.length - allowed;
  // Only attempts that REACHED the deployment can say anything about the address:
  // one that never arrived carries no echo for a reason that is already reported.
  const echoes = attempts.filter((a) => a.status !== 0).map((a) => a.seenIp);
  const unidentified = echoes.filter((ip) => ip === CONTROL_UNIDENTIFIED_IP).length;
  const unreported = echoes.filter((ip) => ip === null).length;
  const addresses = [
    ...new Set(echoes.filter((ip): ip is string => ip !== null && ip !== CONTROL_UNIDENTIFIED_IP)),
  ].sort();
  const base = {
    sent,
    allowed,
    refused,
    appRefused,
    unauthorized,
    unreachable,
    firstRefusedAt: at === -1 ? null : at + 1,
    addresses,
    unidentified,
    unreported,
  };

  if (sent === 0) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.nothingSent,
      detail: "the control sent no writes at all, so the ceiling was never exercised",
    };
  }
  if (unreachable === sent) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.neverReached,
      detail:
        `none of the ${sent} control writes reached the deployment, so nothing is known about ` +
        "the ceiling either way",
    };
  }
  if (unauthorized > 0 && refused === 0 && allowed === 0) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.notAuthorized,
      detail:
        `the deployment rejected the control's key on ${unauthorized} of ${sent} writes, which ` +
        "happens before either limiter, so the ceiling was never reached",
    };
  }
  if (refused === 0 && allowed === 0 && appRefused > 0) {
    // The 2026-09-11 run. Every request passed the limiter and was then refused by
    // the handler, so the ceiling was exercised and cannot be judged from this.
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.appRefusedEverything,
      detail:
        `all ${appRefused} of the ${sent} control writes were refused by the application rather ` +
        "than by a ceiling, so they were counted against it but none could show it refusing. " +
        "Fix the control's request shape; this says nothing about the ceiling",
    };
  }
  // The three ways the control's own premise, that every write lands on ONE
  // address, can be false or unmeasured. Each is asked only where it can explain
  // an ABSENCE of refusals: a refusal that happened anyway is still a refusal,
  // and several addresses only ever RAISE the headroom. Every one of them used to
  // render as "the ceiling is not applying", which is the finding that sent
  // somebody to look at a ceiling that was working (L11, L70).
  if (refused === 0 && unidentified > 0 && addresses.length === 0) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.callerUnidentified,
      detail:
        `the deployment could not read the caller's address on ${unidentified} of ${sent} control ` +
        "writes, and the per address ceiling declines to judge a caller it cannot identify, so it " +
        "was never asked to refuse. Check what is in front of the deployment, not the ceiling",
    };
  }
  if (refused === 0 && addresses.length > 1) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.severalAddresses,
      detail:
        `the ${sent} control writes were counted against ${addresses.length} different addresses ` +
        `(${addresses.join(", ")}), so no single one of them reached the ceiling of ${ceiling}. ` +
        "The runner's egress is a pool; this says nothing about the ceiling either way",
    };
  }
  if (refused === 0 && addresses.length === 0 && unreported > 0) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.addressUnmeasured,
      detail:
        `none of the ${sent} control writes came back with the address it was keyed on, so whether ` +
        "they were counted against one address or many is unmeasured. The echo is gated on " +
        "SLATE_LOADTEST; check it is set on the deployment",
    };
  }
  if (refused === 0) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.neverRefused,
      detail:
        `${allowed} of ${sent} control writes, all counted against ${addresses.join(", ")}, were ` +
        `allowed against a ceiling of ${ceiling} and none was refused, so the ceiling is not ` +
        "applying. Every 429 the run attributed means something else",
    };
  }
  if (base.firstRefusedAt !== null && base.firstRefusedAt < ceiling * CEILING_TIGHTNESS_FLOOR) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.tighter,
      detail:
        `the ceiling refused at write ${base.firstRefusedAt} of ${sent}, far below the configured ` +
        `${ceiling}, so the run is pacing against a number that is not the real one`,
    };
  }
  return {
    ...base,
    conclusion: CEILING_CONCLUSION.applies,
    detail:
      `${allowed} of ${sent} writes from one address were allowed and ${refused} refused against ` +
      `a ceiling of ${ceiling}, so the ceiling is applying`,
  };
}

/** One bucket code and the times the deployment is offering for it. */
export interface CeilingOffer {
  code: string;
  slots: readonly string[];
}

/** The code the control will aim at, with every time it may use. */
export interface CeilingTarget {
  code: string;
  slots: string[];
}

/**
 * What the control aims its writes at (#2275, second pass).
 *
 * It used to aim at a hardcoded code with a start SEVEN days out, against a four
 * day booking horizon, so the application refused every request before the
 * ceiling's answer could be read. Two runs in a row concluded nothing that way.
 * So the target is a slot the deployment is ACTUALLY offering, read from
 * `/api/availability`, and a control with nothing to aim at refuses rather than
 * sending into a guaranteed refusal (L98).
 *
 * It keeps EVERY offered slot rather than the first, and the control rotates
 * through them. The steady pass is booking against the same roster while this
 * runs, so one slot can be taken mid control and turn every remaining write into
 * an application refusal, which is the exact state this pass exists to stop
 * reaching the report again.
 */
export function chooseCeilingTarget(offers: readonly CeilingOffer[]): CeilingTarget | null {
  for (const offer of offers) {
    if (offer.slots.length > 0) return { code: offer.code, slots: [...offer.slots] };
  }
  return null;
}

/**
 * The verdict for a control that never found a slot to aim at.
 *
 * Its own conclusion rather than `nothingSent`, because the two send a reader to
 * different places: this one means the deployment is offering nothing for the
 * codes asked (a seed or a roster problem), and that one means the control step
 * did not run.
 */
export function ceilingNoSlot(ceiling: number, codesAsked: readonly string[]): CeilingVerdict {
  return {
    sent: 0,
    allowed: 0,
    refused: 0,
    appRefused: 0,
    unauthorized: 0,
    unreachable: 0,
    firstRefusedAt: null,
    addresses: [],
    unidentified: 0,
    unreported: 0,
    conclusion: CEILING_CONCLUSION.noSlot,
    detail:
      `the deployment offered no bookable time for any of ${codesAsked.join(", ")}, so the control ` +
      `had nothing to aim its writes at and the ceiling of ${ceiling} was never exercised. ` +
      "Fix the roster or the seed; this says nothing about the ceiling",
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
  const payload: { loadtest?: unknown; commit?: unknown; productionSecrets?: unknown } =
    typeof body === "object" && body !== null
      ? (body as { loadtest?: unknown; commit?: unknown; productionSecrets?: unknown })
      : {};
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
  // Which of production's own settings the deployment is holding (#2335). Reported
  // only under load test, so under the flag the field is always there, even when it
  // is empty.
  //
  // This is the refusal that arrives FIRST and the only one that can: a build that
  // baked production's `.env.local` into its bundle is pointed at the right branch
  // and answering on the right address, so every other refusal here is correctly
  // satisfied while it holds a live Slack token. This endpoint is the one that
  // answers without touching the database, which is why it can still say so while
  // the rest of the deployment refuses itself.
  if (!("productionSecrets" in payload)) {
    return {
      ok: false,
      why:
        "/api/smoke/version reports no productionSecrets field at all, so whether this deployment " +
        "is carrying production's own credentials could not be established: the build predates " +
        "the check rather than having answered none. Deploy the current commit with --env " +
        "loadtest and re-run.",
    };
  }
  if (!Array.isArray(payload.productionSecrets)) {
    return {
      ok: false,
      why:
        `/api/smoke/version reported productionSecrets as ` +
        `${JSON.stringify(payload.productionSecrets)}, which is not a list of names. Something ` +
        `other than this route answered, so nothing it said can be read.`,
    };
  }
  if (payload.productionSecrets.length > 0) {
    return {
      ok: false,
      why:
        `this deployment is carrying ${payload.productionSecrets.length} of production's own ` +
        `settings: ${payload.productionSecrets.join(", ")}. The cause is a build tree holding a ` +
        `.env file: the Cloudflare adapter writes every .env* value into the bundle and the ` +
        `runtime applies each one the Worker's bindings did not set, so the run would reach real ` +
        `Slack, Salesforce, Twilio and cal.com. Rebuild in a tree with no .env files and deploy ` +
        `again. Nothing was written.`,
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

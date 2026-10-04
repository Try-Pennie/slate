import { normalizeCommit } from "../stamp-build-info.ts";
import { hydrationBatchSize, HYDRATION_ONBOARDING_MAX } from "../../src/lib/google/hydration.ts";

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
 * How far past the EXACT bound the control goes before it concludes nothing is
 * refusing it (#2339).
 *
 * It used to send three times the per minute ceiling and require SOME refusal,
 * and that could not conclude either. Run 34889873261 sent 180 writes from one
 * measured address in 20 seconds against a 60 a minute ceiling and every one was
 * allowed. That is not a broken limiter: Cloudflare's own documentation says the
 * Rate Limiting API is "permissive, eventually consistent, and intentionally
 * designed to not be used as an accurate accounting system", with "a unique limit
 * per Cloudflare location", and each isolate checking "against its locally cached
 * value". A bar built on a number the platform never promised fails for a reason
 * nobody should fix, which is how a bar stops being read (L36).
 *
 * So the control aims at the bound that IS exact: the per address HOURLY cap, a
 * Postgres counter that refuses at a number it really holds. A margin rather than
 * a multiple, because an exact counter needs no overshoot: the whole reason the
 * old number was a multiple was that its counter was approximate.
 */
export const CEILING_EXACT_MARGIN = 1.1;

/**
 * The exact per address bound, read from the app's own rules rather than written
 * here a second time (L41).
 *
 * The TIGHTEST rule is what refuses first, so that is the one a budget has to
 * clear. An empty rule set answers null rather than a number, because a budget
 * derived from no rule at all would send a fixed count and call whatever happened
 * a measurement.
 */
export function exactAddressBound(rules: readonly { max: number }[]): number | null {
  const maxima = rules.map((r) => r.max).filter((m) => Number.isFinite(m) && m > 0);
  return maxima.length === 0 ? null : Math.min(...maxima);
}

/** How many writes the control will send before it stops asking. */
export function ceilingControlBudget(exactBound: number): number {
  return Math.max(1, Math.ceil(exactBound * CEILING_EXACT_MARGIN));
}

/**
 * The share of the per KEY minute ceiling this control will spend.
 *
 * The control and the run's drivers hold ONE booking API key, and the per key
 * ceiling is checked FIRST and returns before the per address one is reached. So a
 * control sending fast enough to trip the key ceiling never reaches the ceiling it
 * exists to prove, and on a run where the two overlap it would throttle the
 * drivers as well. A share rather than the whole, so a little drift either way
 * still lands under it.
 */
export const CEILING_CONTROL_KEY_SHARE = 0.8;

/** How many writes a minute the control holds itself to, from the app's own key ceiling. */
export function ceilingControlPerMinute(keyPerMinute: number): number {
  return Math.max(1, Math.floor(keyPerMinute * CEILING_CONTROL_KEY_SHARE));
}

/**
 * How long to wait before sending the next wave, to hold that rate.
 *
 * Derived from what has been SENT against the time that has really passed, rather
 * than by adding up its own sleeps: a timer built out of its own sleeps measures
 * iterations, and every round trip the requests take makes it slower than the rate
 * it believes it is holding (L226).
 */
export function ceilingWaveDelayMs(sent: number, elapsedMs: number, perMinute: number): number {
  if (perMinute <= 0) return 0;
  return Math.max(0, Math.round((sent / perMinute) * 60_000 - elapsedMs));
}

/**
 * How far below the configured per minute ceiling a refusal may start before the
 * ceiling is called tighter than configured.
 *
 * The run PACES itself at the ceiling, so a limiter that really refuses at a third
 * of it would make every other number about the run wrong. Permissiveness only
 * ever errs the other way, so there is no matching upper bound: being permissive
 * is now the expected reading rather than a finding.
 */
export const CEILING_TIGHTNESS_FLOOR = 0.5;

/**
 * What the deployment echoes on a refusal to say WHICH ceiling said no (#2339).
 *
 * Copied as literals rather than imported from `@/lib/booking/api-auth`, because
 * this file is reached by the node suite with no `@/` alias, and the value is a
 * string on the wire anyway: it arrives as whatever the deployment stamped on the
 * header, not as the constant. `scripts/test-loadtest-ceiling-control.ts` pins the
 * spelling against the app's own list.
 */
export const CEILING_REFUSED_BY = {
  /** The per address backstop, which is the one this control exists to prove. */
  address: "throttled_ip",
  /** The per key ceiling, which is checked FIRST and short circuits the other. */
  key: "throttled_key",
} as const;

/** Every conclusion one control run can reach. Exactly one of them is a pass. */
export const CEILING_CONCLUSION = {
  /** A refusal the deployment attributed to the per address ceiling. The only pass. */
  applies: "applies",
  /** Nothing was sent at all. */
  nothingSent: "nothing-sent",
  /** Nothing reached the deployment. */
  neverReached: "never-reached",
  /** The key was rejected, which happens BEFORE either limiter. */
  notAuthorized: "not-authorized",
  /**
   * The deployment could not read the caller's address, which the per address
   * ceiling DECLINES to judge (#1557), so it can never refuse this control.
   */
  callerUnidentified: "caller-unidentified",
  /** The writes were counted against several addresses, so none of them saw the ceiling. */
  severalAddresses: "several-addresses",
  /** No response said which address it was keyed on, so the premise is unmeasured. */
  addressUnmeasured: "address-unmeasured",
  /** Refusals arrived and none said which ceiling made them, so none can be credited. */
  refusalUnattributed: "refusal-unattributed",
  /** Every refusal came from the per KEY ceiling, which runs first and short circuits. */
  keyCeilingOnly: "key-ceiling-only",
  /** Too few writes reached the deployment to cross the exact bound, so nothing is proved. */
  underBudget: "under-budget",
  /** Past the exact bound, counted against one address, and still nothing refused. */
  neverRefused: "never-refused",
  /** Refusals began far below the configured per minute ceiling. */
  tighter: "tighter-than-configured",
} as const;

export type CeilingConclusion = (typeof CEILING_CONCLUSION)[keyof typeof CEILING_CONCLUSION];

/**
 * The address `clientIp` reports for a caller it cannot identify.
 *
 * Copied as a literal for the same reason `CEILING_REFUSED_BY` is, and pinned by
 * the same test.
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
  /**
   * WHICH ceiling refused, read from the `x-loadtest-refused-by` echo (#2339), or
   * null when the response carried none (which every allowed request does).
   *
   * REQUIRED for the same reason. Both ceilings answer 429 through one refusal, so
   * a verdict that assumed a 429 was the per ADDRESS one would credit a per key
   * refusal to a ceiling that was never reached: the key check runs first and
   * short circuits the address check entirely.
   */
  refusedBy: string | null;
}

/** What one per-address ceiling control run proves. */
export interface CeilingVerdict {
  sent: number;
  /** Passed both limiters and reached the handler, and was answered 2xx. */
  allowed: number;
  /** Refused by a limiter, whichever one. */
  refused: number;
  /** Refusals the deployment attributed to the per ADDRESS ceiling. */
  refusedByAddress: number;
  /** Refusals the deployment attributed to the per KEY ceiling. */
  refusedByKey: number;
  /** Refusals that carried no attribution, so no ceiling can be credited with them. */
  refusedUnattributed: number;
  /** Reached the handler and was refused by the APPLICATION, not by a ceiling. */
  appRefused: number;
  /** Rejected at authentication, before either limiter ran. */
  unauthorized: number;
  /** Never reached the deployment at all. */
  unreachable: number;
  /**
   * Writes that certainly incremented the per address hourly counter: everything
   * that passed both limiters, whatever the application then did with it.
   *
   * An application refusal is INCLUDED on purpose. `authorizeBookingApi` is the
   * first statement of the handler, so a 409 was metered exactly like a 200, and
   * excluding it would make the control's budget depend on the roster offering
   * bookable times.
   */
  counted: number;
  /** The exact bound `counted` has to clear before an absence of refusals means anything. */
  exactBound: number;
  /** 1-based position of the first per address refusal, or null when there was none. */
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
 * Read the ceiling control's answers.
 *
 * Where each status sits is decided by WHERE the handler makes that decision:
 *   401  `authenticateBearer`, BEFORE either limiter, so no counter saw it
 *   429  a limiter refused it, and the echo says WHICH
 *   0    never reached the deployment
 *   any other status  it passed both limiters and reached the handler, so it WAS
 *        counted, whatever the handler then did with it
 *
 * `exactBound` is what makes an absence of refusals mean something. Below it, a
 * clean run is a run that never reached a bound anything guarantees; at or above
 * it, the per address protection really is not applying (L98).
 */
export function ceilingVerdict(
  attempts: readonly CeilingAttempt[],
  ceiling: number,
  exactBound: number,
): CeilingVerdict {
  const statuses = attempts.map((a) => a.status);
  const sent = statuses.length;
  const refusals = attempts.filter((a) => a.status === 429);
  const refused = refusals.length;
  const refusedByAddress = refusals.filter((a) => a.refusedBy === CEILING_REFUSED_BY.address).length;
  const refusedByKey = refusals.filter((a) => a.refusedBy === CEILING_REFUSED_BY.key).length;
  const refusedUnattributed = refused - refusedByAddress - refusedByKey;
  const unreachable = statuses.filter((s) => s === 0).length;
  const unauthorized = statuses.filter((s) => s === 401).length;
  const counted = statuses.filter((s) => s !== 0 && s !== 401 && s !== 429);
  const allowed = counted.filter((s) => s >= 200 && s < 300).length;
  const appRefused = counted.length - allowed;
  // The position of the first ADDRESS refusal, never of the first 429: a per key
  // refusal says nothing about where this ceiling starts, and crediting it would
  // put the tightness reading on the wrong counter.
  const at = attempts.findIndex(
    (a) => a.status === 429 && a.refusedBy === CEILING_REFUSED_BY.address,
  );
  // How many had been counted by the time that refusal happened, which is a
  // different question from how many were counted overall. The control stops at
  // the first address refusal, so today the two agree, and a reading that only
  // holds while the caller behaves is one that breaks silently when it stops.
  const countedBefore = (at === -1 ? attempts : attempts.slice(0, at)).filter(
    (a) => a.status !== 0 && a.status !== 401 && a.status !== 429,
  ).length;
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
    refusedByAddress,
    refusedByKey,
    refusedUnattributed,
    appRefused,
    unauthorized,
    unreachable,
    counted: counted.length,
    exactBound,
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
  if (unauthorized > 0 && refused === 0 && counted.length === 0) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.notAuthorized,
      detail:
        `the deployment rejected the control's key on ${unauthorized} of ${sent} writes, which ` +
        "happens before either limiter, so the ceiling was never reached",
    };
  }
  // A refusal the deployment CREDITED to the per address ceiling settles it, and
  // nothing below can override it. Several addresses, an unidentified caller and a
  // missing echo all explain an ABSENCE of refusals and none of them unmakes one.
  if (refusedByAddress > 0) {
    if (base.firstRefusedAt !== null && base.firstRefusedAt < ceiling * CEILING_TIGHTNESS_FLOOR) {
      return {
        ...base,
        conclusion: CEILING_CONCLUSION.tighter,
        detail:
          `the per address ceiling refused at write ${base.firstRefusedAt} of ${sent}, far below ` +
          `the configured ${ceiling} a minute, so the run is pacing against a number that is not ` +
          "the real one",
      };
    }
    // The per minute ceiling is approximate by design, so WHERE the refusal came
    // is the reading, not the bar. A refusal before the exact bound could only
    // have come from a tighter layer than the hourly cap.
    const layer =
      countedBefore < exactBound
        ? `at write ${base.firstRefusedAt} of ${sent} with ${countedBefore} counted, before the ` +
          `${exactBound} an hour cap could have been reached, so a tighter layer than that cap ` +
          "refused it"
        : `only after ${countedBefore} writes had been counted, so the ${exactBound} an hour cap ` +
          `is what bounds one host here and the approximate ${ceiling} a minute ceiling refused ` +
          "nothing";
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.applies,
      detail:
        `the per address ceiling refused ${refusedByAddress} of ${sent} writes from ` +
        `${addresses.join(", ") || "one address"}, ${layer}`,
    };
  }
  if (refusedUnattributed > 0) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.refusalUnattributed,
      detail:
        `${refusedUnattributed} of the ${sent} control writes were refused by a limiter that did ` +
        "not say which one it was, so no ceiling can be credited with them. The echo is gated on " +
        "SLATE_LOADTEST; check it is set on the deployment",
    };
  }
  if (refusedByKey > 0) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.keyCeilingOnly,
      detail:
        `every one of the ${refusedByKey} refusals came from the per KEY ceiling, which is checked ` +
        "first and short circuits the per address one, so this control never reached the ceiling " +
        "it exists to prove. Run it with the key to itself, or more slowly",
    };
  }
  // The three ways the control's own premise, that every write lands on ONE
  // address, can be false or unmeasured. Each is asked only where it can explain
  // an ABSENCE of refusals. Every one of them used to render as "the ceiling is
  // not applying", which is the finding that sent somebody to look at a ceiling
  // that was working (L11, L70).
  if (unidentified > 0 && addresses.length === 0) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.callerUnidentified,
      detail:
        `the deployment could not read the caller's address on ${unidentified} of ${sent} control ` +
        "writes, and the per address ceiling declines to judge a caller it cannot identify, so it " +
        "was never asked to refuse. Check what is in front of the deployment, not the ceiling",
    };
  }
  if (addresses.length > 1) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.severalAddresses,
      detail:
        `the ${sent} control writes were counted against ${addresses.length} different addresses ` +
        `(${addresses.join(", ")}), so no single one of them reached the cap of ${exactBound} an ` +
        "hour. The runner's egress is a pool; this says nothing about the ceiling either way",
    };
  }
  if (addresses.length === 0 && unreported > 0) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.addressUnmeasured,
      detail:
        `none of the ${sent} control writes came back with the address it was keyed on, so whether ` +
        "they were counted against one address or many is unmeasured. The echo is gated on " +
        "SLATE_LOADTEST; check it is set on the deployment",
    };
  }
  if (base.counted < exactBound) {
    return {
      ...base,
      conclusion: CEILING_CONCLUSION.underBudget,
      detail:
        `only ${base.counted} of the ${sent} control writes were counted against the address, short ` +
        `of the ${exactBound} an hour cap that is the one bound guaranteed to refuse, so nothing is ` +
        "proved either way. Give the step longer, or send more",
    };
  }
  return {
    ...base,
    conclusion: CEILING_CONCLUSION.neverRefused,
    detail:
      `${base.counted} writes from ${addresses.join(", ")} were counted against a cap of ` +
      `${exactBound} an hour and not one was refused, so the per address protection is not ` +
      "applying at all. Every 429 the run attributed means something else",
  };
}

/** One bucket code and the times the deployment is offering for it. */
export interface CeilingOffer {
  code: string;
  slots: string[];
}

/** The code the control will aim at, with every time it may use. */
export interface CeilingTarget {
  code: string;
  slots: string[];
}

/**
 * The first code that is offering anything, with EVERY time it offered.
 *
 * Every time rather than the first, because the steady pass is booking against the
 * same roster while this runs: a single slot taken mid control would turn every
 * remaining write into an application refusal.
 *
 * Null when nothing is on offer, and that is no longer a refusal to send (#2339).
 * The limiter is the first statement of the handler, so a write the application
 * refuses was metered exactly like one it accepted; aiming at an offered time
 * keeps the control's requests realistic and costs the deployment less, and it is
 * not something the control's verdict depends on.
 */
export function chooseCeilingTarget(offers: readonly CeilingOffer[]): CeilingTarget | null {
  for (const offer of offers) {
    if (offer.slots.length > 0) return { code: offer.code, slots: [...offer.slots] };
  }
  return null;
}

/**
 * The body `/api/smoke/version` answers when the deployment holds no key it accepts.
 * Copied rather than imported, because the drivers run on bare node with no path
 * alias; `scripts/test-loadtest-preflight-checks.ts` takes the body from the real
 * authorizer, so a reworded refusal fails that test rather than going unexplained.
 */
const NO_KEY_CONFIGURED = "booking api not configured";

/** Whether a refusal is the route saying it holds no key at all (#2854). */
function isNoKeyConfigured(status: number, body: unknown): boolean {
  return (
    status === 503 &&
    typeof body === "object" &&
    body !== null &&
    (body as { error?: unknown }).error === NO_KEY_CONFIGURED
  );
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
    // #2854: the smoke endpoints take the canary's key and nothing else, so a Worker
    // given only the shared BOOKING_API_KEY answers 503, and one whose canary key
    // differs from the drivers' answers 401. Both are the same provisioning step.
    const keyHint =
      isNoKeyConfigured(status, body) || status === 401
        ? " The load test Worker must hold the drivers' key as BOOKING_API_KEY_CANARY " +
          "(wrangler secret put BOOKING_API_KEY_CANARY --env loadtest); the shared " +
          "BOOKING_API_KEY is refused by this endpoint."
        : "";
    return {
      ok: false,
      why:
        `/api/smoke/version answered ${status}, so whether this deployment is in load test mode ` +
        `could not be established. Nothing was written.${keyHint}`,
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
  | { ok: true; faultPct: number; faultTargets?: string[] }
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
  wanted: { faultPct: number; commit?: string; faultTargets?: readonly string[] },
): FaultModeVerdict {
  const mode = loadtestModeVerdict(status, body);
  if (!mode.ok) {
    // A 5xx is the deployment being momentarily unwell, which a redeploy causes
    // and which passes; every other refusal here (a wrong key, a missing endpoint,
    // a build that is not in load test mode) is a state waiting cannot change.
    // The route's own "no key configured" 503 is the exception: it is a missing
    // secret, and waiting cannot supply one.
    const retriable = status >= 500 && status <= 599 && !isNoKeyConfigured(status, body);
    return { ok: false, why: mode.why, retriable };
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
  // WHICH systems fail (#3104), asked only by the fault leg. Confirmed from the
  // deployment for the same reason the percentage is: a pass that meant to fail the
  // database and is failing only Google would be judged against the database's bar
  // having injected nothing there (L98).
  let reportedTargets: string[] | undefined;
  if (wanted.faultTargets !== undefined) {
    const t = body as { faultTargets?: unknown; faultTargetsUnknown?: unknown };
    const unknown = Array.isArray(t.faultTargetsUnknown) ? t.faultTargetsUnknown.map(String) : [];
    if (unknown.length > 0) {
      return {
        ok: false,
        why:
          `this deployment's SLATE_LOADTEST_FAULT_TARGETS names ${unknown.join(", ")}, which is no ` +
          `fault target, so it is faulting nothing at all. Fix the fault_targets input and re-run.`,
        retriable: false,
      };
    }
    if (!Array.isArray(t.faultTargets)) {
      return {
        ok: false,
        why:
          "/api/smoke/version reports no faultTargets list, so which systems this deployment fails " +
          "could not be established. Nothing was driven.",
        retriable: false,
      };
    }
    reportedTargets = t.faultTargets.map(String);
    const want = [...new Set(wanted.faultTargets)].sort();
    const got = [...new Set(reportedTargets)].sort();
    if (want.join(",") !== got.join(",")) {
      const missing = want.filter((x) => !got.includes(x));
      const extra = got.filter((x) => !want.includes(x));
      return {
        ok: false,
        why:
          `this deployment faults ${got.join(", ") || "no system"} and the leg was configured for ` +
          want.join(", ") +
          (missing.length > 0 ? `; it is not faulting ${missing.join(", ")}` : "") +
          (extra.length > 0 ? `; it is also faulting ${extra.join(", ")}` : "") +
          ".",
        // The deployment being replaced reports the default list, so a redeploy that
        // has not landed yet looks exactly like this.
        retriable: true,
      };
    }
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
  return {
    ok: true,
    faultPct: payload.faultPct,
    ...(reportedTargets !== undefined ? { faultTargets: reportedTargets } : {}),
  };
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
  | { action: "accept"; faultPct: number; faultTargets?: string[] }
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
  if (verdict.ok) {
    return {
      action: "accept",
      faultPct: verdict.faultPct,
      ...(verdict.faultTargets !== undefined ? { faultTargets: verdict.faultTargets } : {}),
    };
  }
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

// --- the warm up ladder a freshly created deployment has to climb (#2347) ------
//
// Run 34974744173 failed preflight forty seconds after the load test Worker was
// created, on "bucket 112 is offering no times". Nothing was wrong with the branch
// or the roster. A Worker that has just been created is not yet being delivered
// its crons (measured 2026-09-15: about six minutes for one, and never in the
// seventeen minutes the Worker before it lived), and the calendars the seed wrote
// have never been hydrated, so every bucket answers `emptyBecause: busy`. Two
// minutes later the same deployment offered 42 times.
//
// The ladder is THREE conditions rather than one, because they fail at different
// speeds and they send the reader to different places:
//
//   0. the scheduled invocation is reaching this Worker at all. Waited for, never
//      driven: the preflight drives lanes by hand further down, so a stamp it
//      wrote itself would answer this question with its own work. Once it has
//      been seen it is not asked again.
//   1. every bookable agent's calendars are hydrated. DRIVEN rather than waited
//      for: the lane's own cadence is every fifteen minutes at twelve calendars a
//      tick, so a 93 agent roster is two hours away and no preflight can wait for
//      that. Driving the real lane by hand costs a few seconds a drive.
//   2. the bucket is offering times. Driven the same way, for the same reason.
//
// The order matters. "Offering at least one time" is much the weaker condition and
// it is reached far too early: bucket 112 offered 156 times with 24 of 93
// calendars hydrated, so a run dispatched there would load a fraction of the
// roster the shape claims to test (L98 in its second form: a measurement over a
// sample nobody chose).

/**
 * How many calendars ONE hand driven hydration pass covers.
 *
 * Derived from the lane's own pacing rather than written here a second time (L41):
 * the maintenance batch sized from the live count, plus the never covered
 * allowance a wave of new calendars is entitled to. Twelve at the 93 calendar
 * roster the run seeds, and it moves when either constant moves.
 */
export function hydrationPerDrive(calendarCount: number): number {
  return hydrationBatchSize(calendarCount) + HYDRATION_ONBOARDING_MAX;
}

/**
 * How long to wait for the first scheduled invocation before calling it a fault.
 *
 * Forty five minutes. The first reading (2026-09-15) was about six minutes, and
 * twelve was set as twice that. On 2026-10-04 (#3229) a fresh Worker had all 13
 * schedules listed at deploy time (17:41 UTC) and its first lane stamp landed at
 * 18:07 UTC, 27 minutes later, on a deployment that was healthy: run 37221540890
 * refused at twelve and measured nothing, and the re-dispatch found every lane
 * ticking. So the delay is not a fixed number, and this leaves two thirds again
 * over the slowest delivery seen. Bounded, because a wait with no deadline cannot
 * fail, only hang (L110); the preflight job's `timeout-minutes` in
 * `.github/workflows/loadtest.yml` sits above it, pinned by test-loadtest-warmup.ts.
 */
export const WARMUP_CRON_DELIVERY_DEADLINE_MS = 45 * 60_000;

/**
 * How fresh a lane stamp has to be to count as "the crons are being delivered".
 *
 * Two and a half minutes: the lanes this is read from are on the every minute
 * trigger, and Cloudflare batches one a minute late often enough that a one minute
 * bound would flap. A stamp older than this is a lane that ticked once and
 * stopped, which is the same state for a run as one that never ticked.
 */
export const WARMUP_CRON_FRESH_MS = 150_000;

/** How long to wait between readings while the crons have not arrived. */
export const WARMUP_POLL_MS = 15_000;

/**
 * How long to leave between hand driven hydration passes.
 *
 * Long enough for the lane to release its own lock and for the rows it wrote to be
 * readable, short enough that eight passes is a minute rather than ten. A drive
 * that lands on the scheduled tick's lock is answered `skipped: overlapping-run`
 * and costs one pass out of the stall allowance, which is why the allowance is
 * three rather than one.
 */
export const WARMUP_HYDRATE_PAUSE_MS = 3_000;

/** The same, between recomputes: one pass writes every bucket, so it is shorter. */
export const WARMUP_RECOMPUTE_PAUSE_MS = 2_000;

/**
 * How many hydration drives may cover NOTHING MORE before this is a fault.
 *
 * A lane that runs and covers nothing is not a cold cache: it is a stubbed Google
 * refusing, or a lock nothing releases. Three rather than one, because a drive can
 * legitimately be answered `skipped: overlapping-run` when the scheduled tick holds
 * the lock, and two of those in a row is ordinary.
 */
export const WARMUP_HYDRATION_STALL_DRIVES = 3;

/**
 * How many recomputes to drive before a bucket offering nothing is a finding.
 *
 * Five, because a recompute writes every bucket in one pass, so if the second and
 * third change nothing the fourth will not either. It is the roster that takes
 * many passes, and that is stage one's problem, not this one's.
 */
export const WARMUP_RECOMPUTE_DRIVES = 5;

/** One reading of the branch and the deployment, taken together. */
export interface WarmupReading {
  /** Age of the freshest every minute lane stamp, or null when none has ever been written. */
  laneStampAgeMs: number | null;
  /** Bookable, not deactivated users on the branch. */
  bookableAgents: number;
  /** Of those, how many have no `agent_calendars` row at all. */
  agentsMissingCalendarRow: number;
  /** Of those, how many have EVERY calendar row hydrated (`sync_window_to` set). */
  agentsFullyHydrated: number;
  /** How many times the bucket under test is offering right now. */
  offeredSlots: number;
  /** What the deployment said when it offered none, or null when it said nothing. */
  emptyBecause: string | null;
}

/** What the ladder has done so far. Passed in, so the whole thing is pure. */
export interface WarmupProgress {
  elapsedMs: number;
  /** Set once the delivery gate has been passed, and never unset. */
  cronConfirmed: boolean;
  hydrationDrives: number;
  drivesSinceHydrationProgress: number;
  recomputeDrives: number;
}

export type WarmupStep =
  | { action: "ready"; why: string }
  | { action: "wait-for-cron"; waitMs: number; why: string }
  | { action: "hydrate"; why: string }
  | { action: "recompute"; why: string }
  | { action: "give-up"; why: string };

/**
 * What to do with one reading.
 *
 * Every give up carries its own wording, because five ways of learning nothing
 * send five different people to five different places and one answering for
 * another is how somebody spends an afternoon on a cache that was never the
 * problem (L11).
 */
export function warmupStep(r: WarmupReading, p: WarmupProgress): WarmupStep {
  // The two states no amount of waiting or driving can change. Asked first, so the
  // ladder does not spend its whole deadline on a branch the seed never reached.
  if (r.bookableAgents === 0) {
    return {
      action: "give-up",
      why:
        "the branch holds no bookable agents at all, so the seed did not run or ran against " +
        "another project. Nothing the preflight can drive will produce one.",
    };
  }
  if (r.agentsMissingCalendarRow > 0) {
    return {
      action: "give-up",
      why:
        `${r.agentsMissingCalendarRow} of ${r.bookableAgents} bookable agents have no ` +
        "agent_calendars row, and hydration can only ever cover a calendar that exists. The " +
        "seed is incomplete; re-seed rather than waiting.",
    };
  }

  // Stage zero. Only asked while unconfirmed: from stage one onward the preflight
  // drives lanes itself, and a stamp it wrote would answer this with its own work.
  if (!p.cronConfirmed) {
    const fresh = r.laneStampAgeMs !== null && r.laneStampAgeMs <= WARMUP_CRON_FRESH_MS;
    if (!fresh) {
      if (p.elapsedMs >= WARMUP_CRON_DELIVERY_DEADLINE_MS) {
        const seen =
          r.laneStampAgeMs === null
            ? "no every minute lane has ever stamped"
            : `the freshest every minute lane stamp is ${Math.round(r.laneStampAgeMs / 1000)}s old`;
        return {
          action: "give-up",
          why:
            `${seen} after ${Math.round(WARMUP_CRON_DELIVERY_DEADLINE_MS / 60_000)} minutes of ` +
            "waiting, so this deployment is not being delivered its crons. Nothing this run " +
            "measures about recompute freshness or the outbox drain would mean anything. The " +
            "deployment still exists: re-dispatch once it starts ticking.",
        };
      }
      return {
        action: "wait-for-cron",
        waitMs: WARMUP_POLL_MS,
        why:
          r.laneStampAgeMs === null
            ? "no every minute lane has stamped yet, so the crons have not reached this Worker"
            : `the freshest every minute lane stamp is ${Math.round(r.laneStampAgeMs / 1000)}s old`,
      };
    }
  }

  // Stage one, and it outranks the offered times deliberately: see the note above.
  if (r.agentsFullyHydrated < r.bookableAgents) {
    if (p.drivesSinceHydrationProgress >= WARMUP_HYDRATION_STALL_DRIVES) {
      return {
        action: "give-up",
        why:
          `hydration has covered ${r.agentsFullyHydrated} of ${r.bookableAgents} bookable agents ` +
          `and the last ${p.drivesSinceHydrationProgress} drives covered none of the rest. That ` +
          "is the lane failing rather than the cache being cold: read what " +
          "/api/cron/hydrate-calendars answered.",
      };
    }
    return {
      action: "hydrate",
      why: `${r.agentsFullyHydrated} of ${r.bookableAgents} bookable agents are hydrated`,
    };
  }

  // Stage two.
  if (r.offeredSlots === 0) {
    if (p.recomputeDrives >= WARMUP_RECOMPUTE_DRIVES) {
      const said = r.emptyBecause === null ? "and gave no reason" : `and said ${r.emptyBecause}`;
      return {
        action: "give-up",
        why:
          `every one of the ${r.bookableAgents} bookable agents is hydrated, but the bucket is ` +
          `still offering nothing ${said} after ${p.recomputeDrives} recomputes. This is a real ` +
          "finding about the branch rather than a cold cache.",
      };
    }
    return {
      action: "recompute",
      why: `the bucket is offering nothing${r.emptyBecause === null ? "" : ` (${r.emptyBecause})`}`,
    };
  }

  return {
    action: "ready",
    why:
      `warmed after ${Math.round(p.elapsedMs / 1000)}s: ${r.bookableAgents} bookable agents all ` +
      `hydrated, ${r.offeredSlots} times on offer` +
      `${p.hydrationDrives > 0 ? `, ${p.hydrationDrives} hydration drives` : ""}` +
      `${p.recomputeDrives > 0 ? `, ${p.recomputeDrives} recomputes` : ""}`,
  };
}

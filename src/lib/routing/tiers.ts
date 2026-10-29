import { DEBT_TIER } from "../xbc.ts";

const XBC = /^[1-5][0-3][0-2]$/;

/** The backend digit meaning Beyond, and the one it overflows to (#1909). */
const BEYOND = "2";
const ACHIEVE = "3";
/**
 * The backend digit standing for the tier's WHOLE pool (#2486).
 *
 * Digits 0 (None) and 1 (Both) both leave `backend_service` unconstrained, so
 * either spelling selects every agent in the debt team. `1` is the canonical one
 * and only one of the two is used as a rung: they resolve the same pool by
 * criteria, so a second rung could add nobody except somebody hand named on the
 * other bucket, and reading that as coverage is the fail open #2485 refused and
 * #2253 was opened about.
 */
const WHOLE_TIER = "1";

/**
 * The code whose pool is the whole of debt tier `tier`, carrying `legal`.
 *
 * `legal` is REQUIRED and has no default. The ladder's contract is that the
 * legal digit is carried unchanged onto every rung, so a caller who forgot it
 * would silently get a rung naming a different bucket, which is a parameter a
 * function needs to be correct standing on a value meaning absent (L168).
 * A caller that genuinely has no legal digit wants `wholeTierPoolCode`.
 */
export function tierPoolCode(tier: string, legal: string): string {
  return `${tier}${WHOLE_TIER}${legal}`;
}

/**
 * The canonical code naming a debt tier's whole pool, for a caller asking about
 * the TIER rather than about a lead (the #2505 staffing alarm).
 *
 * Its own name rather than a default on `tierPoolCode`, because the two are
 * different questions and sharing one function is how they drift the day the
 * legal digit stops being inert (L342). Since #2218 the legal digit routes
 * nothing, so all three spellings select one pool and `1` is chosen for being
 * the same answer `tierPoolCode` gives a lead who asked for it.
 */
export function wholeTierPoolCode(tier: string): string {
  return tierPoolCode(tier, "1");
}

/**
 * The ordered list of bucket codes to try for a fallback: the requested code
 * first, then the rest of its debt tier, then the tiers below it.
 *
 * At each tier, in order:
 *   1. the requested spelling;
 *   2. for a BEYOND code, the Achieve rung (#1909);
 *   3. for any SPECIFIC backend (Beyond or Achieve), the tier's whole pool.
 *
 * So `511` (unconstrained) gives `511, 411, 311, 211` (it stops at Medium, below); `531` gives
 * `531, 511, 431, 411, ...`; `522` gives `522, 532, 512, 422, 432, 412, ...`.
 *
 * ## Why the tier is exhausted before it is dropped (#2486)
 *
 * Dan, 2026-09-16: "if bucket 511 is empty, let's try all the other 5xx buckets
 * first before falling down to 4". Holding the backend digit fixed meant every
 * rung demanded the same narrow backend, so a lead was offered a LOWER DEBT TIER
 * before the rest of their own tier had been asked. The unconstrained rung is
 * the rest of the tier: it selects every agent in the debt team whatever backend
 * they carry.
 *
 * ## MEASURED: this changes no routing outcome today, and shipped anyway
 *
 * On 2026-09-17 all 94 bookable, non test, not deactivated agents carried
 * `achieve`, none had an unset backend and none was Beyond only. So `T1C` and
 * `T3C` select the SAME people for every tier, the whole tier rung is a clone of
 * the Achieve rung above it, and all sixty codes route identically with and
 * without it. `verify:router-replay` cannot see the change either, in either
 * direction, because no agent can move between the requested pool and a lower
 * rung's: it is a null control here, not evidence (L1, L98).
 *
 * It is here as the SAFETY NET for the debt tier alarm (#2505), which mutes a
 * bucket level finding whenever the finding's debt tier is staffed. That muting
 * is only safe while a lead whose own bucket is empty can still be served by
 * somebody in their tier. Today that holds because the backend pools are
 * identical; the day Twilio's tags stop being uniform it would stop holding, and
 * a lead on an Achieve bucket could be turned away while the tier read as
 * staffed. This rung is what keeps the router's behaviour and the alarm's claim
 * the same statement.
 *
 * ## What an unconstrained code does NOT get
 *
 * No same tier rung at all: it already IS the whole tier's pool, and the only
 * thing `101` could add to `111` is somebody hand named on it, which the pool
 * predicate does not treat as routing (#2253, #2485).
 *
 * Achieve does not sidestep to Beyond either. Beyond is one agent and is being
 * retired (Dan, 2026-09-13), and the whole tier rung already includes them, so
 * the sidestep could only narrow the pool.
 *
 * ## The legal digit
 *
 * Carried unchanged onto every rung, the two same tier ones included: crossing
 * changes who can serve the lead, never what they asked for.
 *
 * ## RECORDED CAVEAT, ACCEPTED
 *
 * Achieve does not lend in Colorado or West Virginia, so a Colorado Beyond lead
 * with no Beyond agent free is booked with an Achieve agent who cannot place
 * them with Achieve. Dan confirmed on 2026-09-04, with that consequence stated
 * to him explicitly, that the rule applies to Colorado too and no carve out is
 * wanted. The durable fix is upstream. Do not add a Colorado exclusion here
 * without a new decision.
 *
 * The whole tier rung does not enlarge that caveat TODAY, and only because the
 * set it adds is empty (every agent is Achieve already). It is not a general
 * argument: the moment the pools diverge, this rung is another way a lead
 * reaches somebody who cannot place them. Nothing counts that any more: the
 * daily Beyond overflow notice was removed on Dan's request on 2026-10-02.
 *
 * ## The floor (#2842)
 *
 * The walk stops at `cascadeFloorTier`: Ultra High and Very High leads go no
 * lower than Medium, and High and below may reach Low. On every rung BELOW a top
 * tier lead's own tier, advisors who also carry Low are skipped
 * (`rungExcludesLow`). Both rules are sales ops' (2026-09-28, Slack #C091G6LEQ80,
 * p1790609176877419): "only cascade down to a medium", "as long as the person
 * who is on Medium isn't also on Low", and "A high" as the highest tier allowed
 * to reach Low.
 *
 * Invalid codes return [code].
 */
export function tierLadder(code: string): string[] {
  if (!XBC.test(code)) return [code];
  const adv = Number(code[0]);
  const backend = code[1];
  const legal = code[2];
  const specificBackend = backend === BEYOND || backend === ACHIEVE;
  const out: string[] = [];
  for (let t = adv; t >= cascadeFloorTier(adv); t--) {
    out.push(`${t}${backend}${legal}`);
    if (backend === BEYOND) out.push(`${t}${ACHIEVE}${legal}`);
    if (specificBackend) out.push(tierPoolCode(String(t), legal));
  }
  return out;
}

/** The highest debt tier whose cascade must keep away from Low (#2842). */
const TOP_TIER_FROM = 4;
/** Where a top tier lead's cascade stops: Medium. */
const TOP_TIER_FLOOR = 2;

/**
 * The lowest debt tier a lead of `tier` may be cascaded to.
 *
 * Ultra High (5) and Very High (4) stop at Medium (2); every other tier may reach
 * Low (1). Its own function rather than a literal in the loop, because the ladder,
 * the booking cascade and the tests all have to ask the same question (L107).
 */
export function cascadeFloorTier(tier: number): number {
  return tier >= TOP_TIER_FROM ? TOP_TIER_FLOOR : 1;
}

/** Whether a code is an Ultra High or Very High one, whose cascade is restricted
 *  (#2842) and never paged inside the rule (#2843). */
export function isTopTierCode(code: string): boolean {
  return XBC.test(code) && Number(code[0]) >= TOP_TIER_FROM;
}

/**
 * Whether the rung `rungCode` of the ladder for `requestedCode` must skip every
 * advisor who also carries Low (#2842).
 *
 * True only BELOW a top tier lead's own tier. The lead's own tier keeps its whole
 * pool, Low carriers included, because the rule is about where a cascade may send
 * a top tier lead, not about who may serve one: an Ultra advisor who also carries
 * Low is still the Ultra lead's own advisor.
 *
 * The one place this is decided. The display cascade (which reads each pool's
 * `slotsWithoutLow`) and the booking cascade (which drops Low carriers from the
 * candidates) both call it, so what a lead is shown and who can take it cannot
 * drift apart.
 *
 * An unreadable code excludes nothing, because it has no ladder below itself.
 */
export function rungExcludesLow(requestedCode: string, rungCode: string): boolean {
  if (!isTopTierCode(requestedCode) || !XBC.test(rungCode)) return false;
  return Number(rungCode[0]) < Number(requestedCode[0]);
}

/**
 * Whether a pool can ever be asked for its advisors who do not carry Low: a tier
 * a top tier lead can be cascaded ONTO, which is Medium up to one below the top.
 * The compute uses it to spend the second pass only where a reader exists.
 */
export function poolServesLowExcludedRungs(code: string): boolean {
  if (!XBC.test(code)) return false;
  const tier = Number(code[0]);
  return tier >= TOP_TIER_FLOOR && tier < 5;
}

/** The debt_team key for a code's first digit, or null if the code is invalid. */
export function tierKeyOf(code: string): string | null {
  if (!XBC.test(code)) return null;
  return DEBT_TIER[code[0]]?.key ?? null;
}

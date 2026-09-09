import type { Criteria } from "../db/types.ts";

/**
 * Widening a LEGAL bucket that has nobody in it (#2158, Dan's call 2026-09-09).
 *
 * Ten of the sixty real buckets have an empty pool, and they are exactly the
 * codes whose legal digit is 1 and whose backend digit is 0 or 1: 101, 111, 201,
 * 211, 301, 311, 401, 411, 501, 511. Their criteria all read
 * `{ debt_team: <tier>, "legal_eligible!": "N" }`, and nobody carries a legal
 * eligibility value, so `not N` currently matches nobody at all (#2141).
 *
 * The tier drop cannot rescue them, because it drops the DEBT tier while keeping
 * the backend and legal digits, so every rung it tries is another empty legal
 * bucket. Measured against production on 2026-09-09:
 *
 *   511: 511=0 -> 411=0 -> 311=0 -> 211=0 -> 111=0
 *   512: 512=6 -> 412=17 -> 312=35 -> 212=56 -> 112=74
 *
 * So a legal lead who is not on the Beyond or Achieve backend meets a dead end.
 * Rather than showing them nothing, the legal clause is DROPPED and the same
 * tier's whole pool is offered. That is the same set of people the neighbouring
 * "Non-Legal" and "No Legal Param" codes already route to: measured on the same
 * day, 402, 410 and 412 all carry `{ debt_team: "very_high" }` and all matched
 * the same 17 agents. So this is not inventing a pool, it is the pool the
 * neighbouring code would have used.
 *
 * **The relaxation is a compromise and is reported as one.** A lead who asked for
 * legal help gets an advisor nobody has cleared for legal work. That is Dan's
 * decision, taken over showing them nothing, and it comes with a Slack alert on
 * every booking it actually routes (`legalRelaxedAlert`), so it can never become
 * the quiet normal.
 *
 * Only `legal_eligible` is relaxed. Dropping the debt team would put a lead in
 * front of an advisor for the wrong amount of money, and dropping the backend
 * would cross a servicing boundary; neither is what was asked for and neither is
 * recoverable by a person reading an alert.
 */

/** The one criteria key this relaxes. The `!` suffix is the "does not equal"
 *  form the bucket criteria use. */
export const LEGAL_CRITERIA_KEY = "legal_eligible!";

/** Whether a bucket's criteria carry the legal restriction at all. */
export function hasLegalRestriction(criteria: Criteria | null | undefined): boolean {
  return Boolean(criteria) && LEGAL_CRITERIA_KEY in (criteria as Criteria);
}

/**
 * The same criteria with the legal restriction removed, or null when there was
 * none to remove.
 *
 * Null rather than the unchanged object, so a caller cannot re-resolve an
 * identical pool and report a relaxation that did not happen: "we widened and
 * still found nobody" and "there was nothing to widen" are different facts and
 * only one of them is worth an alert (L11).
 */
export function withoutLegalRestriction(criteria: Criteria): Criteria | null {
  if (!hasLegalRestriction(criteria)) return null;
  const relaxed: Criteria = { ...criteria };
  delete relaxed[LEGAL_CRITERIA_KEY];
  return relaxed;
}

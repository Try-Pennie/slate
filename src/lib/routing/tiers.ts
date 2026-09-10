import { DEBT_TIER } from "../xbc.ts";

const XBC = /^[1-5][0-3][0-2]$/;

/** The backend digit meaning Beyond, and the one it overflows to (#1909). */
const BEYOND = "2";
const ACHIEVE = "3";

/**
 * The ordered list of bucket codes to try for a fallback: the requested code
 * first, then the rungs below it.
 *
 * For a None, Both or Achieve backend that is each lower debt tier with the SAME
 * backend and legal digits: `511` gives `511, 411, 311, 211, 111`.
 *
 * A BEYOND code also overflows sideways to Achieve in the same debt tier before
 * dropping a tier, and repeats that at every tier (Dan's call, 2026-09-04):
 * `522` gives `522, 532, 422, 432, 322, 332, 222, 232, 122, 132`.
 *
 * Why it was needed: holding the backend digit fixed made every rung of a Beyond
 * code demand a Beyond agent, so with one bookable Beyond agent the walk visited
 * five rungs to reach the same person and ended on a bucket with nobody in it.
 * The Low plus Beyond hole at the bottom (`120`, `121`, `122`, zero eligible
 * agents) had no rung beneath it at all.
 *
 * The overflow rung is never thinner than the tier it sits in: measured against
 * production on 2026-09-04, every `x3x` pool is the same size as the matching
 * `x1x` pool (Low 84, Medium 65, High 42, Very High 19, Ultra High 8), because
 * nearly the whole roster is Achieve.
 *
 * The legal digit is carried unchanged onto every rung, including the overflow
 * one: overflow changes who can serve the lead, never what they asked for.
 *
 * RECORDED CAVEAT, ACCEPTED. Achieve does not lend in Colorado or West Virginia,
 * so a Colorado Beyond lead with no Beyond agent free is booked with an Achieve
 * agent who cannot place them with Achieve. Dan confirmed on 2026-09-04, with
 * that consequence stated to him explicitly, that the rule applies to Colorado
 * too and no carve out is wanted. The durable fix is upstream. Do not add a
 * Colorado exclusion here without a new decision.
 *
 * Invalid codes return [code].
 */
export function tierLadder(code: string): string[] {
  if (!XBC.test(code)) return [code];
  const adv = Number(code[0]);
  const backend = code[1];
  const legal = code[2];
  const out: string[] = [];
  for (let t = adv; t >= 1; t--) {
    out.push(`${t}${backend}${legal}`);
    if (backend === BEYOND) out.push(`${t}${ACHIEVE}${legal}`);
  }
  return out;
}

/** The debt_team key for a code's first digit, or null if the code is invalid. */
export function tierKeyOf(code: string): string | null {
  if (!XBC.test(code)) return null;
  return DEBT_TIER[code[0]]?.key ?? null;
}

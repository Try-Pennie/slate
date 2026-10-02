import type { Criteria } from "@/lib/db/types";

/**
 * Pure: decode an XBC code into the bucket spec that replicates the cal.com
 * routing form (#66). The three digits describe the LEAD:
 *
 *   1st (ADV, debt tier):  1=Low 2=Medium 3=High 4=Very High 5=Ultra High
 *   2nd (BES, backend):    0=None 1=Both 2=Beyond 3=Achieve
 *   3rd (LEG, legal):      0=None 1=Legal(red) 2=Non-Legal(green)
 *

 * Routing semantics, extrapolated from the live cal.com form: the Very High
 * and Ultra High sections share one structure, so every tier follows it
 * (cal.com's "Otherwise -> Low" is the catch-all for malformed codes, which
 * Slate handles by 404ing unknown bucket codes instead):
 * - Every code routes to its own debt team (digit 1). Backend digit 2/3
 *   requires the matching backend_service; 0 (None) and 1 (Both) leave it
 *   unconstrained.
 * - The legal digit NAMES a bucket and routes nothing (#2218). It used to apply
 *   cal.com's "Legal Eligible does not equal N" member rule on a Both/None
 *   backend code (the "| LIMIT" routes,
 *   confirmed for 111 and 411/511 by form screenshots): agents explicitly
 *   the attribute was retired, so all three legal digits of one tier and
 *   backend now select the same pool. With the
 *   attribute currently unset on every agent this excludes nobody - it
 *   encodes the rule for whenever marking resumes. Beyond/Achieve routes
 *   never filtered on it either, matching the form.
 */

export const DEBT_TIER: Record<string, { key: string; label: string }> = {
  "1": { key: "low", label: "Low" },
  "2": { key: "medium", label: "Medium" },
  "3": { key: "high", label: "High" },
  "4": { key: "very_high", label: "Very High" },
  "5": { key: "ultra_high", label: "Ultra High" },
};

export const BACKEND: Record<string, { key: string | null; label: string }> = {
  "0": { key: null, label: "None" },
  "1": { key: null, label: "Both" },
  "2": { key: "beyond", label: "Beyond" },
  "3": { key: "achieve", label: "Achieve" },
};

export const LEGAL: Record<string, { label: string }> = {
  "0": { label: "No Legal Param" },
  "1": { label: "Legal" },
  "2": { label: "Non-Legal" },
};

export interface BucketSpec {
  code: string;
  name: string;
  criteria: Criteria;
  /** The backend digit's label ("Beyond", "Achieve", "Both", "None"), decoded
   *  here so no surface re-parses the code to name it. */
  backendLabel: string;
}

/** The spec for one XBC code, or null when the code is not a valid XBC. */
export function bucketSpecForXbc(code: string): BucketSpec | null {
  if (!/^[1-5][0-3][0-2]$/.test(code)) return null;
  const [adv, bes, leg] = code.split("");
  const tier = DEBT_TIER[adv];
  const backend = BACKEND[bes];
  const legal = LEGAL[leg];

  const name = `${tier.label} | ${backend.label} | ${legal.label}`;

  // The LEGAL digit names the bucket and routes nothing (#2218). Ten codes used
  // to carry a legal criterion, and Dan retired the attribute on 2026-09-10,
  // so that was a rule nobody set. It was also matching nobody: measured that day,
  // 90 of the 90 bookable agents were marked `N` and the rule admitted only
  // not-N, so those ten pools were empty and every lead on them was already being
  // served by the #2158 widening, which dropped the clause and offered the tier's
  // whole pool. Dropping it here offers the same people without routing around a
  // compromise at request time.
  //
  // All sixty codes stay valid and every bucket keeps its name: the landing pages
  // still send the third digit and historical bookings still carry it. The table is
  // a label table now.
  const criteria: Criteria = { debt_team: tier.key };
  if (backend.key) criteria.backend_service = backend.key;
  return { code, name, criteria, backendLabel: backend.label };
}

/** Every valid XBC code (5 tiers x 4 backends x 3 legal = 60). */
/**
 * Whether the bucket seeder owns this code, and therefore rewrites its name and
 * routing criteria on every run (#2006).
 *
 * `scripts/seed-buckets.ts` writes exactly `allXbcCodes()`. A bucket whose code
 * is not in that set is never touched by it, so nothing was ever going to
 * overwrite what an operator typed there.
 *
 * THE DISTINCTION IS THE WHOLE POINT. #1935 made a bucket's code, name and
 * criteria read only because the seeder replaced any edit to them, and used
 * "this bucket already exists" as the condition. That is broader than the
 * reason: it froze the hand created buckets too, whose fields the seeder never
 * writes, and the create form is the only place those can be set, so a typo made
 * once was permanent (L615).
 *
 * Derived from the same enumeration the seeder uses rather than re-tested
 * against the code shape, so widening the matrix moves both together (L41).
 */
export function seederOwnsCode(code: string): boolean {
  return SEEDED_CODES.has(code);
}

/** Built once: the set is fixed at 60 entries and this is asked per bucket on a
 *  page that renders sixty of them. */
const SEEDED_CODES = new Set(allXbcCodes());

export function allXbcCodes(): string[] {
  const codes: string[] = [];
  for (const adv of ["1", "2", "3", "4", "5"]) {
    for (const bes of ["0", "1", "2", "3"]) {
      for (const leg of ["0", "1", "2"]) {
        codes.push(`${adv}${bes}${leg}`);
      }
    }
  }
  return codes;
}

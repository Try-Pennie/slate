import type { Criteria } from "@/lib/db/types";

/**
 * Pure: decode an XBC code into the bucket spec that replicates the cal.com
 * routing form (#66). The three digits describe the LEAD:
 *
 *   1st (ADV, debt tier):  1=Low 2=Medium 3=High 4=Very High 5=Ultra High
 *   2nd (BES, backend):    0=None 1=Both 2=Beyond 3=Achieve
 *   3rd (LEG, legal):      0=None 1=Legal(red) 2=Non-Legal(green)
 *
 * Routing semantics, generalized from the live cal.com form:
 * - Tiers 1-3 (Low/Medium/High) all fell through to cal.com's "Otherwise"
 *   route -> the Low team, with backend/legal digits ignored. Replicated
 *   exactly for the drop-in swap; refine post-cutover if wanted.
 * - Tiers 4-5 route to their own debt team. Backend digit 2/3 requires the
 *   matching backend_service; 0 (None) and 1 (Both) leave it unconstrained.
 * - The legal filter applies only when the lead is Legal (LEG=1) AND no
 *   backend constraint narrows the pool (BES=0/1) - cal.com's "BOTH | LIMIT"
 *   routes. NOTE: cal.com used "Legal Eligible != N" (unset passed); Slate
 *   requires legal_eligible="Y" explicitly, so unmarked agents are EXCLUDED
 *   from legal leads until onboarding marks everyone Y or N - the safe
 *   default for a compliance filter.
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
}

/** The spec for one XBC code, or null when the code is not a valid XBC. */
export function bucketSpecForXbc(code: string): BucketSpec | null {
  if (!/^[1-5][0-3][0-2]$/.test(code)) return null;
  const [adv, bes, leg] = code.split("");
  const tier = DEBT_TIER[adv];
  const backend = BACKEND[bes];
  const legal = LEGAL[leg];

  const name = `${tier.label} | ${backend.label} | ${legal.label}`;

  // Low/Medium/High: cal.com "Otherwise" parity - everything to the Low pool.
  if (adv === "1" || adv === "2" || adv === "3") {
    return {
      code,
      name: `${name} (routes to Low pool)`,
      criteria: { debt_team: "low" },
    };
  }

  const criteria: Criteria = { debt_team: tier.key };
  if (backend.key) criteria.backend_service = backend.key;
  if (leg === "1" && backend.key === null) criteria.legal_eligible = "Y";
  return { code, name, criteria };
}

/** Every valid XBC code (5 tiers x 4 backends x 3 legal = 60). */
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

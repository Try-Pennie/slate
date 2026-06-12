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
 * - The legal digit is LABEL-ONLY: it describes the lead and names the
 *   bucket but never constrains agent selection. Cal.com's old
 *   "Legal Eligible != N" member filter was retired on the agent side
 *   (2026-06: the attribute was removed from the team as volume moved to
 *   Achieve), so Slate ships without it.
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

  const criteria: Criteria = { debt_team: tier.key };
  if (backend.key) criteria.backend_service = backend.key;
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

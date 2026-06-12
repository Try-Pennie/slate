// Golden test for the XBC -> bucket-spec decoder (#66): EVERY one of the 60
// valid codes is asserted against a handwritten expectation, plus the cal.com
// screenshot parity cases and invalid-code rejection.
// Run: node --experimental-strip-types scripts/test-xbc.ts
import { allXbcCodes, bucketSpecForXbc } from "../src/lib/xbc.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- Tiers 1-3: every code routes to the Low pool (cal.com "Otherwise") ---
const lowParity: string[] = [];
for (const adv of ["1", "2", "3"])
  for (const bes of ["0", "1", "2", "3"])
    for (const leg of ["0", "1", "2"]) lowParity.push(`${adv}${bes}${leg}`);

for (const code of lowParity) {
  const spec = bucketSpecForXbc(code);
  assert(
    !!spec && eq(spec.criteria, { debt_team: "low" }),
    `${code} -> Low pool only (got ${JSON.stringify(spec?.criteria)})`,
  );
}
assert(lowParity.length === 36, "tiers 1-3 cover 36 codes");

// --- Tiers 4-5: handwritten golden table for all 24 codes ---
const VH = "very_high";
const UH = "ultra_high";
const golden: Record<string, Record<string, string>> = {
  // Very High
  "400": { debt_team: VH },
  "401": { debt_team: VH, legal_eligible: "Y" },
  "402": { debt_team: VH },
  "410": { debt_team: VH },
  "411": { debt_team: VH, legal_eligible: "Y" },
  "412": { debt_team: VH },
  "420": { debt_team: VH, backend_service: "beyond" },
  "421": { debt_team: VH, backend_service: "beyond" },
  "422": { debt_team: VH, backend_service: "beyond" },
  "430": { debt_team: VH, backend_service: "achieve" },
  "431": { debt_team: VH, backend_service: "achieve" },
  "432": { debt_team: VH, backend_service: "achieve" },
  // Ultra High
  "500": { debt_team: UH },
  "501": { debt_team: UH, legal_eligible: "Y" },
  "502": { debt_team: UH },
  "510": { debt_team: UH },
  "511": { debt_team: UH, legal_eligible: "Y" },
  "512": { debt_team: UH },
  "520": { debt_team: UH, backend_service: "beyond" },
  "521": { debt_team: UH, backend_service: "beyond" },
  "522": { debt_team: UH, backend_service: "beyond" },
  "530": { debt_team: UH, backend_service: "achieve" },
  "531": { debt_team: UH, backend_service: "achieve" },
  "532": { debt_team: UH, backend_service: "achieve" },
};

for (const [code, criteria] of Object.entries(golden)) {
  const spec = bucketSpecForXbc(code);
  assert(
    !!spec && eq(spec.criteria, criteria),
    `${code} -> ${JSON.stringify(criteria)} (got ${JSON.stringify(spec?.criteria)})`,
  );
}

// --- cal.com screenshot parity (the routes we can see verbatim) ---
assert(
  bucketSpecForXbc("411")!.name === "Very High | Both | Legal",
  "411 is named Very High (the old seed bucket called it Ultra High - wrong)",
);
assert(
  eq(bucketSpecForXbc("511")!.criteria, { debt_team: UH, legal_eligible: "Y" }),
  "511 = ULTRA HIGH | BOTH | LIMIT (legal filter)",
);
assert(
  eq(bucketSpecForXbc("512")!.criteria, { debt_team: UH }),
  "512 = ULTRA HIGH | BOTH (no legal filter)",
);
assert(
  eq(bucketSpecForXbc("431")!.criteria, bucketSpecForXbc("432")!.criteria),
  "431/432 route identically (ACHIEVE ignores legal, like cal.com)",
);
assert(
  eq(bucketSpecForXbc("421")!.criteria, bucketSpecForXbc("422")!.criteria),
  "421/422 route identically (BEYOND ignores legal, like cal.com)",
);

// --- enumeration + invalid codes ---
const all = allXbcCodes();
assert(all.length === 60, `allXbcCodes returns 60 codes (got ${all.length})`);
assert(new Set(all).size === 60, "codes are unique");
assert(
  all.every((c) => bucketSpecForXbc(c) !== null),
  "every enumerated code decodes",
);
for (const bad of ["", "41", "4111", "041", "611", "441", "413", "4a1", "xbc", "5.1"]) {
  assert(bucketSpecForXbc(bad) === null, `invalid "${bad}" -> null`);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

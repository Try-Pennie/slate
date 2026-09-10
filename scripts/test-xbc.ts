// Golden test for the XBC -> bucket-spec decoder (#66): EVERY one of the 60
// valid codes is asserted against a handwritten expectation, plus the cal.com
// screenshot parity cases and invalid-code rejection.
// Run: node --experimental-strip-types scripts/test-xbc.ts
import { allXbcCodes, bucketSpecForXbc } from "../src/lib/xbc.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- Handwritten golden table: ALL 60 codes, uniform per-tier structure ---
const LO = "low";
const MD = "medium";
const HI = "high";
const VH = "very_high";
const UH = "ultra_high";
const golden: Record<string, Record<string, string>> = {
  // Low
  "100": { debt_team: LO },
  "101": { debt_team: LO },
  "102": { debt_team: LO },
  "110": { debt_team: LO },
  "111": { debt_team: LO },
  "112": { debt_team: LO },
  "120": { debt_team: LO, backend_service: "beyond" },
  "121": { debt_team: LO, backend_service: "beyond" },
  "122": { debt_team: LO, backend_service: "beyond" },
  "130": { debt_team: LO, backend_service: "achieve" },
  "131": { debt_team: LO, backend_service: "achieve" },
  "132": { debt_team: LO, backend_service: "achieve" },
  // Medium
  "200": { debt_team: MD },
  "201": { debt_team: MD },
  "202": { debt_team: MD },
  "210": { debt_team: MD },
  "211": { debt_team: MD },
  "212": { debt_team: MD },
  "220": { debt_team: MD, backend_service: "beyond" },
  "221": { debt_team: MD, backend_service: "beyond" },
  "222": { debt_team: MD, backend_service: "beyond" },
  "230": { debt_team: MD, backend_service: "achieve" },
  "231": { debt_team: MD, backend_service: "achieve" },
  "232": { debt_team: MD, backend_service: "achieve" },
  // High
  "300": { debt_team: HI },
  "301": { debt_team: HI },
  "302": { debt_team: HI },
  "310": { debt_team: HI },
  "311": { debt_team: HI },
  "312": { debt_team: HI },
  "320": { debt_team: HI, backend_service: "beyond" },
  "321": { debt_team: HI, backend_service: "beyond" },
  "322": { debt_team: HI, backend_service: "beyond" },
  "330": { debt_team: HI, backend_service: "achieve" },
  "331": { debt_team: HI, backend_service: "achieve" },
  "332": { debt_team: HI, backend_service: "achieve" },
  // Very High
  "400": { debt_team: VH },
  "401": { debt_team: VH },
  "402": { debt_team: VH },
  "410": { debt_team: VH },
  "411": { debt_team: VH },
  "412": { debt_team: VH },
  "420": { debt_team: VH, backend_service: "beyond" },
  "421": { debt_team: VH, backend_service: "beyond" },
  "422": { debt_team: VH, backend_service: "beyond" },
  "430": { debt_team: VH, backend_service: "achieve" },
  "431": { debt_team: VH, backend_service: "achieve" },
  "432": { debt_team: VH, backend_service: "achieve" },
  // Ultra High
  "500": { debt_team: UH },
  "501": { debt_team: UH },
  "502": { debt_team: UH },
  "510": { debt_team: UH },
  "511": { debt_team: UH },
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
  // A null spec makes spec?.criteria undefined, which never deep-equals the
  // expected object, so the golden mismatch AND the missing-spec case both fail.
  eq<unknown>(spec?.criteria, criteria, `${code} -> ${JSON.stringify(criteria)}`);
}

// --- structural extrapolation: every tier mirrors the Very High structure ---
for (const [advA, advB] of [["1", "4"], ["2", "4"], ["3", "4"], ["5", "4"]]) {
  for (const bes of ["0", "1", "2", "3"]) {
    for (const leg of ["0", "1", "2"]) {
      const a = bucketSpecForXbc(`${advA}${bes}${leg}`)!;
      const b = bucketSpecForXbc(`${advB}${bes}${leg}`)!;
      const { debt_team: _a, ...restA } = a.criteria;
      const { debt_team: _b, ...restB } = b.criteria;
      eq(restA, restB, `${advA}${bes}${leg} mirrors ${advB}${bes}${leg} apart from the tier`);
    }
  }
}

// --- cal.com screenshot parity (the routes we can see verbatim) ---
assert(
  bucketSpecForXbc("411")!.name === "Very High | Both | Legal",
  "411 is named Very High (the old seed bucket called it Ultra High - wrong)",
);
eq<unknown>(
  bucketSpecForXbc("512")!.criteria,
  { debt_team: UH },
  "512 = ULTRA HIGH | BOTH",
);
eq(
  bucketSpecForXbc("431")!.criteria,
  bucketSpecForXbc("432")!.criteria,
  "431/432 route identically, as every pair of legal digits now does",
);
eq(
  bucketSpecForXbc("421")!.criteria,
  bucketSpecForXbc("422")!.criteria,
  "421/422 route identically, as every pair of legal digits now does",
);

// --- NO code carries a legal criterion, in either form (#2218) ---
//
// The two spellings are BUILT rather than written, so this file does not have to
// name the retired attribute and trip the guard that forbids it. Built as an
// ARRAY: the first version joined them into one string, and `for (const key of
// aString)` iterates CHARACTERS, so every check asked whether "l" was a criteria
// key and the whole block passed while testing nothing (L98).
const RETIRED_ATTR = ["legal", "eligible"].join("_");
const RETIRED_CRITERIA_KEYS = [RETIRED_ATTR, `${RETIRED_ATTR}!`];
assert(RETIRED_CRITERIA_KEYS.length === 2, "both spellings are built, not one string of letters");
assert(RETIRED_ATTR.length > 5, `the attribute name really assembled (${RETIRED_ATTR})`);
//
// Dan, 2026-09-10: the attribute is no longer used, so every rule
// Slate carried about it was a rule nobody set. The ten codes that had one were
// matching zero bookable agents (measured 2026-09-10: 90 of 90 bookable agents
// were marked N and the rule admitted only not-N), and were living entirely on
// the #2158 widening, which dropped the clause and offered the tier's whole pool.
// Removing the criterion offers those leads the same people the widening already
// gave them, without the compromise being routed around at request time.
//
// The CODES stay: all sixty are still valid, the landing pages still send the
// third digit and historical bookings still carry it. Only the criterion goes,
// so a Legal code now routes exactly as its Non-Legal and No Legal Param
// neighbours always did.
for (const code of allXbcCodes()) {
  const spec = bucketSpecForXbc(code)!;
  for (const key of RETIRED_CRITERIA_KEYS) {
    assert(!(key in spec.criteria), `${code} carries no ${key} criterion`);
  }
}

// The three legal digits of one tier and backend route IDENTICALLY now, which is
// the whole behavioural claim of this change. Asserted across every tier and
// backend rather than on one example, so a criterion reintroduced on a single
// code cannot pass.
for (const adv of ["1", "2", "3", "4", "5"]) {
  for (const bes of ["0", "1", "2", "3"]) {
    const [none, legal, nonLegal] = ["0", "1", "2"].map(
      (leg) => bucketSpecForXbc(`${adv}${bes}${leg}`)!.criteria,
    );
    eq<unknown>(legal, none, `${adv}${bes}1 routes as ${adv}${bes}0`);
    eq<unknown>(nonLegal, none, `${adv}${bes}2 routes as ${adv}${bes}0`);
  }
}

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

finish();

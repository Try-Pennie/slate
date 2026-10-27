// The customer's time zone from their Salesforce Lead's zip, then its state (#4205).
// Run: node --experimental-strip-types scripts/test-zip-zones.ts
//
// The Lead has no zone field. The zip decides, through the table generated from
// GeoNames (`scripts/generate-zip-zones.ts`); the state stands in only where every zip
// in it keeps one clock; anything else is refused. Never Eastern by default: the
// booker's `FALLBACK_ZONE` is exactly what a coordinator must not book a Phoenix or
// Honolulu customer in.
//
// Two halves: the encoding round trip on a synthetic table (so a decoder that reads
// nothing cannot pass), and real cases pinned against the generated table, which is
// what a regeneration must still say.
import { compactTable, type ZipZoneSource } from "./lib/zip-zone-compact.ts";
import { decodeZipZone, normaliseZip, zoneForZip, zoneForState, leadZone } from "../src/lib/zip-zones/zip-zones.ts";
import { ZIP_ZONE_NAMES } from "../src/lib/zip-zones/zip-zone-data.ts";
import { CURATED_ZONES } from "../src/lib/booking/timezones.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the encoding, round tripped -------------------------------------------------
{
  const rows: ZipZoneSource[] = [
    { zip: "10001", state: "NY", zone: "America/New_York" },
    { zip: "10002", state: "NY", zone: "America/New_York" },
    { zip: "79901", state: "TX", zone: "America/Denver" },
    { zip: "79902", state: "TX", zone: "America/Chicago" },
    { zip: "75201", state: "TX", zone: "America/Chicago" },
  ];
  const t = compactTable(rows);
  const dec = (zip: string) => decodeZipZone(t.zones, t.prefixes, t.mixed, zip);
  eq(dec("10001"), "America/New_York", "a zip under a one zone prefix is that zone");
  eq(dec("10099"), "America/New_York", "and so is an unlisted zip under the same prefix");
  eq(dec("79901"), "America/Denver", "a zip under a split prefix is its own zone");
  eq(dec("79902"), "America/Chicago", "and its neighbour keeps its own");
  eq(dec("79903"), null, "an unlisted zip under a split prefix is refused, never given the majority");
  eq(dec("00501"), null, "a prefix with no known zip is refused");
  eq(t.states, { NY: "America/New_York" }, "only a state whose every zip keeps one zone stands in for a zip");
  let threw = false;
  try {
    compactTable([...rows, { zip: "10001", state: "NY", zone: "America/Chicago" }]);
  } catch {
    threw = true;
  }
  assert(threw, "a zip listed with two zones is refused at generation, not resolved by order");
}

// --- the zip as Salesforce holds it ------------------------------------------------
eq(normaliseZip("07030"), "07030", "a five digit zip is itself");
eq(normaliseZip(" 07030-1234 "), "07030", "a ZIP+4 is its first five digits");
eq(normaliseZip("070301234"), "07030", "so is a nine digit zip written without the dash");
eq(normaliseZip("7030"), "07030", "a New Jersey zip that lost its leading zero to a spreadsheet gets it back");
for (const bad of [null, undefined, "", "   ", "ABCDE", "123", "K1A 0B1", "1234567"]) {
  eq(normaliseZip(bad), null, `an unreadable zip is no zip: ${JSON.stringify(bad)}`);
}

// --- real cases, pinned against the generated table -----------------------------------
const PINNED: [string, string, string][] = [
  ["85001", "America/Phoenix", "Phoenix, which keeps no daylight saving"],
  ["86515", "America/Denver", "Window Rock, the Navajo Nation, which does"],
  ["79901", "America/Denver", "El Paso, Mountain in a Central state"],
  ["75201", "America/Chicago", "Dallas"],
  ["32501", "America/Chicago", "Pensacola, the Central panhandle"],
  ["32301", "America/New_York", "Tallahassee, east of the Apalachicola"],
  ["33101", "America/New_York", "Miami"],
  ["07030", "America/New_York", "Hoboken, a leading zero zip"],
  ["10001", "America/New_York", "New York"],
  ["46204", "America/New_York", "Indianapolis"],
  ["46312", "America/Chicago", "East Chicago, Indiana's Central corner"],
  ["47708", "America/Chicago", "Evansville"],
  ["49938", "America/Chicago", "Ironwood, Michigan's Central Upper Peninsula"],
  ["48201", "America/New_York", "Detroit"],
  ["37902", "America/New_York", "Knoxville"],
  ["37201", "America/Chicago", "Nashville"],
  ["40202", "America/New_York", "Louisville"],
  ["42101", "America/Chicago", "Bowling Green, Kentucky"],
  ["58601", "America/Denver", "Dickinson, North Dakota"],
  ["58501", "America/Chicago", "Bismarck"],
  ["57701", "America/Denver", "Rapid City"],
  ["57104", "America/Chicago", "Sioux Falls"],
  ["69361", "America/Denver", "Scottsbluff"],
  ["68102", "America/Chicago", "Omaha"],
  ["67735", "America/Denver", "Goodland, Kansas"],
  ["83702", "America/Denver", "Boise, which keeps Denver's clock"],
  ["83814", "America/Los_Angeles", "Coeur d'Alene, Idaho's Pacific panhandle"],
  ["97914", "America/Denver", "Ontario, Oregon, on Mountain time"],
  ["97201", "America/Los_Angeles", "Portland"],
  ["99501", "America/Anchorage", "Anchorage"],
  ["99801", "America/Anchorage", "Juneau, which keeps Anchorage's clock"],
  ["96813", "Pacific/Honolulu", "Honolulu"],
  ["90012", "America/Los_Angeles", "Los Angeles"],
];
for (const [zip, zone, where] of PINNED) eq(zoneForZip(zip), zone, `${zip} (${where}) is ${zone}`);
eq(zoneForZip("99546"), "America/Adak", "Adak keeps Hawaii-Aleutian time, no listed clock, and is kept as itself");

// Every zone the table can answer is a clock the booker lists, or Adak, which has none.
for (const zone of ZIP_ZONE_NAMES) {
  assert(zone === "America/Adak" || CURATED_ZONES.some((z) => z.id === zone), `the table answers only listed clocks: ${zone}`);
}

// --- the state, only where it is one zone -------------------------------------------
eq(zoneForState("NY"), "America/New_York", "New York is one zone");
eq(zoneForState(" ga "), "America/New_York", "a state code is read trimmed and in either case");
eq(zoneForState("HI"), "Pacific/Honolulu", "Hawaii is one zone");
for (const split of ["TX", "FL", "IN", "KY", "TN", "MI", "ND", "SD", "NE", "KS", "ID", "OR", "AZ", "AK"]) {
  eq(zoneForState(split), null, `${split} is split, so its state alone is no answer`);
}
eq(zoneForState("Texas"), null, "a state written out is not a code");
eq(zoneForState(null), null, "and no state is no answer");

// --- the derivation the coordinator page reads --------------------------------------
eq(leadZone({ postalCode: "85001", state: "AZ" }), { ok: true, zone: "America/Phoenix", from: "zip" }, "the zip decides first");
eq(leadZone({ postalCode: "79901", state: "TX" }), { ok: true, zone: "America/Denver", from: "zip" }, "a split state is decided by its zip");
eq(leadZone({ postalCode: "07030", state: "CA" }), { ok: true, zone: "America/New_York", from: "zip" }, "the zip outranks a state that disagrees with it");
eq(leadZone({ postalCode: null, state: "NY" }), { ok: true, zone: "America/New_York", from: "state" }, "no zip: a one zone state stands in");
eq(leadZone({ postalCode: "ABCDE", state: "GA" }), { ok: true, zone: "America/New_York", from: "state" }, "so does a malformed zip");
eq(leadZone({ postalCode: null, state: "TX" }), { ok: false }, "no zip in a split state is refused");
eq(leadZone({ postalCode: "garbage", state: "AZ" }), { ok: false }, "Arizona with no usable zip is refused, never guessed as Phoenix");
eq(leadZone({ postalCode: "00000", state: null }), { ok: false }, "a zip nobody knows and no state is refused");
eq(leadZone({ postalCode: null, state: null }), { ok: false }, "nothing at all is refused, never Eastern");

finish();

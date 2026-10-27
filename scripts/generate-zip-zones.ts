// Generate src/lib/zip-zones/zip-zone-data.ts: each US zip code's IANA time zone (#4205).
//
// A Salesforce Lead carries no time zone, but its `PostalCode` and `State` are filled
// (20 of 20 sampled leads, 2026-10-26), so the coordinator page derives the customer's
// zone from the zip. This builds that table offline from two GeoNames datasets, both
// Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/) and
// refreshed daily by GeoNames (https://www.geonames.org):
//
//   - the US postal codes, each zip with its state and centroid;
//   - the US gazetteer, about 2.2 million named places, each carrying its time zone.
//
// Each zip takes the zone most of its nearest gazetteer places IN THE SAME STATE carry,
// so a zip is judged by what surrounds it rather than by its state, which is what
// splits Texas, Florida, Indiana, Kentucky, Tennessee, Michigan, the Dakotas, Nebraska,
// Kansas, Idaho and Oregon, and keeps the Navajo Nation's daylight saving apart from the
// rest of Arizona. Only the 29 United States zones in the tz database count as an answer,
// and each is stored as the listed zone that keeps its clock (`listedZoneFor`, the one
// mapping the booker and the hours form use), so `America/Boise` is stored as Denver and
// `America/Indiana/Knox` as Chicago. GeoNames tags a few Carolina places with Kentucky's
// Monticello zone, which keeps New York's clock; storing clocks makes that harmless.
// Adak keeps no listed clock and is stored as itself.
//
// To regenerate (about a minute; the downloads are untrusted data, so each goes in its
// own empty folder and is only read):
//
//   mkdir -p /tmp/geonames/postal /tmp/geonames/places
//   curl -sSo /tmp/geonames/postal.zip https://download.geonames.org/export/zip/US.zip
//   curl -sSo /tmp/geonames/places.zip https://download.geonames.org/export/dump/US.zip
//   unzip -o -q /tmp/geonames/postal.zip -d /tmp/geonames/postal
//   unzip -o -q /tmp/geonames/places.zip -d /tmp/geonames/places
//   node --experimental-strip-types scripts/generate-zip-zones.ts /tmp/geonames/postal/US.txt /tmp/geonames/places/US.txt
//
// then run `scripts/test-zip-zones.ts`, whose pinned cases are the check that the new
// table still says what the old one did where it matters.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compactZipZones, type ZipZoneSource } from "./lib/zip-zone-compact.ts";
import { listedZoneFor } from "../src/lib/booking/timezones.ts";

/** The United States zones in the tz database (`zone1970.tab`, country US). */
export const US_ZONES = new Set([
  "America/New_York",
  "America/Detroit",
  "America/Kentucky/Louisville",
  "America/Kentucky/Monticello",
  "America/Indiana/Indianapolis",
  "America/Indiana/Vincennes",
  "America/Indiana/Winamac",
  "America/Indiana/Marengo",
  "America/Indiana/Petersburg",
  "America/Indiana/Vevay",
  "America/Chicago",
  "America/Indiana/Tell_City",
  "America/Indiana/Knox",
  "America/Menominee",
  "America/North_Dakota/Center",
  "America/North_Dakota/New_Salem",
  "America/North_Dakota/Beulah",
  "America/Denver",
  "America/Boise",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Juneau",
  "America/Sitka",
  "America/Metlakatla",
  "America/Yakutat",
  "America/Nome",
  "America/Adak",
  "Pacific/Honolulu",
]);

/** The military post office "states", which have no zone of their own. */
const MILITARY = new Set(["AA", "AE", "AP"]);

/** The instant the clocks are compared from, so a run is not judged against a moving day. */
const CLOCK_AT = Date.now();

/** How many nearest places vote on a zip's zone. */
const VOTERS = 7;
/** Grid cell size in degrees, for the nearest place search. */
const CELL = 0.1;

interface Place {
  lat: number;
  lng: number;
  zone: string;
}

function main(postalPath: string, placesPath: string): void {
  // GeoNames gazetteer columns: 4 lat, 5 lng, 6 feature class, 10 admin1 (state), 17 zone.
  const placesByState = new Map<string, Map<string, Place[]>>();
  for (const line of readFileSync(placesPath, "utf8").split("\n")) {
    const c = line.split("\t");
    if (c.length < 18) continue;
    const zone = c[17];
    if (!US_ZONES.has(zone) || c[6] === "U") continue; // undersea features carry stray zones
    const lat = Number(c[4]);
    const lng = Number(c[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const state = c[10];
    const grid = placesByState.get(state) ?? new Map<string, Place[]>();
    placesByState.set(state, grid);
    const key = `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;
    const cell = grid.get(key) ?? [];
    cell.push({ lat, lng, zone });
    grid.set(key, cell);
  }

  // GeoNames postal columns: 1 zip, 4 state code, 9 lat, 10 lng.
  const zips: ZipZoneSource[] = [];
  let unplaced = 0;
  for (const line of readFileSync(postalPath, "utf8").split("\n")) {
    const c = line.split("\t");
    if (c.length < 11 || !/^\d{5}$/.test(c[1])) continue;
    const state = c[4];
    // The military post offices (AA, AE, AP, or no state at all) are not a place a
    // customer's clock can be read from.
    if (!/^[A-Z]{2}$/.test(state) || MILITARY.has(state)) {
      unplaced++;
      continue;
    }
    const grid = placesByState.get(state);
    const lat = Number(c[9]);
    const lng = Number(c[10]);
    if (!grid || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      unplaced++;
      continue;
    }
    const zone = vote(grid, lat, lng);
    if (zone === null) {
      unplaced++;
      continue;
    }
    zips.push({ zip: c[1], state, zone: listedZoneFor(zone, CLOCK_AT) ?? zone });
  }

  const out = compactZipZones(zips);
  const target = join(import.meta.dirname, "..", "src", "lib", "zip-zones", "zip-zone-data.ts");
  writeFileSync(target, out.source);
  console.log(
    `wrote ${target}: ${zips.length} zips, ${out.mixedPrefixes} mixed prefixes, ${out.singleZoneStates} single zone states, ` +
      `${unplaced} zips left out (military post offices, or no places to vote), ${out.source.length} bytes`,
  );
}

/** The zone most of the nearest places carry; ties go to the nearest. */
function vote(grid: Map<string, Place[]>, lat: number, lng: number): string | null {
  const row = Math.floor(lat / CELL);
  const col = Math.floor(lng / CELL);
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dist = (p: Place) => (p.lat - lat) ** 2 + ((p.lng - lng) * cosLat) ** 2;
  let found: { d: number; zone: string }[] = [];
  for (let ring = 0; ring <= 30; ring++) {
    for (let r = row - ring; r <= row + ring; r++) {
      for (let k = col - ring; k <= col + ring; k++) {
        if (Math.max(Math.abs(r - row), Math.abs(k - col)) !== ring) continue;
        for (const p of grid.get(`${r}:${k}`) ?? []) found.push({ d: dist(p), zone: p.zone });
      }
    }
    // Every place outside the rings searched is at least `ring` cells away, so once
    // VOTERS places sit inside that distance the nearest VOTERS are all found.
    found.sort((a, b) => a.d - b.d);
    found = found.slice(0, VOTERS * 4);
    const reach = (ring * CELL * cosLat) ** 2;
    if (found.length >= VOTERS && found[VOTERS - 1].d <= reach) break;
  }
  const voters = found.slice(0, VOTERS);
  if (voters.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of voters) counts.set(v.zone, (counts.get(v.zone) ?? 0) + 1);
  let best = voters[0].zone;
  for (const [zone, n] of counts) if (n > (counts.get(best) ?? 0)) best = zone;
  return best;
}

const [postal, places] = process.argv.slice(2);
if (!postal || !places) {
  console.error("usage: generate-zip-zones.ts <postal US.txt> <gazetteer US.txt>");
  process.exit(2);
}
main(postal, places);

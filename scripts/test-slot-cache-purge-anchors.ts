// Every edge cache entry a booker can create is the one the purge deletes (#3366).
//
// The booker asks for `from` = the lead's local midnight. The edge cache key used to
// anchor on the UTC day of that `from`, while every purge (`invalidateBucketSlots`,
// and the one `recomputeBucketSlotsForToday` makes) deleted only the key for the
// UTC day of NOW. From about 8 PM Eastern a US lead's local midnight falls on
// YESTERDAY'S UTC date, so their entry sat under a key no booking, splice or
// recompute ever deleted: it lived out its TTL however many times the times under
// it were taken. On 2026-10-06 04:10Z bucket 112 was read under exactly that key.
//
// This drives the REAL read path's key choice (`resolveBucketSlots`, through the
// deps the cache binding uses) for every `from` a booker can produce, and the REAL
// purge against a fake `caches.default`, and requires the purge to delete the very
// key each reader wrote. A fixed key would also pass, so the positive control below
// proves a key that differs is caught.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-slot-cache-purge-anchors.ts
import { resolveBucketSlots, type ReadDeps } from "../src/lib/availability/precompute-core.ts";
import { HORIZON_DAYS, invalidateBucketSlots } from "../src/lib/availability/slot-cache.ts";
import type { BucketSlots } from "../src/lib/availability/service.ts";
import { assert, finish } from "./lib/harness.ts";

const CODE = "112";

const row: BucketSlots = {
  bucket: { code: CODE, name: "Call" } as BucketSlots["bucket"],
  eventType: { duration_min: 20, min_notice_min: 0 } as BucketSlots["eventType"],
  orgName: "Pennie",
  slots: ["2026-10-06T17:00:00.000Z"],
};
const OPEN_ALL_WEEK = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
  exceptions: [],
};

/** The key the read path writes its entry under for this `from`. */
async function keyWrittenFor(fromIso: string): Promise<string> {
  let written: string | null = null;
  const deps: ReadDeps = {
    cacheGet: async () => null,
    cachePut: async (key) => { written = key; },
    readRow: async () => ({ payload: row, computed_at: "2026-10-06T04:00:00.000Z" }),
    compute: async () => null,
    writeRow: async () => "2026-10-06T04:00:00.000Z",
    writeFailed: () => {},
    businessHours: async () => OPEN_ALL_WEEK,
  };
  await resolveBucketSlots(CODE, fromIso, HORIZON_DAYS, deps);
  if (written === null) throw new Error(`the read path cached nothing for from=${fromIso}`);
  return written;
}

/** The keys the real purge deletes, read off a fake colo cache. */
async function keysPurged(): Promise<string[]> {
  const deleted: string[] = [];
  const fake = {
    match: async () => undefined,
    put: async () => {},
    delete: async (req: Request) => {
      const path = new URL(req.url).pathname;
      deleted.push(decodeURIComponent(path.slice(path.indexOf("/__slot-cache/") + "/__slot-cache/".length)));
      return true;
    },
  };
  const g = globalThis as unknown as { caches?: unknown };
  const before = g.caches;
  g.caches = { default: fake };
  try {
    await invalidateBucketSlots(CODE);
  } finally {
    g.caches = before;
  }
  return deleted;
}

const purged = await keysPurged();
assert(purged.length === 1, `the purge deletes one key (deleted ${purged.length})`);

// The `from` values a booker can send while the purge runs at any moment: each US
// zone's local midnight (which is yesterday's UTC date in the evening), the incident's
// own URL, zones east of UTC, a page left open since yesterday, and the default (now).
const now = new Date();
const dayMs = 86_400_000;
const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const froms = [
  now.toISOString(),
  new Date(utcMidnight).toISOString(),
  new Date(utcMidnight - dayMs + 4 * 3_600_000).toISOString(), // Eastern midnight, yesterday's UTC date
  new Date(utcMidnight - dayMs + 7 * 3_600_000).toISOString(), // Pacific midnight
  new Date(utcMidnight - dayMs + 10 * 3_600_000).toISOString(), // Hawaii midnight
  new Date(utcMidnight - 9 * 3_600_000).toISOString(), // Tokyo midnight
  new Date(utcMidnight - 2 * dayMs + 4 * 3_600_000).toISOString(), // a page left open overnight
  "2026-10-05T07:00:00.000Z", // the incident's own request
];
for (const from of froms) {
  const key = await keyWrittenFor(from);
  assert(purged.includes(key), `an entry written for from=${from} is the one the purge deletes (${key} vs ${purged.join(",")})`);
}

// Positive control: the comparison can see a key the purge does not delete.
{
  const otherBucket = await (async () => {
    let written = "";
    await resolveBucketSlots("113", froms[0], HORIZON_DAYS, {
      cacheGet: async () => null,
      cachePut: async (key) => { written = key; },
      readRow: async () => ({ payload: { ...row, bucket: { ...row.bucket, code: "113" } }, computed_at: "2026-10-06T04:00:00.000Z" }),
      compute: async () => null,
      writeRow: async () => "2026-10-06T04:00:00.000Z",
      writeFailed: () => {},
      businessHours: async () => OPEN_ALL_WEEK,
    });
    return written;
  })();
  assert(otherBucket !== "" && !purged.includes(otherBucket), "control: another bucket's entry is NOT deleted by this bucket's purge");
}

finish();

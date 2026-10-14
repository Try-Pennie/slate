/**
 * #1245: per-lane cost attribution for the shared cron invocation, and the
 * tripwire that the Worker actually records it.
 *
 * The four every-minute lanes share one invocation's budget. That budget tripled
 * in four days on a flat workload and the only symptom was a page from the
 * recompute lane, which is the lane that NOTICED, not necessarily the lane that
 * spent it. An unwired measurement is the exact shape of defect this repo keeps
 * hitting: a tested function nothing calls, sitting green while the cost stays
 * unattributable, so the source-text checks below matter as much as the unit ones.
 *
 * Run: node --experimental-strip-types scripts/test-lane-timing.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { laneTimingFields, laneFieldName } from "../src/lib/monitor/lane-timing.ts";
import { CRON_ROUTES } from "../worker/cron-routes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// ------------------------------------------------------------ field names

eq(laneFieldName("/api/cron/recompute"), "recompute", "the lane's own name");
eq(
  laneFieldName("/api/cron/bulk-reassign"),
  "bulk_reassign",
  "a hyphen becomes an underscore so the field is queryable",
);
eq(laneFieldName(""), "unknown", "an empty path still yields a usable field name");

// Within ONE cron expression the lanes share an invocation and therefore share a
// log line, so their field names must be distinct or one lane's timing silently
// overwrites another's and a lane disappears from the record. Across DIFFERENT
// expressions a repeat is harmless (the same route driven by two schedules never
// appears in one line), which is why this is scoped per expression rather than
// globally.
{
  for (const [cron, routes] of Object.entries(CRON_ROUTES)) {
    const paths = Array.isArray(routes) ? routes : [routes];
    const names = paths.map(laneFieldName);
    eq(
      new Set(names).size,
      names.length,
      `every lane on "${cron}" has a distinct field name, so none is overwritten`,
    );
  }
  const every = Object.values(CRON_ROUTES)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .map(laneFieldName);
  assert(
    every.every((n) => /^[a-z0-9_]+$/.test(n)),
    "and every field name is queryable (lowercase, digits, underscores only)",
  );
}

// ------------------------------------------------------------ the fields

{
  const fields = laneTimingFields(
    [
      { path: "/api/cron/sync", ms: 1200.4, ok: true },
      { path: "/api/cron/recompute", ms: 5100.6, ok: true },
      { path: "/api/cron/outbox", ms: 300, ok: true },
      { path: "/api/cron/selfheal", ms: 250, ok: true },
    ],
    5400.2,
  );
  eq(fields.total_ms, 5400, "the invocation's own wall time, rounded");
  eq(fields.sync_ms, 1200, "one flat field per lane, so a single lane can be charted");
  eq(fields.recompute_ms, 5101, "rounded to the nearest millisecond");
  eq(fields.slowest, "recompute", "and the slowest lane is named for a glance");
  assert(!("failed" in fields), "nothing about failure when every lane succeeded");
  eq(fields.lanes_ok, 4, "every lane counted as succeeded (#3138)");
  eq(fields.lanes_failed, 0, "and a zero failure count is present, not missing, so it sums");
}

{
  // A lane that fails usually returns FAST, so its low figure would read as
  // cheap. Naming it stops the next person reading a crash as an improvement.
  const fields = laneTimingFields(
    [
      { path: "/api/cron/sync", ms: 12, ok: false },
      { path: "/api/cron/recompute", ms: 4000, ok: true },
    ],
    4010,
  );
  eq(fields.failed, "sync", "a failed lane is named, so its small figure is not read as cheap");
  eq(fields.sync_ms, 12, "and its measurement is still recorded");
}

{
  const fields = laneTimingFields(
    [
      { path: "/api/cron/sync", ms: 5, ok: false },
      { path: "/api/cron/outbox", ms: 7, ok: false },
    ],
    12,
  );
  eq(fields.failed, "sync,outbox", "several failures are all named");
  eq(fields.lanes_failed, 2, "and counted, so the count charts in Better Stack (#3138)");
  eq(fields.lanes_ok, 0, "beside the count that succeeded");
}

{
  // The lanes run concurrently, so the sum normally EXCEEDS the invocation's wall
  // time. That is expected, and this pins that nothing tries to reconcile them:
  // a helper that "corrected" the total would be inventing a number.
  const fields = laneTimingFields(
    [
      { path: "/api/cron/sync", ms: 900, ok: true },
      { path: "/api/cron/recompute", ms: 950, ok: true },
    ],
    1000,
  );
  const sum = (fields.sync_ms as number) + (fields.recompute_ms as number);
  assert(sum > (fields.total_ms as number), "overlapping lanes may sum past the total");
  eq(fields.total_ms, 1000, "and the total stays as measured");
}

{
  // #3693: which path each lane ran on, so the effect of placing them is measurable.
  const fields = laneTimingFields(
    [
      { path: "/api/cron/sync", ms: 40, ok: true, via: "placed", placement: "remote-SEA" },
      { path: "/api/cron/recompute", ms: 90, ok: true, via: "placed", placement: null },
      { path: "/api/cron/outbox", ms: 20, ok: true, via: "in_process", fallback: "standby_canary" },
      { path: "/api/cron/selfheal", ms: 10, ok: true },
    ],
    95,
  );
  eq(fields.sync_via, "placed", "a placed lane says so");
  eq(fields.sync_placement, "remote-SEA", "with the cf-placement value");
  eq(fields.recompute_placement, "none", "a placed lane with no header says none, never nothing");
  eq(fields.outbox_via, "in_process", "a lane that fell back says in process");
  eq(fields.outbox_fallback, "standby_canary", "and why");
  assert(!("outbox_placement" in fields), "and carries no placement, since nothing placed it");
  assert(!("selfheal_via" in fields), "a run with no recorded path claims none");
  eq(fields.lanes_placed, 2, "and the placed lanes are counted, so the share charts");
  eq(fields.lanes_near_db, 1, "and only the one that ran beside the database counts as near it");
}

{
  // #3693: what #3720 shipped read `lanes_placed=4` while every lane ran `local-BOM`,
  // so the count said placed and the header said not moved. Sent over the binding and
  // moved by Cloudflare are two different facts, and the line carries both.
  const fields = laneTimingFields(
    [
      { path: "/api/cron/sync", ms: 40, ok: true, via: "placed", placement: "local-BOM" },
      { path: "/api/cron/recompute", ms: 90, ok: true, via: "placed", placement: "local-BOM" },
      { path: "/api/cron/outbox", ms: 20, ok: true, via: "placed", placement: "unreadable" },
    ],
    95,
  );
  eq(fields.lanes_placed, 3, "every lane went over the binding");
  eq(fields.lanes_near_db, 0, "and none of them ran near the database, which the line now says");
}

{
  // #3693 lessons review: under the region hint, a lane whose tick already ran beside
  // the database can answer `local-SEA`. That lane IS where it should be, so the count
  // reads the airport code, never only the remote prefix.
  const fields = laneTimingFields(
    [
      { path: "/api/cron/sync", ms: 40, ok: true, via: "placed", placement: "local-SEA" },
      { path: "/api/cron/recompute", ms: 90, ok: true, via: "placed", placement: "remote-PDX" },
      { path: "/api/cron/outbox", ms: 20, ok: true, via: "placed", placement: "local-BOM" },
      { path: "/api/cron/selfheal", ms: 10, ok: true, via: "placed", placement: "remote-ARN" },
    ],
    95,
  );
  eq(fields.lanes_near_db, 2, "local-SEA and remote-PDX are near the database; local-BOM and remote-ARN are not");
}

{
  const fields = laneTimingFields([{ path: "/api/cron/sync", ms: 5, ok: true }], 5);
  eq(fields.lanes_placed, 0, "the placed count is present at zero, so it sums");
  eq(fields.lanes_near_db, 0, "and so is the near the database count");
}

{
  const fields = laneTimingFields([], 3);
  eq(fields.total_ms, 3, "an invocation with no lanes still reports its own time");
  assert(!("slowest" in fields), "and names no slowest lane");
}

// --------------------------------------------------- the wiring tripwire
//
// worker/index.ts cannot be imported by a test: it imports .open-next/worker.js,
// which only exists after a build, and is excluded from the app tsconfig. So this
// asserts against the source text, the same approach test-cron-routes.ts and
// test-https-redirect-wiring.ts take for their wiring.

const entry = readFileSync(join(import.meta.dirname, "..", "worker/index.ts"), "utf8");

assert(
  /import\s*\{[^}]*\blaneTimingFields\b[^}]*\}\s*from\s*["']@\/lib\/monitor\/lane-timing["']/.test(
    entry,
  ),
  "worker/index.ts imports laneTimingFields from the module that owns the shape",
);
assert(
  /laneTimingFields\s*\(/.test(entry),
  "and calls it, so the measurement is not a tested function nothing runs",
);
assert(
  /log\.info\(\s*["']cron["']/.test(entry),
  "and logs it under the cron tag, where the lane lines are already queried",
);
// The measurement has to bracket each lane's own request, not the whole
// invocation: a single timer around Promise.allSettled attributes nothing.
assert(
  /performance\.now\(\)/.test(entry),
  "and times with performance.now(), which is what the runtime offers",
);

finish();

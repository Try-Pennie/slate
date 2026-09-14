// Export the live roster's SHAPE for the load test seed (#2243). READ ONLY.
//
// Run:
//   pnpm loadtest:export-shape > shape.json
//   ROSTER_SHAPE_FILE=shape.json node --experimental-strip-types scripts/loadtest/seed.ts
//
// WHY IT EXISTS. The seed's attribute distribution was measured by hand on
// 2026-06-22 and was wrong by 2026-09-11 in the way that mattered most: it gave
// the Beyond backend 60 percent of the roster where production gives it two agents
// out of ninety. Two agents is what makes every `x2x` bucket resolve to a pool of
// exactly ONE, and that one agent pool is the entire positive control for the
// burst. A hand maintained distribution goes stale silently and nothing reports it
// (L41), so this reads the real thing.
//
// It prints to stdout and writes nothing anywhere: no Slate row, no file, no
// alert. The POOL DEPTHS it records are deliberately not an input to the seed. The
// seed derives depth from the profiles it generates, and the exported depths are
// what that output is CHECKED against, so a generator that drifts is caught by
// comparing two independently produced numbers rather than by trusting the
// generator to have applied its own input (L58).
import { loadEnvFiles } from "../smoke-env.ts";
import { shapeFromRoster } from "./roster-shape.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
// Dynamic like its neighbours: this module reaches `@/lib/availability/pool`, and
// every `@/` import in this file has to come AFTER `loadEnvFiles` above.
const { poolDepthsFrom } = await import("./pool-depth.ts");
type Attributes = import("@/lib/db/types").Attributes;
type Criteria = import("@/lib/db/types").Criteria;

const db = supabaseAdmin();

// cap-safe: users is roster bounded, ~142 rows against a 200-agent design target
const users = (unwrap(
  await db
    .from("users")
    .select("id, attributes")
    .eq("bookable", true)
    .is("deactivated_at", null)
    .eq("is_test", false),
  "roster shape agents",
) ?? []) as { id: string; attributes: Attributes | null }[];

// cap-safe: buckets is roster bounded, 60 codes
const buckets = (unwrap(
  await db.from("buckets").select("id, code, criteria").eq("is_test", false),
  "roster shape buckets",
) ?? []) as { id: string; code: string; criteria: Criteria | null }[];

// cap-safe: bucket_members is roster bounded, a handful of hand named people
const members = (unwrap(
  await db.from("bucket_members").select("bucket_id, user_id").eq("active", true),
  "roster shape members",
) ?? []) as { bucket_id: string; user_id: string }[];

// cap-safe: availability_schedules is roster bounded, one row per agent
const schedules = (unwrap(
  await db.from("availability_schedules").select("user_id, timezone"),
  "roster shape schedules",
) ?? []) as { user_id: string; timezone: string | null }[];

// Depth through the booker's OWN predicate over each bucket's own members, so the
// exported number is the one the booker would produce rather than a second
// implementation of the same question. Shared with the burst's choice of code
// (#2278): two copies of "how deep is this pool" drift silently, and the two would
// then disagree about one roster while each read as correct (L41).
const poolDepths = poolDepthsFrom({ agents: users, buckets, members });

const zoneOf = new Map(schedules.map((s) => [s.user_id, s.timezone]));
// The SHAPE, and every refusal it can make, is decided in `roster-shape.ts` and
// pinned offline. This file is the reads.
const built = shapeFromRoster({
  agents: users.map((u) => ({
    id: u.id,
    attributes: (u.attributes ?? {}) as Record<string, unknown>,
    timezone: zoneOf.get(u.id) ?? null,
  })),
  poolDepths,
  measuredAt: new Date().toISOString().slice(0, 10),
});
if (!built.ok) {
  console.error(`FAILED: ${built.why}`);
  process.exit(2);
}
const shape = built.shape;
const smallestDepth = Math.min(...poolDepths.map((p) => p.depth));

console.log(JSON.stringify(shape, null, 2));
console.error(
  `exported ${shape.agents} agents, ${shape.profiles.length} profiles, ${shape.zones.length} zones, ` +
    `thinnest pool ${smallestDepth}`,
);

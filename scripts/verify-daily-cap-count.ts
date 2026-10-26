// #832 positive control (NOT a CI test; it needs a live DB, so it is named
// verify-* so scripts/run-tests.ts does not glob it). It proves the
// `count_bookings_per_local_day` RPC's server-side local-day bucketing matches the
// app's own Luxon bucketing on REAL data, including any DST-transition day in the
// window and multi-schedule agents. Re-run it before merging any change to that SQL
// function; a manual eyeball rots (the repo's false-confidence failure mode).
//
// Requires the same env as the app (SUPABASE URL + secret key via src/lib/env).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/verify-daily-cap-count.ts
import { DateTime } from "luxon";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { capCountWindow } from "@/lib/availability/compute";

const db = supabaseAdmin();
const FALLBACK_TZ = "America/New_York";

// A window wide enough to span a DST boundary is ideal; default to the next ~14 days.
// Override with VERIFY_FROM / VERIFY_TO (ISO) to target a window that has real
// bookings (a positive control must exercise a known-present case, not an empty one).
const from = process.env.VERIFY_FROM ?? DateTime.utc().startOf("day").toISO();
const to = process.env.VERIFY_TO ?? DateTime.utc().plus({ days: 14 }).endOf("day").toISO();
if (!from || !to) throw new Error("could not build the verify window");
const cap = capCountWindow(from, to);

// Every agent's tz, the SAME last-wins pick the app makes (fallback ET).
const { data: schedRows, error: schedErr } = await db
  .from("availability_schedules")
  .select("user_id, timezone");
if (schedErr) throw new Error(`schedules read failed: ${schedErr.message}`);
const tzByUser: Record<string, string> = {};
for (const s of (schedRows ?? []) as { user_id: string; timezone: string }[]) {
  tzByUser[s.user_id] = s.timezone;
}

const { data: userRows, error: userErr } = await db.from("users").select("id");
if (userErr) throw new Error(`users read failed: ${userErr.message}`);
const userIds = ((userRows ?? []) as { id: string }[]).map((u) => u.id);
if (userIds.length === 0) throw new Error("no users to verify against (positive control needs data)");

// The RPC under test.
const { data: rpcJson, error: rpcErr } = await db.rpc("count_bookings_per_local_day", {
  p_user_ids: userIds,
  p_tz_by_user: tzByUser,
  p_from: cap.from,
  p_to: cap.to,
});
if (rpcErr) throw new Error(`RPC failed: ${rpcErr.message}`);
const rpcCounts = new Map<string, number>(Object.entries((rpcJson ?? {}) as Record<string, number>));

// The independent oracle: read the raw rows (paged) and bucket them with Luxon exactly
// as the app used to, keyed identically to the RPC ("<user_id>|<local_date>").
const rows = await selectAllPages<{ assigned_user_id: string; starts_at: string }>(
  "bookings",
  "id",
  () =>
    db
      .from("bookings")
      .select("id, assigned_user_id, starts_at")
      .in("assigned_user_id", userIds)
      .in("status", ["confirmed", "rescheduled"])
      .gte("starts_at", cap.from)
      .lte("starts_at", cap.to),
);
const luxonCounts = new Map<string, number>();
for (const r of rows) {
  const tz = tzByUser[r.assigned_user_id] ?? FALLBACK_TZ;
  const localDate = DateTime.fromISO(r.starts_at, { zone: "utc" }).setZone(tz).toISODate();
  if (!localDate) continue;
  const key = `${r.assigned_user_id}|${localDate}`;
  luxonCounts.set(key, (luxonCounts.get(key) ?? 0) + 1);
}

// Diff both directions.
const keys = new Set<string>([...rpcCounts.keys(), ...luxonCounts.keys()]);
const mismatches: string[] = [];
for (const k of keys) {
  const a = rpcCounts.get(k) ?? 0;
  const b = luxonCounts.get(k) ?? 0;
  if (a !== b) mismatches.push(`${k}: rpc=${a} luxon=${b}`);
}

console.log(
  `verify-daily-cap-count: ${rows.length} bookings, ${keys.size} (agent,day) cells, ` +
    `${mismatches.length} mismatches`,
);
if (mismatches.length > 0) {
  for (const m of mismatches.slice(0, 40)) console.error(`  MISMATCH ${m}`);
  console.error("\nFAILED: RPC bucketing diverges from Luxon. Do NOT ship the SQL change.");
  process.exit(1);
}
console.log("\nOK: RPC counts match the Luxon oracle exactly.");

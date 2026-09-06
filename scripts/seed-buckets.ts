// Seeds/updates the full XBC bucket matrix (#66): one bucket per valid code,
// criteria decoded by src/lib/xbc.ts (cal.com routing-form parity).
// Idempotent: upserts on (org_id, code), so re-running after a rule change
// refreshes names/criteria without touching ids (existing bookings keep
// their bucket references). Fallback agents are NOT set here - that's agent
// onboarding (#63), and since #1935 neither are the event type or the
// assignment mode: those are per bucket choices the editor offers, so the
// seeder sets them once at creation and never overwrites them.
// Run: node --experimental-strip-types scripts/seed-buckets.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allXbcCodes, bucketSpecForXbc } from "../src/lib/xbc.ts";

const env = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "../.env.local"), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const BASE = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1`;
const H = {
  apikey: env.SUPABASE_SECRET_KEY!,
  Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
  "content-type": "application/json",
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, { headers: H });
  const body = (await res.json()) as T;
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const [org] = await get<{ id: string; name: string }[]>(
  "organizations?select=id,name&limit=1",
);
// ORDERED, so a re-run picks the same one twice (#1935). It was `limit=1` with
// no order at all, which is whatever the database happened to return first.
const [eventType] = await get<{ id: string; name: string }[]>(
  "event_types?select=id,name&order=created_at.asc,id.asc&limit=1",
);
if (!org || !eventType) throw new Error("org or event type missing");
console.log(`org: ${org.name} | event type for NEW buckets: ${eventType.name}`);

// Which codes already exist decides which of the two row shapes below they get.
const existing = new Set(
  (await get<{ code: string }[]>(`buckets?select=code&org_id=eq.${org.id}`)).map((b) => b.code),
);

/**
 * THE SEEDER OWNS THE FIRST SHAPE AND NOT THE SECOND (#1935).
 *
 * It used to write one row per bucket, every field, on every run. Two of those
 * fields are offered as a per bucket choice in the editor, so editing them
 * looked like it worked and the next seed run replaced them: `event_type_id`
 * with an arbitrary first row, and `assignment` with "round_robin". That is the
 * same defect as #1874, where three routing attributes were hand editable and
 * Salesforce reverted them within the hour. An override that is silently undone
 * is worse than none.
 *
 * Dan's call on 2026-09-06: the event type is a genuine per bucket choice, so
 * the seeder sets it only when it CREATES a bucket and never touches it again.
 * `assignment` goes with it, for the same reason and by the same argument.
 *
 * What stays refreshable is what the seeder is FOR: a name or a criteria rule
 * changing in `src/lib/xbc.ts` and needing to reach all sixty buckets. Those two
 * are the seeder's, and `scripts/test-seeder-owned-fields.ts` derives that
 * boundary from these two literals rather than from a list kept beside them, so
 * the editor cannot start offering a field the seeder reverts.
 */
const specs = allXbcCodes().map((code) => bucketSpecForXbc(code)!);

const created = specs
  .filter((spec) => !existing.has(spec.code))
  .map((spec) => ({
    org_id: org.id,
    code: spec.code,
    name: spec.name,
    criteria: spec.criteria,
    event_type_id: eventType.id,
    assignment: "round_robin",
  }));

const refreshed = specs
  .filter((spec) => existing.has(spec.code))
  .map((spec) => ({
    org_id: org.id,
    code: spec.code,
    name: spec.name,
    criteria: spec.criteria,
  }));

async function upsert(rows: Record<string, unknown>[], what: string) {
  if (!rows.length) {
    console.log(`${what}: none`);
    return;
  }
  const res = await fetch(`${BASE}/buckets?on_conflict=org_id,code`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
  const body = (await res.json()) as { code: string }[];
  if (!res.ok) throw new Error(`${what} -> ${res.status} ${JSON.stringify(body)}`);
  console.log(`${what}: ${body.length}`);
}

// Created first: a code that appears in both lists would be a bug, and this
// order makes it loud rather than letting the refresh quietly win.
await upsert(created, "buckets created");
await upsert(refreshed, "buckets refreshed (name and criteria only)");

const all = await get<{ code: string; name: string }[]>(
  `buckets?select=code,name&org_id=eq.${org.id}&order=code`,
);
console.log(`total buckets now: ${all.length}`);
console.log("411 is:", JSON.stringify(all.find((b) => b.code === "411")));

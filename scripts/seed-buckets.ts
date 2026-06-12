// Seeds/updates the full XBC bucket matrix (#66): one bucket per valid code,
// criteria decoded by src/lib/xbc.ts (cal.com routing-form parity).
// Idempotent: upserts on (org_id, code), so re-running after a rule change
// refreshes names/criteria without touching ids (existing bookings keep
// their bucket references). Fallback agents are NOT set here - that's agent
// onboarding (#63).
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
const [eventType] = await get<{ id: string; name: string }[]>(
  "event_types?select=id,name&limit=1",
);
if (!org || !eventType) throw new Error("org or event type missing");
console.log(`org: ${org.name} | event type: ${eventType.name}`);

const rows = allXbcCodes().map((code) => {
  const spec = bucketSpecForXbc(code)!;
  return {
    org_id: org.id,
    code: spec.code,
    name: spec.name,
    event_type_id: eventType.id,
    assignment: "round_robin",
    criteria: spec.criteria,
  };
});

const res = await fetch(`${BASE}/buckets?on_conflict=org_id,code`, {
  method: "POST",
  headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
  body: JSON.stringify(rows),
});
const body = (await res.json()) as { code: string }[];
if (!res.ok) throw new Error(`upsert -> ${res.status} ${JSON.stringify(body)}`);
console.log(`upserted ${body.length} buckets`);

const all = await get<{ code: string; name: string }[]>(
  `buckets?select=code,name&org_id=eq.${org.id}&order=code`,
);
console.log(`total buckets now: ${all.length}`);
console.log("411 is:", JSON.stringify(all.find((b) => b.code === "411")));

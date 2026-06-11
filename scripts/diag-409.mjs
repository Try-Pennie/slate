// One-off diagnostic for issue #35: why does verify-on-book 409 in dev?
// Mirrors the booking path: bucket 411 eligible agents -> delegated freeBusy
// per agent for a slot the cache reports as free.
import { readFileSync } from "node:fs";
import { google } from "googleapis";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const sec = env.SUPABASE_SECRET_KEY;
const H = { apikey: sec, Authorization: `Bearer ${sec}` };
const get = async (path) => {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: H });
  const body = await r.json();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
};

const slotStart = process.argv[2] ?? "2026-06-15T20:00:00.000Z";

const [bucket] = await get(`buckets?select=*&code=eq.411`);
console.log("bucket:", bucket.name, "criteria:", JSON.stringify(bucket.criteria), "fallback:", bucket.fallback_user_id);

const [et] = await get(`event_types?select=id,name,duration_min&id=eq.${bucket.event_type_id}`);
const slotEnd = new Date(Date.parse(slotStart) + et.duration_min * 60_000).toISOString();
console.log(`slot: ${slotStart} -> ${slotEnd} (${et.duration_min}m, ${et.name})`);

const manual = await get(`bucket_members?select=user_id&bucket_id=eq.${bucket.id}&active=is.true`);
const agents = await get(`users?select=id,email,name,bookable,attributes&org_id=eq.${bucket.org_id}&bookable=is.true`);
console.log("manual members:", manual.length, "| bookable org agents:", agents.length);
for (const a of agents) console.log(`  ${a.email} attrs=${JSON.stringify(a.attributes)}`);

const jwtFor = (subject) =>
  new google.auth.JWT({
    email: env.GOOGLE_SA_CLIENT_EMAIL,
    key: env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n").replace(/^"|"$/g, ""),
    scopes: [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.freebusy",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
    subject,
  });

for (const a of agents) {
  const cals = await get(`agent_calendars?select=calendar_id&user_id=eq.${a.id}`);
  const calendarIds = cals.length ? cals.map((c) => c.calendar_id) : ["primary"];
  console.log(`\n--- ${a.email} (calendars: ${calendarIds.length})`);

  const cached = await get(
    `busy_blocks?select=starts_at,ends_at,source&user_id=eq.${a.id}&starts_at=lt.${slotEnd}&ends_at=gt.${slotStart}`,
  );
  console.log("  busy_blocks overlapping slot:", JSON.stringify(cached));

  try {
    const cal = google.calendar({ version: "v3", auth: jwtFor(a.email) });
    const fb = await cal.freebusy.query({
      requestBody: {
        timeMin: slotStart,
        timeMax: slotEnd,
        items: calendarIds.map((id) => ({ id })),
      },
    });
    console.log("  live freeBusy:", JSON.stringify(fb.data.calendars));
  } catch (e) {
    console.log("  live freeBusy FAILED:", e.code ?? e.response?.status, e.message);
  }
}

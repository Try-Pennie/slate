// Live cal.com parity probe (#1731). Run:
//   pnpm verify:availability-parity                     # sweep every active bucket
//   PARITY_BUCKET=411 pnpm verify:availability-parity   # one bucket
//
// WHAT IT IS FOR. During the parallel run (docs/parallel-run-plan.md) Slate
// computes availability nobody can book while cal.com keeps taking every lead.
// This is what turns that silence into a measurement: for one bucket, ask cal.com
// what it offers for EXACTLY that bucket's agents, ask Slate what it offers for
// the same bucket, and compare the open hours.
//
// WHAT IT DOES NOT PROVE. Not correctness: cal.com is the incumbent, not the
// source of truth, and a time both systems offer can be busy in both. That
// question belongs to `pnpm verify:availability-truth`, which asks Google. This
// one catches CONFIGURATION drift, which is invisible from inside Slate: working
// hours that were never set to the real 8am to 8pm (#1255), a bucket whose
// membership does not match cal.com's routing, business hours that close a day
// cal.com keeps open, an agent whose calendar never connected.
//
// THE COMPARISON IS AT THE HOUR LEVEL, deliberately, and the reasoning lives in
// `scripts/lib/availability-parity.ts`: the two systems carry different slot
// intervals, durations and buffers, so demanding equal instants would be red from
// the day it shipped for reasons nobody should fix (L36).
//
// THE PIN IS THE DANGEROUS PART. cal.com narrows the pool with
// `routedTeamMemberIds[]`, and when an id is not a host on the event type it
// IGNORES the pin and answers 200 with the WHOLE pool. Against one bucket that
// reads as Slate under-offering: a false finding pointing at agents who are fine.
// So every pinned read is accompanied by a bogus-id read whose answer is known to
// be the pool, and an identical pair refuses the run rather than reporting it.
//
// It WRITES NOTHING: no calendar, no database, no alert. It is deliberately not
// named `test-*.ts`, because that glob is the offline unit suite and this needs
// live cal.com plus the Supabase secret key. Its decision logic is pinned offline
// by `scripts/test-availability-parity.ts`.
//
// Env:
//   CALCOM_API_KEY        required, resolves agent email -> cal.com user id
//   CALCOM_ORG_ID         default 19474 (trypennie)
//   CALCOM_EVENT_TYPE_ID  default 1314152 (the review event the landing pages use)
//   SLATE_BASE_URL        default https://slate.trypennie.app
//   BOOKING_API_KEY       only needed to read a hidden test bucket (#396)
//   PARITY_BUCKET         one bucket code instead of the sweep
//   PARITY_DAYS           how far ahead to compare (default 7)
//   PARITY_ZONE           the zone hours are bucketed in (default America/New_York)
import { loadEnvFiles, envOr } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { resolveBucketAgentIds } = await import("@/lib/availability/service");
const { unwrap } = await import("@/lib/db/result");
const { compareCoverage, parseCalcomSlots, parseSlateSlots, detectPinIgnored } = await import(
  "./lib/availability-parity.ts"
);
type ParityVerdict = import("./lib/availability-parity.ts").ParityVerdict;

/**
 * Every way this can end, each with its own code, so a shell caller can branch on
 * which one it met and nobody has to read prose to find out whether anything was
 * actually compared. Finding nothing to check is never a pass (L98).
 */
const EXIT = {
  agree: 0,
  notConfigured: 1,
  noBuckets: 2,
  slateUnreachable: 3,
  calcomUnreachable: 4,
  calcomUnreadable: 5,
  noCalcomIdentity: 6,
  pinIgnored: 7,
  neitherOffers: 8,
  calcomOffersNothing: 9,
  slateOffersNothing: 10,
  slateUnderOffers: 11,
  slateOverOffers: 12,
} as const;

const calcomKey = process.env.CALCOM_API_KEY ?? "";
const orgId = envOr(process.env.CALCOM_ORG_ID, "19474");
const eventTypeId = envOr(process.env.CALCOM_EVENT_TYPE_ID, "1314152");
const baseUrl = envOr(process.env.SLATE_BASE_URL, "https://slate.trypennie.app").replace(/\/$/, "");
const bookingKey = process.env.BOOKING_API_KEY ?? "";
const onlyBucket = process.env.PARITY_BUCKET ?? "";
const days = Number(envOr(process.env.PARITY_DAYS, "7"));
const zone = envOr(process.env.PARITY_ZONE, "America/New_York");

// A bogus routed member id. cal.com answers a pin it cannot honour with the whole
// pool, so this read IS the pool, and it is the only way to tell a genuinely
// narrow answer from an ignored pin.
const BOGUS_MEMBER_ID = "999999999";

function stop(code: number, why: string): never {
  console.error(`\nFAILED (${code}): ${why}`);
  process.exit(code);
}

if (!calcomKey) {
  stop(
    EXIT.notConfigured,
    "no CALCOM_API_KEY here, so agent emails cannot be resolved to cal.com user ids and " +
      "nothing was attempted. It is a wrangler secret on the deployment; add it to .env.local to run this.",
  );
}
if (!Number.isFinite(days) || days <= 0) {
  stop(EXIT.notConfigured, `PARITY_DAYS is not a positive number: ${process.env.PARITY_DAYS}`);
}

const nowMs = Date.now();
const startIso = new Date(nowMs).toISOString();
const endIso = new Date(nowMs + days * 24 * 60 * 60_000).toISOString();

async function calcomFetch(path: string): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`https://api.cal.com/v2${path}`, {
    headers: {
      Authorization: `Bearer ${calcomKey}`,
      "cal-api-version": "2024-09-04",
      "Content-Type": "application/json",
    },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: unknown };
  return { status: res.status, data: body.data };
}

/** Agent email -> cal.com user id. Absent is not an error: a new hire can exist in
 *  Slate and never have had a cal.com account, and that is worth reporting as its
 *  own thing rather than as a failed lookup. */
async function calcomUserId(email: string): Promise<number | null> {
  const { status, data } = await calcomFetch(
    `/organizations/${orgId}/users?emails[]=${encodeURIComponent(email)}`,
  );
  if (status < 200 || status >= 300 || !Array.isArray(data)) return null;
  const user = (data as { id?: number }[])[0];
  return user?.id ?? null;
}

async function calcomSlots(memberIds: string[]): Promise<string[]> {
  const pins = memberIds.map((id) => `&routedTeamMemberIds[]=${encodeURIComponent(id)}`).join("");
  const { status, data } = await calcomFetch(
    `/slots?eventTypeId=${encodeURIComponent(eventTypeId)}` +
      `&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}${pins}`,
  );
  if (status < 200 || status >= 300) {
    stop(EXIT.calcomUnreachable, `cal.com slots returned ${status} for event type ${eventTypeId}`);
  }
  const parsed = parseCalcomSlots(data);
  if (!parsed.ok) stop(EXIT.calcomUnreadable, `cal.com answered with something unreadable: ${parsed.why}`);
  return parsed.slots;
}

async function slateSlots(code: string): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (bookingKey) headers.Authorization = `Bearer ${bookingKey}`;
  const url =
    `${baseUrl}/api/availability?bucket=${encodeURIComponent(code)}` +
    `&from=${encodeURIComponent(startIso)}&to=${encodeURIComponent(endIso)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    stop(EXIT.slateUnreachable, `Slate did not answer at ${baseUrl}: ${String(err)}`);
  }
  if (!res.ok) {
    stop(EXIT.slateUnreachable, `Slate returned ${res.status} for bucket ${code}`);
  }
  const body = await res.json().catch(() => null);
  const parsed = parseSlateSlots(body);
  if (!parsed.ok) {
    stop(EXIT.slateUnreachable, `Slate's answer for bucket ${code} could not be read: ${parsed.why}`);
  }
  return parsed.slots;
}

// --- which buckets to compare -------------------------------------------------
const db = supabaseAdmin();
const bucketRes = await db
  .from("buckets")
  .select("id, code, org_id, criteria, fallback_user_id, is_test")
  .eq("active", true);
const allBuckets = (unwrap(bucketRes, "buckets") ?? []) as {
  id: string;
  code: string;
  is_test: boolean | null;
}[];
const buckets = onlyBucket
  ? allBuckets.filter((b) => b.code === onlyBucket)
  : allBuckets.filter((b) => !b.is_test);

if (buckets.length === 0) {
  stop(
    EXIT.noBuckets,
    onlyBucket
      ? `no active bucket with code ${onlyBucket}`
      : "no active non-test buckets to compare",
  );
}

console.log(
  `cal.com parity over ${buckets.length} bucket(s), next ${days} days, hours bucketed in ${zone}`,
);
console.log(`Slate: ${baseUrl}   cal.com event type: ${eventTypeId}\n`);

interface Outcome {
  code: string;
  verdict: ParityVerdict | "no-members" | "no-calcom-identity";
  detail: string;
}
const outcomes: Outcome[] = [];

for (const bucket of buckets) {
  const agentIds = await resolveBucketAgentIds(bucket as never);
  if (agentIds.length === 0) {
    // Expected while the roster is dark (#1272): every real agent is bookable=false
    // so every real bucket resolves to an empty pool. Reported per bucket rather
    // than aborting, so one dark bucket does not hide a live one.
    outcomes.push({ code: bucket.code, verdict: "no-members", detail: "no bookable agents in the pool" });
    console.log(`${bucket.code}: no bookable agents, nothing to compare`);
    continue;
  }
  const emailRes = await db.from("users").select("email").in("id", agentIds);
  const emails = ((unwrap(emailRes, "agent emails") ?? []) as { email: string }[])
    .map((u) => u.email)
    .filter(Boolean);

  const ids: string[] = [];
  const unknown: string[] = [];
  for (const email of emails) {
    const id = await calcomUserId(email);
    if (id === null) unknown.push(email);
    else ids.push(String(id));
  }
  if (ids.length === 0) {
    outcomes.push({
      code: bucket.code,
      verdict: "no-calcom-identity",
      detail: `none of ${emails.length} agent(s) exist in cal.com`,
    });
    console.log(`${bucket.code}: no cal.com identity for any member, cannot pin`);
    continue;
  }

  const pinned = await calcomSlots(ids);
  const pool = await calcomSlots([BOGUS_MEMBER_ID]);
  if (detectPinIgnored(pinned, pool)) {
    stop(
      EXIT.pinIgnored,
      `cal.com ignored the member pin for bucket ${bucket.code} and answered with the whole pool. ` +
        "Every comparison built on that read would blame the bucket for the pool's extra hours. " +
        `Check that these are hosts on event type ${eventTypeId}: ${ids.join(", ")}`,
    );
  }

  const slate = await slateSlots(bucket.code);
  const result = compareCoverage({ calcomSlots: pinned, slateSlots: slate, zone });
  const gap = (label: string, gaps: { day: string; hours: number[] }[]) =>
    gaps.length === 0 ? "" : `\n    ${label}: ` + gaps.map((g) => `${g.day} h${g.hours.join(",")}`).join("; ");
  console.log(
    `${bucket.code}: ${result.verdict} ` +
      `(${ids.length} agent(s) pinned${unknown.length ? `, ${unknown.length} not in cal.com` : ""}, ` +
      `${result.daysCompared} day(s) both answered for)` +
      gap("Slate does not offer", result.missingInSlate) +
      gap("cal.com does not offer", result.missingInCalcom),
  );
  outcomes.push({ code: bucket.code, verdict: result.verdict, detail: "" });
}

// --- the run's own verdict ----------------------------------------------------
// Ranked worst first. A sweep is only as good as its worst bucket, and a single
// under-offering bucket is the finding even when fifty others agree.
const ranked: [Outcome["verdict"], number][] = [
  ["slate-offers-nothing", EXIT.slateOffersNothing],
  ["slate-under-offers", EXIT.slateUnderOffers],
  ["slate-over-offers", EXIT.slateOverOffers],
  ["calcom-offers-nothing", EXIT.calcomOffersNothing],
  ["neither-offers", EXIT.neitherOffers],
  ["no-calcom-identity", EXIT.noCalcomIdentity],
];
const counts = new Map<Outcome["verdict"], number>();
for (const o of outcomes) counts.set(o.verdict, (counts.get(o.verdict) ?? 0) + 1);
console.log(
  "\n" + [...counts].map(([v, n]) => `${v}: ${n}`).join("   "),
);

const compared = outcomes.filter((o) => o.verdict !== "no-members" && o.verdict !== "no-calcom-identity");
if (compared.length === 0) {
  stop(
    EXIT.noBuckets,
    "not one bucket could be compared: every one had no bookable agents or no cal.com identity. " +
      "That is the expected state while the roster is dark (#1272), and it is not a pass.",
  );
}
for (const [verdict, code] of ranked) {
  const hit = outcomes.filter((o) => o.verdict === verdict);
  if (hit.length > 0) {
    stop(code, `${hit.length} bucket(s) reported ${verdict}: ${hit.map((h) => h.code).join(", ")}`);
  }
}
console.log(`\nPASSED: ${compared.length} bucket(s) compared, every one agreeing on open hours`);
process.exit(EXIT.agree);

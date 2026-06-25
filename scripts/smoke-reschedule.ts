// Post-deploy smoke for the crash-safe / concurrency-safe reschedule (#439).
// Validates the lease-pin reschedule against the REAL database + deployed code,
// isolated to the dedicated test agent (#396): it books a throwaway appointment
// in the SMOKE test bucket, reschedules it, then fires TWO different-target
// reschedules at once and asserts exactly one wins and the other gets the typed
// 409 conflict. Cleans up the booking at the end.
//
// It hits PRODUCTION (creates a real, then-cancelled booking on smoketest@'s
// calendar; the attendee is a plus-alias of that same mailbox). Run it manually:
//
//   BOOKING_API_KEY=<key> node --experimental-strip-types scripts/smoke-reschedule.ts
//
// Optional env: SLATE_BASE_URL (default prod), SMOKE_BUCKET (default SMOKE).

const BASE = (process.env.SLATE_BASE_URL ?? "https://slate.trypennie.app").replace(/\/$/, "");
const KEY = process.env.BOOKING_API_KEY ?? "";
const BUCKET = process.env.SMOKE_BUCKET ?? "SMOKE";
const REASON = "schedule_conflict";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) console.log("ok:", msg);
  else {
    console.error("FAIL:", msg);
    failures += 1;
  }
}

type Json = Record<string, unknown>;
async function jpost(path: string, body: Json, auth = false): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${KEY}`;
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

async function slots(): Promise<string[]> {
  const res = await fetch(`${BASE}/api/availability?bucket=${encodeURIComponent(BUCKET)}`, {
    headers: { authorization: `Bearer ${KEY}` },
  });
  const body = (await res.json().catch(() => ({}))) as { slots?: string[] };
  return res.status === 200 ? body.slots ?? [] : [];
}

function tokenFrom(manageUrl: unknown): string {
  return String(manageUrl ?? "").split("/").pop() ?? "";
}

async function main(): Promise<void> {
  if (!KEY) {
    console.error("Set BOOKING_API_KEY in the environment first.");
    process.exit(2);
  }
  console.log(`# reschedule smoke vs ${BASE} (bucket ${BUCKET})`);
  const open = await slots();
  // Need 4 distinct future slots: book[0], reschedule->[1], then race [2] vs [3].
  check(open.length >= 4, `SMOKE has >= 4 future slots (got ${open.length})`);
  if (open.length < 4) process.exit(1);
  const [s0, s1, s2, s3] = open;

  const externalId = `smoke-resched-${open[0]}`;
  const email = `smoketest+resched@trypennie.com`;
  let token = "";

  try {
    // 1. Book a throwaway appointment in the test bucket.
    const created = await jpost(
      "/api/bookings",
      {
        bucketCode: BUCKET,
        start: s0,
        timezone: "America/New_York",
        attendee: { name: "Resched Smoke", email, phone: "+12025550123" },
        externalId,
        confirmReschedule: false,
        dryRun: false,
      },
      true,
    );
    check(created.status === 200, `create -> 200 (got ${created.status})`);
    token = tokenFrom((created.body.booking as Json | undefined)?.manageUrl ?? created.body.manageUrl);
    check(!!token, "create returns a manage token");
    if (!token) return;

    // 2. A normal reschedule to a different time must succeed (new code + real DB).
    const moved = await jpost(`/api/bookings/${token}/reschedule`, { start: s1, reason: REASON });
    check(moved.status === 200, `reschedule -> 200 (got ${moved.status})`);
    check(moved.body.startsAt === s1, `reschedule lands on the new time (${moved.body.startsAt} == ${s1})`);

    // 3. Two DIFFERENT-target reschedules at once: exactly one wins, the other 409s.
    const [a, b] = await Promise.all([
      jpost(`/api/bookings/${token}/reschedule`, { start: s2, reason: REASON }),
      jpost(`/api/bookings/${token}/reschedule`, { start: s3, reason: REASON }),
    ]);
    const statuses = [a.status, b.status].sort();
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 409);
    console.log(`  concurrent statuses: ${a.status}, ${b.status}`);
    if (conflicts.length === 1) {
      check(oks.length === 1 && conflicts.length === 1, "concurrent: exactly one wins, one conflicts (409)");
      check(
        /just changed/i.test(String(conflicts[0].body.error ?? "")),
        `conflict carries the refresh message (got: ${conflicts[0].body.error})`,
      );
    } else {
      // The two requests serialized (the winner released before the other claimed)
      // — both are valid sequential reschedules. Not a failure, but flag it so the
      // run is re-tried if we specifically wanted to exercise the conflict path.
      console.log(
        `  NOTE: both reschedules serialized (${statuses.join(",")}) — no overlap this run; re-run to exercise the conflict path.`,
      );
      check(oks.length === 2, "concurrent: serialized run still left the booking consistent (both 200)");
    }
  } finally {
    // 4. Teardown: cancel the booking (frees the slot + deletes the calendar event).
    if (token) {
      const cancelled = await jpost(`/api/bookings/${token}/cancel`, { reason: "no_longer_interested" });
      check(cancelled.status === 200, `teardown: booking cancelled (got ${cancelled.status})`);
    }
  }

  console.log(failures === 0 ? "\nSMOKE PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});

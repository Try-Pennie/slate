// Manual smoke test for the live direct booking API (#253/#250). NOT a CI test
// (it hits production and creates a REAL, then-cancelled booking) — run it by
// hand to validate the endpoint end to end after setting BOOKING_API_KEY.
//
//   BOOKING_API_KEY=xxx node --experimental-strip-types scripts/smoke-booking-api.ts
//
// Optional env: SLATE_BASE_URL (default https://slate.trypennie.app),
//               SMOKE_BUCKET (default 411).
//
// It runs the full contract: find a slot -> book (created) -> rebook same slot
// (deduped) -> rebook a different time (rescheduled) -> cancel to clean up.
// Each run uses a unique external id + email so it never collides with another.

const BASE = (process.env.SLATE_BASE_URL ?? "https://slate.trypennie.app").replace(/\/$/, "");
const BUCKET = process.env.SMOKE_BUCKET ?? "411";
const KEY = process.env.BOOKING_API_KEY ?? "";

const runId = `smoke-${Date.now()}`;
const attendee = {
  name: "Smoke Test",
  email: `smoke+${Date.now()}@trypennie.com`,
  phone: "+12155550100",
};

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) failures++;
}

async function book(start: string) {
  const res = await fetch(`${BASE}/api/bookings/direct`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      bucketCode: BUCKET,
      start,
      timezone: "America/New_York",
      attendee,
      externalId: runId,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    outcome?: string;
    booking?: { id?: string; manageUrl?: string };
    error?: string;
    code?: string;
  };
  return { status: res.status, body };
}

function tokenFromManageUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/booking\/manage\/([^/?#]+)/);
  return m ? m[1] : null;
}

async function main() {
  if (!KEY) {
    console.error("Set BOOKING_API_KEY in the environment first.");
    process.exit(2);
  }
  console.log(`Smoke test against ${BASE} (bucket ${BUCKET}) as ${runId}\n`);

  // 1) Find two distinct open slots.
  const availRes = await fetch(`${BASE}/api/availability?bucket=${encodeURIComponent(BUCKET)}`);
  const avail = (await availRes.json().catch(() => ({}))) as { slots?: string[] };
  const slots = avail.slots ?? [];
  check(availRes.status === 200, `availability returned 200 (got ${availRes.status})`);
  check(slots.length >= 2, `bucket ${BUCKET} has at least 2 open slots (got ${slots.length})`);
  if (slots.length < 2) {
    console.log("\nNot enough slots to test — pick a bucket with availability via SMOKE_BUCKET.");
    process.exit(1);
  }
  const slotA = slots[0];
  const slotB = slots[Math.min(10, slots.length - 1)];

  // 2) Book slotA -> created.
  const created = await book(slotA);
  check(created.status === 200, `book slotA -> 200 (got ${created.status} ${created.body.code ?? created.body.error ?? ""})`);
  check(created.body.outcome === "created", `book slotA -> outcome "created" (got "${created.body.outcome}")`);

  // 3) Re-book the SAME slot, same person -> deduped (no second booking).
  const dup = await book(slotA);
  check(dup.body.outcome === "deduped", `re-book same slot -> outcome "deduped" (got "${dup.body.outcome}")`);
  check(
    dup.body.booking?.id === created.body.booking?.id,
    "deduped returns the SAME booking id",
  );

  // 4) Re-book a DIFFERENT time, same person -> rescheduled (moved, not duplicated).
  const moved = await book(slotB);
  check(moved.body.outcome === "rescheduled", `re-book different time -> outcome "rescheduled" (got "${moved.body.outcome}")`);

  // 5) Clean up: cancel the resulting booking so no real appointment lingers.
  const token = tokenFromManageUrl(moved.body.booking?.manageUrl ?? created.body.booking?.manageUrl);
  if (token) {
    const cancelRes = await fetch(`${BASE}/api/bookings/${token}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "no_longer_interested" }),
    });
    check(cancelRes.status === 200, `cleanup cancel -> 200 (got ${cancelRes.status})`);
  } else {
    check(false, "could not resolve a manage token to clean up — cancel the test booking manually");
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

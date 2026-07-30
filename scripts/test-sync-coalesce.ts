// Sanity test for the sync coalescing helpers (#30).
// Run: node --experimental-strip-types scripts/test-sync-coalesce.ts
import {
  claimWindow,
  eligibleCalendarsForSync,
  orderCalendarsForSync,
  pastDeadline,
  shouldRerun,
  syncEligible,
  CALENDAR_CLAIM_TTL_MS,
  GONE_BACKOFF_STREAK,
  GONE_RETRY_INTERVAL_MIN,
  MAX_SYNC_PASSES,
  SYNC_TICK_BUDGET_MS,
} from "../src/lib/google/sync-coalesce.ts";
import { assert, finish } from "./lib/harness.ts";

// --- claimWindow ---
const now = Date.parse("2026-06-11T12:00:00.000Z");
const w = claimWindow(now, CALENDAR_CLAIM_TTL_MS);
assert(w.claimIso === "2026-06-11T12:00:00.000Z", "claim is the current instant");
assert(
  w.staleBeforeIso === "2026-06-11T11:59:00.000Z",
  "stale cutoff is claim minus the TTL",
);
assert(
  Date.parse(w.staleBeforeIso) < Date.parse(w.claimIso),
  "cutoff always precedes the claim",
);

// A claim taken at the cutoff instant is NOT stale (strict lt in the query).
const fresh = claimWindow(now - CALENDAR_CLAIM_TTL_MS, CALENDAR_CLAIM_TTL_MS);
assert(
  !(fresh.claimIso < w.staleBeforeIso),
  "claim exactly TTL old is not strictly before the cutoff",
);

// --- shouldRerun ---
assert(shouldRerun(true, 1), "rerun when new pushes arrived during the pass");
assert(!shouldRerun(false, 1), "no rerun when nothing arrived");
assert(
  !shouldRerun(true, MAX_SYNC_PASSES),
  "burst bound stops reruns (cron backstop owns the tail)",
);
assert(shouldRerun(true, MAX_SYNC_PASSES - 1), "passes under the bound continue");

// --- per-tick budget (#44) ---
assert(!pastDeadline(1000, null), "no deadline -> never past (login warm-up path)");
assert(!pastDeadline(999, 1000), "before the deadline -> keep going");
assert(pastDeadline(1000, 1000), "at the deadline -> stop starting new calendars");
assert(pastDeadline(2000, 1000), "after the deadline -> stop");
assert(SYNC_TICK_BUDGET_MS < 30_000, "tick budget stays under Worker CPU ceilings");

const ordered = orderCalendarsForSync([
  { id: "boot-1", sync_token: null },
  { id: "inc-1", sync_token: "t1" },
  { id: "boot-2", sync_token: null },
  { id: "inc-2", sync_token: "t2" },
] as { id: string; sync_token: string | null }[]);
assert(
  ordered.map((c: { id: string }) => c.id).join(",") === "inc-1,inc-2,boot-1,boot-2",
  "incrementals first, bootstraps last, stable within groups",
);

// --- gone-calendar backoff (#1049) -----------------------------------------
// A calendar classified `gone` (delegation revoked, the Google account removed)
// is not coming back without a human. The failure streak only ever tuned
// ALERTING, never attempt eligibility, so every such calendar was re-attempted
// on all 1440 rotations a day, each one a wasted Google call that can only fail.
//
// The eligibility rule has to satisfy three things at once, and the third is
// what rules out the obvious designs:
//   1. Far fewer attempts once a calendar is established as gone.
//   2. Still attempt SOMETIMES, so a fixed calendar recovers without a deploy.
//   3. Derive "is it my turn" from data that already exists. There is no
//      last_attempt_at column (only last_success_at, which by definition stops
//      moving once a calendar is failing), and counting attempts cannot work:
//      skipping an attempt records no failure, so a counter-based rule freezes
//      at whatever value made it skip and then either never or always fires.
// Hence a stable hash of the calendar id picked against the wall clock: each
// gone calendar owns one minute in every interval, needs no new column and no
// stored state, and the fleet's retries spread evenly instead of stampeding.
type Cal = {
  id: string;
  sync_token: string | null;
  last_failure_kind: "gone" | "transient" | null;
  consecutive_failures: number;
};
const cal = (over: Partial<Cal> = {}): Cal => ({
  id: "cal-a",
  sync_token: "t",
  last_failure_kind: null,
  consecutive_failures: 0,
  ...over,
});
const minute = (n: number) => n * 60_000;

// A healthy calendar is ALWAYS eligible: the backoff must never touch the
// working fleet, which is the whole availability cache.
for (let m = 0; m < GONE_RETRY_INTERVAL_MIN; m++) {
  assert(
    syncEligible(cal(), minute(m)),
    `a healthy calendar is eligible at minute ${m} of the interval`,
  );
}

// A transient failure keeps retrying every tick: that is how a blip recovers
// inside the minute, and it must not be swept up by this.
assert(
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].every((m) =>
    syncEligible(cal({ last_failure_kind: "transient", consecutive_failures: 99 }), minute(m)),
  ),
  "a transient failure stays eligible on every tick regardless of streak",
);

// A gone calendar under the streak threshold also keeps retrying: one or two
// 'gone' classifications can be a misread, so back off only once established.
assert(
  [0, 1, 2, 3, 4, 5].every((m) =>
    syncEligible(
      cal({ last_failure_kind: "gone", consecutive_failures: GONE_BACKOFF_STREAK - 1 }),
      minute(m),
    ),
  ),
  "a gone calendar under the streak threshold is still attempted every tick",
);

// The actual backoff: established gone, so eligible on EXACTLY ONE minute per
// interval. Both halves matter: "at least once" (it can still recover) and
// "not more than once" (the saving is real).
const goneCal = cal({
  last_failure_kind: "gone",
  consecutive_failures: GONE_BACKOFF_STREAK,
});
const eligibleMinutes = Array.from({ length: GONE_RETRY_INTERVAL_MIN }, (_, m) => m).filter((m) =>
  syncEligible(goneCal, minute(m)),
);
assert(
  eligibleMinutes.length === 1,
  `an established-gone calendar is attempted exactly once per ${GONE_RETRY_INTERVAL_MIN}-minute interval (got ${eligibleMinutes.length})`,
);

// The chosen minute must be STABLE for a given calendar across intervals and
// across days, or the rule degenerates into "sometimes twice, sometimes never".
const slot = eligibleMinutes[0];
assert(
  syncEligible(goneCal, minute(slot) + GONE_RETRY_INTERVAL_MIN * 60_000) &&
    syncEligible(goneCal, minute(slot) + 24 * 60 * 60_000),
  "the eligible minute is stable for a calendar across intervals and days",
);

// Different calendars must land on different minutes, or 200 dead calendars all
// retry in the same tick and rebuild the stampede the backoff exists to remove.
const slots = new Set(
  ["cal-a", "cal-b", "cal-c", "cal-d", "cal-e", "cal-f", "cal-g", "cal-h"].map((id) => {
    const c = cal({
      id,
      last_failure_kind: "gone",
      consecutive_failures: GONE_BACKOFF_STREAK,
    });
    return Array.from({ length: GONE_RETRY_INTERVAL_MIN }, (_, m) => m).find((m) =>
      syncEligible(c, minute(m)),
    );
  }),
);
assert(slots.size > 1, "different gone calendars spread across different minutes");

// The list filter used by the sync lane keeps working calendars and drops only
// the backed-off ones, preserving the incremental-before-bootstrap order.
const filtered = eligibleCalendarsForSync(
  [
    cal({ id: "healthy-inc", sync_token: "t" }),
    cal({
      id: "gone-1",
      last_failure_kind: "gone",
      consecutive_failures: GONE_BACKOFF_STREAK,
    }),
    cal({ id: "healthy-boot", sync_token: null }),
  ],
  // A minute chosen so gone-1 is NOT its turn.
  minute(
    (Array.from({ length: GONE_RETRY_INTERVAL_MIN }, (_, m) => m).find(
      (m) =>
        !syncEligible(
          cal({
            id: "gone-1",
            last_failure_kind: "gone",
            consecutive_failures: GONE_BACKOFF_STREAK,
          }),
          minute(m),
        ),
    ) ?? 0),
  ),
);
assert(
  filtered.map((c) => c.id).join(",") === "healthy-inc,healthy-boot",
  "the lane filter drops a backed-off gone calendar and keeps the rest in sync order",
);

finish();

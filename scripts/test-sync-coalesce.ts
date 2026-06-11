// Sanity test for the sync coalescing helpers (#30).
// Run: node --experimental-strip-types scripts/test-sync-coalesce.ts
import {
  claimWindow,
  orderCalendarsForSync,
  pastDeadline,
  shouldRerun,
  CALENDAR_CLAIM_TTL_MS,
  MAX_SYNC_PASSES,
  SYNC_TICK_BUDGET_MS,
} from "../src/lib/google/sync-coalesce.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

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

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

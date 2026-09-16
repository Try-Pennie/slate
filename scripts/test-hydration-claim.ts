// The pure half of the hydration claim (#2411).
//
// The INTERLEAVING is proved in src/lib/google/hydration-race.test.ts, which runs two real
// writers against one store and reads the busy block back: a test that only asked whether a
// claim had been taken would say nothing about whether the block survived (L63). What lives
// here is the three decisions that do not need a store, so each is driven at its boundaries
// with an injected clock and no wall-clock wait (L290).
//
// Run: node --experimental-strip-types scripts/test-hydration-claim.ts
import {
  claimIsHeld,
  partitionCalendarsForSync,
  CALENDAR_CLAIM_TTL_MS,
  GONE_BACKOFF_STREAK,
  GONE_RETRY_INTERVAL_MIN,
} from "../src/lib/google/sync-coalesce.ts";
import { hydrationMeasuredTick, hydrationTickVerdict } from "../src/lib/google/hydration.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-06-11T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// --- claimIsHeld -----------------------------------------------------------
// The claim is a timestamp with a TTL rather than a lock, which is the whole reason a pass
// that DIED holding it does not hold the calendar for ever (L409). So the boundary is what
// matters: exactly TTL old must be stealable, or a holder that crashed at the TTL boundary
// could never be taken over by a caller reading the same clock.
assert(!claimIsHeld(null, NOW), "an unclaimed calendar is not held");
assert(!claimIsHeld(undefined, NOW), "an absent column reads the same as unclaimed");
assert(claimIsHeld(iso(NOW), NOW), "a claim taken this instant is held");
assert(
  claimIsHeld(iso(NOW - CALENDAR_CLAIM_TTL_MS + 1), NOW),
  "a claim one millisecond inside the TTL is still held",
);
assert(
  !claimIsHeld(iso(NOW - CALENDAR_CLAIM_TTL_MS), NOW),
  "a claim exactly TTL old is abandoned, so a crashed holder is taken over",
);
assert(
  !claimIsHeld(iso(NOW - 60 * 60_000), NOW),
  "an hour-old claim is abandoned",
);
// An unreadable stamp reads as NOT held on purpose. Reading it as held would hold the
// every-minute lane off that calendar for ever, because a value nothing can parse can never
// age out either, and the agent's availability would silently stop updating.
assert(!claimIsHeld("not a timestamp", NOW), "an unreadable claim does not hold the lane off");
// A claim from the FUTURE (a clock skew between two isolates) is held, not abandoned: the
// safe reading of "somebody stamped this ahead of me" is that somebody is working on it.
assert(claimIsHeld(iso(NOW + 5_000), NOW), "a claim stamped slightly ahead is held");

// --- partitionCalendarsForSync --------------------------------------------
type Cal = Parameters<typeof partitionCalendarsForSync<{
  id: string;
  sync_token: string | null;
  last_failure_kind: "gone" | "not-provisioned" | "transient" | null;
  consecutive_failures: number;
  sync_claimed_at: string | null;
}>>[0][number];

const cal = (over: Partial<Cal> & { id: string }): Cal => ({
  sync_token: "tok",
  last_failure_kind: null,
  consecutive_failures: 0,
  sync_claimed_at: null,
  ...over,
});

{
  const out = partitionCalendarsForSync([cal({ id: "a" }), cal({ id: "b" })], NOW);
  eq(out.due.length, 2, "nothing held back when every calendar is free and healthy");
  eq(out.goneSkipped, 0, "no gone skips");
  eq(out.claimSkipped, 0, "no claim skips");
}

{
  const out = partitionCalendarsForSync(
    [cal({ id: "free" }), cal({ id: "held", sync_claimed_at: iso(NOW) })],
    NOW,
  );
  eq(out.due.map((c) => c.id).join(","), "free", "a claimed calendar is not synced this pass");
  eq(out.claimSkipped, 1, "and it is counted as a claim skip");
  eq(out.goneSkipped, 0, "never as a gone skip");
}

{
  const out = partitionCalendarsForSync(
    [cal({ id: "stale", sync_claimed_at: iso(NOW - 10 * 60_000) })],
    NOW,
  );
  eq(out.due.length, 1, "a claim whose holder died no longer holds the lane off");
  eq(out.claimSkipped, 0, "and nothing is reported as skipped");
}

// The two reasons must never answer for each other (L11): one sends somebody to repair a
// delegation and the other is a pass that finishes by itself. A gone calendar on a minute
// that is not its retry slot is picked so the backoff really fires.
{
  const goneMinute = (id: string): number => {
    // Walk minutes until this calendar is NOT in its retry slot, so the backoff applies.
    for (let m = 0; m < GONE_RETRY_INTERVAL_MIN * 4; m++) {
      const at = NOW + m * 60_000;
      const only = partitionCalendarsForSync(
        [cal({ id, last_failure_kind: "gone", consecutive_failures: GONE_BACKOFF_STREAK })],
        at,
      );
      if (only.goneSkipped === 1) return at;
    }
    throw new Error("no minute found where the gone backoff applies");
  };
  const at = goneMinute("gone");
  const out = partitionCalendarsForSync(
    [
      cal({ id: "gone", last_failure_kind: "gone", consecutive_failures: GONE_BACKOFF_STREAK }),
      cal({ id: "held", sync_claimed_at: iso(at) }),
      cal({ id: "free" }),
    ],
    at,
  );
  eq(out.due.map((c) => c.id).join(","), "free", "only the free healthy calendar runs");
  eq(out.goneSkipped, 1, "the revoked calendar is reported as a gone skip");
  eq(out.claimSkipped, 1, "the claimed one is reported separately");
}

// Sync ORDER survives the new filter: cheap incrementals before expensive bootstraps, or a
// long bootstrap consumes the tick's budget ahead of every working calendar's freshness.
{
  const out = partitionCalendarsForSync(
    [cal({ id: "boot", sync_token: null }), cal({ id: "delta" })],
    NOW,
  );
  eq(out.due.map((c) => c.id).join(","), "delta,boot", "incrementals still come first");
}

// --- hydrationMeasuredTick -------------------------------------------------
// A skipped calendar was never attempted against Google, so it is neither a refresh nor a
// failure. Leaving it in the denominator is what makes this necessary: an all-skipped tick
// would read as all-failed, and four of those in a row would page about a lane with nothing
// wrong with it.
{
  const all = hydrationMeasuredTick({ due: 2, refreshed: 0, failed: 0, skipped: 2 });
  eq(all.due, 0, "a tick whose whole batch was held back measured nothing");
  eq(
    hydrationTickVerdict(all),
    "unmeasured",
    "so it neither pages nor all-clears",
  );
}
{
  const mixed = hydrationMeasuredTick({ due: 3, refreshed: 0, failed: 2, skipped: 1 });
  eq(mixed.due, 2, "only the calendars actually attempted are judged");
  eq(hydrationTickVerdict(mixed), "all-failed", "and a real all-failed tick still pages");
}
{
  const healthy = hydrationMeasuredTick({ due: 3, refreshed: 1, failed: 1, skipped: 1 });
  eq(hydrationTickVerdict(healthy), "healthy", "one refresh among skips is still healthy");
}
{
  // Nothing skipped is the ordinary tick, and it must be left exactly as it was: this
  // helper may only ever REMOVE what was not attempted.
  const plain = hydrationMeasuredTick({ due: 2, refreshed: 2, failed: 0, skipped: 0 });
  eq(plain.due, 2, "an ordinary tick is unchanged");
  eq(plain.refreshed, 2, "refreshed is passed through");
  eq(plain.failed, 0, "failed is passed through");
}
{
  // Counts that contradict each other must not become a confident answer. More skips than
  // were due can only arrive from a caller bug, and clamping keeps the verdict at
  // "unmeasured" instead of producing a negative denominator nothing can reason about.
  const nonsense = hydrationMeasuredTick({ due: 1, refreshed: 0, failed: 0, skipped: 5 });
  eq(nonsense.due, 0, "more skips than due clamps to nothing measured");
  eq(hydrationTickVerdict(nonsense), "unmeasured", "and reaches no verdict");
}

finish();

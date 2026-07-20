// #87: the header's urgent "you may get double-booked" banner used to fire
// whenever a bookable user had no LIVE push-watch. But a watch lapses and
// auto-renews on the cron, and even with no live watch the 1-min backstop still
// syncs the agent, so a mere lapse is NOT the urgent case. calendarHeaderStatus
// makes the state a truthful three-way: connected (live watch) / degraded (a
// calendar row exists so the backstop syncs, the push just lapsed) / disconnected
// (no calendar row at all, so we genuinely can't sync them). Only the last, for a
// bookable agent, is urgent. Keeps the red banner trustworthy.
// Run: node --experimental-strip-types scripts/test-header-status.ts
import { calendarHeaderStatus } from "../src/lib/calendar/header-status.ts";
import { eq, finish } from "./lib/harness.ts";

// Not checked (OOO-only agent, or no userId): nothing to say, never urgent.
eq(
  calendarHeaderStatus({ checked: false, bookable: true, hasCalendars: false, hasLiveWatch: false }),
  { menu: "na", urgent: false },
  "unchecked = na, never urgent",
);

// Live push-watch: connected, calm.
eq(
  calendarHeaderStatus({ checked: true, bookable: true, hasCalendars: true, hasLiveWatch: true }),
  { menu: "connected", urgent: false },
  "live watch = connected, not urgent",
);

// THE #87 FIX: a calendar row exists (backstop syncs it) but the push watch has
// lapsed. Degraded, NOT urgent, so no false red banner.
eq(
  calendarHeaderStatus({ checked: true, bookable: true, hasCalendars: true, hasLiveWatch: false }),
  { menu: "degraded", urgent: false },
  "lapsed watch with a calendar row = degraded, NOT urgent",
);

// No calendar row at all for a bookable agent: we can't sync them, so they can
// genuinely drift and double-book. Disconnected + urgent.
eq(
  calendarHeaderStatus({ checked: true, bookable: true, hasCalendars: false, hasLiveWatch: false }),
  { menu: "disconnected", urgent: true },
  "no calendar row + bookable = disconnected, urgent",
);

// Same, but the agent isn't bookable: nobody can book them, so not urgent.
eq(
  calendarHeaderStatus({ checked: true, bookable: false, hasCalendars: false, hasLiveWatch: false }),
  { menu: "disconnected", urgent: false },
  "no calendar row + NOT bookable = disconnected, not urgent",
);

// Degraded is never urgent even for a non-bookable agent.
eq(
  calendarHeaderStatus({ checked: true, bookable: false, hasCalendars: true, hasLiveWatch: false }),
  { menu: "degraded", urgent: false },
  "lapsed watch + not bookable = degraded, not urgent",
);

finish();

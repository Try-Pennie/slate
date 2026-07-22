import {
  listBookingHistory,
  collectUserIds,
  type BookingHistoryDeps,
} from "../src/lib/booking/history.ts";
import { CODED_DEFAULTS } from "../src/lib/booking/reason-options.ts";
import type { BookingEvent } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const base: BookingEvent = {
  id: "e",
  booking_id: "b1",
  action: "rescheduled",
  initiator: "admin",
  reason_code: "schedule_conflict",
  reason_detail: null,
  from_starts_at: null,
  to_starts_at: null,
  from_agent_user_id: null,
  to_agent_user_id: null,
  actor_user_id: null,
  acting_as_user_id: null,
  lead_time_minutes: null,
  reschedule_seq: null,
  created_at: "2026-07-02T14:03:00Z",
};

// --- collectUserIds: unique, non-null, across all four user-id columns ---
const ev1: BookingEvent = { ...base, id: "1", actor_user_id: "u1", acting_as_user_id: "u2" };
const ev2: BookingEvent = {
  ...base,
  id: "2",
  action: "reassigned",
  from_agent_user_id: "u2",
  to_agent_user_id: "u3",
  actor_user_id: "u1",
};
const ids = collectUserIds([ev1, ev2]).sort();
eq(JSON.stringify(ids), JSON.stringify(["u1", "u2", "u3"]), "collectUserIds dedups across columns");
eq(collectUserIds([base]).length, 0, "no user ids -> empty");

// --- listBookingHistory: tenant scoping + assembly via injected data seam ---
function deps(over: Partial<BookingHistoryDeps>): BookingHistoryDeps {
  return {
    bookingOrg: async () => "org1",
    events: async () => [],
    users: async () => [],
    reasonOptions: async () => CODED_DEFAULTS,
    timeZone: "America/New_York",
    ...over,
  };
}

async function main() {
  // Booking in a different org -> null (a manager can't read another org's history).
  const wrongOrg = await listBookingHistory("b1", "org1", deps({ bookingOrg: async () => "org2" }));
  eq(wrongOrg, null, "booking belongs to another org -> null");

  // Booking not found -> null.
  const missing = await listBookingHistory("b1", "org1", deps({ bookingOrg: async () => null }));
  eq(missing, null, "booking not found -> null");

  // Found: returns newest-first views; users() gets exactly the referenced ids.
  let usersCalledWith: string[] | null = null;
  const events = [
    { ...base, id: "old", created_at: "2026-07-01T09:00:00Z", actor_user_id: "u1" },
    {
      ...base,
      id: "new",
      created_at: "2026-07-04T09:00:00Z",
      action: "reassigned" as const,
      reason_code: "coverage",
      from_agent_user_id: "u1",
      to_agent_user_id: "u2",
      actor_user_id: "u1",
    },
  ];
  const views = await listBookingHistory(
    "b1",
    "org1",
    deps({
      events: async () => events,
      users: async (requested) => {
        usersCalledWith = [...requested].sort();
        return [
          { id: "u1", name: "Dan Wright", email: "dan@x.co" },
          { id: "u2", name: "Jo Lee", email: "jo@x.co" },
        ];
      },
    }),
  );
  assert(views != null && views.length === 2, "found booking -> two views");
  eq(views![0].id, "new", "views are newest-first");
  eq(views![1].who, "Dan Wright (admin)", "actor name resolved from roster");
  eq(views![0].agentChange, "Dan Wright → Jo Lee", "reassign agent change resolved");
  eq(
    JSON.stringify(usersCalledWith),
    JSON.stringify(["u1", "u2"]),
    "users() called with the referenced ids",
  );

  // Found but no events -> empty list (not null); users() skipped when no ids.
  let usersCalled = false;
  const empty = await listBookingHistory(
    "b1",
    "org1",
    deps({ events: async () => [], users: async () => ((usersCalled = true), []) }),
  );
  assert(empty != null && empty.length === 0, "found booking, no events -> empty list");
  eq(usersCalled, false, "users() not called when there are no ids to resolve");

  finish();
}

void main();

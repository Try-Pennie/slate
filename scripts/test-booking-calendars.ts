// Verify-on-book calendar-list resolution (#314): a FAILED read of an agent's
// calendars must be distinguishable from a genuine "no calendars yet" so the
// caller can skip the agent (never verify against an unknown calendar set and
// risk a double-book) rather than silently checking only the primary calendar.
import { calendarIdsFromResult } from "../src/lib/booking/core.ts";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else console.log("ok:", msg);
};

// A real query error -> readFailed, no ids. The caller skips the agent + alerts.
{
  const r = calendarIdsFromResult({ data: null, error: { message: "boom" } });
  ok(r.readFailed === true, "a query error is flagged readFailed");
  ok(r.ids.length === 0, "a failed read yields no calendar ids");
}

// Rows present, no error -> the calendar ids, not failed.
{
  const r = calendarIdsFromResult({
    data: [{ calendar_id: "primary" }, { calendar_id: "team@x.com" }],
    error: null,
  });
  ok(r.readFailed === false, "a clean read is not failed");
  ok(
    JSON.stringify(r.ids) === JSON.stringify(["primary", "team@x.com"]),
    "returns the calendar ids in order",
  );
}

// Genuine empty (no rows, no error) -> NOT failed, empty ids. This is the
// pre-first-sync case; the caller falls back to the primary calendar as before.
{
  const r = calendarIdsFromResult({ data: [], error: null });
  ok(r.readFailed === false && r.ids.length === 0, "empty-with-no-error is a clean empty, not a failure");
}
{
  const r = calendarIdsFromResult({ data: null, error: null });
  ok(r.readFailed === false && r.ids.length === 0, "null-data-no-error is a clean empty, not a failure");
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

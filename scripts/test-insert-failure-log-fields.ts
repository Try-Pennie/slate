// #1047: what a FAILED booking insert writes to the log.
//
// There is no booking id on this path, because the row was never written, so the fields
// that make the line joinable are the slot and the agent: they tie it to the confirm
// that produced it and to the busy-block and calendar work around it.
//
// The rule worth testing is the other one. **Contact data does not go in logs**
// (docs/pii.md), and an error path is exactly where somebody reaches for "just log the
// whole row" while debugging a live incident. The fields are a pure function so that
// rule is a check rather than a comment, and the check reads the SERIALIZED output, so a
// field added to bookings later that happens to carry contact data is caught even though
// nobody thought to update a list here.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-insert-failure-log-fields.ts
import { insertFailureLogFields } from "../src/lib/booking/core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

{
  const row = {
    bucket_id: "bk-411",
    assigned_user_id: "u-1",
    starts_at: "2026-09-02T13:00:00.000Z",
    gcal_event_id: "gcal-abc",
    // Everything below is what must NOT appear.
    attendee_name: "Jane Doe",
    attendee_email: "jane@example.com",
    attendee_phone: "+15555550100",
    prefill: { utm_source: "google", email: "jane@example.com" },
    manage_token: "tok-secret",
    idempotency_key: "idem-1",
  };
  const fields = insertFailureLogFields(row);

  eq(fields.bucket_id, "bk-411", "the failed insert logs the bucket");
  eq(fields.user_id, "u-1", "and the agent");
  eq(fields.starts_at, "2026-09-02T13:00:00.000Z", "and the slot");
  eq(fields.gcal_event_id, "gcal-abc", "and the deterministic event id");

  const serialized = JSON.stringify(fields);
  for (const secret of [
    "Jane Doe",
    "jane@example.com",
    "+15555550100",
    "utm_source",
    "tok-secret",
    "idem-1",
  ]) {
    assert(!serialized.includes(secret), `the log carries no ${secret}`);
  }
  eq(Object.keys(fields).length, 4, "and carries only the four identifying fields");
}
{
  // A row missing a field logs NULL rather than undefined: the log formatter DROPS an
  // undefined field, so "we did not know the agent" and "there is no agent field" would
  // read identically to somebody querying the logs.
  const fields = insertFailureLogFields({});
  eq(fields.user_id, null, "an absent agent is null, not a missing field");
  eq(fields.bucket_id, null, "and so is an absent bucket");
  eq(Object.keys(fields).length, 4, "every field is present even when empty");
}

finish();

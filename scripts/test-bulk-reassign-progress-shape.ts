/**
 * The move panel reads a progress payload it did not check (#2135).
 *
 * `const done = progress?.summary.done` guarded a null progress and not a
 * progress whose `summary` is missing, so a 200 carrying an unexpected body threw
 * during render and the page error boundary took out the WHOLE admin page. Seen
 * live on 2026-09-09: `TypeError: Cannot read properties of undefined (reading
 * 'done')`, then a blank `/admin`.
 *
 * `getJson` already refuses a non-ok response, so this is the successful but
 * wrong case: a shape change, a cached older payload against a newer page (L598),
 * or something else answering 200.
 *
 * The control that keeps this honest is the LAST block: the predicate must accept
 * what `buildBulkReassignProgress` actually produces. A predicate calibrated only
 * against fixtures written beside it agrees with its author's assumption about the
 * server rather than with the server (L48, L52).
 */
// Run: node --experimental-strip-types scripts/test-bulk-reassign-progress-shape.ts
import {
  BULK_REASSIGN_ITEM_STATUSES,
  buildBulkReassignProgress,
  isBulkReassignProgress,
  summarizeBulkReassignItems,
} from "../src/lib/booking/bulk-reassign.ts";
import type { BulkReassignItem, BulkReassignJob } from "../src/lib/db/types.ts";
import { assert, finish } from "./lib/harness.ts";

const job = { id: "job1", out_user_id: "out1", range_start: "2026-08-12T00:00:00.000Z", range_end: null };
const counts = Object.fromEntries(BULK_REASSIGN_ITEM_STATUSES.map((s) => [s, 0]));
const good = {
  job,
  summary: { total: 0, counts, done: true },
  actionable: [],
  skipped: [],
};

assert(isBulkReassignProgress(good), "accepts a well formed payload");

// The shapes that are NOT progress. Each one used to reach render.
for (const [name, value] of [
  ["null", null],
  ["undefined", undefined],
  ["a string", "ok"],
  ["a number", 3],
  ["an array", []],
  ["an error body", { error: "Not found" }],
  ["no summary at all, the live crash", { ...good, summary: undefined }],
  ["a summary that is not an object", { ...good, summary: "done" }],
  ["no done flag", { ...good, summary: { total: 0, counts, done: undefined } }],
  ["a done flag that is not a boolean", { ...good, summary: { total: 0, counts, done: "yes" } }],
  ["a total that is not a number", { ...good, summary: { total: "0", counts, done: true } }],
  ["a total that is NaN", { ...good, summary: { total: Number.NaN, counts, done: true } }],
  ["no counts", { ...good, summary: { total: 0, counts: undefined, done: true } }],
  [
    "counts missing one status",
    { ...good, summary: { total: 0, counts: { ...counts, pending: undefined }, done: true } },
  ],
  ["no job", { ...good, job: undefined }],
  ["a job with no id", { ...good, job: { out_user_id: "out1" } }],
  ["actionable that is not an array", { ...good, actionable: {} }],
  ["skipped that is not an array", { ...good, skipped: null }],
  ["a row with no bookingId", { ...good, actionable: [{ status: "failed", detail: null, startsAt: null, attendeeName: null }] }],
  [
    "a row whose status is not one the engine can produce",
    { ...good, actionable: [{ bookingId: "b1", status: "wobbly", detail: null, startsAt: null, attendeeName: null }] },
  ],
  [
    "a row whose startsAt is not a string",
    { ...good, actionable: [{ bookingId: "b1", status: "failed", detail: null, startsAt: 173, attendeeName: null }] },
  ],
] as const) {
  assert(!isBulkReassignProgress(value), `refuses ${name}`);
}

// Every nullable field really is nullable, so a genuine payload with no booking
// context is not mistaken for a broken one: refusing it would put the panel in
// the unreadable state on an ordinary run.
assert(
  isBulkReassignProgress({
    ...good,
    summary: { total: 1, counts: { ...counts, failed: 1 }, done: true },
    actionable: [{ bookingId: "b1", status: "failed", detail: null, startsAt: null, attendeeName: null }],
  }),
  "accepts a row whose detail, time and name are all absent",
);

// A field the panel does not read may be added by the server without the page
// calling the whole reply unreadable, which is the deploy window (L598).
assert(
  isBulkReassignProgress({ ...good, somethingNew: 42, job: { ...job, reason_code: "owner_change" } }),
  "accepts a payload carrying fields this page does not read",
);

// THE CONTROL. Built by the real composer from a real job and real items, so the
// predicate is measured against the server's own output rather than against a
// fixture written next to it.
const realJob = {
  id: "job1",
  org_id: "org1",
  out_user_id: "out1",
  range_start: "2026-08-12T00:00:00.000Z",
  range_end: "2026-08-19T23:59:59.999Z",
  reason_code: "owner_change",
  reason_detail: null,
  status: "done",
  created_by: "u1",
  acting_as_user_id: null,
  ooo_request_id: null,
  offboarding_deactivated_at: null,
  redistribute_marked_at: null,
  created_at: "2026-08-12T00:00:00.000Z",
  updated_at: "2026-08-12T00:00:00.000Z",
} as BulkReassignJob;
const realItems = [
  { id: "i1", job_id: "job1", booking_id: "b1", status: "moved" },
  { id: "i2", job_id: "job1", booking_id: "b2", status: "failed", detail: "Google would not take it." },
  { id: "i3", job_id: "job1", booking_id: "b3", status: "skipped", detail: "Booking was cancelled." },
] as unknown as BulkReassignItem[];
const built = buildBulkReassignProgress(
  realJob,
  realItems,
  new Map([["b2", { startsAt: "2026-08-13T17:00:00.000Z", attendeeName: "Kris" }]]),
);
assert(isBulkReassignProgress(built), "accepts what buildBulkReassignProgress actually produces");
assert(
  isBulkReassignProgress({ ...built, summary: summarizeBulkReassignItems(realItems) }),
  "and what summarizeBulkReassignItems actually produces, which is where the counts come from",
);

// The status list the predicate judges rows by is the one the counter builds its
// keys from, so the two cannot answer differently about which statuses exist.
const summarized = summarizeBulkReassignItems([]);
assert(
  BULK_REASSIGN_ITEM_STATUSES.length === Object.keys(summarized.counts).length &&
    BULK_REASSIGN_ITEM_STATUSES.every((s) => s in summarized.counts),
  "the status list and the summary's own counts hold exactly the same statuses",
);

finish();

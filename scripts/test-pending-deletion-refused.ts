// A queued calendar deletion that Google has refused for good ends on its FIRST
// drain pass (#2577).
//
// Since #2561 `deleteEvent` throws a typed GoogleHttpError, so the drain can tell
// an account that is gone, or was never given Calendar, from a blip. Until #2577 it
// did not look: every failure was retried identically until
// PENDING_DELETION_GIVE_UP_AT, spending the shared Google budget on a call that can
// never succeed, and the page it raised at PENDING_DELETION_ALERT_AFTER read as a
// stuck retry ("failed N+ times, check API health") rather than as an account a
// person has to fix.
//
// The queue fake (scripts/lib/pending-deletion-queue.ts) is STATEFUL and its read
// applies the same give-up filter the real `loadPendingEventDeletions` does
// (`attempts < PENDING_DELETION_GIVE_UP_AT`), so "never retried again" is measured
// by running a second pass against the rows the first pass wrote, rather than by
// trusting the attempt count alone.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pending-deletion-refused.ts
import {
  processPendingEventDeletions,
  PENDING_DELETION_ALERT_AFTER,
  PENDING_DELETION_GIVE_UP_AT,
} from "../src/lib/booking/orchestration.ts";
import { pendingDeletionRefusedAlert } from "../src/lib/booking/alert-copy.ts";
import {
  GONE,
  NOT_PROVISIONED,
  TRANSIENT,
  pendingDeletionQueue as queue,
  pendingRow as row,
} from "./lib/pending-deletion-queue.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- a never provisioned calendar ends on the first pass -------------------------
{
  const q = queue([row("p1", "new-hire@x.com", "evt-1")], () => NOT_PROVISIONED());
  const first = await processPendingEventDeletions(q.deps, 50);

  eq(first.deleted, 0, "not-provisioned: nothing was deleted");
  eq(first.failed, 1, "not-provisioned: the failure still counts toward the page the drain loaded");
  eq(first.stuck.length, 0, "not-provisioned: a refused row is never reported as stuck");
  eq(first.refused.length, 1, "not-provisioned: the row is reported as refused");
  eq(first.refused[0]?.kind, "not-provisioned", "not-provisioned: the refusal carries its kind");
  eq(first.refused[0]?.row.id, "p1", "not-provisioned: the refusal names the row");
  eq(q.bumps.length, 1, "not-provisioned: exactly one attempt write");
  eq(
    q.bumps[0]?.attempts,
    PENDING_DELETION_GIVE_UP_AT,
    "not-provisioned: attempts is written straight to the give-up count",
  );
  assert(
    (q.bumps[0]?.error ?? "").includes("not-provisioned"),
    `not-provisioned: last_error names the kind, got "${q.bumps[0]?.error}"`,
  );
  assert(
    (q.bumps[0]?.error ?? "").includes("403"),
    "not-provisioned: last_error keeps the Google message for forensics",
  );
  assert(q.table.has("p1"), "not-provisioned: the row STAYS in the table as the record of the orphaned event");
  eq(q.deletes.length, 1, "not-provisioned: one delete was attempted on the first pass");

  const second = await processPendingEventDeletions(q.deps, 50);
  eq(q.deletes.length, 1, "not-provisioned: the second pass does not retry the delete");
  eq(second.failed + second.deleted + second.refused.length, 0, "not-provisioned: the second pass finds nothing to do");
  eq(second.stuck.length, 0, "not-provisioned: the second pass reports nothing stuck");
}

// --- a gone account ends the same way ---------------------------------------------
{
  const q = queue([row("p2", "left@x.com", "evt-2", PENDING_DELETION_ALERT_AFTER - 1)], () => GONE());
  const first = await processPendingEventDeletions(q.deps, 50);

  eq(first.refused.length, 1, "gone: the row is reported as refused");
  eq(first.refused[0]?.kind, "gone", "gone: the refusal carries its kind");
  // This row's attempts + 1 would have crossed PENDING_DELETION_ALERT_AFTER, so
  // the old code would have pushed it into `stuck`. A refused row must not reach
  // the stuck alert, whose copy sends the reader to check API health.
  eq(first.stuck.length, 0, "gone: a refused row on the alert threshold is still not stuck");
  eq(q.bumps[0]?.attempts, PENDING_DELETION_GIVE_UP_AT, "gone: attempts is written to the give-up count");
  assert((q.bumps[0]?.error ?? "").includes("gone"), `gone: last_error names the kind, got "${q.bumps[0]?.error}"`);
  assert(q.table.has("p2"), "gone: the row stays in the table");

  await processPendingEventDeletions(q.deps, 50);
  eq(q.deletes.length, 1, "gone: the second pass does not retry the delete");
}

// --- the CONTROL: a 503 is still retried and still reaches stuck ------------------
// Without this a change that classified every failure as definitive would pass
// both cases above while ending every legitimate retry (L1).
{
  const q = queue([row("p3", "fine@x.com", "evt-3")], () => TRANSIENT());
  let res = await processPendingEventDeletions(q.deps, 50);
  eq(res.refused.length, 0, "transient: a 503 is not refused");
  eq(res.stuck.length, 0, "transient: one failure is not stuck");
  eq(q.bumps[0]?.attempts, 1, "transient: attempts advances by one");
  eq(q.bumps[0]?.error, "events.delete failed: 503 backendError", "transient: last_error is the message, unchanged from before");

  for (let pass = 2; pass <= PENDING_DELETION_ALERT_AFTER; pass++) {
    res = await processPendingEventDeletions(q.deps, 50);
  }
  eq(q.deletes.length, PENDING_DELETION_ALERT_AFTER, "transient: every pass retried the delete");
  eq(q.table.get("p3")?.attempts, PENDING_DELETION_ALERT_AFTER, "transient: attempts counts each retry");
  eq(res.stuck.length, 1, "transient: the row reaches stuck at PENDING_DELETION_ALERT_AFTER exactly as before");
  eq(res.refused.length, 0, "transient: and is still not refused");
  assert(
    (q.table.get("p3")?.attempts ?? 0) < PENDING_DELETION_GIVE_UP_AT,
    "transient: the row is still eligible for the next read",
  );
}

// --- a plain Error carries no status and stays transient ---------------------------
{
  const q = queue([row("p4", "plain@x.com", "evt-4")], () => new Error("socket hang up"));
  const res = await processPendingEventDeletions(q.deps, 50);
  eq(res.refused.length, 0, "plain error: not refused, it carries no status to classify");
  eq(q.bumps[0]?.attempts, 1, "plain error: retried like any transient failure");
}

// --- a mixed batch keeps the two populations apart ---------------------------------
{
  const q = queue(
    [
      row("m1", "new-hire@x.com", "evt-m1"),
      row("m2", "fine@x.com", "evt-m2", PENDING_DELETION_ALERT_AFTER - 1),
      row("m3", "left@x.com", "evt-m3"),
    ],
    (email) => (email === "fine@x.com" ? TRANSIENT() : email === "left@x.com" ? GONE() : NOT_PROVISIONED()),
  );
  const res = await processPendingEventDeletions(q.deps, 50);
  eq(res.failed, 3, "mixed: every failure counts toward the loaded page");
  eq(
    res.refused.map((r) => r.row.id).sort().join(","),
    "m1,m3",
    "mixed: the two definitive rows are refused",
  );
  eq(res.stuck.map((r) => r.id).join(","), "m2", "mixed: only the transient row that crossed the threshold is stuck");
  assert(
    !res.stuck.some((s) => res.refused.some((r) => r.row.id === s.id)),
    "mixed: no row is in both stuck and refused",
  );
}

// --- the copy says what to DO, per kind ---------------------------------------------
{
  const one = pendingDeletionRefusedAlert([
    { calendarEmail: "new-hire@x.com", eventId: "evt-1", kind: "not-provisioned" },
  ]);
  assert(!/^\s*Slate\b/i.test(one), "copy: does not open with the word Slate");
  assert(one.includes("1 calendar event deletion "), `copy: singular count, got "${one}"`);
  assert(!one.includes("calendar event deletions"), "copy: singular does not say deletions");
  assert(one.includes("meeting is"), "copy: singular consequence sentence");
  assert(one.includes("new-hire@x.com"), "copy: names the calendar");
  assert(one.includes("evt-1"), "copy: names the event");
  assert(one.includes("event id evt-1"), `copy: singular event id label, got "${one}"`);
  assert(one.includes("Workspace admin"), "copy: not-provisioned sends the reader to a Workspace admin");
  assert(/retrying can never fix/i.test(one), "copy: not-provisioned says retrying can never fix it");
  assert(!/re-authenticate|out of the pool/i.test(one), "copy: not-provisioned does NOT give the gone remedy");
  assert(!one.includes("(s)"), "copy: no lazy plural");

  const gone = pendingDeletionRefusedAlert([
    { calendarEmail: "left@x.com", eventId: "evt-2", kind: "gone" },
    { calendarEmail: "left@x.com", eventId: "evt-3", kind: "gone" },
  ]);
  assert(gone.includes("2 calendar event deletions"), `copy: plural count, got "${gone}"`);
  assert(/re-authenticate/i.test(gone), "copy: gone says to re-authenticate");
  assert(/out of the pool/i.test(gone), "copy: gone offers taking the agent out of the pool");
  assert(!gone.includes("Workspace admin"), "copy: gone does NOT give the provisioning remedy");
  assert(gone.includes("event ids evt-2, evt-3"), `copy: one calendar's events are grouped, got "${gone}"`);
  eq(gone.split("left@x.com").length - 1, 1, "copy: a calendar with several events is named once");

  // Plurals about ACCOUNTS follow the number of distinct calendars, never the
  // number of deletions: one departed agent queues one deletion per cancelled
  // meeting, so "fix the accounts below" over a single named calendar sends the
  // reader hunting for a second account that is not there.
  assert(gone.includes("fixes the account below"), `copy: one calendar, several deletions, is one account, got "${gone}"`);
  assert(/re-authenticate the account/i.test(gone), `copy: one gone calendar says the account, got "${gone}"`);
  assert(!/accounts/.test(gone), `copy: one calendar never reads as accounts, got "${gone}"`);

  const twoGone = pendingDeletionRefusedAlert([
    { calendarEmail: "left@x.com", eventId: "evt-2", kind: "gone" },
    { calendarEmail: "revoked@x.com", eventId: "evt-3", kind: "gone" },
  ]);
  assert(twoGone.includes("fixes the accounts below"), `copy: two calendars are two accounts, got "${twoGone}"`);
  assert(/re-authenticate each account/i.test(twoGone), `copy: two gone calendars say each account, got "${twoGone}"`);

  const twoProvisioning = pendingDeletionRefusedAlert([
    { calendarEmail: "a@x.com", eventId: "evt-4", kind: "not-provisioned" },
    { calendarEmail: "a@x.com", eventId: "evt-5", kind: "not-provisioned" },
  ]);
  assert(twoProvisioning.includes("give this account"), `copy: one unprovisioned calendar is this account, got "${twoProvisioning}"`);

  const both = pendingDeletionRefusedAlert([
    { calendarEmail: "new-hire@x.com", eventId: "evt-1", kind: "not-provisioned" },
    { calendarEmail: "left@x.com", eventId: "evt-2", kind: "gone" },
  ]);
  assert(both.includes("Workspace admin") && /re-authenticate/i.test(both), "copy: both kinds get both remedies");
  assert(
    both.indexOf("new-hire@x.com") > both.indexOf("Workspace admin") &&
      both.indexOf("left@x.com") > both.indexOf("re-authenticate"),
    "copy: each calendar sits under its own kind's instruction",
  );

  const many = pendingDeletionRefusedAlert(
    Array.from({ length: 6 }, (_, i) => ({ calendarEmail: "busy@x.com", eventId: `evt-${i}`, kind: "gone" as const })),
  );
  assert(many.includes("and 3 more"), `copy: caps the event ids named per calendar, got "${many}"`);
  assert(!many.includes("evt-5"), "copy: the capped ids are not all listed");
  for (const text of [one, gone, both, many, twoGone, twoProvisioning]) {
    assert(!/undefined|NaN|\[object Object\]/.test(text), "copy: nothing leaks");
    assert(!new RegExp("[\\u2013\\u2014]").test(text), "copy: no dashes as punctuation");
  }
}

finish();

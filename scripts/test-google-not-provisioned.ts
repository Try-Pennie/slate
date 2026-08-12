// A Google account that cannot use Calendar at all (#1396).
//
// Found on 2026-08-11 while measuring the drift probe against the live roster: at
// least one real agent has an `agent_calendars` row and Google refuses their
// account outright with `403 notACalendarUser`, "The user must be signed up for
// Google Calendar".
//
// That is not a stale account and it is not an account that has gone away. It has
// never been PROVISIONED, and the fix is a human adding the person to Calendar in
// Google Workspace, not a re-auth and not a deactivation. Scored as "gone", every
// message about it sends the reader after a credential problem that does not
// exist, and new hires landing in Slate before their Google provisioning finishes
// make this the expected direction of travel rather than a one-off.
//
// The risk in adding a third value is that a consumer branching on `=== "gone"`
// silently stops recognising it and treats it as transient, which is fail-OPEN: a
// never-provisioned account would be retried forever and could be admitted to the
// booking pool. So every gate goes through one shared predicate, and this file
// asserts both the classification and each gate that hangs off it.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-google-not-provisioned.ts
import {
  classifyGoogleStatus,
  NOT_A_CALENDAR_USER_REASON,
} from "../src/lib/google/reachability-classify.ts";
import { syncEligible } from "../src/lib/google/sync-coalesce.ts";
import { isDefinitiveFailure, nextSyncState } from "../src/lib/google/sync-health.ts";
import {
  dedupeFailingAgents,
  isPageableFailure,
  formatSyncFailureAlert,
  GONE_PAGE_AT,
  TRANSIENT_PAGE_AT,
} from "../src/lib/notify/alerts.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DASHES = new RegExp("[\\u2013\\u2014]");

// --- the classification -------------------------------------------------------
{
  eq(
    classifyGoogleStatus(403, NOT_A_CALENDAR_USER_REASON),
    "not-provisioned",
    "a 403 notACalendarUser is its own kind, not gone",
  );
  eq(
    classifyGoogleStatus(403, "NotACalendarUser"),
    "not-provisioned",
    "and the reason match is case insensitive, as Google's casing is not a contract",
  );
  // The three neighbours must be untouched: a shape filter has to be tested
  // against what it must PRESERVE, not only what it must catch (L104).
  eq(classifyGoogleStatus(403, "forbidden"), "gone", "an ordinary 403 is still gone");
  eq(classifyGoogleStatus(404), "gone", "a 404 is still gone");
  eq(classifyGoogleStatus(401), "gone", "a 401 is still gone");
  eq(classifyGoogleStatus(403, "rateLimitExceeded"), "transient", "a rate limit is still transient");
  eq(classifyGoogleStatus(503), "transient", "a 5xx is still transient");
  eq(classifyGoogleStatus(undefined), "transient", "no status at all is still transient");
}

// --- the shared predicate every gate uses -------------------------------------
// The whole reason the new value is safe to add. A gate written as `=== "gone"`
// would treat not-provisioned as transient, which retries forever and, at the
// activation gate, is the difference between refusing an agent and admitting one.
{
  assert(isDefinitiveFailure("gone"), "gone is definitive");
  assert(isDefinitiveFailure("not-provisioned"), "not-provisioned is definitive: no retry fixes it");
  assert(!isDefinitiveFailure("transient"), "transient is not definitive");
  assert(!isDefinitiveFailure("reachable"), "reachable is not a failure at all");
  // A null kind is a failure recorded before the classification shipped, and #916
  // deliberately treats it as needing a human so no streak that used to page goes
  // silent. Keep that direction.
  assert(isDefinitiveFailure(null), "an unclassified failure stays on the conservative side");
  assert(isDefinitiveFailure(undefined), "and so does a missing one");
}

// --- the sync rotation backs off, exactly as it does for gone -----------------
// A never-provisioned account cannot recover without a human, so retrying it every
// minute spends the shared budget on a call that is guaranteed to fail.
{
  const cal = (kind: "gone" | "transient" | "not-provisioned", failures: number) => ({
    id: "11111111-1111-4111-8111-111111111111",
    last_failure_kind: kind,
    consecutive_failures: failures,
  });
  // Find a minute this calendar is NOT due, so "skipped" is observable at all.
  const interval = 60;
  let notDue = -1;
  for (let m = 0; m < interval; m++) {
    if (!syncEligible(cal("gone", 99), m * 60_000, interval)) {
      notDue = m * 60_000;
      break;
    }
  }
  assert(notDue >= 0, "found a minute an established-gone calendar is backed off (control)");
  assert(
    !syncEligible(cal("not-provisioned", 99), notDue, interval),
    "an established never-provisioned calendar is backed off on the same schedule as gone",
  );
  assert(
    syncEligible(cal("transient", 99), notDue, interval),
    "a transient failure is still retried every tick",
  );
  assert(
    syncEligible(cal("not-provisioned", 1), notDue, interval),
    "a single not-provisioned failure is retried: the backoff waits for a streak, as for gone",
  );
}

// --- the health transition records it -----------------------------------------
{
  const prev = {
    consecutive_failures: 1,
    last_success_at: "2026-08-01T00:00:00.000Z",
    last_sync_error: null,
    last_failure_kind: null,
  };
  const next = nextSyncState(
    prev,
    { ok: false, error: "403 notACalendarUser", kind: "not-provisioned" },
    "2026-08-12T00:00:00.000Z",
  );
  eq(next.last_failure_kind, "not-provisioned", "the transition stores the new kind");
  eq(next.consecutive_failures, 2, "and still counts the failure");
  eq(next.last_success_at, prev.last_success_at, "and preserves the last success");
}

// --- paging: it needs a human, so it pages on the FAST threshold ---------------
{
  assert(
    isPageableFailure("not-provisioned", GONE_PAGE_AT),
    "a not-provisioned row pages at the gone threshold, because a human has to act",
  );
  assert(
    !isPageableFailure("not-provisioned", GONE_PAGE_AT - 1),
    "but not before it",
  );
  assert(
    !isPageableFailure("transient", GONE_PAGE_AT),
    "and a transient row still waits longer (control)",
  );
  assert(TRANSIENT_PAGE_AT > GONE_PAGE_AT, "the two thresholds really are different (control)");
}

// --- the alert says what to DO, which is the whole point ----------------------
{
  const row = (email: string, kind: string) => ({
    consecutive_failures: 3,
    last_success_at: null,
    last_sync_error: "403 notACalendarUser",
    email,
    bookable: true,
    deactivated_at: null,
    last_failure_kind: kind,
  });
  const agents = dedupeFailingAgents([row("jordan@trypennie.com", "not-provisioned")]);
  eq(agents.length, 1, "the row survives dedup");
  eq(agents[0].failureKind, "not-provisioned", "and keeps its classification rather than dropping to null");

  const text = formatSyncFailureAlert(agents, 126, Date.parse("2026-08-12T12:00:00.000Z"));
  assert(/calendar/i.test(text), "the alert mentions Calendar");
  assert(
    /Workspace|sign(ed)? up|provision/i.test(text),
    "and tells the reader the fix is provisioning the account, not a credential repair",
  );
  assert(
    !/re-?auth/i.test(text),
    "and does NOT tell them to re-authenticate, which fixes nothing here",
  );
  assert(!DASHES.test(text), "no dashes as punctuation");
  assert(!/undefined|NaN|\[object Object\]/.test(text), "no placeholder leak");

  // A mixed list must serve both readers: one account needs provisioning, the
  // other needs a re-auth, and a single instruction for both sends somebody the
  // wrong way. That is the #1133 defect facing a new direction.
  const mixed = dedupeFailingAgents([
    row("jordan@trypennie.com", "not-provisioned"),
    row("sam@trypennie.com", "gone"),
  ]);
  const mixedText = formatSyncFailureAlert(mixed, 126, Date.parse("2026-08-12T12:00:00.000Z"));
  assert(/Workspace|sign(ed)? up|provision/i.test(mixedText), "a mixed list still names the provisioning fix");
  assert(/re-?auth|deactivate/i.test(mixedText), "and still names the account fix");
  assert(!DASHES.test(mixedText), "mixed copy has no dashes");
}

// --- every kind has its OWN words, checked from the LIST, not by hand ----------
// The failure this closes is the next one: a fourth kind added to FailureKind and
// then labelled by a chain of literal comparisons that does not mention it renders
// as no label at all, so the alert names a failure and says nothing about what to
// do with it. Driven off the kinds the code can record, so a new one is covered by
// construction rather than by whoever remembers this file (L96).
{
  const KINDS = ["gone", "not-provisioned", "transient"] as const;
  const row = (email: string, kind: string) => ({
    consecutive_failures: 6,
    last_success_at: null,
    last_sync_error: "an error",
    email,
    bookable: true,
    deactivated_at: null,
    last_failure_kind: kind,
  });
  const labels = new Map<string, string>();
  for (const kind of KINDS) {
    const text = formatSyncFailureAlert(
      dedupeFailingAgents([row(`${kind}@trypennie.com`, kind)]),
      126,
      Date.parse("2026-08-12T12:00:00.000Z"),
    );
    const label = /\[([^\]]+)\]/.exec(text)?.[1] ?? "";
    assert(label.length > 0, `${kind} renders a bracketed label saying what it is`);
    labels.set(kind, label);
  }
  eq(
    new Set(labels.values()).size,
    KINDS.length,
    `each kind's label is its own, not shared (${[...labels.values()].join(" | ")})`,
  );
  // And the instruction differs too, since the label alone does not tell anybody
  // what to do.
  const instructions = KINDS.map((kind) =>
    formatSyncFailureAlert(
      dedupeFailingAgents([row(`${kind}@trypennie.com`, kind)]),
      126,
      Date.parse("2026-08-12T12:00:00.000Z"),
    ).split("\n")[0],
  );
  eq(new Set(instructions).size, KINDS.length, "and each kind's instruction is its own");
}

finish();

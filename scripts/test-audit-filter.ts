/**
 * #1222: making the admin audit trail findable.
 *
 * Measured against production on 2026-08-17: `audit_log` holds 378 rows and
 * 373 of them (98.7%) are time off actions. The five rows the trail exists for,
 * two impersonations, two PII actions and one settings change, are all from June
 * and July and sit far outside a 25 row window. So the panel opened on routine
 * approvals and the privileged changes were the hardest rows to reach.
 *
 * The decision that falls out of that measurement: the default view HIDES the
 * routine family rather than showing the newest of everything.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-audit-filter.ts
 */
import { AUDIT_ACTIONS } from "../src/lib/audit.ts";
import {
  isRoutineAudit,
  auditActionChoices,
  DB_WRITTEN_AUDIT_ACTIONS,
  parseAuditFilters,
  testAdvisorRowsFilter,
  auditFilterHref,
  describeAuditFilters,
  AUDIT_PAGE_SIZE,
} from "../src/lib/audit-filter.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// ------------------------------------------------- what counts as routine

// The classification is by PREFIX, and anything unrecognised is NOT routine, so
// a privileged action added later shows up by default instead of being hidden by
// a list nobody remembered to update (L113: the entry most likely to be missing
// is the one a later writer adds).
{
  for (const a of ["ooo.submit", "ooo.approve", "ooo.cancel", "ooo.reject", "ooo.modify", "ooo.retry"]) {
    assert(isRoutineAudit(a), `${a} is routine`);
  }
  for (const a of [
    "role.set",
    "impersonate.start",
    "impersonate.stop",
    "pii.erasure",
    "pii.warehouse_purge",
    "monitor.settings",
    "org.business_hours",
    "agent.deactivate",
  ]) {
    assert(!isRoutineAudit(a), `${a} is privileged, never routine`);
  }
  // The fail-safe direction for something nobody has written yet.
  assert(!isRoutineAudit("something.brand_new"), "an unknown action defaults to SHOWN");
  assert(!isRoutineAudit(""), "an empty action defaults to SHOWN rather than throwing");
  // The match is ANCHORED, so an action merely CONTAINING the family name is not
  // it. Note this holds because of startsWith, not because of the trailing dot:
  // changing the prefix to "ooo" leaves this passing, and saying so keeps the
  // test from claiming to guard something it does not.
  assert(!isRoutineAudit("agent.ooo_calendar"), "agent.ooo_calendar is an agent edit, not a time off decision");
  // What the trailing dot actually buys: a future top-level action beginning
  // "ooo" that is not part of the family stays visible by default.
  assert(!isRoutineAudit("ooops.rollback"), "a non-family action beginning ooo is still SHOWN");
}

// ------------------------------------------------- the default view

{
  const f = parseAuditFilters({});
  eq(f.includeRoutine, false, "the default view hides the routine family");
  eq(f.actions, null, "with no action filter");
  eq(f.actorId, null, "no actor filter");
  eq(f.fromIso, null, "and no date bound");
  eq(f.page, 1, "starting at page one");
}

// ------------------------------------------------- reading the URL

{
  const f = parseAuditFilters({ routine: "1", actor: "u-1", from: "2026-08-01", to: "2026-08-17", page: "3" });
  eq(f.includeRoutine, true, "routine=1 brings the time off rows back");
  eq(f.actorId, "u-1", "the actor is carried");
  eq(f.fromIso, "2026-08-01", "as is the start of the range");
  eq(f.toIso, "2026-08-17", "and its end");
  eq(f.page, 3, "and the page");
}

{
  // An explicit action wins over the routine default: asking for time off rows by
  // name must not be silently overruled by a filter the person did not set.
  const f = parseAuditFilters({ action: "ooo.approve" });
  eq(f.actions?.length, 1, "one action requested");
  eq(f.actions?.[0], "ooo.approve", "and it is the one asked for");
  eq(f.includeRoutine, true, "naming a routine action implies including the family");
}

{
  const f = parseAuditFilters({ action: "role.set" });
  eq(f.includeRoutine, false, "naming a privileged action does not drag the routine family in");
}

// ------------------------------------------------- junk in the URL

// These are hand-edited or stale URLs, and none of them may produce a filter that
// silently returns nothing while looking like a real answer.
{
  eq(parseAuditFilters({ page: "0" }).page, 1, "page 0 clamps to 1");
  eq(parseAuditFilters({ page: "-4" }).page, 1, "a negative page clamps to 1");
  eq(parseAuditFilters({ page: "abc" }).page, 1, "an unparseable page falls back to 1, never NaN (L50)");
  eq(parseAuditFilters({ from: "not-a-date" }).fromIso, null, "an unreadable date is DROPPED, not passed to the query");
  eq(parseAuditFilters({ to: "2026-13-45" }).toIso, null, "an impossible date is dropped too");
  eq(parseAuditFilters({ actor: "   " }).actorId, null, "a blank actor is no actor");
  eq(parseAuditFilters({ action: "  " }).actions, null, "a blank action is no action filter");
}

// ------------------------------------------------- links keep the rest of the filter

{
  const f = parseAuditFilters({ actor: "u-1", from: "2026-08-01", routine: "1" });
  const href = auditFilterHref(f, { page: 2 });
  assert(href.includes("actor=u-1"), "paging keeps the actor");
  assert(href.includes("from=2026-08-01"), "and the date range");
  assert(href.includes("routine=1"), "and whether routine rows are shown");
  assert(href.includes("page=2"), "while moving the page");
  assert(href.includes("#audit"), "and jumps to the table rather than the top of the page");
}

{
  // Page 1 is the default, so it is not spelled out: a link back to the first page
  // should be the clean URL a person can read.
  const href = auditFilterHref(parseAuditFilters({}), { page: 1 });
  assert(!href.includes("page="), "page 1 is left out of the URL");
  assert(!href.includes("routine="), "and so is the default routine setting");
}

// ------------------------------------------------- the sentence above the table

// L11 and L21: the panel must say what it is showing, because a filtered view
// that looks like the whole trail is how somebody concludes nothing happened.
{
  const none = describeAuditFilters(parseAuditFilters({}), 5);
  assert(/time off/i.test(none), "the default view SAYS time off is hidden");
  assert(/5/.test(none), "and how many rows it is describing");

  const withRoutine = describeAuditFilters(parseAuditFilters({ routine: "1" }), 378);
  assert(!/hidden|hiding/i.test(withRoutine), "showing everything does not claim to hide anything");
  // Once the routine family is back in, most rows are time off decisions, so
  // calling the whole set "privileged" is simply false. Caught by rendering it
  // against the real 378 rows, not by reading the builder.
  assert(!/privileged/i.test(withRoutine), "and does not call routine time off decisions privileged");
  assert(/378/.test(withRoutine), "while still saying how many there are");

  // Naming an action already decides what is shown, so repeating that time off is
  // hidden reads as a second, contradictory filter.
  const byAction = describeAuditFilters(parseAuditFilters({ action: "impersonate.start" }), 1);
  assert(!/time off/i.test(byAction), "an explicit action filter drops the routine note");
  assert(/1 privileged action\b/.test(byAction), "and still says how many matched, in the singular");

  const filtered = describeAuditFilters(parseAuditFilters({ actor: "u-1" }), 0);
  assert(/no /i.test(filtered) || /0/.test(filtered), "an empty RESULT is described as an empty result");
  // It must never read as though the trail itself is empty.
  assert(/filter|match/i.test(filtered), "and names the filter as the reason, not the trail being empty");
}

// ------------------------------------------------- the page size is real
{
  assert(AUDIT_PAGE_SIZE >= 10 && AUDIT_PAGE_SIZE <= 100, "a sane page size");
}

// ------------------------------------------------- what the dropdown can offer

// The application's own vocabulary does NOT cover the whole trail: pii.erasure is
// written by the erase_booking_pii database function, and production holds a row
// for it. A dropdown built from the app list alone could never reach one of the
// most privileged actions there is.
{
  const choices = auditActionChoices(AUDIT_ACTIONS);
  for (const a of AUDIT_ACTIONS) assert(choices.includes(a), `${a} is offered`);
  for (const a of DB_WRITTEN_AUDIT_ACTIONS) {
    assert(choices.includes(a), `${a} is offered even though no TypeScript writes it`);
    assert(!AUDIT_ACTIONS.includes(a as never), `${a} really is absent from the app list, so this is not a no-op`);
  }
  eq(new Set(choices).size, choices.length, "nothing is offered twice");
  eq([...choices].sort().join(","), choices.join(","), "the order is stable, not edit-history order");
  assert(choices.some((a) => !isRoutineAudit(a)), "and privileged actions are among them");
}

// ------------------------------------------------- test advisors (#3615)
//
// The daily reroute drill writes two audit rows a day about the smoke test advisors. They are not
// privileged actions anybody needs to read, so they are hidden by default, like time off, and a
// box brings them back.
{
  eq(parseAuditFilters({}).includeTest, false, "rows about test advisors are hidden by default");
  eq(parseAuditFilters({ test: "1" }).includeTest, true, "test=1 brings them back");
  const f = parseAuditFilters({ test: "1", actor: "u-1" });
  assert(auditFilterHref(f, { page: 2 }).includes("test=1"), "and a link that changes the page keeps them shown");
  assert(!auditFilterHref(parseAuditFilters({}), {}).includes("test="), "a default link carries no test parameter");

  // The filter that hides them must keep every row with NO target: SQL's NOT IN answers unknown
  // for a missing value, so a bare "target not in test advisors" would also hide every action
  // that is about nobody.
  eq(
    testAdvisorRowsFilter(["t1", "t2"]),
    "target_id.is.null,target_id.not.in.(t1,t2)",
    "rows about nobody stay, rows about a test advisor go",
  );
  eq(testAdvisorRowsFilter([]), null, "with no test advisors there is nothing to hide, and no filter at all");
}

finish();

// Tests for the pure OOO-approvals digest core (no IO).
// Run: node --experimental-strip-types scripts/test-approvals-digest.ts
import {
  isApprovalsDigestTime,
  yesterdayEtRange,
  approvalsFileDate,
  approvalsDisplayDate,
  approvalsSubject,
  approvalsBody,
  approvalsWindow,
  formatApprovalTime,
  buildApprovalsCsv,
  APPROVALS_CATCHUP_MAX_DAYS,
  type ApprovalRow,
} from "../src/lib/ooo/approvals-digest.ts";
import { assert, finish } from "./lib/harness.ts";

// isApprovalsDigestTime — 7am ET, across DST (EDT 11:00 UTC, EST 12:00 UTC)
assert(isApprovalsDigestTime(Date.UTC(2026, 5, 8, 11, 0)), "summer: 11:00 UTC is 7am ET");
assert(!isApprovalsDigestTime(Date.UTC(2026, 5, 8, 12, 0)), "summer: 12:00 UTC is 8am ET, skipped");
assert(isApprovalsDigestTime(Date.UTC(2026, 0, 8, 12, 0)), "winter: 12:00 UTC is 7am ET");
assert(!isApprovalsDigestTime(Date.UTC(2026, 0, 8, 11, 0)), "winter: 11:00 UTC is 6am ET, skipped");

// yesterdayEtRange — the UTC window covering yesterday in ET
{
  const { startIso, endIso } = yesterdayEtRange(Date.UTC(2026, 5, 8, 11, 0));
  assert(startIso === "2026-06-07T04:00:00.000Z", "yesterday ET start -> 04:00Z (EDT)");
  assert(endIso === "2026-06-08T04:00:00.000Z", "yesterday ET end -> next midnight ET in UTC");
}

// The catch-up window (#2543). The report's range is decided by a WATERMARK (the
// stamp of the last report that went out), never by the clock alone, so a morning
// the lane missed is covered by the next run rather than falling out of every
// later one.
const JUN8_7AM = Date.UTC(2026, 5, 8, 11, 0);
{
  const w = approvalsWindow(JUN8_7AM, null);
  assert(w.days === 1, "no watermark yet: one day, exactly as before");
  assert(w.startIso === "2026-06-07T04:00:00.000Z", "and that day is yesterday ET");
  assert(w.endIso === "2026-06-08T04:00:00.000Z", "ending at this morning's ET midnight");
  assert(!w.capped, "one day is never capped");
}
{
  const w = approvalsWindow(JUN8_7AM, Date.UTC(2026, 5, 7, 11, 0));
  assert(w.days === 1, "a report that went out yesterday leaves one day to cover");
  assert(w.startIso === "2026-06-07T04:00:00.000Z", "which is yesterday ET");
}
{
  // Three mornings missed. The gap is caught up rather than lost.
  const w = approvalsWindow(JUN8_7AM, Date.UTC(2026, 5, 4, 11, 0));
  assert(w.days === 4, "a four day gap is covered in one report");
  assert(
    w.startIso === "2026-06-04T04:00:00.000Z",
    "starting the morning the last report covered up to",
  );
  assert(w.endIso === "2026-06-08T04:00:00.000Z", "and still ending this morning");
  assert(!w.capped, "four days is inside the cap");
}
{
  // A gap longer than the cap reaches as far back as the cap allows, and SAYS so.
  const w = approvalsWindow(JUN8_7AM, Date.UTC(2026, 3, 1, 11, 0));
  assert(w.days === APPROVALS_CATCHUP_MAX_DAYS, "a long gap is capped at the maximum");
  assert(w.capped, "and the window records that it was capped");
}
{
  // Already reported this morning: the second cron trigger, or a forced re-run.
  const w = approvalsWindow(JUN8_7AM, JUN8_7AM);
  assert(w.days === 0, "a report already sent today leaves nothing to cover");
}
{
  // A stamp from the future (clock skew) must never produce a negative window.
  const w = approvalsWindow(JUN8_7AM, Date.UTC(2026, 5, 20, 11, 0));
  assert(w.days === 0, "a watermark ahead of the clock covers nothing, never a negative range");
}
{
  // THE FAILURE PATH for the mark itself. An existing stamp that cannot be PARSED
  // arrives as the epoch 0 sentinel (#1169), and it has to read as ancient: the
  // widest catch-up the cap allows, said out loud, rather than as a fresh mark that
  // would silently narrow the report to yesterday and move on.
  const w = approvalsWindow(JUN8_7AM, 0);
  assert(w.days === APPROVALS_CATCHUP_MAX_DAYS, "an unreadable mark reaches back as far as the cap");
  assert(w.capped, "and says it was capped, rather than reading as a complete report");
}

const ONE_DAY = approvalsWindow(JUN8_7AM, null);
const FOUR_DAYS = approvalsWindow(JUN8_7AM, Date.UTC(2026, 5, 4, 11, 0));
const CAPPED = approvalsWindow(JUN8_7AM, Date.UTC(2026, 3, 1, 11, 0));

// file + display dates use yesterday in ET
assert(approvalsFileDate(ONE_DAY) === "260607", "fileDate = yyMMdd of yesterday ET");
assert(
  approvalsFileDate(FOUR_DAYS) === "260604 to 260607",
  "a caught up report names both ends of its range in the filename",
);
assert(
  approvalsDisplayDate(Date.UTC(2026, 5, 8, 11, 0)) === "June 7th, 2026",
  "displayDate is friendly with ordinal",
);
assert(
  approvalsDisplayDate(Date.UTC(2026, 5, 2, 11, 0)) === "June 1st, 2026",
  "ordinal handles 1st",
);

// subject + body match the original Pipedream copy verbatim on the ordinary day
assert(
  approvalsSubject(ONE_DAY) === "Yesterday's OOO Approvals 260607",
  "subject is 'Yesterday's OOO Approvals <yyMMdd>'",
);
assert(
  approvalsBody(ONE_DAY) === "Please see the attached CSV with approvals from June 7th, 2026",
  "body matches the original wording",
);

// A report covering more than a day may not call itself yesterday's (L11).
assert(
  !approvalsSubject(FOUR_DAYS).includes("Yesterday"),
  "a caught up report does not claim to be yesterday's",
);
assert(
  approvalsSubject(FOUR_DAYS) === "OOO Approvals 260604 to 260607",
  "it names its range instead",
);
{
  const body = approvalsBody(FOUR_DAYS);
  assert(
    body.includes("June 4th, 2026") && body.includes("June 7th, 2026"),
    "the body names both ends",
  );
  assert(body.includes("4 days"), "and says how many days it covers");
  assert(
    !body.includes("are not in this report"),
    "an uncapped catch up does not claim to have left anything out",
  );
}
assert(
  approvalsBody(CAPPED).includes("are not in this report"),
  "a capped report says what it had to leave out rather than reading as complete",
);

// formatApprovalTime — render in the request's display timezone
assert(
  // One spelling for a time across the product (#1765): the lowercase form the
  // booker and the time off form already use. Five places spelled it three ways.
  formatApprovalTime("2026-06-08T19:00:00Z", "ET") === "Jun 8, 2026, 3:00pm ET",
  "ET time renders as 3:00pm ET",
);
assert(
  formatApprovalTime("2026-06-08T19:00:00Z", "PT") === "Jun 8, 2026, 12:00pm PT",
  "same instant renders as noon PT, spelled 12:00pm rather than 0:00pm",
);
assert(formatApprovalTime("not-a-date", "ET") === "not-a-date", "invalid iso falls back to raw");

// buildApprovalsCsv — columns + CSV escaping
{
  const rows: ApprovalRow[] = [
    {
      request_id: "r1",
      agent_name: "Smith, Jane",
      manager_name: "Bob Boss",
      starts_at: "2026-06-08T19:00:00Z",
      ends_at: "2026-06-08T22:00:00Z",
      decided_at: "2026-06-07T13:30:00Z",
      display_tz_label: "ET",
    },
  ];
  const csv = buildApprovalsCsv(rows);
  const lines = csv.split("\n");
  assert(
    lines[0] === "request_id,agent_name,start_time,end_time,manager_name,approved_at",
    "header row matches the original columns",
  );
  assert(lines[1].startsWith('r1,"Smith, Jane",'), "a name with a comma is quoted");
  assert(lines[1].includes("3:00pm ET") && lines[1].includes("6:00pm ET"), "times render in tz");
  assert(buildApprovalsCsv([]).split("\n").length === 1, "empty rows -> header only");
}

finish();

// Tests for the pure OOO-approvals digest core (no IO).
// Run: node --experimental-strip-types scripts/test-approvals-digest.ts
import {
  isApprovalsDigestTime,
  yesterdayEtRange,
  approvalsFileDate,
  approvalsDisplayDate,
  approvalsSubject,
  approvalsBody,
  formatApprovalTime,
  buildApprovalsCsv,
  type ApprovalRow,
} from "../src/lib/ooo/approvals-digest.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

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

// file + display dates use yesterday in ET
assert(approvalsFileDate(Date.UTC(2026, 5, 8, 11, 0)) === "260607", "fileDate = yyMMdd of yesterday ET");
assert(
  approvalsDisplayDate(Date.UTC(2026, 5, 8, 11, 0)) === "June 7th, 2026",
  "displayDate is friendly with ordinal",
);
assert(
  approvalsDisplayDate(Date.UTC(2026, 5, 2, 11, 0)) === "June 1st, 2026",
  "ordinal handles 1st",
);

// subject + body match the original Pipedream copy verbatim
assert(
  approvalsSubject(Date.UTC(2026, 5, 8, 11, 0)) === "Yesterday's OOO Approvals 260607",
  "subject is 'Yesterday's OOO Approvals <yyMMdd>'",
);
assert(
  approvalsBody(Date.UTC(2026, 5, 8, 11, 0)) ===
    "Please see the attached CSV with approvals from June 7th, 2026",
  "body matches the original wording",
);

// formatApprovalTime — render in the request's display timezone
assert(
  formatApprovalTime("2026-06-08T19:00:00Z", "ET") === "Jun 8, 2026, 3:00 PM ET",
  "ET time renders as 3:00 PM ET",
);
assert(
  formatApprovalTime("2026-06-08T19:00:00Z", "PT") === "Jun 8, 2026, 12:00 PM PT",
  "same instant renders as noon PT",
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
  assert(lines[1].includes("3:00 PM ET") && lines[1].includes("6:00 PM ET"), "times render in tz");
  assert(buildApprovalsCsv([]).split("\n").length === 1, "empty rows -> header only");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

import { oooApprovalsDigestAlert } from "@/lib/notify/misc-alert-copy";
import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import {
  oooApprovalsBcc,
  oooApprovalsRecipients,
  oooApprovalsReplyTo,
  oooCalendarActorEmail,
} from "@/lib/env";
import { sendGmailEmail } from "@/lib/notify/email";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure } from "@/lib/notify/send-failure";
import { shortErrorReason } from "@/lib/notify/error-text";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { log } from "@/lib/log";
import {
  approvalsBody,
  approvalsFileDate,
  approvalsSubject,
  approvalsWindow,
  buildApprovalsCsv,
  isApprovalsDigestTime,
  type ApprovalRow,
} from "@/lib/ooo/approvals-digest";
import { recordHeartbeat, readHeartbeatMsStrict } from "@/lib/monitor/heartbeat";
import {
  OOO_APPROVALS_ATTEMPT_LANE,
  OOO_APPROVALS_REPORT_LANE,
} from "@/lib/ooo/time-off-lanes";

export const dynamic = "force-dynamic";

// One report a day, so a generous cooldown — enough to never double-alert if
// the platform retries the cron, short enough that tomorrow's failure alerts.
const DIGEST_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Daily 7am ET digest (port of the Pipedream flow): emails a CSV of every OOO
 * request approved since the last report went out. Two UTC crons (11:00 + 12:00)
 * straddle DST so one lands at 7am ET; isApprovalsDigestTime lets exactly one
 * fire. Skips silently on days with zero approvals. `?force=1` bypasses the time
 * gate.
 *
 * "Since the last report went out" rather than "the previous day" (#2543): the
 * window comes from a WATERMARK, so a morning this lane missed is covered by the
 * next run rather than falling out of every later one. On the ordinary morning
 * that is yesterday and the email is word for word what it always was.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/ooo-approvals");
  if (claimed) return claimed;
  // #2543: the cron reached the route. Stamped BEFORE the time gate, so it is
  // written by both daily triggers and says one thing only, that the dispatcher is
  // firing. Nothing about whether a report went out hangs off it; that is the
  // second stamp, further down.
  await recordHeartbeat(OOO_APPROVALS_ATTEMPT_LANE);

  const force = req.nextUrl.searchParams.get("force") === "1";
  const now = Date.now();
  if (!force && !isApprovalsDigestTime(now)) {
    return NextResponse.json({ skipped: "not 7am ET" });
  }

  const recipients = oooApprovalsRecipients();
  if (recipients.length === 0) {
    // Deliberately NOT a covered run. An unset recipient list means the report is
    // not reaching anybody, so stamping here would make a silently disabled report
    // look like a healthy one for ever (L543). It is configured on the deployment,
    // so this is not a permanently red alarm; it is the only thing that would say
    // so if somebody cleared it.
    return NextResponse.json({ skipped: "no recipients configured" });
  }

  // The catch-up window (#2543), measured from the last report that WENT OUT rather
  // than from the clock. A morning this lane missed is covered by this run instead
  // of falling out of every later one.
  // Strict, so a failed read THROWS rather than reading as "never reported", which
  // would narrow this run to yesterday and then move the mark past the days it
  // skipped. A throw is a 500 the cron records, the mark does not move, and
  // tomorrow's run covers the whole gap.
  const window = approvalsWindow(now, await readHeartbeatMsStrict(OOO_APPROVALS_REPORT_LANE));
  if (window.days === 0) {
    // Nothing left to cover: the second daily trigger, or a `?force=1` re-run after
    // a report has already gone out this morning. Stamped, because this run reached
    // a measured outcome about its own window.
    await recordHeartbeat(OOO_APPROVALS_REPORT_LANE);
    return NextResponse.json({ sent: false, count: 0, alreadyCovered: true });
  }
  const { startIso, endIso } = window;
  const db = supabaseAdmin();
  // #2383: unwrap, never a swallowed `data`. An empty result here is read one
  // line down as the specific answer "nobody's time off was approved yesterday",
  // and that answer is a silent 200 with no CSV. There is also no second chance:
  // the window is yesterday relative to the clock, so a day this lane drops falls
  // out of every later run's window. A throw is a 500 the cron records, which is
  // the only way a morning with no report is distinguishable from a morning with
  // nothing to report.
  const approvedRows = unwrap(
    await db
      // cap-safe: one day's approved time off decisions across the org.
      .from("ooo_requests")
      .select(
        "id, legacy_request_id, user_id, manager_id, starts_at, ends_at, decided_at, display_tz_label",
      )
      .eq("status", "approved")
      .gte("decided_at", startIso)
      .lt("decided_at", endIso)
      .order("decided_at", { ascending: true }),
    "approvals digest requests",
  );

  const approved = (approvedRows ?? []) as {
    id: string;
    legacy_request_id: string | null;
    user_id: string;
    manager_id: string | null;
    starts_at: string;
    ends_at: string;
    decided_at: string;
    display_tz_label: string;
  }[];

  // Skip silently on empty days (matches the original flow). This branch now
  // means a day with genuinely no approvals and nothing else, because the read
  // above throws rather than arriving here as an empty array (#2383).
  if (approved.length === 0) {
    // #2543: a MEASURED outcome, so the watermark moves. "Nobody's time off was
    // approved in this window" is an answer, and leaving the mark where it was
    // would make every quiet week read as a lane that had stopped, and widen
    // tomorrow's window over days this run has already looked at.
    await recordHeartbeat(OOO_APPROVALS_REPORT_LANE);
    return NextResponse.json({ sent: false, count: 0, days: window.days });
  }

  // Resolve agent + manager names in one lookup.
  const ids = [
    ...new Set(
      approved.flatMap((r) => [r.user_id, r.manager_id]).filter((id): id is string => !!id),
    ),
  ];
  // #2383: unwrap too. A swallowed error here empties the name map, so every row
  // of the CSV ships with a blank agent and a blank manager, and a report about
  // who was away naming nobody is worse than no report: it looks complete. There
  // is nothing downstream that could tell a missing name from an unreadable one.
  const userRows = unwrap(
    await db.from("users").select("id, name").in("id", ids),
    "approvals digest names",
  );
  const nameById = new Map(
    ((userRows ?? []) as { id: string; name: string | null }[]).map((u) => [u.id, u.name]),
  );

  const rows: ApprovalRow[] = approved.map((r) => ({
    request_id: r.legacy_request_id ?? r.id,
    agent_name: nameById.get(r.user_id) ?? null,
    manager_name: r.manager_id ? (nameById.get(r.manager_id) ?? null) : null,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    decided_at: r.decided_at,
    display_tz_label: r.display_tz_label,
  }));

  const csv = buildApprovalsCsv(rows);
  const filename = `${approvalsFileDate(window)} OOO Approvals.csv`;
  const replyTo = oooApprovalsReplyTo();

  // Silent non-delivery is the worst failure mode for a report people rely on,
  // so alert (throttled) on any send error before surfacing the 500 — a slow or
  // disabled Gmail, a lapsed gmail.send scope, etc. The lane still answers 500 so
  // the cron records the failure (and can retry within the time gate). It used to
  // re-throw, which reached the dispatcher as a bare 500 and paged a second time
  // about the same failure; laneFailure carries the fact that this alert spoke.
  try {
    await sendGmailEmail({
      from: oooCalendarActorEmail(),
      to: recipients,
      bcc: oooApprovalsBcc(),
      ...(replyTo ? { replyTo } : {}),
      subject: approvalsSubject(window),
      body: approvalsBody(window),
      attachments: [{ filename, content: csv, mimeType: "text/csv" }],
    });
  } catch (e) {
    log.error("ooo-approvals", { msg: "approvals report send failed" }, e);
    return laneFailure("ooo-approvals", shortErrorReason(e), async () => {
      await sendThrottledAlert(
        "ooo_approvals_digest",
        DIGEST_ALERT_COOLDOWN_MS,
        oooApprovalsDigestAlert(rows.length, recipients.length, shortErrorReason(e)),
      ).catch(logAlertSendFailure("ooo_approvals_digest"));
    });
  }

  // #2543: the watermark moves only AFTER the send has succeeded. The failure
  // return above skips it deliberately, so a morning whose email failed is reported again
  // tomorrow rather than being recorded as covered by a report nobody received.
  await recordHeartbeat(OOO_APPROVALS_REPORT_LANE);

  return NextResponse.json({
    sent: true,
    count: rows.length,
    recipients: recipients.length,
    days: window.days,
    capped: window.capped,
  });
}

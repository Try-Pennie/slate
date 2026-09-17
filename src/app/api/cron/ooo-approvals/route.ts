import { oooApprovalsDigestAlert } from "@/lib/notify/misc-alert-copy";
import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
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
import { shortErrorReason } from "@/lib/notify/error-text";
import {
  approvalsBody,
  approvalsFileDate,
  approvalsSubject,
  buildApprovalsCsv,
  isApprovalsDigestTime,
  yesterdayEtRange,
  type ApprovalRow,
} from "@/lib/ooo/approvals-digest";

export const dynamic = "force-dynamic";

// One report a day, so a generous cooldown — enough to never double-alert if
// the platform retries the cron, short enough that tomorrow's failure alerts.
const DIGEST_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Daily 7am ET digest (port of the Pipedream flow): emails a CSV of every OOO
 * request approved the previous day. Two UTC crons (11:00 + 12:00) straddle DST
 * so one lands at 7am ET; isApprovalsDigestTime lets exactly one fire. Skips
 * silently on days with zero approvals. `?force=1` bypasses the time gate.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const force = req.nextUrl.searchParams.get("force") === "1";
  const now = Date.now();
  if (!force && !isApprovalsDigestTime(now)) {
    return NextResponse.json({ skipped: "not 7am ET" });
  }

  const recipients = oooApprovalsRecipients();
  if (recipients.length === 0) {
    return NextResponse.json({ skipped: "no recipients configured" });
  }

  const { startIso, endIso } = yesterdayEtRange(now);
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
    return NextResponse.json({ sent: false, count: 0 });
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
  const filename = `${approvalsFileDate(now)} OOO Approvals.csv`;
  const replyTo = oooApprovalsReplyTo();

  // Silent non-delivery is the worst failure mode for a report people rely on,
  // so alert (throttled) on any send error before surfacing the 500 — a slow or
  // disabled Gmail, a lapsed gmail.send scope, etc. The error is re-thrown so
  // the cron still records the failure (and can retry within the time gate).
  try {
    await sendGmailEmail({
      from: oooCalendarActorEmail(),
      to: recipients,
      bcc: oooApprovalsBcc(),
      ...(replyTo ? { replyTo } : {}),
      subject: approvalsSubject(now),
      body: approvalsBody(now),
      attachments: [{ filename, content: csv, mimeType: "text/csv" }],
    });
  } catch (e) {
    await sendThrottledAlert(
      "ooo_approvals_digest",
      DIGEST_ALERT_COOLDOWN_MS,
      oooApprovalsDigestAlert(rows.length, recipients.length, shortErrorReason(e)),
    ).catch(() => {});
    throw e;
  }

  return NextResponse.json({ sent: true, count: rows.length, recipients: recipients.length });
}

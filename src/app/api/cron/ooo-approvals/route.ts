import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { oooApprovalsRecipients, oooCalendarActorEmail } from "@/lib/env";
import { sendGmailEmail } from "@/lib/notify/email";
import {
  approvalsDisplayDate,
  approvalsFileDate,
  buildApprovalsCsv,
  isApprovalsDigestTime,
  yesterdayEtRange,
  type ApprovalRow,
} from "@/lib/ooo/approvals-digest";

export const dynamic = "force-dynamic";

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
  const { data: approvedRows } = await db
    .from("ooo_requests")
    .select(
      "id, legacy_request_id, user_id, manager_id, starts_at, ends_at, decided_at, display_tz_label",
    )
    .eq("status", "approved")
    .gte("decided_at", startIso)
    .lt("decided_at", endIso)
    .order("decided_at", { ascending: true });

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

  // Skip silently on empty days (matches the original flow).
  if (approved.length === 0) {
    return NextResponse.json({ sent: false, count: 0 });
  }

  // Resolve agent + manager names in one lookup.
  const ids = [
    ...new Set(
      approved.flatMap((r) => [r.user_id, r.manager_id]).filter((id): id is string => !!id),
    ),
  ];
  const { data: userRows } = await db.from("users").select("id, name").in("id", ids);
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
  const displayDate = approvalsDisplayDate(now);
  const filename = `${approvalsFileDate(now)} OOO Approvals.csv`;

  await sendGmailEmail({
    from: oooCalendarActorEmail(),
    to: recipients,
    subject: `OOO approvals for ${displayDate}`,
    body:
      `${rows.length} time off ${rows.length === 1 ? "request was" : "requests were"} ` +
      `approved on ${displayDate}. The full list is attached as a CSV.`,
    attachments: [{ filename, content: csv, mimeType: "text/csv" }],
  });

  return NextResponse.json({ sent: true, count: rows.length, recipients: recipients.length });
}

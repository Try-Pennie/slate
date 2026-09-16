import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { appUrl } from "@/lib/env";
import { sendGmailEmail } from "@/lib/notify/email";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { shortErrorReason } from "@/lib/notify/error-text";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { REMINDER_LEAD_MS } from "@/lib/booking/reminder";
import { runBookingReminders, type DueBooking } from "@/lib/booking/reminder-send";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * The 24 hour reminder email lane (#2359).
 *
 * The decision and the copy are pure (`src/lib/booking/reminder.ts`) and the order of
 * effects is pure too (`reminder-send.ts`); this file is the IO and nothing else.
 *
 * It runs every five minutes, which is the precision this needs: the reminder lands
 * within five minutes of the 24 hour mark, and a same day booking is reminded on the
 * next tick rather than at some second schedule. It is NOT on the every minute
 * trigger, which is the invocation already short of CPU headroom (#1245, #2021).
 */

/** One page of candidates per tick. Sized well above real volume: the busiest hour
 *  measured across the whole roster is 230 leads (#2484), so a five minute tick can
 *  never approach this, and a cap that is never reached cannot silently drop a lead. */
const MAX_PER_TICK = 200;

/** One page a day at most about a broken send path, so a bad hour is one message. */
const REMINDER_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const db = supabaseAdmin();
  const now = Date.now();
  const windowEndIso = new Date(now + REMINDER_LEAD_MS).toISOString();
  const nowIso = new Date(now).toISOString();

  /**
   * What this tick READ for each booking's reminder record, so the claim below can
   * compare and swap against the exact value rather than re-stating the rule in a
   * filter. Keyed by booking id, filled by the load.
   */
  const rowsSeen = new Map<string, string | null>();

  const run = await runBookingReminders({
    now: () => now,
    loadDue: async () => {
      // unwrap, NOT a swallowed read. An empty list here is indistinguishable from
      // "nobody needs reminding", which is the normal state, so a failed read would
      // silently stop every reminder and look exactly like a quiet afternoon
      // (#277, the class this repo keeps meeting). A throw fails the tick, and the
      // lane's heartbeat lapses, which is what pages.
      const rows = (unwrap(
        await db
          .from("bookings")
          .select(
            "id, starts_at, reminder_sent_for, status, attendee_email, agent_email, agent_name, timezone, manage_token, buckets!inner(is_test)",
          )
          .in("status", ["confirmed", "rescheduled"])
          .gt("starts_at", nowIso)
          .lte("starts_at", windowEndIso)
          // Test bookings are excluded through the BUCKET, which is where the flag
          // lives: `bookings` has no `is_test` of its own. The canary books and
          // cancels a real row every six hours against a real inbox, and reminding
          // SMOKE about its own fixture would be a live email nobody asked for
          // (#396).
          .eq("buckets.is_test", false)
          .limit(MAX_PER_TICK),
        "bookings due a reminder",
      ) ?? []) as {
        id: string;
        starts_at: string;
        reminder_sent_for: string | null;
        status: string;
        attendee_email: string | null;
        agent_email: string | null;
        agent_name: string | null;
        timezone: string;
        manage_token: string;
      }[];
      for (const r of rows) rowsSeen.set(r.id, r.reminder_sent_for);
      return rows
        .filter((r): r is typeof r & { agent_email: string } => !!r.agent_email)
        .map(
          (r): DueBooking => ({
            id: r.id,
            startsAtIso: r.starts_at,
            reminderSentForIso: r.reminder_sent_for,
            status: r.status,
            attendeeEmail: r.attendee_email,
            agentEmail: r.agent_email,
            // The advisor's name signs the email, so a missing one would sign it
            // "undefined". Their address is the honest fallback: it is who the
            // lead is speaking to either way.
            agentName: r.agent_name ?? r.agent_email,
            timezone: r.timezone,
            manageUrl: `${appUrl()}/booking/manage/${r.manage_token}`,
          }),
        );
    },
    // The CLAIM, and every clause of it is load bearing. It is conditional on the
    // booking still holding this start AND on no reminder having been recorded for
    // it, so two overlapping ticks cannot both send: Postgres decides the winner,
    // not the order the two reads happened in.
    claim: async (id, startsAtIso) => {
      // A compare and swap on the value THIS tick read, rather than a filter that
      // re-states the rule. Two reasons, and the second is the one that bites.
      //
      // It is exact: the write lands only if the row still holds the start and the
      // reminder record this caller judged, so an overlapping tick that claimed
      // first finds the row changed and loses. Postgres decides, not the order two
      // reads happened in.
      //
      // And it keeps the timestamp OUT of a hand built filter string. PostgREST's
      // `.or()` takes one string with commas separating its arms and dots
      // separating operator from value, while a Postgres timestamp renders as
      // `2026-09-17T10:00:00+00:00`. Embedding one in that grammar is a value being
      // parsed as syntax, which is the shape that fails on the character nobody
      // pictured rather than on the common case.
      const seen = rowsSeen.get(id) ?? null;
      let q = db
        .from("bookings")
        .update({ reminder_sent_for: startsAtIso })
        .eq("id", id)
        .eq("starts_at", startsAtIso);
      q = seen === null ? q.is("reminder_sent_for", null) : q.eq("reminder_sent_for", seen);
      const claimed = unwrap(await q.select("id").maybeSingle(), "claim booking reminder") as
        | { id: string }
        | null;
      return !!claimed;
    },
    send: (msg) => sendGmailEmail(msg),
    alert: async (text) => {
      // alert-key: booking_reminder_failed
      // alert-text-ok: the text is built by `reminderFailedAlert`, which carries a
      // short reason rather than the provider's body.
      await sendThrottledAlert("booking_reminder_failed", REMINDER_ALERT_COOLDOWN_MS, text);
    },
  });

  if (run.failed > 0) {
    log.error("booking-reminder", { msg: "reminders failed to send", failed: run.failed }, new Error("reminder send failed"));
  }
  log.info("booking-reminder", {
    msg: "cycle",
    sent: run.sent,
    failed: run.failed,
    skipped: run.skipped,
    lost: run.lost,
  });

  // Stamped at the END, so a tick that threw on the read never stamps and the lane
  // watchdog notices. That is the whole dead man's switch for this lane: nothing
  // else would say the reminders had stopped, because "nothing to send" and "the
  // read is broken" both look like silence (L98).
  await recordHeartbeat("booking-reminders").catch((e) =>
    log.error("booking-reminder", { msg: "heartbeat failed" }, e instanceof Error ? e : new Error(shortErrorReason(e))),
  );

  return NextResponse.json(run);
}

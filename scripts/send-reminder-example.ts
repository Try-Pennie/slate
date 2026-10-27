// Send one example reminder email, 24 hour by default or the 1 hour one with
// REMINDER_EXAMPLE_KIND=hour (#4285), built by the real reminder lane, so
// somebody can see exactly what a lead receives (subject, body, sender name, and the
// contact card with the advisor's calling number and photo).
//
//   REMINDER_EXAMPLE_ADVISOR=marnold@trypennie.com \
//   REMINDER_EXAMPLE_TO=you@trypennie.com \
//   pnpm send:reminder-example            # builds and prints it, sends nothing
//   ... SEND=1 pnpm send:reminder-example # sends it
//
// Optional: REMINDER_EXAMPLE_LEAD (a 00Q lead id whose calling number goes on the
// card; defaults to the advisor's most recent booked lead) and REMINDER_EXAMPLE_TZ
// (the zone the call time is written in; defaults to America/New_York), and
// REMINDER_EXAMPLE_KIND (day, the default, or hour for the 1 hour email, #4285), and
// REMINDER_EXAMPLE_PHONE (the lead's own number the email names, #4292; unset shows
// the "number you gave us" fallback).
//
// It sends FROM the advisor's mailbox (the email lands in their Sent folder) and only
// TO a @trypennie.com inbox. It writes nothing: no booking, no calendar, no alert.
// Reads the Supabase secret key, Google delegation and Salesforce credentials from
// `.env.local` / `.dev.vars` itself, so it needs nothing sourced into the shell (a
// shell `source` cannot read the multi-line Google private key). Deliberately not named `test-*.ts`: that glob is the offline suite.
// The decisions are pinned by `scripts/test-reminder-example.ts`.
import { loadCardPhotoRows } from "@/lib/advisor-photos/store";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { sendGmailEmail } from "@/lib/notify/email";
import { runBookingReminders } from "@/lib/booking/reminder-send";
import { readLeadCallingNumbersLive } from "@/lib/salesforce/lead-calling-number";
import { bookingLeadId } from "@/lib/booking/lookup-identity";
import { isLeadId } from "@/lib/salesforce/lead-xbc";
import { shortErrorReason } from "@/lib/notify/error-text";
import {
  EXAMPLE_EXIT,
  exampleBooking,
  exampleDeps,
  judgeExampleRun,
  readExampleConfig,
} from "./lib/reminder-example.ts";
import { loadEnvFiles } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const parsed = readExampleConfig(process.env);
if (!parsed.ok) {
  console.error(parsed.reason);
  process.exit(EXAMPLE_EXIT.config);
}
const cfg = parsed.config;
const db = supabaseAdmin();

const advisor = unwrap(
  await db.from("users").select("id, name, email").eq("email", cfg.advisorEmail).maybeSingle(),
  "advisor for the reminder example",
) as { id: string; name: string | null; email: string } | null;
if (!advisor) {
  console.error(`No Slate user has the address ${cfg.advisorEmail}.`);
  process.exit(EXAMPLE_EXIT.noAdvisor);
}

let leadId = cfg.leadId;
if (!leadId) {
  // Their most recent booked lead, so the card carries the number that advisor's
  // leads are really called from.
  const rows = unwrap(
    await db
      .from("bookings")
      .select("salesforce_id, external_id")
      .eq("assigned_user_id", advisor.id)
      .order("starts_at", { ascending: false })
      .limit(20),
    "recent bookings for the reminder example",
  ) as { salesforce_id: string | null; external_id: string | null }[];
  leadId = rows.map((r) => bookingLeadId(r)).find((id): id is string => !!id && isLeadId(id)) ?? null;
}
if (!leadId) {
  console.error(
    `${cfg.advisorEmail} has no booked lead to read a calling number from. Name one with REMINDER_EXAMPLE_LEAD.`,
  );
  process.exit(EXAMPLE_EXIT.noLead);
}

const nowMs = Date.now();
const run = await runBookingReminders(
  exampleDeps({
    config: cfg,
    booking: exampleBooking(cfg, advisor, leadId, nowMs),
    nowMs,
    readCallingNumbers: (ids) => readLeadCallingNumbersLive(ids),
    // #3027: the stored directory photos, the same read the reminder lane makes.
    readAdvisorPhotos: (ids) => loadCardPhotoRows(ids),
    sendEmail: (msg) => sendGmailEmail(msg),
    preview: (msg) => {
      console.log(`From:    ${msg.fromName ? `${msg.fromName} <${msg.from}>` : msg.from}`);
      console.log(`To:      ${msg.to.join(", ")}`);
      console.log(`Subject: ${msg.subject}`);
      for (const a of msg.attachments ?? []) console.log(`Attached: ${a.filename} (${a.mimeType})`);
      console.log(`\n${msg.body}\n`);
    },
    warn: (msg, _id, err) => console.error(`warning: ${msg} (${shortErrorReason(err)})`),
  }),
  cfg.kind,
);

const verdict = judgeExampleRun(run, cfg.send);
(verdict.code === EXAMPLE_EXIT.ok ? console.log : console.error)(verdict.message);
process.exit(verdict.code);

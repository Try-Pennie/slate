// Does Slate lift the booking rate over cal.com? (#2898)
// The runbook, with everything below in more detail, is docs/pilot-split-report.md.
//
//   PILOT_SPLIT_CSV=~/Downloads/pilot-split.csv PILOT_SPLIT_PERCENT=50 pnpm report:pilot-split
//   PILOT_SPLIT_CSV=~/Downloads/week1.csv,~/Downloads/week2.csv   (several exports, #2908)
//   PILOT_SPLIT_CSV=~/Downloads/pilot-split/                    (every .csv in a folder)
//   PILOT_SPLIT_PLAN=1 PILOT_SPLIT_LEADS_PER_DAY=180 PILOT_SPLIT_PERCENT=50 \
//     PILOT_SPLIT_BASE_RATE=0.12 PILOT_SPLIT_LIFT=0.02 pnpm report:pilot-split
//
// WHY. The pilot used to be all or nothing, so a before and after comparison could
// not separate a lift from a change in lead mix or day of week. Halo-lab-Trypennie/trypennie#517
// splits Low leads (XBC starting with 1) on `/booking/[SO_ID]` and
// `/my-offers/result` by `slateBucket(submission id)` against
// `SlatePilotPercent__c` (null means 100). This reads both halves over the same
// days and says whether their booking rates differ, with an interval, and how many
// days the split needs before a difference of a given size is readable.
//
// WHERE THE DATA COMES FROM, and why it is a file. GA4 reaches the warehouse only
// as daily totals with no event parameters, so the warehouse cannot split by
// submission; Slate holds no GA4 API credentials. So the input is a GA4 Exploration
// export, downloaded by hand. Setup, once:
//
//   1. GTM: a GA4 Event tag on a Custom Event trigger booking_assignment, sending
//      booking_provider, submission_id and xbc. trypennie pushes the event on every
//      load of both pages (Halo-lab-Trypennie/trypennie#517); without the tag GA4
//      never sees it and this command exits 6. The booker steps already reach GA4
//      as their own event names (view_booker, complete_booking) with both
//      parameters, through the existing Cal Booking Funnel tag.
//   2. GA4 Admin, Custom definitions: register three EVENT scoped custom
//      dimensions, submission_id, booking_provider and xbc, each on the parameter
//      of the same name. Registration is not retroactive.
//   3. Explore, Free form. Rows: Date, submission_id, booking_provider, xbc, Event
//      name. Values: Event count. Filter: Event name matches regex
//      booking_assignment|navigate_to_booker|view_booker|reopen_booker|reload_booker|load_slots|complete_booking|cancel_booking|reschedule_booking|fail_booker_load.
//      Date range: only days SlatePilotPercent__c held one value. Show rows: the
//      largest. The full walkthrough is docs/pilot-split-report.md.
//   4. Share, Download file, CSV. That file is PILOT_SPLIT_CSV; several files, one
//      per week, are read together.
//
// Every lead is counted on the side the split ASSIGNED it, slateBucket under the
// percentage, whichever booker it was later seen in (intention to treat, #3327; see
// scripts/lib/pilot-split.ts, rule 3). So the percentage is always needed:
// PILOT_SPLIT_PERCENT, or SlatePilotPercent__c read from Salesforce as it is now when
// that is unset and Salesforce credentials are here. A lead seen under both providers
// is counted on its side and named as leakage, by direction. A lead is counted once
// per submission, and only if it has a booking_assignment event.
//
// The export must hold ONLY PILOT leads (rule 4): an xbc column (the third custom
// dimension, which trypennie sends with booking_assignment since #517) filters them
// directly; without one, the hash finds the leads that were never in the pilot only
// where their bucket is under the percentage.
//
// PILOT_SPLIT_LIFT, when set outside planning mode, adds a days estimate at the
// volume and cal.com rate the export measured.
//
// THE SLATE CROSS CHECK. With the Supabase secret key in .env.local it reads
// Slate's own routed, real bookings over the export's dates (a day either side,
// since GA4 dates are in the property's zone) and compares their submission ids
// with the Slate side leads whose complete_booking GA4 labelled slate (a booking
// made on cal.com has no Slate row to find). Without the key it says it was skipped.
// It writes nothing anywhere.
//
// Only a comparison made exits 0. Every way of learning nothing exits on its own
// code (L98, L11), and the judgement is pinned by scripts/test-pilot-split.ts:
//
// | exit | what it met |
// |---|---|
// | 0 | a comparison was made (planning mode: an estimate) |
// | 1 | no PILOT_SPLIT_CSV here; nothing was read |
// | 2 | the file is missing, empty, or has no header row |
// | 3 | a required column is missing, named |
// | 4 | a date or event count cannot be read, line named |
// | 5 | PILOT_SPLIT_PERCENT is not a number from 0 to 100 |
// | 6 | no booking_assignment event at all: the GTM tag is not sending it |
// | 7 | retired by #3327 (no xbc and no percentage); every run now needs the percentage, so that is 17 |
// | 8 | the export holds leads outside the pilot and nothing can remove them |
// | 9 | one half has no leads |
// | 10 | plenty of leads and not one booker event in the export |
// | 11 | a half is under the minimum sample: not yet readable |
// | 12 | planning mode is missing an input or was given one it cannot use |
// | 13 | the comparison was made and the Slate cross check could not read Slate |
// | 14 | an export ends exactly on a GA4 row limit, so it was probably cut off; export fewer days per file |
// | 15 | two exports cover the same day, so its leads would be read twice |
// | 16 | the export has an xbc column and no pilot tiers are known (PILOT_SPLIT_TIERS, or SlatePilotTiers__c read from Salesforce) |
// | 17 | no split percentage is known (PILOT_SPLIT_PERCENT, or SlatePilotPercent__c read from Salesforce), so no lead has a side |
//
// It is deliberately NOT named `test-*.ts`: that glob is the offline unit suite.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFiles } from "./smoke-env.ts";
import { ENV_FILES, judgeSupabaseCredentials } from "./lib/supabase-credentials.ts";
import {
  pilotOffersReportLines,
  readPilotOffersForReport,
  type PilotOfferRow,
  type PilotOffersRead,
} from "../src/lib/monitor/pilot-offers.ts";
import {
  judgePilotSplit,
  planFromEnv,
  PILOT_SPLIT_EXIT,
  type SlateCheckInput,
  type SalesforceTiers,
  type SalesforcePercent,
  type ExportFile,
} from "./lib/pilot-split.ts";

loadEnvFiles(ENV_FILES);
const env = process.env;

function print(lines: string[], exit: number): never {
  const write = exit === PILOT_SPLIT_EXIT.compared ? console.log : console.error;
  for (const line of lines) write(line);
  process.exit(exit);
}

if ((env.PILOT_SPLIT_PLAN ?? "").trim() === "1") {
  const plan = planFromEnv(env);
  print(plan.lines, plan.exit);
}

// One export, several separated by commas, or a folder of them (#2908): a split long
// enough to read outgrows one GA4 download, so the runbook exports a week at a time.
const named = (env.PILOT_SPLIT_CSV ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter((p) => p !== "");
let exportFiles: ExportFile[] | null = null;
if (named.length > 0) {
  exportFiles = [];
  for (const path of named) {
    const resolved = path.startsWith("~/") ? `${env.HOME ?? ""}${path.slice(1)}` : path;
    try {
      const files = statSync(resolved).isDirectory()
        ? readdirSync(resolved)
            .filter((f) => f.toLowerCase().endsWith(".csv"))
            .sort()
            .map((f) => join(resolved, f))
        : [resolved];
      if (files.length === 0) {
        print([`FAILED (unreadable-file): ${resolved} is a folder with no .csv files in it`], PILOT_SPLIT_EXIT.unreadableFile);
      }
      for (const f of files) exportFiles.push({ name: f, text: readFileSync(f, "utf8") });
    } catch (err) {
      print(
        [`FAILED (unreadable-file): could not read ${resolved}: ${err instanceof Error ? err.message : String(err)}`],
        PILOT_SPLIT_EXIT.unreadableFile,
      );
    }
  }
}

// Judge once without Slate; only a comparison that stands is worth a Slate read.
let first = judgePilotSplit({ exports: exportFiles, env });

// The pilot tiers (#2946) and the split percentage (#3327): PILOT_SPLIT_TIERS and
// PILOT_SPLIT_PERCENT when set, otherwise SlatePilotTiers__c and SlatePilotPercent__c
// as Salesforce holds them NOW, read once, only when the judgement asks (tiers for an
// export with an xbc column; the percentage for every export, since it decides each
// lead's side). Salesforce keeps no history of either, so today's values stand for
// every day in the export; set the variables for an export from before a change. Each
// value is handed to the judgement AS Salesforce's, which validates it and names the
// Salesforce field in any refusal, never as a setting the person did not set.
let salesforceTiers: SalesforceTiers | undefined;
let salesforcePercent: SalesforcePercent | undefined;
if ((first.needsTiers || first.needsPercent) && ["SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_INSTANCE_URL"].every((n) => env[n]?.trim())) {
  const askedTiers = first.needsTiers;
  try {
    const { readPilotSettings } = await import("@/lib/salesforce/pilot-settings");
    const settings = await readPilotSettings();
    salesforceTiers = { ok: true, value: settings.tiers };
    salesforcePercent = { ok: true, value: settings.percent };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    salesforceTiers = { ok: false, message };
    salesforcePercent = { ok: false, message };
  }
  first = judgePilotSplit({ exports: exportFiles, env, salesforceTiers, salesforcePercent });
  // The percentage's source is in the report itself; the tiers' is said here.
  if (askedTiers && salesforceTiers.ok && first.exit !== PILOT_SPLIT_EXIT.tiersUnknown) {
    console.error(`Pilot tiers from SlatePilotTiers__c as it is now: ${salesforceTiers.value}.`);
  }
}
if (first.exit !== PILOT_SPLIT_EXIT.compared) print(first.lines, first.exit);

async function readSlate(dates: string[]): Promise<SlateCheckInput> {
  const creds = judgeSupabaseCredentials(env);
  if (!creds.ok) {
    // Say which one is absent: a missing URL is not a missing key (L11).
    const missing = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"].filter((n) => !env[n]?.trim());
    return { ok: "skipped", missing };
  }
  try {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const { selectAllPages } = await import("@/lib/supabase/paginate");
    const { partnerKeysFrom } = await import("@/lib/booking/partner-keys");
    const DAY = 86_400_000;
    const from = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - DAY).toISOString();
    const to = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + 2 * DAY).toISOString();
    const db = supabaseAdmin();
    const rows = await selectAllPages<{ id: string; prefill: Record<string, unknown> | null }>("pilot split bookings", "id", () =>
      db
        .from("bookings")
        .select("id, prefill, buckets!inner(is_test)")
        .eq("buckets.is_test", false)
        .eq("kind", "routed")
        .gte("created_at", from)
        .lt("created_at", to),
    );
    const submissionIds = rows
      .map((r) => partnerKeysFrom(r.prefill).submissionId)
      .filter((id): id is string => id !== null);
    return { ok: true, submissionIds };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// #2927: what each booker offered a Low lead over the same days, from the monitor
// lane's quarter hourly samples, so a gap in booking rate can be read against a gap
// in availability. Informational: it never changes the exit code.
async function readOffers(dates: string[]): Promise<PilotOffersRead> {
  const creds = judgeSupabaseCredentials(env);
  const missing = creds.ok
    ? []
    : (() => {
        const absent = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"].filter((n) => !env[n]?.trim());
        return absent.length > 0 ? absent : ["usable Supabase credentials"];
      })();
  return readPilotOffersForReport({
    missing,
    fetchRows: async () => {
      const { supabaseAdmin } = await import("@/lib/supabase/admin");
      const { selectAllPages } = await import("@/lib/supabase/paginate");
      const DAY = 86_400_000;
      const from = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - DAY).toISOString();
      const to = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + 2 * DAY).toISOString();
      const db = supabaseAdmin();
      return selectAllPages<PilotOfferRow>("pilot offer samples", ["sampled_at", "system"], () =>
        db
          .from("pilot_offer_samples")
          .select("sampled_at, system, bucket_code, ok, earliest_offered_at, offered_24h, error, calcom_time_zone")
          .gte("sampled_at", from)
          .lt("sampled_at", to),
      );
    },
  });
}

const slateCheck = await readSlate(first.dates);
const final = judgePilotSplit({ exports: exportFiles, env, slateCheck, salesforceTiers, salesforcePercent });
const offers = await readOffers(first.dates);
print([...final.lines, "", ...pilotOffersReportLines(offers)], final.exit);

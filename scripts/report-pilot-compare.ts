// Slate against cal.com across the 50/50 split on every tier (#2946): booking rate
// and show rate, from each system's own records rather than GA4.
//
//   pnpm report:pilot-compare
//   PILOT_COMPARE_LIFT=0.03 pnpm report:pilot-compare            (size the days estimate for 3 points)
//   PILOT_COMPARE_REHEARSAL_START=2026-09-30 PILOT_COMPARE_REHEARSAL_SPAN_HOURS=12 pnpm report:pilot-compare
//   PILOT_COMPARE_BOOKING_UPDATE=1 pnpm report:pilot-compare      (bookings within 24 hours through yesterday, #3698)
//
// WHAT IT READS, all read only. Salesforce: every `Submission__c` made in the cohort
// (id, CreatedDate, XBC_SO__c, Lead__c, Email_SO__c, Mobile_Number_SO__c,
// Source__c), the
// applications behind any cal.com booking that carries no id (by Email_SO__c), and
// `WebsiteConfiguration__c` as it is now. Slate: every real, routed booking made since
// the window opened, and the quarter hourly readings of the split stored over the
// window (`pilot_settings_samples`, #3641). cal.com: every booking MADE since the window opened, a day and a
// status at a time (#2945: a `past` listing's first page was measured at up to 117 s
// over a week, and never over 3.5 s for a day). Regal: `regal_call_outcomes` (#2944)
// for the booked applications' Leads. Every list read is paginated and refuses on a
// short read. Email addresses and phones are held in memory to match bookings and are
// never printed.
//
// The judgement lives in scripts/lib/pilot-compare.ts and is pinned offline by
// scripts/test-pilot-compare.ts. Only the readout exits 0; every way of learning
// nothing exits on its own code (L98, L11), and every run says what it compared and
// what the stored readings say about the 50 split: CHECKED, CHECKED IN PART (an edit
// inside the window, with the span it leaves unverified), THE SPLIT CHANGED, or, with
// no successful reading, ASSUMED, NOT CHECKED (#3641).
//
// | exit | what it met |
// |---|---|
// | 0 | the readout: the fixed date is reached and the headline is readable |
// | 1 | Salesforce, Supabase or cal.com credentials are missing here; nothing was read |
// | 2 | nothing to judge yet: the window has not opened, or a rehearsal's span has not closed |
// | 3 | Salesforce could not be read |
// | 4 | cal.com could not be read |
// | 5 | Slate could not be read, its bookings or its stored readings of the split |
// | 6 | the Regal call store could not be read |
// | 7 | no application in a pilot tier was made in the cohort |
// | 8 | one side holds no applications |
// | 9 | too many cal.com bookings tied to no application |
// | 10 | the Regal call store holds no call over the span |
// | 11 | a side is under the minimum sample on the booking rate or the show rate |
// | 12 | provisional: before the fixed readout date, or none is fixed yet |
// | 13 | a rehearsal over days outside the window |
// | 14 | what Salesforce holds now contradicts the assumed split |
// | 15 | an input could not be read, or a row carried a time that does not parse |
// | 16 | partial: the window is open and no span has closed yet, so these are rates so far |
// | 17 | a stored reading saw a split other than the assumed one inside the window |
// | 18 | a booking update: bookings within 24 hours through yesterday, never a readout |
//
// PARTIAL (#2976): between the window opening and the first closed span (the first
// whole day is judgeable from 2026-10-10 03:00 ET), the run reports the booking and
// show rates over every application made so far, with every line labelled partial,
// how much of the first full window it covers, an early interval on each rate worded
// as biased low and not a result (#3073), and no verdict. A show counts only once its call is due; the booking rate is biased low
// and the report says so. It always exits 16 unless it refused, never 0, 11 or 12.
//
// Once a comparison is printed, the run exits on the first condition that holds of
// 13, 17, 14, 11, 12, 0, and prints every one that holds.
//
// It is deliberately NOT named `test-*.ts`: that glob is the offline unit suite.
import { loadEnvFiles } from "./smoke-env.ts";
import { ENV_FILES, judgeSupabaseCredentials } from "./lib/supabase-credentials.ts";
import {
  planWindow,
  refusal,
  readSplitReadings,
  calcomChains,
  matchBookings,
  leadKeysToRead,
  judgePilotCompare,
  PILOT_COMPARE_EXIT,
  SHOW_BEFORE_MS,
  SPAN_DAYS,
  CONTACT_READ_TIMEOUT_MS,
  readEveryBatch,
  type Application,
  type SlateBookingRow,
  type RegalCall,
  type PilotSettings,
} from "./lib/pilot-compare.ts";
import { CALCOM_LISTING_STATUSES, followRescheduleChains, phoneKey, type CalcomListedBooking } from "../src/lib/calcom/upcoming-bookings.ts";
import type { PilotSettingsRow } from "../src/lib/monitor/pilot-settings-samples.ts";

loadEnvFiles(ENV_FILES);
const env = process.env;

function print(lines: string[], exit: number): never {
  const write = exit === PILOT_COMPARE_EXIT.compared ? console.log : console.error;
  for (const line of lines) write(line);
  process.exit(exit);
}

const missing = [
  ...["SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_INSTANCE_URL", "CALCOM_API_KEY"].filter((n) => !env[n]?.trim()),
  ...(judgeSupabaseCredentials(env).ok ? [] : ["NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY"]),
];
if (missing.length > 0) {
  print(refusal(PILOT_COMPARE_EXIT.notConfigured, `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set here; nothing was read.`).lines, PILOT_COMPARE_EXIT.notConfigured);
}

const plan = planWindow(Date.now(), env);
if (!plan.ok) print(plan.lines, plan.exit);
const window = plan.window;
const DAY = 86_400_000;
/** SOQL takes a datetime literal without milliseconds. */
const soqlTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const { sfToken, querySoqlComplete } = await import("@/lib/salesforce/rest");
const { chunkSoqlValues, sfInList } = await import("@/lib/salesforce/soql");
const { readPilotSettings } = await import("@/lib/salesforce/pilot-settings");
const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { selectAllPages } = await import("@/lib/supabase/paginate");
const { partnerKeysFrom } = await import("@/lib/booking/partner-keys");
const { isTestSourceBooking } = await import("@/lib/monitor/offsite-origin");
const { calcomBookingsCreated, calcomListedBookingByUid } = await import("@/lib/calcom/client");

interface SubmissionRecord {
  Id: string;
  CreatedDate: string;
  XBC_SO__c: string | null;
  Lead__c: string | null;
  Email_SO__c: string | null;
  Mobile_Number_SO__c: string | null;
  Source__c: string | null;
}
const SUBMISSION_FIELDS = "Id, CreatedDate, XBC_SO__c, Lead__c, Email_SO__c, Mobile_Number_SO__c, Source__c";
const toApplication = (r: SubmissionRecord): Application => ({
  id: r.Id,
  createdAt: r.CreatedDate,
  xbc: r.XBC_SO__c,
  leadId: r.Lead__c,
  email: r.Email_SO__c,
  phone10: phoneKey(r.Mobile_Number_SO__c),
  source: r.Source__c,
});

// --- Salesforce: the cohort and the settings ---------------------------------------------
let auth: { token: string; instanceUrl: string };
let applications: Application[];
let settings: PilotSettings;
try {
  auth = await sfToken();
  settings = await readPilotSettings(auth);
  const records = await querySoqlComplete<SubmissionRecord>(
    auth.instanceUrl,
    auth.token,
    `SELECT ${SUBMISSION_FIELDS} FROM Submission__c WHERE CreatedDate >= ${soqlTime(window.startMs)} AND CreatedDate < ${soqlTime(window.cohortEndMs)}`,
  );
  applications = records.map(toApplication);
} catch (err) {
  print(refusal(PILOT_COMPARE_EXIT.salesforceUnreadable, `Salesforce could not be read: ${errText(err)}`).lines, PILOT_COMPARE_EXIT.salesforceUnreadable);
}

// --- Slate: every real, routed booking made since the window opened ----------------------
let slate: SlateBookingRow[];
try {
  const db = supabaseAdmin();
  const rows = await selectAllPages<{
    id: string;
    prefill: Record<string, unknown> | null;
    created_at: string;
    starts_at: string;
    status: string;
    agent_email: string | null;
    source: string | null;
    referrer_origin: string | null;
  }>("pilot compare bookings", "id", () =>
    db
      .from("bookings")
      .select("id, prefill, created_at, starts_at, status, agent_email, source, referrer_origin, buckets!inner(is_test)")
      .eq("buckets.is_test", false)
      .eq("kind", "routed")
      .gte("created_at", new Date(window.startMs).toISOString())
      .lt("created_at", new Date(window.readEndMs).toISOString()),
  );
  slate = rows.map((r) => ({
    id: r.id,
    submissionId: partnerKeysFrom(r.prefill).submissionId,
    // #3718: the inline card's link always carries `layout=inline`, kept in `prefill`.
    inlineCard: r.prefill?.layout === "inline",
    // #2974: test traffic from a development host, by the one shared predicate.
    // `classifyOrigin` reads a non string parentOrigin as none, so the stored jsonb passes as is.
    testSource: isTestSourceBooking({ prefill: r.prefill as Record<string, string> | null, referrer_origin: r.referrer_origin }),
    createdAt: r.created_at,
    startsAt: r.starts_at,
    status: r.status,
    agentEmail: r.agent_email,
    source: r.source,
  }));
} catch (err) {
  print(refusal(PILOT_COMPARE_EXIT.slateUnreadable, `Slate's bookings could not be read: ${errText(err)}`).lines, PILOT_COMPARE_EXIT.slateUnreadable);
}

// --- Slate: the stored readings of the split over the window (#3641) ---------------------
// A refusal rather than an empty list when they cannot be read: no readings is the old
// assumption, so an unreadable table must never pass for one that holds nothing.
const readingsRead = await readSplitReadings(() =>
  selectAllPages<PilotSettingsRow>("pilot compare split readings", "sampled_at", () =>
    supabaseAdmin()
      .from("pilot_settings_samples")
      .select("sampled_at, ok, read_at, active, percent, tiers, record_modified_at, error")
      .gte("sampled_at", new Date(window.startMs).toISOString())
      .lte("sampled_at", new Date(window.readEndMs).toISOString()),
  ),
);
if (!readingsRead.ok) print(readingsRead.lines, readingsRead.exit);
const readings = readingsRead.ok ? readingsRead.rows : [];

// --- cal.com: every booking made since the window opened, a day and a status at a time ----
const calcom: CalcomListedBooking[] = [];
{
  const deadlineAtMs = Date.now() + 40 * 60_000;
  const byId = new Map<number, CalcomListedBooking>();
  for (let from = window.startMs; from < window.readEndMs; from += DAY) {
    const to = Math.min(from + DAY, window.readEndMs);
    for (const status of CALCOM_LISTING_STATUSES) {
      const read = await calcomBookingsCreated(status, new Date(from).toISOString(), new Date(to).toISOString(), deadlineAtMs);
      if (read === null || !read.ok) {
        const why = read === null ? "cal.com is not configured here" : `${read.reason} (status ${read.status}, page ${read.page})`;
        print(
          refusal(PILOT_COMPARE_EXIT.calcomUnreadable, `cal.com's ${status} bookings made ${new Date(from).toISOString()} to ${new Date(to).toISOString()} could not be read: ${why}.`).lines,
          PILOT_COMPARE_EXIT.calcomUnreadable,
        );
      }
      for (const row of read.rows) byId.set(row.id, row);
    }
  }
  // A reschedule's later links the listing did not hold (a page can shift under a live
  // walk) are read directly by uid, round after round to the chain's end, so a chain
  // is judged at its real last start. A uid cal.com will not return stays an
  // unresolved chain, counted in the report; any other failure refuses by uid.
  const followed = await followRescheduleChains([...byId.values()], async (uid) => {
    const one = await calcomListedBookingByUid(uid, deadlineAtMs);
    return one ?? { ok: false, reason: "refused", status: 0 };
  });
  if (!followed.ok) {
    const why =
      followed.reason === "too-many-hops"
        ? `a reschedule chain was still going after ${followed.hops} links past the listing (next uid ${followed.uid}), so it loops or the data is wrong`
        : `cal.com booking ${followed.uid} could not be read: ${followed.reason} (status ${followed.status})`;
    print(refusal(PILOT_COMPARE_EXIT.calcomUnreadable, `${why}.`).lines, PILOT_COMPARE_EXIT.calcomUnreadable);
  }
  calcom.push(...followed.rows);
}

// --- Salesforce again: the applications behind cal.com bookings that carry no id ----------
const contactApplications: Application[] = [];
try {
  const emails = [
    ...new Set(
      calcomChains(calcom)
        .chains.filter((c) => c.submissionKey === null && c.email !== null)
        .map((c) => c.email as string),
    ),
  ].sort();
  // Email_SO__c is not a selective filter, so a long IN list runs past Salesforce's
  // request timeout; #2945 measured the read at 80 addresses a query, and a first run
  // of this command at the URI budget alone timed out. So at most CONTACT_CHUNK.
  const CONTACT_CHUNK = 50;
  const chunks = chunkSoqlValues(emails).flatMap((c) => Array.from({ length: Math.ceil(c.length / CONTACT_CHUNK) }, (_, i) => c.slice(i * CONTACT_CHUNK, (i + 1) * CONTACT_CHUNK)));
  const records = await readEveryBatch(chunks, (chunk) =>
    querySoqlComplete<SubmissionRecord>(
      auth!.instanceUrl,
      auth!.token,
      `SELECT ${SUBMISSION_FIELDS} FROM Submission__c WHERE Email_SO__c IN (${sfInList(chunk)})`,
      { timeoutMs: CONTACT_READ_TIMEOUT_MS },
    ),
  );
  contactApplications.push(...records.map(toApplication));
} catch (err) {
  print(
    refusal(PILOT_COMPARE_EXIT.salesforceUnreadable, `the applications behind cal.com bookings with no id could not be read: ${errText(err)}`).lines,
    PILOT_COMPARE_EXIT.salesforceUnreadable,
  );
}

const matched = matchBookings({ window, applications: applications!, contactApplications, slate: slate!, calcom });

// --- Regal: the booked applications' calls, and whether the store is filling at all -------
const calls: RegalCall[] = [];
let storedInSpan = 0;
let storeBeganMs: number | null = null;
// A booking update (#3698) reports bookings only, so it reads no calls.
if (window.update === null) {
  try {
    const db = supabaseAdmin();
    const from = new Date(window.startMs - SHOW_BEFORE_MS).toISOString();
    const to = new Date(window.readEndMs).toISOString();
    const keys = leadKeysToRead(matched);
    // 200 ids a request: the PostgREST in() list is measured to fit at 200 and refuse at 400.
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200);
      const rows = await selectAllPages<{ lead_key: string; started_at: string; talk_time_s: number; is_ai_agent: boolean }>(
        "pilot compare calls",
        "id",
        () =>
          db
            .from("regal_call_outcomes")
            .select("id, lead_key, started_at, talk_time_s, is_ai_agent")
            .in("lead_key", chunk)
            .gte("started_at", from)
            .lt("started_at", to),
      );
      calls.push(...rows.map((r) => ({ leadKey: r.lead_key, startedAt: r.started_at, talkTimeS: r.talk_time_s, isAiAgent: r.is_ai_agent })));
    }
    const { count, error } = await db
      .from("regal_call_outcomes")
      .select("id", { count: "exact", head: true })
      .gte("started_at", from)
      .lt("started_at", to);
    if (error) throw new Error(error.message);
    if (count === null) throw new Error("the count of stored calls came back empty");
    storedInSpan = count;
    // The store's first call ever: shows due before it cannot be judged (rule in the judge).
    const first = await db.from("regal_call_outcomes").select("started_at").order("started_at", { ascending: true }).limit(1);
    if (first.error) throw new Error(first.error.message);
    const firstAt = (first.data ?? [])[0]?.started_at;
    storeBeganMs = typeof firstAt === "string" && Number.isFinite(Date.parse(firstAt)) ? Date.parse(firstAt) : null;
  } catch (err) {
    print(refusal(PILOT_COMPARE_EXIT.regalUnreadable, `the Regal call store could not be read: ${errText(err)}`).lines, PILOT_COMPARE_EXIT.regalUnreadable);
  }
}

// A booking update measures its 24 hour window against the newest cohort whose full 7
// days have closed, matched over that full span from the same reads (#3698).
const referenceEndMs = window.update?.referenceEndMs ?? null;
const reference =
  referenceEndMs === null
    ? null
    : matchBookings({
        window: { ...window, spanMs: SPAN_DAYS * DAY, cohortEndMs: referenceEndMs, update: null },
        applications: applications!,
        contactApplications,
        slate: slate!,
        calcom,
      });

const result = judgePilotCompare({ window, settings: settings!, readings, matched, calls: { calls, storedInSpan, storeBeganMs }, reference });
print(result.lines, result.exit);

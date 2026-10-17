// Live positive control for the booking refusal alerts (#1726). Run, from the main
// checkout:
//   pnpm verify:refusal-alerts
//
// WHY THIS IS NOT A UNIT TEST. `booking_api_ceiling`, `booking_api_credential` and
// `booking_api_list_read` (#1442, #1450, #1709) ship ARMED, and so do the embed
// booker's three (#1727), but nothing has refused often enough to reach a floor, so
// the path from a recorded refusal to a built page has never run against the real
// store. A fake agrees with our assumption about that store by construction (L52);
// only a real write and a real read can say the tally, the mix RPC and the window
// carry these names. It talks to the LIVE database, so it is deliberately not named
// `test-*.ts`, the glob of the offline suite.
//
// WHAT IT PROVES. It writes refusals under a MONITOR ONLY bucket (one no request can
// produce, the reason is on `PROBE_BUCKET`), reads the probe's row back after each
// of three intervals' writes, checks the mix RPC the monitor reads carries every
// name, and folds the readings through the real failure rate window and the real
// judges with the SHIPPED thresholds. Every alert must move from a measured clear to
// paging and build a sendable message; the two embed caps, which page on the
// limiter's own rows, must be judged against a live read of those rows. Nothing but
// agreement passes, and every way of learning nothing exits on its own code (L98,
// L11). The exit codes are `VERIFY_EXIT` in `scripts/lib/refusal-alert-live-control.ts`,
// whose decisions `scripts/test-refusal-alert-live-control.ts` pins with fixtures.
//
// WHAT IT WRITES, AND WHAT IT LEAVES. Up to about forty increments of the daily
// tally, all under the probe bucket and all marked as test traffic, which every
// monitor's read leaves out (`p_include_test: false`). It deletes the probe's rows
// for the day when it is done, and says so; if that delete fails it exits 10, and
// the only thing the rows can still move is the outcome panel's count of excluded
// test calls. It reads `rate_limits` as a head count, so no key, email, phone or
// address is read into this process. It posts NOTHING to Slack: the message is
// built and checked, because sending would page the alerts channel about a
// verification, and the transport is the one every other alert uses daily.
//
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (from .env.local, run from
// the main checkout). Its first live run waits for Dan (#1726).
import { loadEnvFiles } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

// Imported after the env files are loaded: a static import is hoisted above the
// call above, so a module reading the environment as it loads would read it unset.
const { VERIFY_EXIT, PROBE_BUCKET, judgeProbeRun, probeNames, bumpsForInterval } = await import(
  "./lib/refusal-alert-live-control.ts"
);
const { outcomeTallyArgs, OUTCOME_DAY_ZONE } = await import("@/lib/monitor/booking-api-outcome");
const { countLockedOutKeys } = await import("@/lib/monitor/embed-lockouts-store");
const { BOOKING_HOURLY_RATE_RULES, BOOKING_CONTACT_HOURLY_RATE_RULES } = await import("@/lib/rate-limit-core");
const { DateTime } = await import("luxon");

function fail(code: number, why: string): never {
  console.error(`\nFAILED (exit ${code}): ${why}`);
  process.exit(code);
}

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  fail(
    VERIFY_EXIT.misconfigured,
    "NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY is not set, so nothing was attempted. Run from the main checkout, where .env.local holds them.",
  );
}

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const db = supabaseAdmin();

// One instant for every write, so a run that crosses midnight ET keeps its rows on
// one day and the read back never compares two days' counts.
const startMs = Date.now();
const day = DateTime.fromMillis(startMs, { zone: OUTCOME_DAY_ZONE }).toISODate() ?? "";
const names: string[] = probeNames();

/** Delete the probe's rows for the day. Returns the error text, or null. Run on
 *  every ending after the first write, so a failed run leaves nothing either. */
async function removeProbeRows(): Promise<string | null> {
  const { error, count } = await db
    .from("booking_api_outcome_daily")
    .delete({ count: "exact" })
    .eq("day", day)
    .eq("bucket_code", PROBE_BUCKET)
    .eq("is_test", true);
  if (error) {
    console.error(`  the probe's rows could not be deleted: ${error.message}`);
    return error.message;
  }
  console.log(`  removed the probe's ${count ?? 0} tally rows`);
  return null;
}

/** Fail after cleaning up: the code is the failure's own, never the cleanup's. */
async function stop(code: number, why: string): Promise<never> {
  await removeProbeRows();
  return fail(code, why);
}

async function readProbeRow(): Promise<Record<string, number>> {
  const { data, error } = await db
    .from("booking_api_outcome_daily")
    .select("outcome, count")
    .eq("day", day)
    .eq("bucket_code", PROBE_BUCKET)
    .eq("error_code", "")
    .eq("is_test", true)
    .eq("host_class", "none")
    .in("outcome", names);
  if (error) return stop(VERIFY_EXIT.readFailed, `the probe's tally row could not be read: ${error.message}`);
  const out: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  for (const r of (data ?? []) as { outcome: string; count: number }[]) out[r.outcome] = r.count;
  return out;
}

async function write(counts: Record<string, number>): Promise<void> {
  for (const [outcome, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      const args = outcomeTallyArgs({ outcome, bucketCode: PROBE_BUCKET, errorCode: null, isTest: true, hostClass: "none", atMs: startMs });
      const { error } = await db.rpc("bump_booking_api_outcome", args);
      if (error) await stop(VERIFY_EXIT.writeRefused, `bump_booking_api_outcome refused ${outcome}: ${error.message}`);
    }
  }
}

console.log(`Booking refusal alerts live control, ${day} (ET), probe bucket ${PROBE_BUCKET.slice(0, 40)}...`);

const readings: Record<string, number>[] = [];
readings.push(await readProbeRow());
console.log("  baseline read");
readings.push(await readProbeRow());
console.log("  zero interval read (nothing written)");
for (const k of [0, 1, 2]) {
  const counts = bumpsForInterval(k);
  await write(counts);
  readings.push(await readProbeRow());
  console.log(`  interval ${k + 1}: wrote ${Object.values(counts).reduce((a, b) => a + b, 0)} refusals and read the row back`);
}

// The read the monitor makes, with test traffic included so the probe's own rows
// are in it: every name must come through by_outcome at no less than the probe's
// own count, or the window could never see it.
const { data: mix, error: mixError } = await db.rpc("booking_api_outcome_mix", {
  p_since: day,
  p_include_test: true,
  p_include_offsite: true,
});
if (mixError) await stop(VERIFY_EXIT.readFailed, `booking_api_outcome_mix could not be read: ${mixError.message}`);
const byOutcome = ((mix as { by_outcome?: Record<string, number> } | null)?.by_outcome ?? {}) as Record<string, number>;
const mixCarried = Object.fromEntries(names.map((n) => [n, (byOutcome[n] ?? 0) >= (readings[4]![n] ?? 0)]));

// The limiter's own rows, which the embed caps page on. Read only, a head count.
let lockouts: { addresses: number | null; contactKeys: number | null } | null;
try {
  lockouts = {
    addresses: await countLockedOutKeys(BOOKING_HOURLY_RATE_RULES[0]!, Date.now()),
    contactKeys: await countLockedOutKeys(BOOKING_CONTACT_HOURLY_RATE_RULES[0]!, Date.now()),
  };
  console.log(`  locked out right now: ${lockouts.addresses} addresses, ${lockouts.contactKeys} emails or phones`);
} catch (err) {
  console.error(`  the locked out count could not be read: ${err instanceof Error ? err.message : String(err)}`);
  lockouts = null;
}

const verdict = judgeProbeRun({ day, startMs, readings, mixCarried, lockouts });
for (const line of verdict.lines) console.log(`  ${line}`);

// Leave nothing behind, whatever the verdict, and say what was removed.
const delError = await removeProbeRows();

if (!verdict.ok) fail(verdict.exitCode, verdict.message);
if (delError) fail(VERIFY_EXIT.leftRows, "every alert passed, and the probe's rows are still in the tally (test traffic, excluded from every monitor)");
console.log("\nPASSED: every booking refusal alert moved from a measured clear to paging, or was judged against the live limiter, and built its message.");
process.exit(VERIFY_EXIT.passed);

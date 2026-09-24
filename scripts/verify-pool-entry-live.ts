// Live proof of the activation gate's calendar reads (#2316). Run:
//   POOL_ENTRY_READABLE_EMAIL=agent@trypennie.com \
//   POOL_ENTRY_UNPROVISIONED_EMAIL=departed@trypennie.com \
//   pnpm verify:pool-entry
//
// WHY THIS IS NOT A UNIT TEST. #2302 made the pool entry calendar read the second
// half of the activation gate, so a failure there REFUSES the flip. Its refusal
// paths are driven by hand written fakes, and a fake agrees with our assumption
// about Google's interface by construction (L52). If `onboardIntoPool` is broken
// in a way the fakes cannot show, no agent can be made bookable at all, and the
// first sign would be a new hire failing to activate with a page blaming their
// calendar.
//
// WHY BOTH DIRECTIONS. A readable agent must come back with every calendar
// hydrated, and an account with no Calendar licence (403 notACalendarUser) must be
// refused as not provisioned. One direction proves nothing, because a gate hard
// wired to a single answer satisfies it (L1).
//
// WHAT IT WRITES, AND WHY THAT IS SAFE. It runs the gate's two reads exactly as
// `applyBookableToRow` composes them, and NOTHING around them: no alert, no
// `bookable_pending_since` mark, no bookable write. The reachability probe only
// lists calendars. `onboardIntoPool` does write, and it is run ONLY for an agent
// who is already bookable and active (refused otherwise, exit 5 and 6), where
// every write it makes is a refresh the lanes make on their own schedule: a watch
// renewal only if one is already due (the watch lane, every five minutes), a
// re-bootstrap of the busy window (the hydration lane, daily for every calendar),
// and `last_synced_at` (the sync lane, every minute). It never flips anybody's
// bookable flag. For the unlicensed account the pool entry read is never run,
// exactly as the real gate never runs it once the probe refuses.
//
// It talks to LIVE Google and Supabase, so it is deliberately NOT named
// `test-*.ts` (that glob is the offline unit suite). Its decision logic is pinned
// offline by scripts/test-pool-entry-live-control.ts.
//
// Needs the Google service account creds and the Supabase secret key in
// .env.local / .dev.vars.
//
// EVERY way of learning nothing exits non-zero on its own code (L98); the table
// is in AGENTS.md and in OUTCOMES.
import { loadEnvFiles } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { checkActivationGate } = await import("@/lib/bookable/service");
const { classifyCalendarReachability } = await import("@/lib/google/reachability");
const { onboardIntoPool } = await import("@/lib/google/pool-entry");
const { ACTIVATION_BUDGET_MS } = await import("@/lib/bookable/activation-allowance");
const { withinBudget } = await import("@/lib/google/sync-pace");
const { shortErrorReason } = await import("@/lib/notify/error-text");
const { OUTCOMES, readInputs, checkSubjects, judgeReadable, judgeUnprovisioned, settle } = await import(
  "./lib/pool-entry-live-check.ts"
);
type OutcomeCode = import("./lib/pool-entry-live-check.ts").OutcomeCode;
type SubjectRow = import("./lib/pool-entry-live-check.ts").SubjectRow;
type EntryReading = import("./lib/pool-entry-live-check.ts").EntryReading;

/** Every refusal exits on its OWN code, and says which refusal it is. */
function fail(code: OutcomeCode, why: string): never {
  console.error(`\nFAILED (${code}, exit ${OUTCOMES[code].exit}): ${why}`);
  process.exit(OUTCOMES[code].exit);
}

const inputs = readInputs(process.env);
if (!inputs.ok) fail(inputs.code, inputs.why);

const db = supabaseAdmin();

async function lookup(email: string): Promise<SubjectRow | null> {
  // Exact match, as the gate's own by-email lookup does: ilike would treat `_`
  // and `%` as wildcards and could resolve the WRONG user.
  const { data, error } = await db
    .from("users")
    .select("id, email, bookable, deactivated_at")
    .eq("email", email)
    .maybeSingle();
  if (error) fail("users-unreadable", `${OUTCOMES["users-unreadable"].meaning}: ${error.message}`);
  if (!data) return null;
  const row = data as { id: string; email: string; bookable: boolean; deactivated_at: string | null };
  return { id: row.id, email: row.email, bookable: row.bookable, deactivatedAt: row.deactivated_at };
}

const readable = await lookup(inputs.readableEmail);
const unprovisioned = await lookup(inputs.unprovisionedEmail);
const subjectRefusal = checkSubjects(readable, unprovisioned);
if (subjectRefusal) fail(subjectRefusal.code, subjectRefusal.why);
// checkSubjects refused every null above; narrowed for the compiler.
const r = readable as SubjectRow;
const u = unprovisioned as SubjectRow;

const gateDeps = { checkReachable: classifyCalendarReachability };

// ---- the unlicensed account: the probe half only, which only lists calendars.
console.log(`Unprovisioned direction: ${u.email}`);
const unprovisionedProbe = await checkActivationGate(u.email, u.id, gateDeps);
const uVerdict = judgeUnprovisioned(unprovisionedProbe?.reason ?? null);
console.log(`  gate probe: ${unprovisionedProbe?.reason ?? "admitted"}`);
console.log(`  ${uVerdict.ok ? "PROVED " : "FAILED "} ${uVerdict.detail}`);

// ---- the readable agent: the probe, then the pool entry read, as the gate runs them.
console.log(`\nReadable direction: ${r.email}`);
// The deadline is taken BEFORE the probe, as the gate takes it (#2317).
const deadlineMs = Date.now() + ACTIVATION_BUDGET_MS;
const readableProbe = await checkActivationGate(r.email, r.id, gateDeps);
console.log(`  gate probe: ${readableProbe?.reason ?? "admitted"}`);
let entry: EntryReading = { kind: "not-run" };
if (readableProbe === null) {
  try {
    const result = await onboardIntoPool(r.id, undefined, {
      withinBudget: () => withinBudget(Date.now(), deadlineMs),
    });
    entry = { kind: "result", result };
    console.log(
      `  pool entry read: ${result.calendars} calendar(s), ${result.hydrated} hydrated, ` +
        `${result.failed} failed, watch ${result.watch}, out of budget ${result.outOfBudget}`,
    );
  } catch (err) {
    entry = { kind: "threw", detail: shortErrorReason(err, { fallback: "no detail" }) };
  }
}
const rVerdict = judgeReadable(readableProbe?.reason ?? null, entry);
console.log(`  ${rVerdict.ok ? "PROVED " : "FAILED "} ${rVerdict.detail}`);

if (entry.kind === "result") {
  // Read back what the run left on the calendar rows, from the table the
  // availability path reads, so the report shows the horizon reached rather than
  // only the count the function returned. Informational: the verdict above is the
  // gate's own answer, which is what this command exists to prove.
  const { data: cals, error: calErr } = await db
    .from("agent_calendars")
    .select("calendar_id, sync_window_to, consecutive_failures")
    .eq("user_id", r.id);
  if (calErr) {
    console.log(`  (could not read the calendar rows back: ${calErr.message})`);
  } else {
    for (const c of (cals ?? []) as { calendar_id: string; sync_window_to: string | null; consecutive_failures: number }[]) {
      console.log(`  calendar ${c.calendar_id}: hydrated to ${c.sync_window_to ?? "never"}, consecutive sync failures ${c.consecutive_failures}`);
    }
  }
}

const outcome = settle(rVerdict, uVerdict);
if (outcome.code !== "passed") fail(outcome.code, OUTCOMES[outcome.code].meaning);
console.log(`\nPASSED: ${OUTCOMES.passed.meaning}.`);

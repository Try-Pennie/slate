import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { defaultRuleRows, type OrgDefaults } from "@/lib/schedule-core";
import { selectAllPages } from "@/lib/supabase/paginate";

/**
 * Gives every agent without working hours the org default (newly-synced agents
 * arrive schedule-less and would show zero availability once bookable).
 * Idempotent: an agent whose schedule already holds rules is never touched, so
 * hours personalized on /me survive. Returns how many agents were filled in.
 *
 * #1670 widened "without": a schedule ROW is not working hours, its RULES are.
 * `isWithinWorkingHours` rejects every instant against an empty rule set, so a row
 * with no rules leaves the agent exactly as unbookable as no row at all, and this
 * fill keyed on the row, so it walked past them forever. The empty ones are filled
 * through the same atomic `replace_availability_rules` the hours editors use, so a
 * concurrent fill converges on one week instead of doubling the rules.
 */
export async function ensureDefaultSchedules(orgId: string): Promise<number> {
  const db = supabaseAdmin();

  // #2542: `unwrap`, not a swallowed read. A failed read arrives here as "no
  // org row", this returns 0, and the caller reads that as "every agent already
  // has hours" while newly synced agents keep zero availability.
  const org = unwrap(
    await db
      .from("organizations")
      .select(
        "default_timezone, default_start_minute, default_end_minute, default_weekdays",
      )
      .eq("id", orgId)
      .single(),
    "ensureDefaultSchedules org defaults",
  );
  if (!org) return 0;
  const defaults = org as unknown as OrgDefaults;

  // The same #2542 reading applies to both of these, and the second is the
  // dangerous one: an unreadable `availability_schedules` makes EVERY agent look
  // uncovered, and this fill then replaces a week somebody personalised on /me.
  const [usersRes, schedulesRes, ruleRows] = await Promise.all([
    db.from("users").select("id").eq("org_id", orgId),
    db.from("availability_schedules").select("id, user_id"),
    // Paged: one rule per agent per working weekday, so the 200-agent design
    // target is ~1,400 rows and a single page would silently stop at 1,000,
    // which here reads as "these agents have no working hours" and would refill
    // a week somebody had personalized.
    selectAllPages<{ schedule_id: string }>("ensureDefaultSchedules rules", "id", () =>
      db.from("availability_rules").select("id, schedule_id"),
    ),
  ]);
  const users = unwrap(usersRes, "ensureDefaultSchedules users");
  const schedules = unwrap(schedulesRes, "ensureDefaultSchedules schedules");
  const scheduleRows = (schedules ?? []) as { id: string; user_id: string }[];
  const withRules = new Set(ruleRows.map((r) => r.schedule_id));
  const covered = new Set(
    scheduleRows.filter((s) => withRules.has(s.id)).map((s) => s.user_id),
  );
  const orgUsers = ((users ?? []) as { id: string }[]).filter(
    (u) => !covered.has(u.id),
  );
  const hasRow = new Map(scheduleRows.map((s) => [s.user_id, s.id]));

  // Two populations, one repair. An agent with no row needs one created; an agent
  // with a row and no rules needs the rules, and creating a second row for them is
  // impossible anyway (the user_id unique index, #532).
  const missing = orgUsers.filter((u) => !hasRow.has(u.id));
  const emptyScheduleIds = orgUsers
    .filter((u) => hasRow.has(u.id))
    .map((u) => hasRow.get(u.id)!);

  // Each agent's refill is its OWN failure. One that cannot be written must not
  // abort the others, and must not abort the row creation below it either: the
  // two populations are unrelated repairs, and a loop that throws on the first
  // one silently leaves every later agent unfixed while the caller sees a single
  // error (L71). Failures are collected and raised together at the end, so the
  // monitor's recheck still reports whoever is left AND the reason is loud.
  const refillFailures: string[] = [];
  let refilled = 0;
  for (const scheduleId of emptyScheduleIds) {
    const wanted = defaultRuleRows(scheduleId, defaults);
    // The RPC refuses an empty rule set by design, and it is right to: writing
    // one is the very state being repaired. Org defaults that produce no week
    // are an org configuration fault, said as itself rather than as a Postgres
    // check violation.
    if (wanted.length === 0) {
      refillFailures.push(`${scheduleId}: the org defaults produce no week`);
      continue;
    }
    const { data: written, error: rpcError } = await db.rpc("replace_availability_rules", {
      p_schedule_id: scheduleId,
      p_rules: wanted,
      // #1753: the fill is a SEED, and saying so is what lets the unset hours
      // detector tell this week from one somebody chose.
      p_source: "seed",
    });
    if (rpcError) {
      refillFailures.push(`${scheduleId}: ${rpcError.message}`);
      continue;
    }
    // Same rule as every other caller of this RPC: claim success only on the count
    // the database reports, never on the absence of an error.
    if (written !== wanted.length) {
      refillFailures.push(
        `${scheduleId}: wrote ${typeof written === "number" ? written : "an unreadable count"} of ${wanted.length} days`,
      );
      continue;
    }
    refilled += 1;
  }

  const raiseRefillFailures = () => {
    if (refillFailures.length) {
      throw new Error(
        `could not fill working hours for ${refillFailures.length} schedule(s): ${refillFailures.join("; ")}`,
      );
    }
  };

  if (missing.length === 0) {
    raiseRefillFailures();
    return refilled;
  }

  // Upsert (not insert) so a concurrent fill settles on the (user_id) unique
  // index (#532): ignoreDuplicates makes each already-covered agent a no-op, and
  // .select returns only the rows this call actually created, so rules are added
  // for exactly those.
  const { data: created, error } = await db
    .from("availability_schedules")
    .upsert(
      missing.map((u) => ({
        user_id: u.id,
        timezone: defaults.default_timezone,
        // #1753: this path writes the rules directly rather than through the RPC,
        // so it stamps the seed itself. A new agent's week is nobody's choice yet.
        hours_source: "seed" as const,
        hours_set_at: new Date().toISOString(),
      })),
      { onConflict: "user_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error || !created) {
    throw new Error(`default schedules insert failed: ${error?.message}`);
  }

  const rules = (created as { id: string }[]).flatMap((s) =>
    defaultRuleRows(s.id, defaults),
  );
  if (rules.length) {
    const { error: ruleError } = await db
      .from("availability_rules")
      .insert(rules);
    if (ruleError) {
      throw new Error(`default rules insert failed: ${ruleError.message}`);
    }
  }
  raiseRefillFailures();
  return created.length + refilled;
}

// Import each agent's real working hours and timezone from cal.com (#1738, #1739).
//
//   pnpm import:calcom-schedules            # dry run: prints what WOULD change
//   APPLY=1 pnpm import:calcom-schedules    # writes
//
// WHY. Slate holds one seeded window for the whole roster (Mon to Fri, 08:00 to
// 17:00, `America/New_York` for all 117 rows) that nobody has ever edited. cal.com
// holds what these agents have actually been maintaining. Measured 2026-09-02:
// 81 of 100 have different hours, and 74 of 103 are not Eastern. Cutting the
// landing pages over (#65) against the seeded week would offer leads times most of
// the roster is not working, and nothing would report it, because a schedule that
// says 08:00 Eastern is indistinguishable from an agent who really works then.
//
// THE ZONE AND THE HOURS ARE WRITTEN TOGETHER. Rules are minutes from local
// midnight read in the schedule's zone, so importing hours alone would move an
// agent's window to their real local times while Slate still read it as Eastern:
// a Phoenix agent becomes differently wrong rather than right.
//
// IT WRITES THROUGH SLATE'S OWN VALIDATOR AND RPC, never its own SQL:
// `planScheduleReplacement` is the one validator every write path uses, and
// `replace_availability_rules` is the atomic replacement the admin screens use. A
// second implementation here would be a second set of rules to keep in step, and
// the validator is where the refusals live that stop a broken week being written.
//
// IT REFUSES RATHER THAN GUESSES. An agent whose cal.com schedule cannot be read,
// or whose week Slate's validator will not accept (a split shift is two windows on
// one weekday, which the validator refuses by design), is SKIPPED and named. It is
// not defaulted to Eastern and not merged into a single window: defaulting is
// precisely how the roster came to claim a timezone three quarters of it does not
// have.
//
// IT IS IDEMPOTENT and safe to re-run. An agent already matching cal.com is left
// alone, so a run interrupted part way is repaired by running it again.
import { loadEnvFiles, envOr } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
const { planScheduleReplacement } = await import("@/lib/schedule-replacement");
const { mapCalcomSchedule, diffSchedule, retryDelayMs, skipKindForStatus, paceMs } =
  await import("./lib/calcom-schedule-import.ts");

const apply = process.env.APPLY === "1";
const calcomKey = process.env.CALCOM_API_KEY ?? "";
const org = envOr(process.env.CALCOM_ORG_ID, "19474");

const EXIT = {
  ok: 0,
  notConfigured: 1,
  nothingToDo: 2,
  needsAPerson: 3,
  writeFailed: 4,
  rateLimited: 5,
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A cal.com GET that survives the rate limit.
 *
 * The first real run met 429 on 89 of 103 agents. cal.com meters this endpoint
 * hard, so every read retries on its own instruction (Retry-After) or an
 * exponential backoff, and a small pause between agents keeps the run under the
 * limit rather than earning one refusal per agent.
 */
async function calGet(path: string): Promise<{ status: number; json: unknown }> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`https://api.cal.com/v2${path}`, { headers: H });
    } catch (err) {
      const wait = retryDelayMs(503, null, attempt);
      if (wait === null) throw err;
      await sleep(wait);
      continue;
    }
    if (res.ok) return { status: res.status, json: await res.json().catch(() => null) };
    const wait = retryDelayMs(res.status, res.headers.get("retry-after"), attempt);
    if (wait === null) return { status: res.status, json: null };
    await sleep(wait);
  }
}

/** Between agents, so a 103-agent run does not trip the limit in the first place.
 *  Parsed through `paceMs`, which refuses a value a timer would treat as zero. */
const PACE_MS = paceMs(process.env.CALCOM_PACE_MS);

function stop(code: number, why: string): never {
  console.error(`\nFAILED (${code}): ${why}`);
  process.exit(code);
}

if (!calcomKey) {
  stop(EXIT.notConfigured, "no CALCOM_API_KEY here, so nothing was attempted. Add it to .env.local.");
}

const H = {
  Authorization: `Bearer ${calcomKey}`,
  "cal-api-version": "2024-09-04",
};
const db = supabaseAdmin();

console.log(apply ? "APPLYING changes to production\n" : "DRY RUN: nothing will be written\n");

// --- who ----------------------------------------------------------------------
const agents = (unwrap(
  await db
    .from("users")
    .select("id, email")
    .eq("bookable", true)
    .is("deactivated_at", null)
    .eq("is_test", false),
  "bookable agents",
) ?? []) as { id: string; email: string }[];

const scheds = (unwrap(
  await db
    .from("availability_schedules")
    .select("id, user_id, timezone")
    .in("user_id", agents.map((a) => a.id)),
  "schedules",
) ?? []) as { id: string; user_id: string; timezone: string }[];

const rules = (unwrap(
  await db
    .from("availability_rules")
    .select("schedule_id, weekday, start_minute, end_minute")
    .in("schedule_id", scheds.map((s) => s.id)),
  "rules",
) ?? []) as { schedule_id: string; weekday: number; start_minute: number; end_minute: number }[];

const schedByUser = new Map(scheds.map((s) => [s.user_id, s]));

// cal.com's org listing, one read for the whole roster.
const listRes = await fetch(`https://api.cal.com/v2/organizations/${org}/users?take=250`, { headers: H });
if (!listRes.ok) stop(EXIT.notConfigured, `cal.com org users returned ${listRes.status}`);
const listJson = (await listRes.json()) as { data?: { id: number; email: string }[] };
const calId = new Map((listJson.data ?? []).map((u) => [u.email.toLowerCase(), u.id]));
console.log(`${agents.length} bookable agents, ${calId.size} users listed in cal.com\n`);

// --- compare ------------------------------------------------------------------
interface Change {
  email: string;
  userId: string;
  scheduleId: string;
  reasons: string[];
  plan: { rules: { weekday: number; start_minute: number; end_minute: number }[]; timezone: string };
}
const changes: Change[] = [];
const unchanged: string[] = [];
const skipped: { email: string; why: string; kind: "transient" | "permanent" }[] = [];

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const render = (rs: { weekday: number; start_minute: number; end_minute: number }[]) => {
  const days = [...new Set(rs.map((r) => r.weekday))].sort().join("");
  const windows = [...new Set(rs.map((r) => `${hhmm(r.start_minute)}-${hhmm(r.end_minute)}`))];
  return `days ${days} ${windows.join(" / ")}`;
};

for (const agent of agents) {
  const sched = schedByUser.get(agent.id);
  if (!sched) {
    skipped.push({ email: agent.email, why: "no availability_schedules row in Slate", kind: "permanent" });
    continue;
  }
  const cid = calId.get(agent.email.toLowerCase());
  if (!cid) {
    skipped.push({ email: agent.email, why: "no cal.com account, so there is nothing to import", kind: "permanent" });
    continue;
  }
  let calSchedule: unknown;
  try {
    await sleep(PACE_MS);
    const r = await calGet(`/organizations/${org}/users/${cid}/schedules`);
    if (r.status < 200 || r.status >= 300) {
      skipped.push({
        email: agent.email,
        why: `cal.com schedules returned ${r.status}`,
        kind: skipKindForStatus(r.status),
      });
      continue;
    }
    const list = ((r.json as { data?: { isDefault?: boolean }[] })?.data ?? []);
    calSchedule = list.find((x) => x.isDefault) ?? list[0];
  } catch (err) {
    // A thrown fetch is a transport problem, the same class as a 5xx.
    skipped.push({ email: agent.email, why: `cal.com read threw: ${String(err).slice(0, 80)}`, kind: "transient" });
    continue;
  }
  if (!calSchedule) {
    skipped.push({ email: agent.email, why: "no schedule in cal.com", kind: "permanent" });
    continue;
  }
  const mapped = mapCalcomSchedule(calSchedule as never);
  if (!mapped.ok) {
    skipped.push({ email: agent.email, why: mapped.why, kind: "permanent" });
    continue;
  }
  // Slate's own validator decides whether this week may be written. A split shift
  // (two windows on one weekday) is refused here BY DESIGN, and merging the two
  // into one would invent hours the agent never set.
  const plan = planScheduleReplacement(mapped.rules, mapped.timezone);
  if (!plan.ok) {
    skipped.push({ email: agent.email, why: `Slate will not accept this week: ${plan.error}`, kind: "permanent" });
    continue;
  }
  const currentRules = rules.filter((r) => r.schedule_id === sched.id);
  const diff = diffSchedule(
    { timezone: sched.timezone, rules: currentRules },
    { timezone: plan.timezone, rules: plan.rules },
  );
  if (!diff.changed) {
    unchanged.push(agent.email);
    continue;
  }
  changes.push({
    email: agent.email,
    userId: agent.id,
    scheduleId: sched.id,
    reasons: diff.reasons,
    plan: { rules: plan.rules, timezone: plan.timezone },
  });
  console.log(`${agent.email}`);
  console.log(`   now:  ${sched.timezone}  ${render(currentRules)}`);
  console.log(`   new:  ${plan.timezone}  ${render(plan.rules)}`);
  console.log(`   why:  ${diff.reasons.join("; ")}`);
}

console.log(`\n--- summary ---`);
console.log(`would change: ${changes.length}`);
console.log(`already matching: ${unchanged.length}`);
// Transient and permanent skips are reported apart, because the action is
// completely different: one wants another run, the other wants a person.
const transient = skipped.filter((s) => s.kind === "transient");
const permanent = skipped.filter((s) => s.kind === "permanent");
console.log(`skipped, needs a person: ${permanent.length}`);
for (const s of permanent) console.log(`   ${s.email}: ${s.why}`);
console.log(`skipped, transient (re-run reaches them): ${transient.length}`);
if (transient.length > 0) {
  const kinds = new Map<string, number>();
  for (const s of transient) kinds.set(s.why, (kinds.get(s.why) ?? 0) + 1);
  for (const [why, n] of kinds) console.log(`   ${n}x ${why}`);
}

if (changes.length === 0) {
  if (transient.length > 0) {
    stop(EXIT.rateLimited, `nothing changed, and ${transient.length} agent(s) were never read. Run it again.`);
  }
  if (permanent.length > 0) {
    stop(EXIT.needsAPerson, `nothing to change, but ${permanent.length} agent(s) need a person`);
  }
  console.log("\nEvery agent already matches cal.com.");
  process.exit(EXIT.ok);
}

if (!apply) {
  console.log(`\nDRY RUN: nothing was written. Re-run with APPLY=1 to write these ${changes.length} change(s).`);
  process.exit(EXIT.ok);
}

// --- write --------------------------------------------------------------------
// Rules FIRST, then the timezone, and both verified by reading back. A run that
// dies between them leaves an agent with new hours in their old zone, which the
// next run repairs, because the diff still reports them as changed.
let wrote = 0;
const writeFailures: { email: string; why: string }[] = [];
for (const c of changes) {
  try {
    const { data, error } = await db.rpc("replace_availability_rules", {
      p_schedule_id: c.scheduleId,
      p_rules: c.plan.rules,
    });
    if (error) throw new Error(`rules: ${error.message}`);
    // Judge on the count the database reports, never on the absence of an error: a
    // write that landed a different number of rules is a silently wrong week.
    const written = typeof data === "number" ? data : Number.NaN;
    if (written !== c.plan.rules.length) {
      throw new Error(`rules: asked for ${c.plan.rules.length}, database recorded ${Number.isFinite(written) ? written : "an unreadable count"}`);
    }
    const tz = await db
      .from("availability_schedules")
      .update({ timezone: c.plan.timezone })
      .eq("id", c.scheduleId)
      .select("id, timezone");
    if (tz.error) throw new Error(`timezone: ${tz.error.message}`);
    const back = (tz.data ?? []) as { timezone: string }[];
    if (back.length !== 1 || back[0].timezone !== c.plan.timezone) {
      throw new Error(`timezone: read back ${back.length === 1 ? back[0].timezone : `${back.length} rows`}`);
    }
    wrote++;
    console.log(`wrote ${c.email}`);
  } catch (err) {
    writeFailures.push({ email: c.email, why: String(err).slice(0, 160) });
    console.error(`FAILED ${c.email}: ${String(err).slice(0, 160)}`);
  }
}

console.log(`\nwritten: ${wrote} of ${changes.length}`);
if (writeFailures.length > 0) {
  stop(EXIT.writeFailed, `${writeFailures.length} agent(s) could not be written; re-running repairs a partial write`);
}
if (transient.length > 0) {
  stop(EXIT.rateLimited, `${wrote} written, but ${transient.length} agent(s) were never read. Run it again to reach them.`);
}
if (permanent.length > 0) {
  stop(EXIT.needsAPerson, `all ${wrote} written, but ${permanent.length} agent(s) need a person`);
}
process.exit(EXIT.ok);

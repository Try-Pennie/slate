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
// or whose week Slate's validator will not accept, is SKIPPED and named. It is not
// defaulted to Eastern and not merged into a single window: defaulting is precisely
// how the roster came to claim a timezone three quarters of it does not have.
//
// SPLIT SHIFTS ARE IMPORTED WHOLE, and until #1782 they were not. Slate could hold
// only one window per weekday, so a day with a morning and an afternoon was left
// out of the import and the agent was offered nothing on it; three agents (jkite@,
// jsullivan@, pdelacerda@) were excluded that way and given a single full-day span
// by hand instead, which makes them bookable straight through a break they never
// offered. The hours editor rebuild removed the limit, and `planScheduleReplacement`
// now refuses only windows that OVERLAP each other, so the shifts come across as
// cal.com holds them and the break stops being bookable.
//
// IT IS IDEMPOTENT and safe to re-run. An agent already matching cal.com is left
// alone, so a run interrupted part way is repaired by running it again. That is
// what lets the daily lane run it unattended every morning (#2092).
//
// env-ok: CALCOM_ORG_ID (optional; defaults to 19474, the live org, and a scheduled
// run has no reason to point elsewhere)
// env-ok: CALCOM_PACE_MS (optional; defaults to 250, which is what keeps cal.com from
// answering 429 on most of the roster)
// env-ok: PARITY_APPLY_FILE (optional; where the daily lane leaves what this run
// wrote, so the alert can say what was corrected. Unset for a hand run, and an
// absent file deliberately means "no apply ran" rather than "it wrote nothing")
import { writeFileSync } from "node:fs";
import { loadEnvFiles, envOr } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
// The mapping and the write this shares with the activation gate (#2627), which
// imports ONE agent's week the moment they become bookable. One reading of a cal.com
// week, so the daily sweep and the gate cannot disagree about what somebody works.
const { planImportedWeek, pickDefaultSchedule, diffSchedule, skipKindForStatus, paceMs, hoursOverwriteRefusal } =
  await import("@/lib/calcom/schedule-import");
const { writeImportedWeek } = await import("@/lib/calcom/import-write");
const { loadCalcomRetired, calcomHoursWriteRefusal } = await import("@/lib/calcom/retirement");
// The reads this shares with `pnpm verify:calcom-parity`. One definition of "who
// is a bookable agent", because two would drift and the command would then report
// agreement about a roster this never wrote to.
const { makeCalGet, emailIndex, loadBookableRoster } = await import(
  "./lib/calcom-roster.ts"
);

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
  /** #2875: cal.com is marked retired, so an APPLY run writes nothing. */
  calcomRetired: 6,
  /** #2875: whether cal.com is retired could not be read, so an APPLY run writes nothing. */
  retiredUnreadable: 7,
} as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Between agents, so a 103-agent run does not trip the limit in the first place.
 *  Parsed through `paceMs`, which refuses a value a timer would treat as zero. */
const PACE_MS = paceMs(process.env.CALCOM_PACE_MS);

/**
 * Leave what this run WROTE somewhere the daily lane's report step can read
 * (#2092), so the alert can say what the lane corrected by itself.
 *
 * Written on every exit that got as far as deciding, including the one where
 * there was nothing to write, because ABSENT and zero are different facts to
 * whoever reads the message: absent means no apply ran at all and re-importing is
 * still the remedy, zero means the import ran and found nothing. A file written on
 * only one of those paths would make the commonest healthy morning read as a
 * broken apply step.
 *
 * Absent variable, no file, no behaviour change for a hand run.
 */
function writeApplySummary(count: number, agents: string[]): void {
  const path = process.env.PARITY_APPLY_FILE?.trim();
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify({ count, agents: agents.slice(0, APPLY_AGENT_CAP) }, null, 2));
  } catch (err) {
    // Reported and never fatal. The hours are the point of the run and they are
    // already written; losing the NOTE about them must not turn a successful
    // import into a failed workflow step.
    //
    // What it costs, said out loud because it is a collapse of two states into
    // one (L11): an absent file reads downstream as "no apply ran", so the alert
    // keeps its "re-import the hours" line. That instruction is then redundant
    // rather than false, since the import is idempotent and running it again
    // reports the same thing, and this line is in the run log either way. A third
    // wire state for "it ran and could not say what it did" would buy a more
    // precise sentence for a filesystem write failing on a runner that has just
    // completed two network passes, which is not worth a vocabulary somebody has
    // to maintain.
    console.error(`could not write the apply summary: ${String(err).slice(0, 120)}`);
  }
}

/** How many agents the summary names. The alert caps it again on the way in. */
const APPLY_AGENT_CAP = 8;

function stop(code: number, why: string): never {
  console.error(`\nFAILED (${code}): ${why}`);
  process.exit(code);
}

if (!calcomKey) {
  stop(EXIT.notConfigured, "no CALCOM_API_KEY here, so nothing was attempted. Add it to .env.local.");
}

const calGet = makeCalGet({ key: calcomKey, sleep });
const db = supabaseAdmin();

// #2875: asked BEFORE any cal.com read, so a retired cal.com costs this run nothing
// and says so on its own exit code. `writeImportedWeek` refuses on the same rule for
// every write it is handed; this is what turns a hundred refused writes into one
// sentence. A dry run still reads and prints, because it writes nothing.
if (apply) {
  const retired = await loadCalcomRetired();
  const refusal = calcomHoursWriteRefusal(retired);
  if (refusal) stop(retired === true ? EXIT.calcomRetired : EXIT.retiredUnreadable, refusal);
}

console.log(apply ? "APPLYING changes to production\n" : "DRY RUN: nothing will be written\n");

// --- who ----------------------------------------------------------------------
const agents = await loadBookableRoster(db, unwrap);

// cal.com's org listing, one read for the whole roster. Refused whole rather than
// salvaged: a half-read listing is a SHORTER index, and a missing entry is reported
// as "this agent has no cal.com account", which is a finding about the roster
// wearing the costume of a defect in our parsing.
const listing = await calGet(`/organizations/${org}/users?take=500`);
if (listing.status < 200 || listing.status >= 300) {
  stop(EXIT.notConfigured, `cal.com org users returned ${listing.status}`);
}
const index = emailIndex(listing.json);
if (!index.ok) stop(EXIT.notConfigured, `cal.com's org user listing could not be read: ${index.why}`);
const calId = index.index;
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
/** Agents whose week really differs and that cal.com is not allowed to replace
 *  (#2092). Kept apart from `skipped` because nothing is wrong with them and
 *  nobody has to go and repair anything: the sweep reports them as a standing
 *  difference, and this run simply leaves them where they are. */
const leftAlone: { email: string; why: string; reasons: string[] }[] = [];

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const render = (rs: { weekday: number; start_minute: number; end_minute: number }[]) => {
  const days = [...new Set(rs.map((r) => r.weekday))].sort().join("");
  const windows = [...new Set(rs.map((r) => `${hhmm(r.start_minute)}-${hhmm(r.end_minute)}`))];
  return `days ${days} ${windows.join(" / ")}`;
};

for (const agent of agents) {
  if (agent.scheduleId === null || agent.timezone === null) {
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
    const picked = pickDefaultSchedule(r.json);
    if (picked.kind === "none") {
      skipped.push({ email: agent.email, why: "no schedule in cal.com", kind: "permanent" });
      continue;
    }
    if (picked.kind === "unreadable") {
      skipped.push({ email: agent.email, why: picked.why, kind: "permanent" });
      continue;
    }
    calSchedule = picked.schedule;
  } catch (err) {
    // A thrown fetch is a transport problem, the same class as a 5xx.
    skipped.push({ email: agent.email, why: `cal.com read threw: ${String(err).slice(0, 80)}`, kind: "transient" });
    continue;
  }
  // The mapping, the empty check and Slate's validator, in the one function the
  // activation gate uses too (#2627). Split shifts come across whole (#1782).
  const plan = planImportedWeek(calSchedule);
  if (!plan.ok) {
    skipped.push({ email: agent.email, why: plan.why, kind: "permanent" });
    continue;
  }
  const currentRules = agent.rules;
  const diff = diffSchedule(
    { timezone: agent.timezone, rules: currentRules },
    { timezone: plan.timezone, rules: plan.rules },
  );
  if (!diff.changed) {
    unchanged.push(agent.email);
    continue;
  }
  // Asked AFTER the diff, never before it. An agent who owns their week and
  // happens to match cal.com is not a finding, and reporting them every morning
  // would put five permanent lines under a heading that means "go and do
  // something", which is how a report stops being read (L36). It costs one cal.com
  // read for an agent this will not write, which is the right trade.
  const refusal = hoursOverwriteRefusal(agent.hoursSource);
  if (refusal !== null) {
    leftAlone.push({ email: agent.email, why: refusal, reasons: diff.reasons });
    continue;
  }
  changes.push({
    email: agent.email,
    userId: agent.id,
    scheduleId: agent.scheduleId,
    reasons: diff.reasons,
    plan: { rules: plan.rules, timezone: plan.timezone },
  });
  console.log(`${agent.email}`);
  console.log(`   now:  ${agent.timezone}  ${render(currentRules)}`);
  console.log(`   new:  ${plan.timezone}  ${render(plan.rules)}`);
  console.log(`   why:  ${diff.reasons.join("; ")}`);
}

console.log(`\n--- summary ---`);
console.log(`would change: ${changes.length}`);
console.log(`already matching: ${unchanged.length}`);
if (leftAlone.length > 0) {
  console.log(`left alone, the agent owns these hours: ${leftAlone.length}`);
  for (const a of leftAlone) console.log(`   ${a.email}: ${a.reasons.join("; ")}`);
}
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
  // Not "every agent matches": an agent whose own week differs and that this run
  // is not allowed to replace has NOT been made to match, and saying so would be a
  // claim this run did not measure (L11).
  console.log(
    leftAlone.length > 0
      ? `\nEvery agent this may write already matches cal.com. ${leftAlone.length} still differ and own their own hours.`
      : "\nEvery agent already matches cal.com.",
  );
  writeApplySummary(0, []);
  process.exit(EXIT.ok);
}

if (!apply) {
  console.log(`\nDRY RUN: nothing was written. Re-run with APPLY=1 to write these ${changes.length} change(s).`);
  process.exit(EXIT.ok);
}

// --- write --------------------------------------------------------------------
// The zone and the rules in ONE transaction, through the write the activation gate
// uses too (#2627). This used to write the rules and then the zone as two
// statements, so a run that died between them left new hours read in the old zone.
let wrote = 0;
const writtenEmails: string[] = [];
const writeFailures: { email: string; why: string }[] = [];
for (const c of changes) {
  try {
    // Throws on a refused write and on a count it did not ask for, so reaching the
    // next line is the verified write, never merely the absence of an error.
    await writeImportedWeek(db, c.userId, c.plan);
    wrote++;
    writtenEmails.push(c.email);
    console.log(`wrote ${c.email}`);
  } catch (err) {
    writeFailures.push({ email: c.email, why: String(err).slice(0, 160) });
    console.error(`FAILED ${c.email}: ${String(err).slice(0, 160)}`);
  }
}

console.log(`\nwritten: ${wrote} of ${changes.length}`);
// Only the agents actually WRITTEN, judged by the read-back above rather than by
// the absence of an error, so the alert's "corrected" count is a claim about rows
// this run verified rather than about ones it attempted.
writeApplySummary(wrote, writtenEmails);
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

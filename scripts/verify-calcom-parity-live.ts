// Live cal.com parity (#1754, #1911). Run:
//   pnpm verify:calcom-parity                              # sweep the roster
//   PARITY_AGENT=someone@trypennie.com pnpm verify:calcom-parity
//
// WHAT IT IS FOR. During the parallel run (docs/parallel-run-plan.md) Slate
// computes availability nobody can book while cal.com keeps taking every lead.
// This is what turns that silence into a measurement, and it asks TWO questions:
//
//   MEMBERSHIP: do the two systems hold the same roster? Nothing reconciled them,
//   so one could be six weeks ahead of the other with no signal. Slate deactivated
//   an agent on 2026-07-21 and had no Low plus Beyond agent from that date, while
//   cal.com went on routing her every Low plus Beyond lead for six more weeks (28
//   of 28 bookings), then removed her, leaving 11 upcoming calls with a host who no
//   longer existed. Both failures were invisible from inside either system.
//
//   HOURS: for every agent bookable in Slate, does cal.com hold the same week?
//   Nothing re-checked the 97 schedules imported on 2026-09-02, and five days later
//   21 of 102 agents had drifted.
//
// The two are asked together because they are one question to whoever reads the
// answer, and because the membership half is the one the hours half cannot see:
// it iterates agents who ARE bookable in Slate, so somebody missing from Slate is
// never in the loop, and a bucket empty in Slate but served by one person in
// cal.com reads as ordinary under-offering.
//
// WHAT IT DOES NOT PROVE. Not correctness: cal.com is the incumbent, not the
// source of truth, and a week both systems hold can be wrong in both. That
// question belongs to the agent, and to `pnpm verify:availability-truth`, which
// asks Google whether the times Slate offers are actually free.
//
// WHY SCHEDULES AND NOT SLOTS. The first parity probe (#1731) narrowed cal.com's
// answer to one bucket's agents with `routedTeamMemberIds[]` on `GET /v2/slots`.
// That parameter does not exist on that endpoint: every spelling answers 400, zero
// pins answers 200 with the whole pool, and the probe could never execute a single
// comparison. Re-measured live 2026-09-07, still 400. Schedules are read through
// the endpoint the OOO dual-write already uses, and are better suited anyway: per
// agent rather than per pool, so one misconfigured person cannot be masked by a
// healthy pool, and with no dependency on busy time being hydrated.
//
// IT WRITES NOTHING: no calendar, no database, no alert. It is deliberately not
// named `test-*.ts`, because that glob is the offline unit suite and this needs
// live cal.com plus the Supabase secret key. Its decision logic is pinned offline
// by `scripts/test-schedule-parity.ts`, `scripts/test-roster-parity.ts`,
// `scripts/test-calcom-parity-outcome.ts` and `scripts/test-calcom-roster.ts`.
//
// Env:
//   CALCOM_API_KEY   required. A wrangler secret on the deployment; add it to
//                    .env.local to run this.
//   TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_WORKSPACE_SID
//                    required since #2153: the tags there are what say who cal.com
//                    actually routes to. TaskRouter scoped, the same key
//                    verify:twilio-parity uses.
//   CALCOM_ORG_ID    default 19474 (trypennie)
//   CALCOM_TEAM_ID   default 19546 (Loan Consultation), which owns the event type
//   CALCOM_EVENT_TYPE_ID  default 1314152 (the review event the landing pages use)
//   CALCOM_PACE_MS   pause between agents, default 250. cal.com meters the
//                    schedules endpoint hard: the first import run met 429 on 89
//                    of 103 agents without this.
//   PARITY_AGENT     one email instead of the whole roster. Narrows the HOURS half
//                    only: membership is a comparison of two whole rosters and
//                    means nothing scoped to one person.
// env-ok: TWILIO_API_KEY_SID (required; a TaskRouter-scoped API key, the basic-auth
//   username, exactly as the Pipedream job that feeds cal.com uses it)
// env-ok: TWILIO_API_KEY_SECRET (required; the matching secret)
// env-ok: TWILIO_WORKSPACE_SID (required; the TaskRouter workspace holding the workers)
// env-ok: CALCOM_ORG_ID (optional; defaults to 19474, the live org, and a scheduled
// run has no reason to point elsewhere)
// env-ok: CALCOM_TEAM_ID (optional; defaults to 19546, Loan Consultation)
// env-ok: CALCOM_EVENT_TYPE_ID (optional; defaults to 1314152, the review event the
// landing pages use)
// env-ok: CALCOM_PACE_MS (optional; defaults to 250, which is what keeps cal.com from
// answering 429 on most of the roster)
// env-ok: PARITY_AGENT (optional; narrows the hours half to one agent, which is a
// hand run debugging aid and never something a schedule sets)
import { writeFileSync } from "node:fs";
import { buildParitySummary } from "./lib/parity-report.ts";
import { loadEnvFiles, envOr } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
const { paceMs, skipKindForStatus } = await import("./lib/calcom-schedule-import.ts");
const { makeCalGet, pickDefaultSchedule, emailIndex, loadBookableRoster, readEventTypeId } = await import(
  "./lib/calcom-roster.ts"
);
const { compareAgentSchedule, reclassifyAgentOwnedHours, VERDICT_RANK } = await import(
  "./lib/schedule-parity.ts"
);
const { compareRosters, ROSTER_VERDICT_RANK, withheldFromWorkers, withheldReadiness } = await import(
  "./lib/roster-parity.ts"
);
const { fetchTwilioWorkers, TwilioReadError } = await import("@/lib/twilio/client");
const { readWorker } = await import("@/lib/twilio/roster");
const { matchableAgentIds } = await import("./lib/bucket-matchability.ts");
const { OUTCOME_ORDER, EXIT_CODE, worstOutcome } = await import("./lib/calcom-parity-outcome.ts");
type ScheduleVerdict = import("./lib/schedule-parity.ts").ScheduleVerdict;
type RosterVerdict = import("./lib/roster-parity.ts").RosterVerdict;
type CalcomSide = import("./lib/schedule-parity.ts").CalcomSide;

/**
 * Every way this can end, each on its own code, so a shell caller can branch on
 * which one it met without reading prose. Finding nothing to compare is never a
 * pass (L98): there is no code here that means "looked at nothing and was happy".
 */
const EXIT = {
  agree: 0,
  notConfigured: 1,
  nothingToCompare: 2,
  calcomUnreachable: 4,
  calcomUnreadable: 5,
  noHosts: 6,
  /**
   * Twilio could not be read, so who cal.com actually routes to is unknown (#2153).
   *
   * It REFUSES rather than comparing without it, and that is the whole point of the
   * exit. An empty withheld set makes every withheld agent read as routable, which
   * is the false agreement #2088 fixed: twelve agents Slate offers and cal.com never
   * routes to, reported as agreement. A check that answers "they agree" when it
   * could not read one of its two inputs is worse than one that says nothing (L98).
   */
  twilioUnreadable: 7,
} as const;

// Which finding names the run, and its code, both live in
// `scripts/lib/calcom-parity-outcome.ts` as ONE table across both halves, so the
// cross-family judgements are a decision somebody made rather than an accident of
// two rank scales written months apart.

const calcomKey = process.env.CALCOM_API_KEY ?? "";
const twilioReady = withheldReadiness(process.env);
const org = envOr(process.env.CALCOM_ORG_ID, "19474");
const teamId = envOr(process.env.CALCOM_TEAM_ID, "19546");
const eventTypeId = readEventTypeId(process.env.CALCOM_EVENT_TYPE_ID, 1314152);
const onlyAgent = (process.env.PARITY_AGENT ?? "").trim().toLowerCase();
const PACE_MS = paceMs(process.env.CALCOM_PACE_MS);

function stop(code: number, why: string): never {
  console.error(`\nFAILED (${code}): ${why}`);
  process.exit(code);
}

if (!calcomKey) {
  stop(
    EXIT.notConfigured,
    "no CALCOM_API_KEY here, so nothing was attempted. It is a wrangler secret on the " +
      "deployment; add it to .env.local to run this.",
  );
}

// #2153: the withheld set comes from Twilio now, so its credentials are as required
// as cal.com's. Said as its own refusal rather than folded into the line above,
// because they are two different things to go and fix (L11).
if (!twilioReady.ok) {
  stop(
    EXIT.notConfigured,
    `${twilioReady.missing.join(", ")} ${twilioReady.missing.length === 1 ? "is" : "are"} not set here, and ` +
      "Twilio is what says who cal.com actually routes to, so nothing was attempted. The key must be " +
      "TaskRouter scoped.",
  );
}

// An unreadable id is refused HERE, by its own cause. The decision lives in
// `readEventTypeId` so it is driven offline; this is only the wiring.
if (eventTypeId === null) {
  stop(
    EXIT.notConfigured,
    `CALCOM_EVENT_TYPE_ID is not a positive whole number: ${JSON.stringify(process.env.CALCOM_EVENT_TYPE_ID)}. ` +
      "Nothing was attempted.",
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const calGet = makeCalGet({ key: calcomKey, sleep });
const db = supabaseAdmin();

// --- who ----------------------------------------------------------------------
const roster = await loadBookableRoster(db, unwrap);
const agents = onlyAgent ? roster.filter((a) => a.email.toLowerCase() === onlyAgent) : roster;
if (agents.length === 0) {
  stop(
    EXIT.nothingToCompare,
    onlyAgent
      ? `no bookable agent with the address ${onlyAgent}`
      : "no bookable agents in Slate, so there was nothing to compare. A dark roster " +
          "(#1272) looks exactly like this and is not a pass.",
  );
}

// The membership half needs EVERY Slate user, not only the bookable ones: somebody
// who has left, or who was held back, is exactly who it exists to find, and they
// are by definition absent from the bookable set.
// cap-safe: users is a roster-bounded table, ~142 rows against a 200-agent design target
const allUsers = (unwrap(
  await db.from("users").select("id, email, role, bookable, deactivated_at, is_test, attributes"),
  "all users",
) ?? []) as {
  id: string;
  email: string;
  role: string;
  bookable: boolean;
  deactivated_at: string | null;
  is_test: boolean;
  attributes: Record<string, unknown> | null;
}[];

// Who could any bucket actually route to (#2094). Answered through the shipped pool
// predicate over the live criteria, never a rule written beside it.
//
// cap-safe: buckets is roster-bounded, 62 rows against a fixed 60-code key space
const realBuckets = (unwrap(
  await db.from("buckets").select("code, criteria").eq("is_test", false),
  "real buckets",
) ?? []) as { code: string; criteria: Record<string, unknown> }[];
// cap-safe: bucket_members is roster-bounded and holds three rows in production
const manualMembers = (unwrap(
  await db.from("bucket_members").select("user_id").eq("active", true),
  "manual bucket members",
) ?? []) as { user_id: string }[];
if (realBuckets.length === 0) {
  // REFUSED rather than reported. An empty bucket list makes every agent look
  // unmatchable, which turns the page this feeds into silence for the whole roster:
  // the fail-open direction, and indistinguishable from a healthy day (L98).
  stop(
    EXIT.nothingToCompare,
    "read no real buckets from Slate, so nothing can be said about who a bucket could match. " +
      "Every agent would score as unreachable and the roster half would go quiet.",
  );
}
const matchable = matchableAgentIds(
  allUsers.map((u) => ({ id: u.id, attributes: (u.attributes ?? {}) as never })),
  realBuckets as never[],
  new Set(manualMembers.map((m) => m.user_id)),
);

// One read for the whole org rather than one lookup per agent: the same listing
// answers every email, and it is the read most likely to be rate limited.
const listing = await calGet(`/organizations/${org}/users?take=500`);
if (listing.status < 200 || listing.status >= 300) {
  stop(EXIT.calcomUnreachable, `cal.com's org user listing returned ${listing.status} for org ${org}`);
}
const index = emailIndex(listing.json);
if (!index.ok) {
  stop(EXIT.calcomUnreadable, `cal.com's org user listing could not be read: ${index.why}`);
}

// The host list for the event type the landing pages actually book. Team
// membership is NOT the same question: `assignAllTeamMembers` can be true today
// and false tomorrow, and it is the hosts on this event type who receive a lead.
const etRes = await calGet(`/organizations/${org}/teams/${teamId}/event-types`);
if (etRes.status < 200 || etRes.status >= 300) {
  stop(EXIT.calcomUnreachable, `cal.com's team event types returned ${etRes.status} for team ${teamId}`);
}
const eventTypes = (etRes.json as { data?: { id?: number; slug?: string; hosts?: { userId?: number }[] }[] })?.data;
if (!Array.isArray(eventTypes)) {
  stop(EXIT.calcomUnreadable, "cal.com's team event types answered with no readable list");
}
const target = eventTypes.find((e) => e?.id === eventTypeId);
if (!target) {
  // Refused rather than reported as "nobody hosts". An event type that has moved
  // teams, or an id that is wrong, would otherwise turn every bookable Slate agent
  // into a finding: a hundred lines about one broken read (L98).
  stop(
    EXIT.noHosts,
    `event type ${eventTypeId} is not among team ${teamId}'s ${eventTypes.length} event types ` +
      `(${eventTypes.map((e) => e?.slug ?? "?").join(", ")}). Nothing was compared.`,
  );
}
const hostIds = (target.hosts ?? []).map((h) => h?.userId).filter((id): id is number => typeof id === "number");
const emailByCalId = new Map([...index.index].map(([email, id]) => [id, email]));
const hostEmails = new Set(hostIds.map((id) => emailByCalId.get(id)).filter((e): e is string => Boolean(e)));
const hostsWithNoOrgUser = hostIds.length - hostEmails.size;

console.log(
  `cal.com parity: ${allUsers.length} Slate user(s), ${agents.length} of them bookable, ` +
    `against ${hostEmails.size} host(s) on event type ${eventTypeId} and ${index.index.size} org user(s)\n`,
);

// --- who cal.com actually routes to ---------------------------------------------
// The event type's hosts[] says who CAN take a booking; six of the seven live
// routing forms then carry `Redistribute Team (does not equal) yes` on every route,
// so the pool cal.com really routes to is narrower. cal.com will not report per-user
// attribute values, and the tag it derives that attribute from lives in Twilio, so
// this reads the source rather than a person's snapshot of its effect (#2153).
//
// It REFUSES on an unreadable read rather than comparing without it: an empty
// withheld set turns every withheld agent into agreement, which is the exact false
// agreement #2088 fixed.
let withheld: Set<string>;
try {
  const workers = await fetchTwilioWorkers();
  withheld = withheldFromWorkers(workers.map((w) => readWorker(w.attributes)));
} catch (err) {
  stop(
    EXIT.twilioUnreadable,
    `Twilio could not be read, so who cal.com withholds is unknown and nothing was compared: ` +
      `${err instanceof TwilioReadError ? err.message : String(err)}`,
  );
}
console.log(`Twilio withholds ${withheld.size} address(es) from cal.com's routed decisions\n`);

// --- membership -----------------------------------------------------------------
const membership = compareRosters(
  allUsers.map((u) => ({
    email: u.email,
    role: u.role,
    bookable: u.bookable,
    deactivatedAt: u.deactivated_at,
    isTest: u.is_test,
    matchableByAnyBucket: matchable.has(u.id),
  })),
  hostEmails,
  withheld,
);
if (membership.hostsEmpty) {
  stop(
    EXIT.noHosts,
    `event type ${eventTypeId} named no hosts this run. Every bookable Slate agent would be ` +
      "reported as absent from cal.com, which is a hundred findings about one read.",
  );
}
if (hostsWithNoOrgUser > 0) {
  console.log(
    `note: ${hostsWithNoOrgUser} host(s) on the event type have no row in the org user listing, ` +
      "so they could not be resolved to an address and are not compared\n",
  );
}
if (membership.withheldNoLongerHosting > 0) {
  // Not a finding, and deliberately not one. Since #2153 it measures TWILIO against
  // cal.com: somebody carrying the Redistribute tag whom cal.com does not list as a
  // host is a person the two systems disagree about, which is worth saying and is
  // nobody's mistake. Said out loud rather than left for somebody to notice (#2088).
  console.log(
    `note: ${membership.withheldNoLongerHosting} address(es) Twilio withholds are not hosts on this event type, ` +
      "so the two have drifted apart about somebody\n",
  );
}
const membershipRows = [...membership.rows]
  .filter((r) => r.verdict !== "agree")
  .sort((a, b) => ROSTER_VERDICT_RANK[b.verdict] - ROSTER_VERDICT_RANK[a.verdict] || a.email.localeCompare(b.email));
if (membershipRows.length > 0) {
  console.log("--- roster ---");
  for (const row of membershipRows) console.log(`${row.verdict}  ${row.email}\n    ${row.reason}`);
  console.log("");
}

console.log("--- hours ---");

// --- compare ------------------------------------------------------------------
interface Row {
  email: string;
  verdict: ScheduleVerdict;
  reasons: string[];
}
const rows: Row[] = [];

for (const agent of agents) {
  const slate = agent.scheduleId === null || agent.timezone === null
    ? null
    : { timezone: agent.timezone, rules: agent.rules };

  let cal: CalcomSide;
  const calId = index.index.get(agent.email.toLowerCase());
  if (calId === undefined) {
    cal = { kind: "user-missing" };
  } else {
    // Paced BEFORE the read, not after, so the first agent pays it too: the run
    // that met 429 at agent 15 did so by opening at full speed.
    await sleep(PACE_MS);
    let read;
    try {
      read = await calGet(`/organizations/${org}/users/${calId}/schedules`);
    } catch (err) {
      // The ladder re-throws a transport fault it could not ride out. That is one
      // agent's read, not the run's, so it is recorded and the sweep continues.
      rows.push({
        email: agent.email,
        verdict: "calcom-unreachable",
        reasons: [`the read threw and did not recover: ${String(err).slice(0, 120)}`],
      });
      continue;
    }
    if (read.status < 200 || read.status >= 300) {
      cal = {
        kind: "read-failed",
        status: read.status,
        transient: skipKindForStatus(read.status) === "transient",
      };
    } else {
      const picked = pickDefaultSchedule(read.json);
      if (picked.kind === "none") cal = { kind: "schedule-missing" };
      else if (picked.kind === "unreadable") {
        rows.push({
          email: agent.email,
          verdict: "calcom-unreadable",
          reasons: [`cal.com's schedules payload could not be read: ${picked.why}`],
        });
        continue;
      } else {
        cal = { kind: "schedule", schedule: picked.schedule as never };
      }
    }
  }

  // The comparison answers whether the two systems agree; the reclassification
  // answers whether it is ours to fix. A difference on a week the AGENT set for
  // themselves is one the daily lane deliberately refuses to overwrite (#2092), so
  // paging on it every morning would leave this check red for as long as it sat.
  rows.push(reclassifyAgentOwnedHours(compareAgentSchedule(agent.email, slate, cal), agent.hoursSource));
}

// --- report -------------------------------------------------------------------
// Worst first, so the agents somebody has to act on are at the top of the output
// rather than buried under ninety lines of agreement (L609).
const ordered = [...rows].sort(
  (a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict] || a.email.localeCompare(b.email),
);
for (const row of ordered) {
  if (row.verdict === "agree") continue;
  console.log(`${row.verdict}  ${row.email}`);
  for (const reason of row.reasons) console.log(`    ${reason}`);
}

const counts = new Map<string, number>();
for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
for (const row of membership.rows) {
  if (row.verdict === "agree") continue;
  counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
}
const severity = (v: string) => {
  const at = OUTCOME_ORDER.indexOf(v as never);
  return at === -1 ? -1 : OUTCOME_ORDER.length - at;
};
console.log(
  "\n" +
    [...counts]
      .sort((a, b) => severity(b[0]) - severity(a[0]))
      .map(([v, n]) => `${v}: ${n}`)
      .join("   "),
);

// An agent whose week could not be read on either side was NOT compared, and a
// sweep made entirely of those has judged nothing. It still exits on its worst
// finding, so it can never read as agreement, but the message has to say which of
// the two happened or a reader takes "no differences" for "no problems".
//
// The four unusable kinds are LISTED rather than picked out by rank. A rank
// threshold reads as a tidy rule and silently reclassifies the moment a verdict is
// inserted between two ranks, which is exactly what adding `timezone-name-differs`
// did.
const CANNOT_COMPARE: ScheduleVerdict[] = [
  "no-calcom-user",
  "no-calcom-schedule",
  "no-slate-schedule",
  "calcom-unreachable",
  "calcom-unreadable",
];
const compared = rows.filter((r) => !CANNOT_COMPARE.includes(r.verdict)).length;
console.log(`${compared} of ${rows.length} agent(s) had a week on both sides to compare`);

// #2031: leave the result somewhere a caller can read, so the scheduled run can
// report it to Slate and get a cooldown and an all clear from the app's own
// alerting. Written HERE rather than at either exit, because both the agreement
// path and the finding path exit immediately below and a summary written on only
// one of them would make "no drift" indistinguishable from "the run never got that
// far". Absent variable, no file, no behaviour change for a hand run.
//
// `total` is the union of everybody either half formed a verdict about, not the
// bookable roster: a cal.com host with no Slate row at all is somebody the sweep
// looked at, and counting only Slate's side could report more agents differing
// than were looked at.
{
  const summaryPath = process.env.PARITY_SUMMARY_FILE?.trim();
  if (summaryPath) {
    writeFileSync(
      summaryPath,
      JSON.stringify(buildParitySummary(rows, membership.rows, compared), null, 2),
    );
  }
}

const all: (ScheduleVerdict | RosterVerdict)[] = [
  ...rows.map((r) => r.verdict),
  ...membership.rows.map((r) => r.verdict),
];
if (all.length === 0) {
  stop(EXIT.nothingToCompare, "not one agent produced a verdict, which is never a pass");
}
const worst = worstOutcome(all);
if (worst === null) {
  console.log(
    `\nPASSED: ${agents.length} agent(s) hold the same week in both systems, and the two ` +
      "rosters agree on who can take a booking",
  );
  process.exit(EXIT.agree);
}
const hit = [
  ...rows.filter((r) => r.verdict === worst).map((r) => r.email),
  ...membership.rows.filter((r) => r.verdict === worst).map((r) => r.email),
];
stop(
  EXIT_CODE[worst],
  `${hit.length} agent(s) reported ${worst}` +
    (compared === 0 ? ", and not one agent's hours could actually be compared" : "") +
    `: ${hit.join(", ")}`,
);

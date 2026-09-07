// Live cal.com schedule parity (#1754). Run:
//   pnpm verify:schedule-parity                              # sweep the roster
//   PARITY_AGENT=someone@trypennie.com pnpm verify:schedule-parity
//
// WHAT IT IS FOR. During the parallel run (docs/parallel-run-plan.md) Slate
// computes availability nobody can book while cal.com keeps taking every lead.
// This is what turns that silence into a measurement: for every bookable agent,
// read the week cal.com holds and the week Slate holds, and report where they
// disagree. It is the only thing that would notice an agent changing their hours
// in cal.com and not in Slate, which nothing has re-checked since the 97 schedules
// imported on 2026-09-02.
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
// by `scripts/test-schedule-parity.ts` and `scripts/test-calcom-roster.ts`.
//
// Env:
//   CALCOM_API_KEY   required. A wrangler secret on the deployment; add it to
//                    .env.local to run this.
//   CALCOM_ORG_ID    default 19474 (trypennie)
//   CALCOM_PACE_MS   pause between agents, default 250. cal.com meters the
//                    schedules endpoint hard: the first import run met 429 on 89
//                    of 103 agents without this.
//   PARITY_AGENT     one email instead of the whole roster
import { loadEnvFiles, envOr } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
const { paceMs, skipKindForStatus } = await import("./lib/calcom-schedule-import.ts");
const { makeCalGet, pickDefaultSchedule, emailIndex, loadBookableRoster } = await import(
  "./lib/calcom-roster.ts"
);
const { compareAgentSchedule, worstVerdict, VERDICT_RANK } = await import("./lib/schedule-parity.ts");
type ScheduleVerdict = import("./lib/schedule-parity.ts").ScheduleVerdict;
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
} as const;

/** One code per verdict, so the run's exit says WHICH kind of disagreement it met
 *  rather than only that it met one. Derived from the verdict list rather than
 *  written out twice, so a verdict added later cannot quietly map to zero. */
const VERDICT_EXIT: Record<ScheduleVerdict, number> = {
  agree: 0,
  "timezone-name-differs": 9,
  "no-calcom-user": 10,
  "no-calcom-schedule": 11,
  "no-slate-schedule": 12,
  "calcom-unreachable": 13,
  "calcom-unreadable": 14,
  "hours-differ": 15,
  "days-differ": 16,
  "timezone-differs": 17,
};

const calcomKey = process.env.CALCOM_API_KEY ?? "";
const org = envOr(process.env.CALCOM_ORG_ID, "19474");
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

console.log(
  `schedule parity: ${agents.length} bookable Slate agent(s) against ${index.index.size} cal.com org user(s)\n`,
);

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

  rows.push(compareAgentSchedule(agent.email, slate, cal));
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

const counts = new Map<ScheduleVerdict, number>();
for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
const summary = [...counts]
  .sort((a, b) => VERDICT_RANK[b[0]] - VERDICT_RANK[a[0]])
  .map(([v, n]) => `${v}: ${n}`)
  .join("   ");
console.log(`\n${summary}`);

// An agent whose week could not be read on either side was NOT compared, and a
// sweep made entirely of those has judged nothing. It still exits on its worst
// verdict, so it can never read as agreement, but the message has to say which of
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

const worst = worstVerdict(rows.map((r) => r.verdict));
if (worst === null) {
  stop(EXIT.nothingToCompare, "not one agent produced a verdict, which is never a pass");
}
if (worst === "agree") {
  console.log(`\nPASSED: every one of ${rows.length} agent(s) holds the same week in both systems`);
  process.exit(EXIT.agree);
}
const hit = rows.filter((r) => r.verdict === worst);
stop(
  VERDICT_EXIT[worst],
  `${hit.length} agent(s) reported ${worst}` +
    (compared === 0 ? ", and not one agent could actually be compared" : "") +
    `: ${hit.map((h) => h.email).join(", ")}`,
);

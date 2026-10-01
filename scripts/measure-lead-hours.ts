// How many leads arrive in an hour, by debt tier? Run:
//   pnpm measure:lead-hours
//
// WHY IT EXISTS (#2484). The booking failure rate check judges a rolling hour and
// refuses to conclude below `minAttempts` (20 at the time of writing), and that
// number was chosen with no traffic to fit it to: Slate has taken no real customer
// booking, so every attempt to date is the canary's. Arming the check without
// re-deriving the floor from real volume would leave it reporting `insufficient`
// on every tick, which is silent in a way that reads exactly like healthy.
//
// A number justifying a design decision has to come from a measurement rather than
// from a query written beside the argument (L107), so this is the measurement, and
// it is committed rather than run once in a scratch file: the floors want revisiting
// as the flip widens, and a number nobody can reproduce is one nobody can revise.
//
// WHAT IT READS. cal.com's routing form responses, which is where the real traffic
// is while cal.com still takes every lead. The debt tier is the FIRST DIGIT of the
// code each lead carried, extracted by the shipped `extractCode` rather than a
// second parser written here, so this counts the leads Slate would have seen.
//
// WHAT IT REPORTS. The distribution across hours, not an average: a floor is cleared
// or not cleared by a SINGLE hour, so the median busy hour and the quiet end are what
// decide it, and a mean over a fortnight including nights and weekends is the one
// number that cannot answer the question (L711, L172).
//
// It writes nothing and talks to cal.com, so it is deliberately not named `test-*.ts`.
//
// Env:
//   CALCOM_API_KEY   required
//   CALCOM_ORG_ID    default 19474
//   MEASURE_DAYS     how far back to read (default 14)
//   MEASURE_PACE_MS  pacing between pages (default 550, measured in #2240)
//   MEASURE_END      where the span ends, an instant with its zone (default now). Since
//                    the 50/50 split on every tier (2026-10-01 15:46 UTC) a span ending
//                    later counts about half of every tier, so pin it before the split.
//   ENV_FILE         an extra env file, so an agent worktree can read the main
//                    checkout's .env.local without the key passing through a command line
import { loadEnvFiles, envOr } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars", ...(process.env.ENV_FILE ? [process.env.ENV_FILE] : [])]);

const KEY = process.env.CALCOM_API_KEY?.trim() ?? "";
if (!KEY) {
  console.error("FAILED (not-configured): CALCOM_API_KEY is needed here; nothing was read");
  process.exit(1);
}

const { PACE_REFUSAL, calcomGetter, measureEndOrRefusal, paceMsOrNull, readRoutingResponses } = await import("./lib/calcom-routing-responses.ts");

const ORG = envOr(process.env.CALCOM_ORG_ID, "19474");
const DAYS = Number(envOr(process.env.MEASURE_DAYS, "14"));
const PACE_MS = paceMsOrNull(envOr(process.env.MEASURE_PACE_MS, "550"));
if (PACE_MS === null) {
  console.error(PACE_REFUSAL);
  process.exit(1);
}
if (!Number.isFinite(DAYS) || DAYS <= 0) {
  console.error("FAILED (bad-input): MEASURE_DAYS must be a positive number");
  process.exit(1);
}
const END = measureEndOrRefusal(process.env.MEASURE_END ?? "", Date.now());
if (!END.ok) {
  console.error(END.refusal);
  process.exit(1);
}
const END_MS = END.endMs;

const calGet = calcomGetter(KEY);

// The paging loop is shared with `measure:volume-floors` (#1956), so both commands
// count the same traffic and both refuse a partial read the same way (L98).
const read = await readRoutingResponses({
  get: calGet,
  org: ORG,
  fromIso: new Date(END_MS - DAYS * 86_400_000).toISOString(),
  paceMs: PACE_MS,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
if (!read.ok) {
  console.error(
    read.reason === "forms-unreadable"
      ? `FAILED (calcom-unreadable): cal.com answered ${read.status} for the org's routing forms, so nothing was measured.`
      : `FAILED (calcom-unreadable): cal.com answered ${read.status} for "${read.formName}", so this run saw only part ` +
          `of the traffic. A 429 means the pacing is too fast; this run used MEASURE_PACE_MS=${PACE_MS}.`,
  );
  process.exit(2);
}
// The reader pages up to the present, so a pinned end is applied here: a lead after
// it is outside the span asked about, and counting it would mix the split back in.
const rows = read.rows.filter((r) => {
  const ms = Date.parse(r.createdAt);
  return !Number.isFinite(ms) || ms < END_MS;
});

if (rows.length === 0) {
  console.error(`FAILED (nothing-measured): no routing form responses in the last ${DAYS} days`);
  process.exit(3);
}

/** Leads per clock hour, keyed by the hour they arrived in, split by debt tier. */
const perHour = new Map<string, Map<string, number>>();
/**
 * The SAME thing per form, which is the number the pilot actually needs. The first
 * flip is one landing page, so the whole tier's volume overstates what will reach
 * Slate that morning, and a floor fitted to the tier would report `insufficient`
 * on every tick of the pilot while looking armed.
 */
const perFormHour = new Map<string, Map<string, number>>();
let unreadable = 0;
for (const r of rows) {
  const code = r.code;
  const ms = Date.parse(r.createdAt);
  if (!Number.isFinite(ms)) {
    unreadable++;
    continue;
  }
  // The hour key is UTC. The shape of a busy hour is what matters here, not which
  // local hour it was, and mixing zones would split one busy hour across two keys.
  const hour = new Date(ms).toISOString().slice(0, 13);
  const tier = code && /^[1-5]/.test(code) ? code[0]! : "unreadable";
  const byTier = perHour.get(hour) ?? new Map<string, number>();
  byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
  byTier.set("all", (byTier.get("all") ?? 0) + 1);
  perHour.set(hour, byTier);

  const formKey = `${r.formName ?? "unknown"}`;
  const formHours = perFormHour.get(formKey) ?? new Map<string, number>();
  formHours.set(hour, (formHours.get(hour) ?? 0) + 1);
  perFormHour.set(formKey, formHours);
  if (tier === "1") {
    const lowKey = `${formKey} (Low only)`;
    const lowHours = perFormHour.get(lowKey) ?? new Map<string, number>();
    lowHours.set(hour, (lowHours.get(hour) ?? 0) + 1);
    perFormHour.set(lowKey, lowHours);
  }
}

const TIER_LABEL: Record<string, string> = {
  "1": "Low",
  "2": "Medium",
  "3": "High",
  "4": "Very High",
  "5": "Ultra High",
  all: "every tier",
  unreadable: "no readable code",
};

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i]!;
}

console.log(`Read ${rows.length} routing form responses over the last ${DAYS} days, across ${read.formCount} forms.`);
if (unreadable > 0) console.log(`${unreadable} carried a timestamp this could not read and are excluded.`);
console.log(`${perHour.size} distinct hours held at least one lead.\n`);

// Only hours that held a lead are counted. An hour with none is a night or a
// weekend, and folding those in would halve every number while answering a
// different question: the floor has to be cleared by hours when leads arrive.
for (const tier of ["all", "1", "2", "3", "4", "5", "unreadable"]) {
  const counts = [...perHour.values()].map((m) => m.get(tier) ?? 0).filter((n) => n > 0);
  if (counts.length === 0) {
    console.log(`${TIER_LABEL[tier]}: no leads at all`);
    continue;
  }
  counts.sort((a, b) => a - b);
  const total = counts.reduce((s, n) => s + n, 0);
  console.log(
    `${TIER_LABEL[tier]}: ${total} leads over ${counts.length} active hours. ` +
      `per hour min ${counts[0]}, p25 ${quantile(counts, 0.25)}, median ${quantile(counts, 0.5)}, ` +
      `p75 ${quantile(counts, 0.75)}, p90 ${quantile(counts, 0.9)}, max ${counts[counts.length - 1]}`,
  );
  // The question the floor actually asks: how often would an hour CLEAR it?
  for (const floor of [3, 5, 10, 20]) {
    const cleared = counts.filter((n) => n >= floor).length;
    console.log(
      `    a floor of ${floor} is cleared by ${cleared} of ${counts.length} active hours ` +
        `(${Math.round((cleared / counts.length) * 100)}%)`,
    );
  }
}

// --- Per FORM, because the first flip is one landing page (#2484) ---
//
// A floor fitted to the whole Low tier is a floor no single page's traffic can
// clear, and the check would then report `insufficient` on every tick of the pilot
// while reading as armed, which is the state the issue was opened about.
console.log("\nPer form, Low only, since the pilot flips one page at a time:");
const formRows = [...perFormHour.entries()]
  .filter(([name]) => name.endsWith("(Low only)"))
  .map(([name, hours]) => {
    const counts = [...hours.values()].sort((a, b) => a - b);
    return { name, counts, total: counts.reduce((s, n) => s + n, 0) };
  })
  .sort((a, b) => b.total - a.total);
for (const f of formRows) {
  const { counts } = f;
  const clears = [3, 5, 10, 20]
    .map((floor) => `${floor}: ${Math.round((counts.filter((n) => n >= floor).length / counts.length) * 100)}%`)
    .join(", ");
  console.log(
    `  ${f.name}: ${f.total} leads over ${counts.length} active hours, ` +
      `median ${quantile(counts, 0.5)}, p25 ${quantile(counts, 0.25)}, max ${counts[counts.length - 1]}. ` +
      `hours clearing a floor of ${clears}`,
  );
}

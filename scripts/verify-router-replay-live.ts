// Replay real cal.com leads through Slate's tier ladder (#2240). Run:
//   pnpm verify:router-replay
//
// WHY. cal.com has taken every real lead for months. Slate has routed nothing, so
// before cutover there is no traffic of its own to judge its routing by. But every
// cal.com routing form response records BOTH the code the lead carried and the
// agent cal.com chose, so the same lead can be put to Slate and the two answers
// compared. That is the only measurement of Slate's routing that exists today.
//
// WHAT IT IS NOT. Not a correctness check. cal.com is the incumbent, not the
// source of truth, and a lead both systems would send to the same person can be
// wrong in both.
//
// THE HALF THAT AGREES BY CONSTRUCTION, and the report says so at the top. Since
// #2152 Slate's debt tiers and backend service come from the same Twilio tags the
// Pipedream job feeds cal.com. So the ATTRIBUTES both systems route on are one
// source, and what is actually under test is everything downstream: the code
// resolution, the tier ladder with its Beyond overflow, and the pool predicate.
//
// AND THE BASELINE. With the legal digit retired (#2218) the big pools hold most
// of the roster, so a coin flip agrees most of the time. Every rate is printed
// beside the requested pool's share of the bookable roster, because an agreement
// rate on its own is a number nobody can read.
//
// IT WRITES NOTHING to Slate, to cal.com, or to Slack. The one thing it writes is
// a cache of booking facts under $TMPDIR, and that cache holds host emails, times
// and status, NEVER the attendee: the lead's own details have no business in a
// file on a laptop.
//
// It is deliberately not named `test-*.ts`, because that glob is the offline unit
// suite and this needs live cal.com plus the Supabase secret key. Its judgement is
// pinned offline by `scripts/test-router-replay.ts`.
//
// Env:
//   CALCOM_API_KEY    required. A wrangler secret on the deployment; add it to
//                     .env.local to run this.
//   CALCOM_ORG_ID     default 19474 (trypennie)
//   REPLAY_MAX_FETCH  most bookings to resolve in one run, default 2000. Each is
//                     one cal.com call of roughly 300ms, so this is the run's
//                     length as much as its cost.
//   REPLAY_PACE_MS    pause between cal.com reads, default 550. MEASURED rather
//                     than guessed: cal.com answers
//                     `x-ratelimit-limit-default: 120` with a 60 second reset, so
//                     the sustainable rate is two a second and 550ms sits just
//                     under it. At 100ms the responses listing met a 429 the retry
//                     ladder could not ride out, on the fourth of eight forms, and
//                     the run correctly refused rather than reporting rates about
//                     whichever forms happened to answer.
//   REPLAY_SINCE      the primary window's start, default 2026-09-10, the day
//                     Twilio became Slate's attribute source and so the first day
//                     both systems were reading one set of facts.
//   REPLAY_CACHE      the cache file, default under $TMPDIR.
//   REPLAY_SUMMARY_FILE  where to write the verdict, for the scheduled lane (#2263).
//                     Unset for a hand run, which reads the terminal instead.
// env-ok: CALCOM_ORG_ID (optional; defaults to 19474, the live org)
// env-ok: REPLAY_MAX_FETCH (optional; defaults to 2000 uids a run)
// env-ok: REPLAY_PACE_MS (optional; defaults to 550ms, derived from cal.com's own
// measured ceiling of 120 requests a minute)
// env-ok: REPLAY_SINCE (optional; defaults to 2026-09-10, when the attribute source
// became shared, and only a deliberate re-measurement would move it)
// env-ok: REPLAY_CACHE (optional; defaults to a file under $TMPDIR)
// env-ok: REPLAY_SUMMARY_FILE (optional; the scheduled lane's internal handoff to
// its alerter, and unset for a hand run)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { writeReplaySummary } from "./lib/router-replay-report.ts";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvFiles, envOr } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
const { makeCalGet, CAL_BOOKINGS_API_VERSION } = await import("./lib/calcom-roster.ts");
const {
  prepareWorld,
  summarise,
  replayOutcome,
  extractCode,
  freshBooking,
  splitBudget,
  REPLAY_EXIT,
  MIN_RESOLUTION,
  MAX_CATCHALL,
  MIN_AGREEMENT,
} = await import("./lib/router-replay.ts");
type ReplayLead = import("./lib/router-replay.ts").ReplayLead;
type ReplayUser = import("./lib/router-replay.ts").ReplayUser;
type ReplayBucket = import("./lib/router-replay.ts").ReplayBucket;
type ReplaySummary = import("./lib/router-replay.ts").ReplaySummary;

function stop(code: number, why: string): never {
  console.error(`\nFAILED (${code}): ${why}`);
  process.exit(code);
}

/**
 * Write the verdict where the scheduled lane's alerter can read it (#2263).
 *
 * Only ever called once a verdict EXISTS. An absent file is what tells the lane
 * this run died before deciding, which is a different thing from any verdict it
 * could have reached and must not be inferred from an exit code alone (L98, L11).
 * A hand run sets nothing and this does nothing.
 *
 * The writing lives beside the READING in `lib/router-replay-report.ts`, so the
 * two halves of one cross process contract cannot drift, and so both are testable
 * with no cal.com and no network.
 */
function writeSummary(outcome: string, exit: number, detail: string): void {
  const res = writeReplaySummary(process.env.REPLAY_SUMMARY_FILE ?? "", {
    outcome,
    exit,
    detail,
  });
  // Loud, and NOT fatal: the run has already measured what it measured, and
  // failing here would turn a reported verdict into a run that looks as though it
  // never happened.
  if (!res.written && res.why !== "no summary path was set") {
    console.error(`note: the summary file could not be written (${res.why})`);
  }
}

const key = process.env.CALCOM_API_KEY ?? "";
if (!key) {
  stop(
    REPLAY_EXIT["not-configured"],
    "no CALCOM_API_KEY here, so nothing was attempted. It is a wrangler secret on the " +
      "deployment; add it to .env.local to run this.",
  );
}
const org = envOr(process.env.CALCOM_ORG_ID, "19474");
const maxFetch = Number(envOr(process.env.REPLAY_MAX_FETCH, "2000"));
const paceMs = Number(envOr(process.env.REPLAY_PACE_MS, "550"));
const sinceIso = `${envOr(process.env.REPLAY_SINCE, "2026-09-10")}T00:00:00.000Z`;
const cachePath = envOr(
  process.env.REPLAY_CACHE,
  join(tmpdir(), "slate-router-replay", "bookings.json"),
);
if (!Number.isFinite(maxFetch) || maxFetch <= 0) {
  stop(REPLAY_EXIT["not-configured"], `REPLAY_MAX_FETCH is not a positive number: ${maxFetch}`);
}
if (!Number.isFinite(paceMs) || paceMs < 0) {
  stop(REPLAY_EXIT["not-configured"], `REPLAY_PACE_MS is not a number: ${paceMs}`);
}
if (Number.isNaN(Date.parse(sinceIso))) {
  stop(REPLAY_EXIT["not-configured"], `REPLAY_SINCE is not a date: ${sinceIso}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const calGet = makeCalGet({ key, sleep });

// --- Slate's side ------------------------------------------------------------
//
// Every read unwraps, so a failed one throws and the run says it could not read
// Slate. Degrading to an empty roster would report every cal.com host as somebody
// Slate has never heard of: a hundred findings from one broken read.

let world: ReturnType<typeof prepareWorld>;
let bucketCount = 0;
try {
  const db = supabaseAdmin();
  // cap-safe: users is roster bounded, ~142 rows against a 200-agent design target
  const users = (unwrap(
    await db.from("users").select("id, email, bookable, deactivated_at, is_test, attributes"),
    "replay users",
  ) ?? []) as {
    id: string;
    email: string;
    bookable: boolean;
    deactivated_at: string | null;
    is_test: boolean;
    attributes: Record<string, unknown> | null;
  }[];
  // cap-safe: buckets is roster bounded, 60 codes
  const buckets = (unwrap(
    await db.from("buckets").select("id, code, criteria").eq("is_test", false),
    "replay buckets",
  ) ?? []) as { id: string; code: string; criteria: Record<string, unknown> | null }[];
  // cap-safe: bucket_members is roster bounded, a handful of hand named people
  const members = (unwrap(
    await db.from("bucket_members").select("bucket_id, user_id").eq("active", true),
    "replay bucket members",
  ) ?? []) as { bucket_id: string; user_id: string }[];

  const membersByBucket = new Map<string, string[]>();
  for (const m of members) {
    const list = membersByBucket.get(m.bucket_id);
    if (list) list.push(m.user_id);
    else membersByBucket.set(m.bucket_id, [m.user_id]);
  }
  bucketCount = buckets.length;
  world = prepareWorld({
    users: users.map(
      (u): ReplayUser => ({
        id: u.id,
        email: u.email,
        bookable: u.bookable,
        deactivated: u.deactivated_at !== null,
        isTest: u.is_test,
        attributes: (u.attributes ?? {}) as ReplayUser["attributes"],
      }),
    ),
    buckets: buckets.map(
      (b): ReplayBucket => ({
        code: b.code,
        criteria: (b.criteria ?? {}) as ReplayBucket["criteria"],
        memberIds: membersByBucket.get(b.id) ?? [],
      }),
    ),
  });
} catch (err) {
  stop(
    REPLAY_EXIT["slate-unreadable"],
    `a Slate read failed, so the pools to compare against are not known: ${(err as Error).message}`,
  );
}

if (world.bookableCount === 0 || bucketCount === 0) {
  stop(
    REPLAY_EXIT["nothing-judged"],
    `Slate has ${world.bookableCount} bookable agents and ${bucketCount} real buckets, so there ` +
      "was nothing to compare against. A dark roster (#1272) looks exactly like this and is not a pass.",
  );
}

// --- cal.com's side ----------------------------------------------------------

interface FormRow {
  id: string;
  name: string;
}
interface ResponseRow {
  id: number;
  formId: string;
  routedToBookingUid: string | null;
  response: unknown;
  createdAt: string;
}

const formsRes = await calGet(`/organizations/${org}/routing-forms`);
const forms = (formsRes.json as { data?: FormRow[] } | null)?.data;
if (formsRes.status !== 200 || !Array.isArray(forms)) {
  stop(
    REPLAY_EXIT["calcom-unreadable"],
    `cal.com answered ${formsRes.status} for the org's routing forms, so no lead could be read.` +
      (formsRes.status === 429
        ? " That is the rate limit, which is shared with anything else using this key: wait a minute and run it again."
        : ""),
  );
}
if (forms.length === 0) {
  stop(REPLAY_EXIT["nothing-judged"], "cal.com holds no routing forms for this org.");
}

const THIRTY_DAYS_MS = 30 * 86_400_000;
const now = Date.now();
const secondaryFromMs = now - THIRTY_DAYS_MS;
// The WIDER window is what is fetched, and the primary is a filter over it, so one
// pass of cal.com answers both questions rather than two.
const fetchFromMs = Math.min(secondaryFromMs, Date.parse(sinceIso));
const fetchFromIso = new Date(fetchFromMs).toISOString();

const PAGE = 250;
const responses: ResponseRow[] = [];
for (const form of forms) {
  for (let skip = 0; ; skip += PAGE) {
    const path =
      `/organizations/${org}/routing-forms/${form.id}/responses` +
      `?take=${PAGE}&skip=${skip}&sortCreatedAt=desc&afterCreatedAt=${encodeURIComponent(fetchFromIso)}`;
    const res = await calGet(path);
    const rows = (res.json as { data?: ResponseRow[] } | null)?.data;
    if (res.status !== 200 || !Array.isArray(rows)) {
      stop(
        REPLAY_EXIT["calcom-unreadable"],
        `cal.com answered ${res.status} for the responses of "${form.name}", so this run saw only ` +
          "part of the traffic and its rates would be about whichever forms happened to answer. " +
          `A 429 here means the pacing is too fast for the org's budget (measured: 120 requests a ` +
          `minute); this run used REPLAY_PACE_MS=${paceMs}.`,
      );
    }
    for (const row of rows) responses.push({ ...row, formId: form.id });
    if (rows.length < PAGE) break;
    // Paced like every booking read, and for the reason the first live run found:
    // cal.com meters the responses endpoint hard enough that paging 250 at a time
    // with no pause exhausts the retry ladder on the fourth form. The refusal was
    // correct (a run that saw part of the traffic would report rates about
    // whichever forms happened to answer), which is exactly why the pacing has to
    // make it unnecessary rather than the ladder longer.
    if (paceMs > 0) await sleep(paceMs);
  }
}

// Sorted NEWEST FIRST across every form, and that is load bearing rather than
// cosmetic. The cap takes the head of this list, so leaving it in per form order
// means the whole sample comes from whichever form paged first: the first live run
// resolved 139 hosts and every one of them was from one of three forms, so the by
// form table read as two forms with zero agreements rather than two forms nobody
// had asked about. A sample biased by the order the reads happened to happen in is
// not a sample of the traffic.
const routed = responses
  .filter((r) => (r.routedToBookingUid ?? "") !== "")
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
if (routed.length === 0) {
  stop(
    REPLAY_EXIT["nothing-judged"],
    `no routed lead since ${fetchFromIso} across ${forms.length} forms, so nothing was replayed.`,
  );
}

// --- The booking cache -------------------------------------------------------
//
// A booking is fetched once and kept, because the fact this needs (who cal.com
// chose) does not change for a call that has already happened. Two things ARE
// re-fetched: a start still in the future, because it can be cancelled or moved,
// and anything read more than two days ago, so a long lived cache cannot quietly
// become the thing being measured.

interface CachedBooking {
  hostEmails: string[];
  start: string | null;
  end: string | null;
  status: string | null;
  eventTypeId: number | null;
  eventTypeSlug: string | null;
  fetchedAt: string;
}
let cache: Record<string, CachedBooking> = {};
try {
  cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, CachedBooking>;
} catch {
  // A missing or unreadable cache is an empty one. Nothing is lost: every entry is
  // re-fetchable, and the alternative (refusing to run) would make a corrupt file
  // on one laptop into an outage of the command.
  cache = {};
}

// The RULE lives in `router-replay.ts` and is pinned offline; this is the wiring.
const fresh = (entry: CachedBooking | undefined): boolean => freshBooking(entry, now);

// The budget is SPLIT between the two windows (`splitBudget`, pinned offline), so
// the secondary one is sampled rather than reported as a copy of the primary. Each
// half keeps newest first within itself.
const primaryStartMs = Date.parse(sinceIso);
const unread = (uids: string[]) => uids.filter((uid) => !fresh(cache[uid]));
const uidsIn = (pred: (atMs: number) => boolean): string[] => [
  ...new Set(
    routed
      .filter((r) => {
        const at = Date.parse(r.createdAt);
        return Number.isFinite(at) && pred(at);
      })
      .map((r) => r.routedToBookingUid!),
  ),
];
const wanted = [...new Set(routed.map((r) => r.routedToBookingUid!))];
const recentUnread = unread(uidsIn((at) => at >= primaryStartMs));
const olderUnread = unread(uidsIn((at) => at < primaryStartMs));
const budget = splitBudget(recentUnread.length, olderUnread.length, maxFetch);
const toFetch = [...recentUnread.slice(0, budget.recent), ...olderUnread.slice(0, budget.older)];
// Every uid this run ends up HOLDING a reading for: the cache it started with plus
// what it asked about. A lead outside this set is not "unreadable", it is one
// nothing asked about, and the two must not share a number (L11).
const asked = new Set([...wanted.filter((uid) => fresh(cache[uid])), ...toFetch]);
let read = 0;
let refused = 0;
for (const uid of toFetch) {
  const res = await calGet(`/bookings/${encodeURIComponent(uid)}`, CAL_BOOKINGS_API_VERSION);
  const data = (res.json as { data?: Record<string, unknown> } | null)?.data;
  if (res.status !== 200 || !data) {
    refused++;
  } else {
    const hosts = Array.isArray(data.hosts) ? (data.hosts as { email?: unknown }[]) : [];
    const et = (data.eventType ?? null) as { id?: unknown; slug?: unknown } | null;
    cache[uid] = {
      // Host emails only. The attendee is the LEAD, and their details have no
      // business in a file on a laptop: this command never needs them and the
      // cache must not be a place they accumulate.
      hostEmails: hosts
        .map((h) => (typeof h.email === "string" ? h.email.trim().toLowerCase() : ""))
        .filter((e) => e !== ""),
      start: typeof data.start === "string" ? data.start : null,
      end: typeof data.end === "string" ? data.end : null,
      status: typeof data.status === "string" ? data.status : null,
      eventTypeId: typeof et?.id === "number" ? et.id : null,
      eventTypeSlug: typeof et?.slug === "string" ? et.slug : null,
      fetchedAt: new Date(now).toISOString(),
    };
    read++;
  }
  if (paceMs > 0) await sleep(paceMs);
}

try {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache), "utf8");
} catch (err) {
  // An unwritable cache costs the NEXT run time and costs this one nothing, so it
  // is reported and not fatal. Said out loud rather than swallowed, because a cache
  // that silently never persists makes every run a full re-fetch (L98).
  console.error(`note: the booking cache could not be written to ${cachePath}: ${(err as Error).message}`);
}

// Not one booking readable is a BROKEN READ, not a thin sample: a wrong API
// version answers exactly like this for every uid, and reporting it as "too few
// hosts resolved" would send somebody to look at the data (L11).
if (toFetch.length > 0 && read === 0) {
  stop(
    REPLAY_EXIT["hosts-unreadable"],
    `cal.com would not answer for any of the ${toFetch.length} bookings asked about, so not one ` +
      `lead could be replayed. Check the bookings API version (${CAL_BOOKINGS_API_VERSION}) and the key's scope.`,
  );
}

// --- Judge -------------------------------------------------------------------

const formName = new Map(forms.map((f) => [f.id, f.name]));

function leadsFrom(fromMs: number, beforeMs = Infinity): ReplayLead[] {
  return routed
    .filter((r) => {
      const at = Date.parse(r.createdAt);
      return Number.isFinite(at) && at >= fromMs && at < beforeMs;
    })
    .map((r): ReplayLead => {
      const uid = r.routedToBookingUid!;
      const entry = cache[uid];
      return {
        formId: r.formId,
        formName: formName.get(r.formId) ?? r.formId,
        responseId: r.id,
        createdAt: r.createdAt,
        rawCode: extractCode(r.response),
        bookingUid: uid,
        // `null` rather than `[]` for a booking that WAS asked about and could not
        // be read. A lead nobody asked about is `sampled: false` instead, and moves
        // no rate at all.
        hostEmails: entry ? entry.hostEmails : null,
        sampled: asked.has(uid),
      };
    });
}

const primaryFromMs = primaryStartMs;
const primary = summarise(leadsFrom(primaryFromMs), world);
// The 30 days BEFORE the primary window, not the 30 days including it: two windows
// that overlap cannot be compared, because the second is mostly the first and a
// difference between them is diluted by however much they share.
const secondary = summarise(leadsFrom(secondaryFromMs, primaryFromMs), world);

// --- Report ------------------------------------------------------------------

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const share = (n: number | null) => (n === null ? "unknown" : pct(n));

console.log("Router replay: cal.com's routed leads put back through Slate's ladder");
console.log(
  "\nWhat this does and does not measure. Slate's debt tiers and backend service come\n" +
    "from the same Twilio tags the Pipedream job feeds cal.com (#2152), so the ATTRIBUTES\n" +
    "both systems route on are one source and agree by construction. What is under test\n" +
    "is everything downstream: the code resolution, the tier ladder with its Beyond\n" +
    "overflow, and the pool predicate.\n\n" +
    "The attributes and pools are TODAY'S, and the leads are historical. An agent whose\n" +
    "tiers changed since a lead was routed reads as a disagreement, which is why the\n" +
    "primary window starts the day the attribute source became shared.\n\n" +
    "Read every rate against the baseline beside it: with the legal digit retired the\n" +
    "big pools hold most of the roster, so a coin flip agrees most of the time.",
);
console.log(
  `\nRoster: ${world.bookableCount} bookable agents, ${bucketCount} real buckets. ` +
    `${forms.length} routing forms, ${routed.length} routed leads since ${fetchFromIso.slice(0, 10)}.`,
);
const cached = wanted.filter((uid) => fresh(cache[uid])).length;
const beyondCap = wanted.length - asked.size;
console.log(
  `Bookings: ${wanted.length} distinct, ${cached} already cached, ${read} read this run, ` +
    `${refused} refused` +
    (beyondCap > 0 ? `, ${beyondCap} left unread by REPLAY_MAX_FETCH=${maxFetch}` : "") +
    ".",
);

function report(label: string, s: ReplaySummary, fromMs: number): void {
  console.log(`\n--- ${label} (from ${new Date(fromMs).toISOString().slice(0, 10)}) ---`);
  console.log(
    `${s.leadsInWindow} routed leads in the window, ${s.leads} asked about` +
      (s.notSampled > 0 ? ` (${s.notSampled} not sampled by this run)` : "") +
      `, ${s.judged} judged.`,
  );
  console.log(
    `host resolved ${pct(s.resolution)} of those asked about, catch-all ${pct(s.catchallShare)}`,
  );
  console.log(
    `LADDER agreement ${pct(s.agreement)} of ${s.judged} (strict ${pct(s.strictAgreement)}) ` +
      `against a chance baseline of ${share(s.baseline)}`,
  );
  if (s.roster > 0) {
    console.log(
      `ROSTER differences ${s.roster} (${pct(s.rosterShare)}): cal.com routed to somebody Slate ` +
        "will not. Reported, never counted as a ladder disagreement, and it cannot fail this run: " +
        "pnpm verify:calcom-parity owns that question and pages on it.",
    );
  }
  for (const [cls, n] of Object.entries(s.byClass)) {
    if (n > 0) console.log(`  ${cls.padEnd(24)} ${n}`);
  }
  console.log("  by code (asked, agree, via ladder, baseline):");
  for (const row of s.byCode) {
    console.log(
      `    ${row.code.padEnd(6)} ${String(row.leads).padStart(5)} ` +
        `${String(row.byClass.agree).padStart(5)} ${String(row.byClass["agree-via-ladder"]).padStart(5)} ` +
        `${share(row.baseline).padStart(8)}`,
    );
  }
  console.log("  by form (asked, agree, via ladder):");
  for (const row of s.byForm) {
    console.log(
      `    ${String(row.leads).padStart(5)} ${String(row.byClass.agree).padStart(5)} ` +
        `${String(row.byClass["agree-via-ladder"]).padStart(5)}  ${row.formName.slice(0, 60)}`,
    );
  }
}

report("PRIMARY, one shared attribute source", primary, primaryFromMs);
report("SECONDARY, the 30 days before that", secondary, secondaryFromMs);

// The run exits on the PRIMARY window. The secondary is reported because a large
// gap between the two is itself the finding (it says the attributes moved), but it
// cannot fail a run: every lead in it predates the shared source, so a
// disagreement there is expected rather than a defect (L36).
const verdict = replayOutcome(primary);
if (verdict.outcome === "agree") {
  const agreed =
    `AGREE: Slate's ladder places ${pct(primary.agreement)} of the ${primary.judged} leads it got to ` +
    `decide about, against a chance baseline of ${share(primary.baseline)}` +
    (primary.roster > 0
      ? `, with ${primary.roster} further leads routed to somebody Slate's roster rules out.`
      : ".");
  console.log(`\n${agreed}`);
  writeSummary("agree", 0, agreed);
  process.exit(0);
}
type ReplayOutcome = import("./lib/router-replay.ts").ReplayOutcome;
const why: Record<Exclude<ReplayOutcome, "agree">, string> = {
  "nothing-judged":
    `nothing in the primary window could be judged (${primary.leadsInWindow} routed leads, ` +
    `${primary.leads} asked about, ${primary.judged} judged), so this run measured nothing. ` +
    "That is never a pass.",
  "resolution-too-low":
    `only ${pct(primary.resolution)} of the ${primary.leads} leads this run asked about had a ` +
    `readable host, under the ${pct(MIN_RESOLUTION)} needed before an agreement rate means anything. ` +
    "This is about cal.com refusing, not about the cap: a lead the cap never reached is not counted here.",
  "catchall-too-high":
    `${pct(primary.catchallShare)} of leads fell to the catch-all, over the ${pct(MAX_CATCHALL)} ceiling. ` +
    "Catch-all leads are excluded from the agreement denominator, so a broken code lookup RAISES the " +
    "headline rate while making the run mean less.",
  disagreement:
    `LADDER agreement is ${pct(primary.agreement)} of ${primary.judged} leads Slate's ladder got to ` +
    `decide about, under ${pct(MIN_AGREEMENT)}, against a chance baseline of ${share(primary.baseline)}. ` +
    "The per code rows above say where. Roster differences are excluded from this rate and reported " +
    "separately, so this is Slate routing a lead differently rather than the two rosters disagreeing.",
};
writeSummary(verdict.outcome, verdict.exit, why[verdict.outcome]);
stop(verdict.exit, why[verdict.outcome]);

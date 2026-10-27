// The reads shared by `pnpm import:calcom-schedules` and
// `pnpm verify:calcom-parity` (#1754). Run:
//   node --experimental-strip-types scripts/test-calcom-roster.ts
//
// WHY THEY ARE SHARED. The importer WRITES cal.com's hours into Slate and the
// parity command READS both to see whether they still agree. They ask cal.com the
// same three questions (who exists in the org, what is this user's default
// schedule, and how do I survive the rate limit) and Slate the same one (who is a
// bookable agent and what week do we hold for them). Two copies of "who is a
// bookable agent" is the pair that matters most: the moment they disagree, the
// command reports agreement about a roster the importer never wrote to.
//
// THE RATE LIMIT IS NOT HYPOTHETICAL. The first real import run met 429 on 89 of
// 103 agents. The ladder is driven here with an injected clock, so the retry
// behaviour is proved without a test that waits (L524, L290).
import {
  emailIndex,
  loadBookableRoster,
  makeCalGet,
  readEventTypeId,
  earnsSecondRead,
  secondReadWaitMs,
  readEachWithSecondRead,
  SECOND_READ_BACKOFF_MS,
  SECOND_READ_MAX_WAIT_MS,
  CAL_SCHEDULES_API_VERSION,
  CAL_BOOKINGS_API_VERSION,
} from "./lib/calcom-roster.ts";
import { pickDefaultSchedule } from "@/lib/calcom/schedule-import";
import { assert, eq, finish } from "./lib/harness.ts";

// --- which of a user's schedules is the one Slate compares against -------------
{
  // cal.com returns every schedule a user owns. Only the default is the one their
  // bookings are taken against, so taking the wrong one would compare Slate to a
  // week nobody books through and report drift that does not exist.
  const r = pickDefaultSchedule({
    data: [
      { id: 1, name: "Holiday cover", isDefault: false, timeZone: "UTC" },
      { id: 2, name: "Working Hours", isDefault: true, timeZone: "America/Denver" },
    ],
  });
  eq(r.kind, "schedule", "a payload with a default yields it");
  if (r.kind === "schedule") eq((r.schedule as { id: number }).id, 2, "the DEFAULT one, not the first one");
}
{
  // A single unflagged schedule is the working week in practice, and the importer
  // has always taken it. Refusing it here would strand every agent cal.com never
  // marked, which on this roster is a real population.
  const r = pickDefaultSchedule({ data: [{ id: 7, timeZone: "UTC" }] });
  eq(r.kind, "schedule", "one schedule with no default flag is still the schedule");
  if (r.kind === "schedule") eq((r.schedule as { id: number }).id, 7, "and it is the one returned");
}
{
  // mharris@ today. An account with no schedule at all is a real state and its own
  // outcome: it needs somebody to ask the agent, not somebody to retry.
  const r = pickDefaultSchedule({ data: [] });
  eq(r.kind, "none", "an empty list is no schedule, not an error");
}
{
  // Distinct from the empty case, because it means the payload changed shape under
  // us rather than that the agent has nothing set. Collapsing them would report a
  // broken contract as a person to chase (L11).
  eq(pickDefaultSchedule({ data: "nope" }).kind, "unreadable", "a non-list refuses");
  eq(pickDefaultSchedule(null).kind, "unreadable", "a null payload refuses");
  eq(pickDefaultSchedule({}).kind, "unreadable", "a payload with no data key refuses");
}

// --- the org listing, one read for the whole roster ----------------------------
{
  const r = emailIndex({ data: [{ id: 1, email: "A@TryPennie.com" }, { id: 2, email: "b@trypennie.com" }] });
  assert(r.ok, "a well-formed listing reads");
  if (r.ok) {
    eq(r.index.get("a@trypennie.com"), 1, "lookup is case insensitive, because the two systems disagree on case");
    eq(r.index.size, 2, "every user is indexed");
  }
}
{
  // A listing we can only half read yields FEWER users, and a missing user is
  // reported as "no cal.com account", which is a finding about the roster rather
  // than about our parsing. So it refuses whole (L340).
  const r = emailIndex({ data: [{ id: 1, email: "a@trypennie.com" }, { id: 2 }] });
  assert(!r.ok, "a user with no email refuses the whole listing");
  const bad = emailIndex({ data: null });
  assert(!bad.ok, "a listing that is not a list refuses");
}

// --- surviving the rate limit --------------------------------------------------
{
  // 429 then success. The point is that the caller gets the success: a ladder that
  // gave up on the first refusal is how 89 of 103 agents were skipped.
  const waits: number[] = [];
  let calls = 0;
  const calGet = makeCalGet({
    key: "k",
    sleep: async (ms) => void waits.push(ms),
    fetchImpl: (async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "2" } });
      return new Response(JSON.stringify({ data: [1] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const r = await calGet("/whatever");
  eq(r.status, 200, "a rate limited read retries and succeeds");
  eq(calls, 2, "exactly one retry was needed");
  eq(waits, [2000], "and it waited as long as cal.com asked, not as long as we guessed");
}
{
  // A 404 is not retried: trying again cannot create a schedule that does not
  // exist, and hammering a system refusing us makes the refusal worse.
  let calls = 0;
  const calGet = makeCalGet({
    key: "k",
    sleep: async () => {},
    fetchImpl: (async () => {
      calls++;
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch,
  });
  const r = await calGet("/gone");
  eq(r.status, 404, "the refusal is returned rather than thrown");
  eq(calls, 1, "and it is not retried");
}
{
  // The ladder is finite. Without a cap a permanently rate limited endpoint hangs
  // the run forever, which is worse than failing: a hang is indistinguishable from
  // slowness and nothing reports it (L110).
  let calls = 0;
  const calGet = makeCalGet({
    key: "k",
    sleep: async () => {},
    fetchImpl: (async () => {
      calls++;
      return new Response("", { status: 429 });
    }) as unknown as typeof fetch,
  });
  const r = await calGet("/busy");
  eq(r.status, 429, "a sustained rate limit ends as a refusal the caller can classify");
  assert(calls > 1 && calls <= 6, `it retried and then stopped (attempts: ${calls})`);
}
{
  // A thrown fetch is a transport fault, the same class as a 5xx, and the run
  // should survive one. If it never recovers the throw is re-raised rather than
  // being turned into a status nobody can tell from a real answer.
  let calls = 0;
  const calGet = makeCalGet({
    key: "k",
    sleep: async () => {},
    fetchImpl: (async () => {
      calls++;
      if (calls < 3) throw new Error("socket hang up");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const r = await calGet("/flaky");
  eq(r.status, 200, "a transport blip is retried through");
  eq(calls, 3, "twice, then the answer");
}
{
  let thrown = false;
  const calGet = makeCalGet({
    key: "k",
    sleep: async () => {},
    fetchImpl: (async () => {
      throw new Error("network is down");
    }) as unknown as typeof fetch,
  });
  await calGet("/dead").catch(() => { thrown = true; });
  assert(thrown, "a fetch that never recovers throws rather than reporting a status it never got");
}
{
  // The key must actually reach cal.com. A request sent without it is answered 401,
  // which the caller reports as cal.com refusing us: a configuration fault wearing
  // the costume of an outage.
  let sawAuth: string | null = null;
  let sawUrl = "";
  const calGet = makeCalGet({
    key: "secret-key",
    sleep: async () => {},
    fetchImpl: ((url: string, init: { headers: Record<string, string> }) => {
      sawUrl = url;
      sawAuth = init.headers.Authorization;
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }) as unknown as typeof fetch,
  });
  await calGet("/organizations/1/users");
  eq(sawAuth, "Bearer secret-key", "the key is sent");
  assert(sawUrl.startsWith("https://api.cal.com/v2/organizations/1/users"), `the path is under the v2 API (${sawUrl})`);
}

{
  // The refusal carries cal.com's own Retry-After out of the ladder, so the second
  // read below can honour it rather than guess (#3963).
  const calGet = makeCalGet({
    key: "k",
    sleep: async () => {},
    fetchImpl: (async () => new Response("", { status: 429, headers: { "retry-after": "90" } })) as unknown as typeof fetch,
  });
  const r = await calGet("/busy");
  eq(r.status, 429, "a sustained rate limit is still a refusal");
  eq(r.retryAfter, "90", "and it says how long cal.com asked us to wait");
}

// --- a second read for the agents cal.com rate limited (#3963) -------------------
//
// Five of seven daily runs ended with exactly three agents unmeasured, a different
// three each day, every one a 429 that had already climbed the whole ladder. The
// ladder retries inside the burst that caused the refusal; a second read after the
// sweep has finished, and after cal.com's window has passed, is what turns a rate
// limit into a delay rather than a missing comparison.
{
  const res = (status: number, retryAfter: string | null = null) => ({ status, json: status === 200 ? { data: [] } : null, retryAfter });
  eq(earnsSecondRead({ kind: "answered", ...res(429) }), true, "a rate limit earns a second read");
  eq(earnsSecondRead({ kind: "answered", ...res(500) }), false, "a server fault does not: the ladder already rode it out");
  eq(earnsSecondRead({ kind: "answered", ...res(404) }), false, "a not found does not: another read cannot create a schedule");
  eq(earnsSecondRead({ kind: "answered", ...res(200) }), false, "an answer does not");
  eq(earnsSecondRead({ kind: "threw", error: new Error("x") }), false, "a transport fault does not");

  eq(secondReadWaitMs([{ kind: "answered", ...res(429) }]), SECOND_READ_BACKOFF_MS, "no Retry-After waits the fixed backoff");
  eq(secondReadWaitMs([{ kind: "answered", ...res(429, "5") }]), SECOND_READ_BACKOFF_MS, "a shorter Retry-After was already honoured by the ladder and failed, so the backoff wins");
  eq(secondReadWaitMs([{ kind: "answered", ...res(429, "90") }, { kind: "answered", ...res(429, "70") }]), 90_000, "a longer Retry-After is honoured, the longest one");
  eq(secondReadWaitMs([{ kind: "answered", ...res(429, "soon") }]), SECOND_READ_BACKOFF_MS, "an unreadable Retry-After falls back to the backoff, never NaN");
  eq(secondReadWaitMs([{ kind: "answered", ...res(429, "86400") }]), SECOND_READ_MAX_WAIT_MS, "and a huge one is capped, so the job's timeout is not spent waiting");
}
{
  // The fixtures the issue names: 429 then 200 is measured, 429 twice stays
  // unmeasured, a non 429 failure is never read again. Waits are recorded, never
  // slept, so this finishes instantly (L524).
  const answers: Record<string, number[]> = {
    healthy: [200],
    "429-then-200": [429, 200],
    "429-twice": [429, 429],
    "500": [500],
    "404": [404],
  };
  const calls: Record<string, number> = {};
  const waits: number[] = [];
  const items = [...Object.keys(answers), "throws"];
  const out = await readEachWithSecondRead(
    items,
    async (item) => {
      calls[item] = (calls[item] ?? 0) + 1;
      if (item === "throws") throw new Error("socket hang up");
      const status = answers[item][calls[item] - 1];
      return { status, json: status === 200 ? { data: [item] } : null, retryAfter: null };
    },
    { sleep: async (ms) => void waits.push(ms), paceMs: 250 },
  );
  const status = (item: string) => {
    const r = out.reads.get(item);
    return r?.kind === "answered" ? r.status : r?.kind;
  };
  eq(status("429-then-200"), 200, "429 then 200 ends measured");
  eq(calls["429-then-200"], 2, "after exactly one more read");
  eq(status("429-twice"), 429, "429 twice stays unmeasured, exactly as before");
  eq(calls["429-twice"], 2, "and is read only twice, never a third time");
  eq(status("500"), 500, "a server fault is left as it was");
  eq(calls["500"], 1, "and not read again");
  eq(calls["404"], 1, "nor is a not found");
  eq(status("throws"), "threw", "a read that throws is recorded, not raised, so one agent cannot end the run");
  eq(calls.throws, 1, "and is not read again");
  eq(calls.healthy, 1, "an answered agent is read once");
  eq(out.reads.size, items.length, "every agent has an outcome");
  eq(out.retried, 2, "two agents earned a second read");
  eq(out.recovered, 1, "and one of them answered");
  eq(
    waits,
    [250, 250, 250, 250, 250, 250, SECOND_READ_BACKOFF_MS, 250],
    "paced on every read, and one backoff before the second pass (standing in for its first pace), not one per agent",
  );
}
{
  // A sweep cal.com never refused pays no backoff at all: the common day before
  // this change, and most of the roster, must not get slower.
  const waits: number[] = [];
  const out = await readEachWithSecondRead(
    ["a", "b"],
    async () => ({ status: 200, json: { data: [] } }),
    { sleep: async (ms) => void waits.push(ms), paceMs: 250 },
  );
  eq(waits, [250, 250], "no second pass, no backoff");
  eq(out.retried, 0, "nothing retried");
}
{
  // An empty list reads nothing and waits for nothing.
  const waits: number[] = [];
  const out = await readEachWithSecondRead([], async () => ({ status: 200, json: null }), {
    sleep: async (ms) => void waits.push(ms),
    paceMs: 250,
  });
  eq(out.reads.size, 0, "nothing read");
  eq(waits, [], "nothing waited");
}

// --- the event type id, which decides which host list is read ------------------
{
  // Handed to a strict equality against every event type cal.com returns. Left to
  // `Number()` alone, an unreadable value is NaN, NaN matches nothing, and the run
  // stops with "event type NaN is not among team 19546's event types": a true
  // sentence that sends somebody hunting for a missing event type rather than for
  // the mistyped setting they actually have (L50, L11).
  eq(readEventTypeId(undefined, 1314152), 1314152, "an unset value takes the default");
  eq(readEventTypeId("", 1314152), 1314152, "and so does an empty one, which is how a blank env var arrives");
  eq(readEventTypeId("  ", 1314152), 1314152, "whitespace is empty too");
  eq(readEventTypeId("1860420", 1314152), 1860420, "a real id is taken");
  eq(readEventTypeId(" 1860420 ", 1314152), 1860420, "padded, because a copied value carries spaces");
  eq(readEventTypeId("nonsense", 1314152), null, "a value that is not a number is REFUSED, never defaulted");
  eq(readEventTypeId("0", 1314152), null, "zero is not an id");
  eq(readEventTypeId("-5", 1314152), null, "nor is a negative");
  eq(readEventTypeId("12.5", 1314152), null, "nor a fraction, which would match nothing and read as a missing event type");
  eq(readEventTypeId("1e5", 1314152), null, "nor a form no cal.com id is ever written in");
}
{
  // Refusing must not collapse into the default. Falling back would silently read
  // the WRONG event type's host list and report a confident answer about a
  // comparison nobody asked for (L214).
  assert(
    readEventTypeId("nonsense", 1314152) !== 1314152,
    "a refusal is never the default wearing a different hat",
  );
}

// --- the API version is per CALL, not per reader (#2240) ---------------------
{
  // One command now reads two endpoint families that answer under DIFFERENT
  // versions: the schedules endpoint does not exist under the bookings one and
  // answers 404 rather than saying so, so a reader that sent one version for both
  // would report "no such booking" for every lead in the replay. Both halves are
  // asserted, because a seam that only ever sends its default is not a seam (L1).
  const sent: (string | null)[] = [];
  const calGet = makeCalGet({
    key: "k",
    sleep: async () => {},
    fetchImpl: (async (_url: string, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>)["cal-api-version"] ?? null);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await calGet("/organizations/1/users/2/schedules");
  await calGet("/bookings/abc", CAL_BOOKINGS_API_VERSION);
  eq(sent[0], CAL_SCHEDULES_API_VERSION, "a call naming no version gets the schedules one");
  eq(sent[1], CAL_BOOKINGS_API_VERSION, "a call naming its own version gets that one");
  assert(
    CAL_SCHEDULES_API_VERSION !== CAL_BOOKINGS_API_VERSION,
    "the two versions really differ, or the case above proves nothing",
  );
}

// --- the roster's rules are read whole, past PostgREST's page (#2416) --------
//
// `availability_rules` is one row per agent per weekday window: 793 on the live
// roster on 2026-10-02, and past 1,000 at the 200 agent design target with any
// weekend cover or split day. PostgREST answers a read with at most 1,000 rows and
// says nothing about the rest, so an unpaged read hands back a SHORTER week for
// every agent whose rules fell past the page, and the parity command reports them
// as days that differ while the importer diffs a week it never fully loaded.
//
// The fake caps every response at 1,000 rows exactly as PostgREST does, honours
// `.range`, `.order` and `.gt`, and fails the named table when told to.
{
  const PG_CAP = 1000;
  type Row = Record<string, unknown>;
  function fakeDb(tables: Record<string, Row[]>, opts: { failTable?: string } = {}) {
    const ranges: Record<string, [number, number][]> = {};
    const from = (table: string) => {
      let rows = [...(tables[table] ?? [])];
      let range: [number, number] | null = null;
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => ((rows = rows.filter((r) => r[col] === v)), q),
        is: (col: string, v: unknown) => ((rows = rows.filter((r) => (r[col] ?? null) === v)), q),
        // #4205: the real advisor rule leaves coordinators out by role.
        neq: (col: string, v: unknown) => ((rows = rows.filter((r) => r[col] !== v)), q),
        in: (col: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[col]))), q),
        // The keyset filter a paged read cuts its next page with (2026-10-25).
        gt: (col: string, v: unknown) => ((rows = rows.filter((r) => String(r[col]) > String(v))), q),
        order: (col: string) => (
          (rows = rows.sort((a, b) => String(a[col]).localeCompare(String(b[col])))), q
        ),
        range: (lo: number, hi: number) => {
          range = [lo, hi];
          (ranges[table] ??= []).push([lo, hi]);
          return q;
        },
        then: (resolve: (r: { data: Row[] | null; error: { message: string } | null }) => unknown) => {
          if (opts.failTable === table) return resolve({ data: null, error: { message: "boom" } });
          const window = range ? rows.slice(range[0], range[1] + 1) : rows;
          return resolve({ data: window.slice(0, PG_CAP), error: null });
        },
      };
      return q;
    };
    return { db: { from } as unknown as Parameters<typeof loadBookableRoster>[0], ranges };
  }
  const unwrap = <T,>(res: { data: T | null; error: { message: string } | null }, context: string): T | null => {
    if (res.error) throw new Error(`${context}: ${res.error.message}`);
    return res.data;
  };
  const pad = (n: number) => String(n).padStart(5, "0");
  function roster(agents: number, rulesPerAgent: number) {
    const users: Row[] = [];
    const scheds: Row[] = [];
    const rules: Row[] = [];
    for (let i = 0; i < agents; i++) {
      // Both flags at their column default, which the roster read filters on (#4201).
      users.push({ id: `u${pad(i)}`, email: `a${i}@trypennie.com`, bookable: true, deactivated_at: null, is_test: false, is_placeholder: false });
      scheds.push({ id: `s${pad(i)}`, user_id: `u${pad(i)}`, timezone: "America/New_York", hours_source: null });
      for (let d = 0; d < rulesPerAgent; d++) {
        // Ids interleave agents, so any one agent's rules straddle a page boundary
        // rather than sitting neatly inside one page.
        rules.push({ id: `r${pad(d * agents + i)}`, schedule_id: `s${pad(i)}`, weekday: d + 1, start_minute: 480, end_minute: 1020 });
      }
    }
    return { users, availability_schedules: scheds, availability_rules: rules };
  }

  // The control first: the fake really does truncate an unpaged read, or every
  // assertion below would pass against a reader that never paged at all.
  {
    const { db } = fakeDb(roster(300, 5));
    const raw = (await (db.from("availability_rules") as unknown as PromiseLike<{ data: Row[] }>)).data;
    eq(raw.length, 1000, "the fake caps an unpaged read at one PostgREST page, as production does");
  }

  for (const [agents, perAgent, label] of [
    [200, 5, "exactly one full page (1,000 rules)"],
    [143, 7, "one rule past a page (143 agents with a seven day week, 1,001 rules)"],
    [300, 5, "the design target with a full week each (1,500 rules)"],
  ] as const) {
    const { db, ranges } = fakeDb(roster(agents, perAgent));
    const loaded = await loadBookableRoster(db, unwrap);
    eq(loaded.length, agents, `${label}: every bookable agent comes back`);
    const short = loaded.filter((a) => a.rules.length !== perAgent);
    eq(short.length, 0, `${label}: no agent comes back holding fewer days than Slate stores`);
    eq(
      loaded.reduce((n, a) => n + a.rules.length, 0),
      agents * perAgent,
      `${label}: every rule is read`,
    );
    assert((ranges.availability_rules?.length ?? 0) >= 2, `${label}: the rules read went past its first page`);
  }

  // A page that fails must refuse the whole run, never stop at the rows it had:
  // a short list is the exact shape of the defect this exists to prevent.
  {
    const { db } = fakeDb(roster(300, 5), { failTable: "availability_rules" });
    let threw: unknown = null;
    try {
      await loadBookableRoster(db, unwrap);
    } catch (e) {
      threw = e;
    }
    assert(
      threw instanceof Error && /rules/.test(threw.message) && /boom/.test(threw.message),
      `a failed rules page refuses the run, naming the read (got ${threw instanceof Error ? threw.message : String(threw)})`,
    );
  }
}

finish();
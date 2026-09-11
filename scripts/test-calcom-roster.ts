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
  pickDefaultSchedule,
  emailIndex,
  makeCalGet,
  readEventTypeId,
  CAL_SCHEDULES_API_VERSION,
  CAL_BOOKINGS_API_VERSION,
} from "./lib/calcom-roster.ts";
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

finish();
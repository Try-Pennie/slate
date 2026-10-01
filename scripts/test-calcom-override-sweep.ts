// The cal.com override sweep (#1253): retry a recorded failure while it still
// matters, and page when an absence has BEGUN with cal.com never updated.
//
// Why this exists at all: cal.com is still the booking system taking real customer
// bookings, so an approved absence whose override never landed leaves an agent
// bookable during their time off. Until now the only recovery was a human reading
// one Slack message and pressing a button, which is a must-not-lose write resting
// on a best-effort mechanism. A single transient 500 in June consumed one absence's
// protection permanently.
//
// The selection predicate matters as much as the retry. Measured on prod
// 2026-08-04: 634 approved requests have `calcom_synced = false`, but 631 of those
// are from before the dual-write existed and carry NO cal.com outcome at all. A
// sweep keyed on the flag would have fired 631 writes, nearly all for absences long
// past. Keyed on a recorded FAILURE it matches 2.
import {
  CALCOM_ALERT_KEY,
  CALCOM_UNPROTECTED_KEY,
  formatUnprotectedAlert,
  inProgressUnprotected,
  agentEmailForRetry,
  isFailure,
  isSettled,
  isRetiredSkip,
  OUTCOME_EMAIL_UNREADABLE,
  OUTCOME_NO_EMAIL,
  runCalcomOverrideSweep,
  selectCandidates,
  PROVISIONAL_RETRY_WINDOW_DAYS,
  toCandidates,
  type OverrideCandidate,
} from "../src/lib/monitor/calcom-override-sweep.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-08-07T15:00:00Z");
const hours = (n: number) => n * 3_600_000;

const candidate = (over: Partial<OverrideCandidate> = {}): OverrideCandidate => ({
  id: "req-1",
  email: "agent@trypennie.com",
  startsAt: new Date(NOW + hours(48)).toISOString(),
  endsAt: new Date(NOW + hours(72)).toISOString(),
  effect: "failed: schedule patch returned 500",
  ...over,
});

// --- which rows need another attempt at all --------------------------------

{
  // The selection rule, in code rather than buried in a query, because the
  // interesting case is the one a "recorded failure" filter cannot express.
  //
  // #1275: nine approved FUTURE absences carry no cal.com outcome at all, because
  // they were approved before the dual-write existed. They are not failures and
  // they are certainly not done, so a filter keyed on either word misses them and
  // those agents stay bookable in cal.com throughout their time off.
  //
  // #1276: "not in cal.com" is PROVISIONAL, not terminal. It stops being true the
  // moment the agent is added there, which happened for real on 2026-08-04, and
  // new hires reaching Slate before cal.com make it the expected direction of
  // travel. Every row here has not ended yet (the loader's own filter), so a skip
  // in this set always has time left to become bookable.
  const rows: OverrideCandidate[] = [
    candidate({ id: "failed", effect: "failed: schedule patch returned 500" }),
    candidate({ id: "never-attempted", effect: "" }),
    candidate({ id: "done", effect: "ok" }),
    candidate({ id: "no-account-yet", effect: "skipped: not in cal.com (a@b.com)" }),
    candidate({ id: "calcom-off", effect: "skipped: cal.com not configured" }),
  ];
  // Pinned at BOTH ends. The fixture's start is NOW plus 48 hours, so leaving the
  // clock to the real one walked the pair out of the retry window entirely and the
  // assertion below stopped being about the rule it names (L130).
  const picked = selectCandidates(rows, NOW).map((r) => r.id);
  eq(
    JSON.stringify([...picked].sort()),
    JSON.stringify(["failed", "never-attempted", "no-account-yet"]),
    "picks a recorded failure, one never attempted, AND an agent who may since have a cal.com account",
  );
  // The other skip reason is genuinely terminal: cal.com being unconfigured is not
  // something a later tick can discover has changed, and retrying it forever would
  // spend the per tick cap on a lookup that cannot succeed.
  assert(!picked.includes("calcom-off"), "cal.com being unconfigured stays terminal");
  assert(!picked.includes("done"), "and a successful write is never redone");

  // Real failures come FIRST, because the per tick cap is a shared budget: a run of
  // agents waiting on cal.com accounts must not push an override that genuinely
  // failed past the cap, where it goes unattempted for a whole tick (L117).
  eq(
    picked[picked.length - 1],
    "no-account-yet",
    "and a provisional skip is ordered behind the real failures it shares the cap with",
  );
}

// --- how far ahead a provisional skip is worth re-checking ------------------

{
  // An agent who never gets a cal.com account would otherwise cost one outbound
  // lookup every five minutes, and hold a slot in the per tick cap, for as long as
  // the absence is in the future. The retry is only useful before somebody can
  // book into the absence, and nobody books further out than the booking horizon.
  const far = new Date(NOW + (PROVISIONAL_RETRY_WINDOW_DAYS + 30) * hours(24)).toISOString();
  const near = new Date(NOW + hours(24)).toISOString();
  const rows: OverrideCandidate[] = [
    candidate({ id: "soon", effect: "skipped: not in cal.com (a@b.com)", startsAt: near }),
    candidate({ id: "months-away", effect: "skipped: not in cal.com (a@b.com)", startsAt: far }),
    // A real failure is retried whatever its date: it is evidence something went
    // wrong, not a state that may change on its own.
    candidate({ id: "failed-far", effect: "failed: 500", startsAt: far }),
  ];
  const picked = selectCandidates(rows, NOW).map((r) => r.id).sort();
  eq(
    JSON.stringify(picked),
    JSON.stringify(["failed-far", "soon"]),
    "a provisional skip is re-checked as its absence approaches, not for months beforehand",
  );

  // Deferred, never dropped: the same row is picked up once it is close.
  const later = selectCandidates(rows, NOW + (PROVISIONAL_RETRY_WINDOW_DAYS + 29) * hours(24))
    .map((r) => r.id);
  assert(
    later.includes("months-away"),
    "and it re-enters the set as the absence approaches, well before anyone can book into it",
  );

  // An unreadable start keeps checking, because the cost of an extra lookup is a
  // lookup and the cost of skipping is an agent bookable through their time off.
  const unreadable = selectCandidates(
    [candidate({ id: "bad-date", effect: "skipped: not in cal.com (a@b.com)", startsAt: "not a date" })],
    NOW,
  );
  eq(unreadable.length, 1, "an unreadable start is re-checked, not silently deferred forever");
}

// --- whose absences count at all -------------------------------------------

{
  // An agent who has LEFT must not drive a retry or a page. Nobody can book someone
  // who no longer works here, so an override for them protects nothing, and paging
  // to ask a human to place one would be asking for work with no purpose in it.
  //
  // Real case, 2026-08-04: the one remaining skipped absence belonged to an agent who
  // had left Pennie. Benign there because a skip settles, but a departed agent still
  // present in cal.com whose write FAILED would have paged.
  const active = new Map([["u-active", "here@trypennie.com"]]);
  const rows = [
    { id: "keep", userId: "u-active", startsAt: "2026-08-09T13:00:00Z", endsAt: "2026-08-09T21:00:00Z", effect: "" },
    { id: "drop", userId: "u-departed", startsAt: "2026-08-09T13:00:00Z", endsAt: "2026-08-09T21:00:00Z", effect: "" },
  ];
  const out = toCandidates(rows, active);
  eq(out.length, 1, "a request whose agent has left is dropped entirely");
  eq(out[0].id, "keep", "and the active agent's request survives");
  eq(out[0].email, "here@trypennie.com", "carrying the email the override is keyed on");
}

// --- which ones are actually dangerous ------------------------------------

{
  const upcoming = candidate();
  const started = candidate({
    id: "req-2",
    startsAt: new Date(NOW - hours(2)).toISOString(),
    endsAt: new Date(NOW + hours(6)).toISOString(),
  });
  const found = inProgressUnprotected([upcoming, started], NOW);
  eq(found.length, 1, "only the absence already under way counts as unprotected");
  eq(found[0].id, "req-2", "and it is the started one");
}

{
  // An unreadable timestamp must not read as "not started yet", which would hide
  // the exact state this check exists to find (the parseStampMs fail-safe rule).
  const broken = candidate({ id: "req-3", startsAt: "not a date" });
  eq(
    inProgressUnprotected([broken], NOW).length,
    1,
    "an unreadable start is treated as under way, not silently skipped",
  );
}

// --- the sweep ------------------------------------------------------------

interface FakeOpts {
  candidates?: OverrideCandidate[] | null;
  outcomes?: Record<string, string>;
  max?: number;
  /** #2875: the "cal.com retired" read. Omitted, the sweep runs as it always has. */
  retired?: boolean | null | "throw";
}

function runFake(opts: FakeOpts) {
  const state = {
    retried: [] as string[],
    alerts: [] as string[],
    resolved: [] as string[],
    resolvedText: [] as string[],
    loaded: 0,
  };
  const promise = runCalcomOverrideSweep({
    nowMs: NOW,
    max: opts.max,
    ...(opts.retired === undefined
      ? {}
      : {
          calcomRetired: async () => {
            if (opts.retired === "throw") throw new Error("monitor_alert_config read failed");
            return opts.retired as boolean | null;
          },
        }),
    loadCandidates: async () => {
      state.loaded++;
      return opts.candidates ?? null;
    },
    retry: async (id) => {
      state.retried.push(id);
      return opts.outcomes?.[id] ?? "failed: schedule patch returned 500";
    },
    alert: async (key, text) => {
      state.alerts.push(`${key}|${text}`);
    },
    resolve: async (key, text) => {
      state.resolved.push(key);
      state.resolvedText.push(text);
      return true;
    },
  });
  return { state, promise };
}

{
  // A transient failure that clears on the retry: nothing to page about.
  const { state, promise } = runFake({
    candidates: [candidate()],
    outcomes: { "req-1": "ok" },
  });
  const res = await promise;
  eq(state.retried.length, 1, "the failed request is retried");
  eq(res.cleared, 1, "and counted as cleared when it comes back ok");
  eq(state.alerts.length, 0, "no page for a failure that just fixed itself");
}

{
  // A retry that comes back "not in cal.com" must NOT page: nobody can book an
  // agent who does not exist there, so nothing is unprotected. It is also not
  // CLEARED, because the reason it skipped can change on any later tick (#1276),
  // and counting it as done is what left an agent bookable through their time off
  // after they were added to the cal.com org.
  const { state, promise } = runFake({
    candidates: [
      candidate({
        startsAt: new Date(NOW - hours(1)).toISOString(),
        endsAt: new Date(NOW + hours(7)).toISOString(),
      }),
    ],
    outcomes: { "req-1": "skipped: not in cal.com (agent@trypennie.com)" },
  });
  const res = await promise;
  eq(state.alerts.length, 0, "an agent with no cal.com account never pages");
  eq(res.unprotected, 0, "and is not counted as unprotected, even mid absence");
  eq(res.cleared, 0, "and is not counted as cleared, because it can still change");
}

{
  // The terminal skip DOES clear: cal.com being switched off is not a state a
  // later tick can find has changed, so sweeping it forever would be waste.
  const { state, promise } = runFake({
    candidates: [candidate()],
    outcomes: { "req-1": "skipped: cal.com not configured" },
  });
  const res = await promise;
  eq(res.cleared, 1, "an unconfigured cal.com clears the row for good");
  eq(state.alerts.length, 0, "and does not page");
}

{
  // The point of the whole change: the agent has since been added to cal.com, so
  // the same row that skipped last tick now succeeds.
  const { state, promise } = runFake({
    candidates: [candidate({ effect: "skipped: not in cal.com (agent@trypennie.com)" })],
    outcomes: { "req-1": "ok" },
  });
  const res = await promise;
  eq(res.retried, 1, "a row that skipped last time is attempted again");
  eq(res.cleared, 1, "and clears once the account exists");
  eq(state.alerts.length, 0, "with nothing to page about");
}

{
  // The dangerous case: the absence is under way and the retry still fails.
  const started = candidate({
    startsAt: new Date(NOW - hours(1)).toISOString(),
    endsAt: new Date(NOW + hours(7)).toISOString(),
  });
  const { state, promise } = runFake({ candidates: [started] });
  const res = await promise;
  eq(res.unprotected, 1, "an in-progress absence that still fails is unprotected");
  assert(state.alerts.length === 1, "and it pages");
  assert(state.alerts[0].startsWith(CALCOM_UNPROTECTED_KEY), "on its own key");
  assert(state.alerts[0].includes("agent@trypennie.com"), "naming the agent");
  eq(state.resolved.length, 0, "and clears nothing while it is still true");
}

{
  // A future absence that still fails is worth retrying but is NOT yet an incident:
  // there is time for the next tick to fix it.
  const { state, promise } = runFake({ candidates: [candidate()] });
  const res = await promise;
  eq(res.unprotected, 0, "an upcoming absence is not yet unprotected");
  eq(state.alerts.length, 0, "so it does not page yet");
}

{
  // Nothing to do: measured healthy, so the condition can be cleared.
  const { state, promise } = runFake({ candidates: [] });
  const res = await promise;
  eq(res.measured, true, "an empty candidate list is a real measurement");
  assert(state.resolved.includes(CALCOM_UNPROTECTED_KEY), "so it sends the all-clear");
}

{
  // The read failed. That is NOT health: alerting would name nobody and clearing
  // would announce a recovery on the strength of a query that never ran (#1134).
  const { state, promise } = runFake({ candidates: null });
  const res = await promise;
  eq(res.measured, false, "an unreadable candidate list is not a measurement");
  eq(state.alerts.length, 0, "so it does not page");
  eq(state.resolved.length, 0, "and it does not all-clear either");
  eq(state.retried.length, 0, "and it retries nothing");
}

{
  // Bounded per tick, and it says what it left, so a cap set too low cannot read as
  // a clean sweep.
  const many = Array.from({ length: 25 }, (_, i) => candidate({ id: `req-${i}` }));
  const { state, promise } = runFake({ candidates: many, max: 10 });
  const res = await promise;
  eq(state.retried.length, 10, "retries at most the per-tick cap");
  eq(res.deferred, 15, "and reports how many it left for the next tick");
}

// --- the copy -------------------------------------------------------------

{
  const started = candidate({
    startsAt: new Date(NOW - hours(1)).toISOString(),
    endsAt: new Date(NOW + hours(7)).toISOString(),
  });
  const text = formatUnprotectedAlert([started], NOW);
  assert(text.includes("agent@trypennie.com"), "the alert names who is affected");
  assert(!/^Slate/.test(text), "does not open with the word Slate (the app name is the header)");
  assert(!text.includes("undefined") && !text.includes("NaN"), "renders no placeholder junk");
  assert(text.length < 400, "short enough to read on a phone mid-incident");
}

// --- the per approval page also has to end (#1280) ----------------------------
//
// `ooo_calcom` fires the moment an approval's cal.com override fails. That is the
// EARLY signal and worth keeping: `ooo_calcom_unprotected` only speaks once the
// absence is UNDER WAY, so an override failing a week ahead would page nobody until
// the day arrived. Keeping it means it needs an ending, which it never had. On
// 2026-08-04 request 844bdbab paged at 14:42, was genuinely fixed that afternoon,
// and the firing marker was still set.
{
  // The retry settles it, so nothing is failing any more and the page is over.
  const { state, promise } = runFake({ candidates: [candidate()], outcomes: { "req-1": "ok" } });
  await promise;
  assert(
    state.resolved.includes(CALCOM_ALERT_KEY),
    "a sweep that settles every failing override clears the per approval page",
  );
}

{
  // Still failing: the condition is still true, so it must not be cleared, even
  // though the absence has not started and the unprotected page stays silent.
  const { state, promise } = runFake({ candidates: [candidate()] });
  await promise;
  assert(
    !state.resolved.includes(CALCOM_ALERT_KEY),
    "a sweep that could not settle it clears nothing",
  );
}

{
  // A row past the per-tick cap was never attempted, so this tick knows nothing
  // about it. Counting it as settled would let the cap end a page for a request
  // still failing, which is the cap hiding the condition.
  const { state, promise } = runFake({
    candidates: [candidate({ id: "req-1" }), candidate({ id: "req-2" })],
    outcomes: { "req-1": "ok" },
    max: 1,
  });
  await promise;
  assert(state.retried.length === 1, "the cap really bit (control)");
  assert(
    !state.resolved.includes(CALCOM_ALERT_KEY),
    "and an unattempted row keeps the page open",
  );
}

{
  // THE failure path. A load that failed measured nothing at all, so it may not
  // announce that anything recovered (#1152).
  const { state, promise } = runFake({ candidates: null });
  const res = await promise;
  assert(!res.measured, "an unreadable candidate set reports it measured nothing");
  eq(state.resolved.length, 0, "and clears NOTHING, in either key");
}

{
  // Nothing failing at all is a measured healthy sweep, so it clears both.
  const { state, promise } = runFake({ candidates: [] });
  await promise;
  assert(state.resolved.includes(CALCOM_ALERT_KEY), "an empty candidate set clears the per approval page");
  assert(
    state.resolved.includes(CALCOM_UNPROTECTED_KEY),
    "and the unprotected page, which was already true",
  );
}

// --- the agent's address, and the two ways it can be missing (#2383) ----------
//
// The retry reads the agent's email before it can ask cal.com anything. That read
// used to swallow its `error`, so a query that never ran arrived as a null row and
// was reported as "agent has no email": a claim about the agent nothing measured
// (L11), written into `ooo_requests.side_effects` and quoted in the Slack line.
//
// The failure path is what matters here, so it is driven first, and the two are
// required to stay DISTINCT: one sends somebody to the roster and the other to the
// database, and a message answering for the other is how an afternoon goes
// somewhere pointless.
{
  const unreadable = agentEmailForRetry({ data: null, error: { message: "57014 statement timeout" } });
  assert("outcome" in unreadable, "an unreadable email read never yields an address");
  eq(
    "outcome" in unreadable ? unreadable.outcome : "",
    OUTCOME_EMAIL_UNREADABLE,
    "and says the READ failed, not that the agent has no address",
  );

  // The same fake, one field different: a read that worked and found no address.
  const missing = agentEmailForRetry({ data: { email: undefined }, error: null });
  assert("outcome" in missing, "a row with no address yields no address");
  eq(
    "outcome" in missing ? missing.outcome : "",
    OUTCOME_NO_EMAIL,
    "and says so in its own words",
  );
  assert(
    OUTCOME_EMAIL_UNREADABLE !== OUTCOME_NO_EMAIL,
    "the two reasons are distinct, or one is answering for the other",
  );

  // Neither may SETTLE the row. A settled outcome leaves the agent bookable in
  // cal.com through an absence Slate has already approved, with nothing retrying.
  for (const outcome of [OUTCOME_EMAIL_UNREADABLE, OUTCOME_NO_EMAIL]) {
    assert(isFailure(outcome), `${outcome} counts as a failure, so the row is retried`);
    assert(!isSettled(outcome), `${outcome} never settles the row`);
  }

  // And the happy path, so the refusals above are not satisfied by a function that
  // refuses everything (L1).
  const ok = agentEmailForRetry({ data: { email: "agent@trypennie.com" }, error: null });
  assert("email" in ok, "a readable row with an address yields the address");
  eq("email" in ok ? ok.email : "", "agent@trypennie.com", "and yields the one it read");
}

// --- #2875: the "cal.com retired" switch ---------------------------------------------
// Once cal.com takes no bookings, an absence with no cal.com block is protected by
// Slate alone, and "cal.com can still book them while they are away" is false.
{
  const underWay = candidate({ id: "req-9", startsAt: new Date(NOW - hours(2)).toISOString() });
  const { state, promise } = runFake({ candidates: [underWay], retired: true });
  const res = await promise;
  eq(state.retried.length, 0, "retired: no cal.com write is retried");
  eq(state.loaded, 0, "retired: the candidates are not even read");
  eq(state.alerts.length, 0, "retired: nothing pages, not even an absence under way with no block");
  eq(
    [...state.resolved].sort(),
    [CALCOM_ALERT_KEY, CALCOM_UNPROTECTED_KEY].sort(),
    "retired: both pages are settled, so one already open ends",
  );
  assert(
    state.resolvedText.every((t) => /retired/i.test(t) && !/in place/i.test(t)),
    "retired: the ending says cal.com was retired, never that the blocks are in place",
  );
  eq(res.measured, true, "retired: a measured answer (the setting was read), not an unreadable tick");
}
for (const retired of [null, "throw", false] as const) {
  // Unknown keeps today's behaviour: during the parallel run a missing block lets
  // cal.com book somebody who is away, and one failed write costs nothing.
  const underWay = candidate({ id: "req-9", startsAt: new Date(NOW - hours(2)).toISOString() });
  const { state, promise } = runFake({ candidates: [underWay], retired });
  await promise;
  eq(state.retried, ["req-9"], `retired read ${String(retired)}: the failed override is retried, as today`);
  assert(
    state.alerts.some((a) => a.startsWith(CALCOM_UNPROTECTED_KEY)),
    `retired read ${String(retired)}: an absence under way with no block still pages`,
  );
}

// --- #2890: putting cal.com back recovers what retirement skipped -------------------
// While cal.com is retired every approval records OUTCOME_CALCOM_RETIRED instead of
// writing. That skip stops being true the moment cal.com is put back, so it must be
// retried then, or every time off approved during retirement stays missing from a
// cal.com that is taking bookings again, with nothing said.
{
  const RETIRED = "skipped: cal.com retired";
  const future = candidate({ id: "approved-while-retired", effect: RETIRED });
  const underWay = candidate({
    id: "under-way",
    effect: RETIRED,
    startsAt: new Date(NOW - hours(2)).toISOString(),
  });
  const farAway = candidate({
    id: "far-away",
    effect: RETIRED,
    startsAt: new Date(NOW + hours(24 * 90)).toISOString(),
    endsAt: new Date(NOW + hours(24 * 91)).toISOString(),
  });
  assert(!isSettled(RETIRED), "a retired skip is not settled, so a live sweep looks at it again");
  assert(isRetiredSkip(RETIRED), "the retired skip is recognised by its own predicate");
  assert(!isRetiredSkip("skipped: cal.com not configured"), "an unconfigured cal.com is a different skip");
  eq(
    selectCandidates([future, underWay, farAway], NOW).map((r) => r.id).sort(),
    ["approved-while-retired", "far-away", "under-way"],
    "live: every retired skip that has not ended is selected, however far ahead it starts",
  );

  // Put back: the sweep retries them and they clear.
  {
    const { state, promise } = runFake({
      candidates: [future, underWay],
      retired: false,
      outcomes: { "approved-while-retired": "ok", "under-way": "ok" },
    });
    const res = await promise;
    eq(state.retried.sort(), ["approved-while-retired", "under-way"], "put back: both are retried");
    eq(res.cleared, 2, "put back: both clear");
    eq(state.alerts.length, 0, "put back: nothing pages once they land");
  }

  // The other direction: still retired, nothing is retried (the #2875 behaviour).
  {
    const { state, promise } = runFake({ candidates: [future, underWay], retired: true });
    await promise;
    eq(state.retried.length, 0, "retired: a retired skip is not retried while cal.com is retired");
  }

  // Put back, and the copy fails: an absence under way with no block pages, because
  // cal.com is live again and can book them.
  {
    const { state, promise } = runFake({ candidates: [underWay], retired: false });
    await promise;
    assert(
      state.alerts.some((a) => a.startsWith(CALCOM_UNPROTECTED_KEY)),
      "put back: a copy that fails for an absence under way pages",
    );
  }

  // The lane's cached answer said live, but cal.com was retired again in the
  // meantime and the retry's FRESH read came back retired. That is a measurement
  // that cal.com is retired, so the tick ends as retired: no page, no false
  // "every block is in place", and no further cal.com work this tick.
  {
    const second = candidate({ id: "second", effect: RETIRED, startsAt: new Date(NOW - hours(1)).toISOString() });
    const { state, promise } = runFake({
      candidates: [underWay, second],
      retired: false,
      outcomes: { "under-way": RETIRED, second: RETIRED },
    });
    const res = await promise;
    eq(state.retried, ["under-way"], "retired mid tick: the first retired answer stops the tick");
    eq(state.alerts.length, 0, "retired mid tick: nothing pages");
    assert(
      state.resolvedText.length > 0 &&
        state.resolvedText.every((t) => /retired/i.test(t) && !/in place/i.test(t)),
      "retired mid tick: the pages end saying cal.com was retired, never that the blocks are in place",
    );
    eq(res.measured, true, "retired mid tick: still a measured tick");
  }

  // Safe to run twice: a second tick after the copy landed has nothing to do.
  {
    const { state, promise } = runFake({
      candidates: [candidate({ id: "approved-while-retired", effect: "ok" })],
      retired: false,
    });
    await promise;
    eq(state.retried.length, 0, "a second tick after the copy landed retries nothing");
  }
}

finish();

// The two decisions the load run's preflight and ceiling control make (#2244).
//
// The first is the most expensive thing in the run to get wrong: if the deployment
// is not running with SLATE_LOADTEST on, six hundred bookings become six hundred
// REAL calendar events and six hundred real invitations on agents' real calendars.
// Nothing about the run's own output would say so, because every booking would
// succeed.
//
// Run: node --experimental-strip-types scripts/test-loadtest-preflight-checks.ts
import {
  stubShapedEventId,
  ceilingVerdict,
  loadtestModeVerdict,
  faultModeVerdict,
  faultPollStep,
  FAULT_PROPAGATION_DEADLINE_MS,
} from "./loadtest/preflight-checks.ts";
import { stubCreateEvent } from "../src/lib/google/loadtest-stub.ts";
import { deterministicEventId } from "../src/lib/booking/core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- an id the stub really produced is recognised -----------------------------

{
  // Driven through the SHIPPED stub rather than against a hand written string, so
  // the check cannot pass against a shape the stub stopped producing (L58). Both
  // of its shapes: the pinned client id returned verbatim, and the id it mints
  // when none was supplied.
  const clientId = await deterministicEventId("idem-key", "user-1");
  const input = { summary: "Pennie call", start: "2026-09-15T15:00:00Z", end: "2026-09-15T15:20:00Z" };
  assert(
    stubShapedEventId(stubCreateEvent(input, clientId)),
    "the id the stub returns for a pinned client id is recognised",
  );
  assert(
    stubShapedEventId(stubCreateEvent(input)),
    "and so is the one it mints when no client id was supplied",
  );
}

// --- a real Google id is NOT -----------------------------------------------------

{
  // Real ids, in the shapes Google actually uses. Every one of these must be
  // refused, because each is the run about to send real invitations.
  for (const real of [
    "7v1k2m3n4o5p6q7r8s9t0u1v2w",
    "_6tj4c9k6cpj6b9k6ss3ib9o70r3ac9p6cp3cb9m6grjic9n6t",
    "abcdefghijklmnopqrstuvwxyz",
    "f2ZGPAxE8skjLBtiQeCsgH",
  ]) {
    assert(!stubShapedEventId(real), `a real Google id is refused: ${real.slice(0, 16)}`);
  }
  assert(!stubShapedEventId(""), "and so is an empty id");
  assert(!stubShapedEventId("   "), "and a blank one");
}

{
  // The check is POSITIVE on purpose. A negative one ("does it look like Google")
  // passes on any id whose shape nobody anticipated, and the direction that fails
  // safe is refusing what we do not recognise.
  assert(!stubShapedEventId("slate"), "a prefix alone is not the stub's shape");
  assert(!stubShapedEventId("slate123"), "nor a short hex tail");
  assert(!stubShapedEventId(`slate${"z".repeat(64)}`), "nor 64 characters that are not hex");
  assert(!stubShapedEventId("lt-evt-"), "nor the mint prefix with nothing after it");
  assert(
    !stubShapedEventId("slate-real-google-id-that-happens-to-start-this-way"),
    "and an id merely STARTING with the prefix is refused, which the first version accepted",
  );
}

// --- the per address ceiling control ----------------------------------------------

{
  const ok = ceilingVerdict([...Array(60).fill(200), 429]);
  eq(ok.firstRefusedAt, 61, "the 61st request refused is the ceiling doing its job");
  eq(ok.unreachable, 0, "and nothing failed to reach the deployment");

  const never = ceilingVerdict(Array(61).fill(200));
  eq(never.firstRefusedAt, null, "nothing refused is reported as null, never as a number");

  const early = ceilingVerdict([...Array(19).fill(200), 429, ...Array(41).fill(429)]);
  eq(early.firstRefusedAt, 20, "an early refusal is reported at the position it happened");

  // A transport fault is UNREACHABLE, never a refusal. Counting it as one would
  // report the ceiling working when the control never reached the deployment,
  // which is the whole failure this control exists to rule out (L98).
  const dead = ceilingVerdict(Array(61).fill(0));
  eq(dead.firstRefusedAt, null, "a control that never reached the deployment refused nothing");
  eq(dead.unreachable, 61, "and says how many never arrived");

  const mixed = ceilingVerdict([200, 0, 200, 429]);
  eq(mixed.firstRefusedAt, 4, "a fault before a refusal does not move the refusal's position");
  eq(mixed.unreachable, 1, "and is still counted");

  eq(ceilingVerdict([]).firstRefusedAt, null, "no requests refused nothing");
  eq(ceilingVerdict([]).unreachable, 0, "and none were unreachable");
}

// --- the deployment says it is in load test mode (#2242) ----------------------
//
// Asked before the preflight writes anything, so every refusal has to be readable
// by somebody who has not yet spent a run. Four of them, and no two may say the
// same thing: they send four different people to four different places (L11).

{
  const ok = loadtestModeVerdict(200, { commit: "abc1234", loadtest: true });
  assert(ok.ok, "a deployment reporting loadtest=true is accepted");
  eq(ok.ok ? ok.commit : null, "abc1234", "and the commit is carried through for the log line");
  // A commit the endpoint did not report is not a refusal: the mode is the
  // question being asked, and the commit is context beside it.
  const noCommit = loadtestModeVerdict(200, { loadtest: true });
  assert(noCommit.ok, "a missing commit does not refuse");
  eq(noCommit.ok ? noCommit.commit : "x", null, "it is reported as unknown instead");
}

{
  // The direction that matters most (L159). Production answers exactly this, and a
  // check hard wired to accept would let the run drive it.
  const v = loadtestModeVerdict(200, { commit: "abc1234", loadtest: false });
  assert(!v.ok, "a deployment reporting loadtest=false is refused");
  assert(
    !v.ok && v.why.includes("REAL calendar events"),
    "and the refusal says what a run against it would do",
  );
}

{
  // ABSENT is not false. A deployment predating the field and one that answered no
  // are two different states, and reading the first as the second sends somebody to
  // check a variable that is already set correctly.
  const missing = loadtestModeVerdict(200, { commit: "abc1234" });
  const answeredNo = loadtestModeVerdict(200, { commit: "abc1234", loadtest: false });
  assert(!missing.ok, "a reply with no loadtest field is refused");
  assert(
    !missing.ok && missing.why.includes("predates"),
    "and is told it is an old deployment rather than a wrong setting",
  );
  assert(
    !missing.ok && !answeredNo.ok && missing.why !== answeredNo.why,
    "the two do not share a message",
  );
  // An explicit null or a string is an answer of some kind, so it takes the
  // "reports loadtest=..." branch rather than the "predates" one.
  const nulled = loadtestModeVerdict(200, { loadtest: null });
  assert(!nulled.ok && nulled.why.includes("loadtest=null"), "an explicit null quotes what it saw");
  const stringy = loadtestModeVerdict(200, { loadtest: "true" });
  assert(
    !stringy.ok && stringy.why.includes('loadtest="true"'),
    "and the string \"true\" is not the boolean true",
  );
}

{
  // A refusal, a redirect and a body this cannot read are all "could not
  // establish", which is its own message and still refuses (L98).
  for (const status of [401, 404, 500, 503]) {
    const v = loadtestModeVerdict(status, {});
    assert(!v.ok, `a ${status} is refused`);
    assert(
      !v.ok && v.why.includes("could not be established") && v.why.includes(String(status)),
      `and the ${status} refusal names the status rather than guessing at a cause`,
    );
  }
  // A body that is not an object at all (what `.json()` gives for a plain text
  // error page, after the caller's catch) does not throw here.
  const v = loadtestModeVerdict(200, null);
  assert(!v.ok, "an unreadable body at 200 is refused");
  const w = loadtestModeVerdict(200, "not json");
  assert(!w.ok, "and so is a string body");
}

// --- the deployment is really injecting faults (#2262) ------------------------
//
// The bar this feeds is "zero 5xx with Google failing ten percent of reads". A
// deployment that never received the setting fails NO reads: it answers every
// request perfectly and satisfies the bar with no fault having happened, which is
// indistinguishable from a path that degraded beautifully (L98). So the leg asks
// the deployment before it drives, and zero is the case that matters most.

{
  const v = faultModeVerdict(200, { commit: "abc1234", loadtest: true, faultPct: 10 }, { faultPct: 10 });
  assert(v.ok, "a deployment reporting the percentage asked for is accepted");
  eq(v.ok ? v.faultPct : -1, 10, "and the percentage it reported is carried, not the one asked for");
}

{
  // ZERO. The whole reason this check exists: it passes every bar while measuring
  // nothing.
  const v = faultModeVerdict(200, { commit: "abc1234", loadtest: true, faultPct: 0 }, { faultPct: 10 });
  assert(!v.ok, "a deployment reporting zero percent is refused");
  assert(
    !v.ok && v.why.includes("no faults at all"),
    "and is told that a zero pass satisfies the bar while measuring nothing",
  );
}

{
  // Any other disagreement, in both directions, because a pass at a percentage
  // nobody configured is a measurement of something nobody asked about.
  for (const [reported, wanted] of [[5, 10], [20, 10], [100, 10]] as const) {
    const v = faultModeVerdict(200, { loadtest: true, faultPct: reported }, { faultPct: wanted });
    assert(!v.ok, `a deployment at ${reported} percent is refused when ${wanted} was asked for`);
    assert(
      !v.ok && v.why.includes(String(reported)) && v.why.includes(String(wanted)),
      `and the refusal names both numbers`,
    );
  }
}

{
  // A field that is absent, or present as something other than a number, is "could
  // not establish" rather than zero. Reading either as zero would send somebody to
  // check a setting when the real answer is that the deployment predates the field.
  const missing = faultModeVerdict(200, { loadtest: true }, { faultPct: 10 });
  assert(!missing.ok, "a reply with no faultPct is refused");
  assert(!missing.ok && missing.why.includes("no faultPct"), "and says the field was not reported");
  const stringy = faultModeVerdict(200, { loadtest: true, faultPct: "10" }, { faultPct: 10 });
  assert(!stringy.ok, 'a faultPct reported as the string "10" is refused');
  assert(
    !stringy.ok && stringy.why.includes("no faultPct number"),
    "because a string is not the number the stub injects from",
  );
}

{
  // The load test gate comes FIRST, so a production deployment is refused for
  // being production rather than for its fault percentage (L11). Otherwise the
  // reader is sent to look at a setting on the wrong machine entirely.
  const v = faultModeVerdict(200, { commit: "abc1234", loadtest: false, faultPct: 10 }, { faultPct: 10 });
  assert(!v.ok, "a deployment that is not in load test mode is refused");
  assert(
    !v.ok && v.why.includes("REAL calendar events"),
    "and is refused as production, not as a wrong percentage",
  );
}

{
  // The commit, because the fault leg REDEPLOYS: a redeploy that silently served
  // the previous version would have the run judge a build nobody drove.
  const stale = faultModeVerdict(
    200,
    { commit: "old1111", loadtest: true, faultPct: 10 },
    { faultPct: 10, commit: "new2222" },
  );
  assert(!stale.ok, "a deployment serving a different commit is refused");
  assert(
    !stale.ok && stale.why.includes("redeploy has not taken effect"),
    "and is told the redeploy is what has not happened",
  );
  // Deliberately "has not" rather than "did not": a commit that has not landed is
  // usually propagation, which the poll waits out, so the wording must not read as
  // a settled failure.
  assert(!stale.ok && stale.retriable, "which is why it is retriable rather than final");
  const fresh = faultModeVerdict(
    200,
    { commit: "new2222", loadtest: true, faultPct: 10 },
    { faultPct: 10, commit: "new2222" },
  );
  assert(fresh.ok, "and the matching commit is accepted");
  // Not checked when the caller does not know which commit it deployed, so a hand
  // run is not refused for a fact it never had.
  assert(
    faultModeVerdict(200, { commit: "anything", loadtest: true, faultPct: 10 }, { faultPct: 10 }).ok,
    "a caller that named no commit is not judged on one",
  );
}

// A leftover faulted deployment, which is the OPPOSITE mistake and the one a
// steady pass meets. A run dispatched with teardown off leaves the deployment
// injecting faults, and the next run's steady pass would count those against the
// path's own 5xx bar.
{
  const v = faultModeVerdict(200, { loadtest: true, faultPct: 10 }, { faultPct: 0 });
  assert(!v.ok, "a deployment still injecting faults is refused when none were asked for");
  assert(!v.ok && v.why.includes("left over"), "and is told a previous leg left it that way");
  assert(
    !v.ok && v.why.includes("--env loadtest"),
    "and how to put it back, since the remedy is a command rather than a diagnosis",
  );
  // The three mismatch messages are genuinely three, not one wording reused: the
  // two extremes send people to opposite places.
  const wantedNoneGotSome = faultModeVerdict(200, { loadtest: true, faultPct: 10 }, { faultPct: 0 })!;
  const wantedSomeGotNone = faultModeVerdict(200, { loadtest: true, faultPct: 0 }, { faultPct: 10 })!;
  const plainMismatch = faultModeVerdict(200, { loadtest: true, faultPct: 5 }, { faultPct: 10 })!;
  const whys = [wantedNoneGotSome, wantedSomeGotNone, plainMismatch].map((r) =>
    r.ok ? "ok" : r.why,
  );
  eq(new Set(whys).size, 3, "the three fault mismatches say three different things");
  // And the quiet case: a steady pass against a clean deployment passes.
  assert(
    faultModeVerdict(200, { loadtest: true, faultPct: 0 }, { faultPct: 0 }).ok,
    "a deployment injecting no faults is accepted when none were asked for",
  );
}

// --- waiting out a redeploy, and knowing when to stop (#2261) -----------------
//
// A deploy does not take effect the instant wrangler exits. The fault leg asked
// two seconds after its own and was answered by the version already serving,
// which reports no faults. The COMMIT could not catch it either: both builds come
// from the same commit, so the one discriminator the check had was blind to
// exactly the case it needed to see.
//
// The whole ladder is driven here with an injected elapsed time, so nothing waits
// for real.

{
  const ok = faultModeVerdict(200, { loadtest: true, faultPct: 10 }, { faultPct: 10 });
  const step = faultPollStep(ok, 0);
  eq(step.action, "accept", "a deployment already reporting the percentage is accepted at once");
  eq(step.action === "accept" ? step.faultPct : -1, 10, "carrying what it reported");
}

{
  // The case this exists for: not yet, so wait.
  const notYet = faultModeVerdict(200, { loadtest: true, faultPct: 0 }, { faultPct: 10 });
  assert(!notYet.ok && notYet.retriable, "a percentage that has not landed is retriable");
  const step = faultPollStep(notYet, 2_000);
  eq(step.action, "wait", "two seconds in, it waits rather than failing");
  assert(step.action === "wait" && step.waitMs > 0, "for a real interval");
}

{
  // And it STOPS. A read that retries forever hangs the run rather than failing it
  // (L110), and the deadline is what turns "not yet" into "never".
  const notYet = faultModeVerdict(200, { loadtest: true, faultPct: 0 }, { faultPct: 10 });
  const step = faultPollStep(notYet, FAULT_PROPAGATION_DEADLINE_MS);
  eq(step.action, "give-up", "at the deadline it gives up");
  assert(
    step.action === "give-up" && step.why.includes("not propagation"),
    "and says the waiting itself is the evidence, rather than repeating the first reading",
  );
  assert(
    step.action === "give-up" && step.why.includes(String(Math.round(FAULT_PROPAGATION_DEADLINE_MS / 1000))),
    "naming how long it waited",
  );
  // Just under the deadline it is still waiting, so the boundary is the deadline
  // rather than something that happened to fire early.
  eq(
    faultPollStep(notYet, FAULT_PROPAGATION_DEADLINE_MS - 1).action,
    "wait",
    "and one millisecond earlier it is still waiting",
  );
}

{
  // A refusal WAITING CANNOT FIX fails at once. Polling one of these just spends
  // three minutes before saying what it could have said immediately, and the
  // message would then blame propagation for a wrong key.
  for (const [label, status, body] of [
    ["a refused key", 401, {}],
    ["a missing endpoint", 404, {}],
    ["a deployment not in load test mode", 200, { loadtest: false, faultPct: 10 }],
    ["a deployment reporting no faultPct at all", 200, { loadtest: true }],
  ] as const) {
    const v = faultModeVerdict(status, body, { faultPct: 10 });
    assert(!v.ok && !v.retriable, `${label} is not retriable`);
    eq(faultPollStep(v, 0).action, "give-up", `so ${label} gives up at once`);
  }
}

{
  // A 5xx IS retriable: a redeploy makes a deployment momentarily unwell and that
  // passes. Both directions on the status (L159).
  const fivexx = faultModeVerdict(503, {}, { faultPct: 10 });
  assert(!fivexx.ok && fivexx.retriable, "a 503 is waited out");
  const fourxx = faultModeVerdict(403, {}, { faultPct: 10 });
  assert(!fourxx.ok && !fourxx.retriable, "a 403 is not");
}

{
  // A commit that has not landed is the same propagation, so it waits too.
  const stale = faultModeVerdict(
    200,
    { commit: "old1111", loadtest: true, faultPct: 10 },
    { faultPct: 10, commit: "new2222" },
  );
  assert(!stale.ok && stale.retriable, "a commit that has not landed is retriable");
  eq(faultPollStep(stale, 1_000).action, "wait", "and is waited out");
}

{
  // The give-up on a retriable verdict must not read like the terminal one: it
  // carries the original reading AND says the waiting is what makes it final.
  const notYet = faultModeVerdict(200, { loadtest: true, faultPct: 0 }, { faultPct: 10 });
  const late = faultPollStep(notYet, FAULT_PROPAGATION_DEADLINE_MS);
  const terminal = faultPollStep(faultModeVerdict(401, {}, { faultPct: 10 }), 0);
  assert(
    late.action === "give-up" && terminal.action === "give-up" && late.why !== terminal.why,
    "the two ways of giving up say different things",
  );
}

finish();

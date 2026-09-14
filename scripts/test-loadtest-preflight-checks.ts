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
  loadtestModeVerdict,
  faultModeVerdict,
  faultPollStep,
  overlappingProbeWindow,
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
//
// MOVED to `scripts/test-loadtest-ceiling-control.ts`, which is that function's
// own suite. It lived here as well, in a form predating the ceiling argument and
// the address echo, so #2275's second pass had two copies of one rule to keep in
// step (L41). Every assertion that was here survives there: the position of a
// first refusal, a null position when nothing was refused, an early refusal's
// position, the unreachable count, a transport fault not moving a later
// refusal's position, and the empty control.

// --- the deployment says it is in load test mode (#2242) ----------------------
//
// Asked before the preflight writes anything, so every refusal has to be readable
// by somebody who has not yet spent a run. Seven of them, and no two may say the
// same thing: they send seven different people to seven different places (L11).

{
  const ok = loadtestModeVerdict(200, { commit: "abc1234", loadtest: true, productionSecrets: [] });
  assert(ok.ok, "a deployment reporting loadtest=true is accepted");
  eq(ok.ok ? ok.commit : null, "abc1234", "and the commit is carried through for the log line");
  // A commit the endpoint did not report is not a refusal: the mode is the
  // question being asked, and the commit is context beside it.
  const noCommit = loadtestModeVerdict(200, { loadtest: true, productionSecrets: [] });
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
  const v = faultModeVerdict(200, { commit: "abc1234", loadtest: true, productionSecrets: [], faultPct: 10 }, { faultPct: 10 });
  assert(v.ok, "a deployment reporting the percentage asked for is accepted");
  eq(v.ok ? v.faultPct : -1, 10, "and the percentage it reported is carried, not the one asked for");
}

{
  // ZERO. The whole reason this check exists: it passes every bar while measuring
  // nothing.
  const v = faultModeVerdict(200, { commit: "abc1234", loadtest: true, productionSecrets: [], faultPct: 0 }, { faultPct: 10 });
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
    const v = faultModeVerdict(200, { loadtest: true, productionSecrets: [], faultPct: reported }, { faultPct: wanted });
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
  const missing = faultModeVerdict(200, { loadtest: true, productionSecrets: [] }, { faultPct: 10 });
  assert(!missing.ok, "a reply with no faultPct is refused");
  assert(!missing.ok && missing.why.includes("no faultPct"), "and says the field was not reported");
  const stringy = faultModeVerdict(200, { loadtest: true, productionSecrets: [], faultPct: "10" }, { faultPct: 10 });
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
    { commit: "aaaaaaaaaaaa", loadtest: true, productionSecrets: [], faultPct: 10 },
    { faultPct: 10, commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
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
    { commit: "bbbbbbbbbbbb", loadtest: true, productionSecrets: [], faultPct: 10 },
    { faultPct: 10, commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  );
  assert(fresh.ok, "and the matching commit is accepted");
  // Not checked when the caller does not know which commit it deployed, so a hand
  // run is not refused for a fact it never had.
  assert(
    faultModeVerdict(200, { commit: "anything", loadtest: true, productionSecrets: [], faultPct: 10 }, { faultPct: 10 }).ok,
    "a caller that named no commit is not judged on one",
  );

  // THE CASE A LIVE RUN MET. The deployment answers the first twelve characters,
  // because that is what `stamp-build-info.ts` writes into the bundle, and the
  // workflow hands this leg `github.sha`, which is all forty. An equality check
  // calls the SAME commit a redeploy that never landed, and since that mismatch is
  // classified as propagation it then waits out the whole deadline before saying
  // so. Comparison goes through the stamper's own shortening (L70).
  const FULL = "660c7aacae82658b8947ca923237f5de2932d8f3";
  const SHORT = "660c7aacae82";
  eq(SHORT.length, 12, "the stamper writes twelve characters");
  assert(FULL.startsWith(SHORT), "and the short form really is the head of the full sha");
  const sameCommit = faultModeVerdict(
    200,
    { commit: SHORT, loadtest: true, productionSecrets: [], faultPct: 10 },
    { faultPct: 10, commit: FULL },
  );
  assert(
    sameCommit.ok,
    "a deployment answering the short sha of the commit the leg deployed is accepted",
  );
  // The other direction (L159): a genuinely different commit is still caught, so
  // the shortening did not turn the check into a no-op.
  const reallyStale = faultModeVerdict(
    200,
    { commit: "111111111111", loadtest: true, productionSecrets: [], faultPct: 10 },
    { faultPct: 10, commit: FULL },
  );
  assert(!reallyStale.ok, "and a genuinely different commit is still refused");
  assert(
    !reallyStale.ok && reallyStale.why.includes(SHORT),
    "with the refusal quoting the commit in the same form the deployment reports",
  );

  // A `commit` that is not a sha at all cannot be shortened, and that is a fault in
  // the caller rather than propagation, so it fails at once instead of spending the
  // deadline.
  const nonsense = faultModeVerdict(
    200,
    { commit: SHORT, loadtest: true, productionSecrets: [], faultPct: 10 },
    { faultPct: 10, commit: "refs/heads/main" },
  );
  assert(!nonsense.ok && !nonsense.retriable, "a commit that is not a sha fails at once");
}

// A leftover faulted deployment, which is the OPPOSITE mistake and the one a
// steady pass meets. A run dispatched with teardown off leaves the deployment
// injecting faults, and the next run's steady pass would count those against the
// path's own 5xx bar.
{
  const v = faultModeVerdict(200, { loadtest: true, productionSecrets: [], faultPct: 10 }, { faultPct: 0 });
  assert(!v.ok, "a deployment still injecting faults is refused when none were asked for");
  assert(!v.ok && v.why.includes("left over"), "and is told a previous leg left it that way");
  assert(
    !v.ok && v.why.includes("--env loadtest"),
    "and how to put it back, since the remedy is a command rather than a diagnosis",
  );
  // The three mismatch messages are genuinely three, not one wording reused: the
  // two extremes send people to opposite places.
  const wantedNoneGotSome = faultModeVerdict(200, { loadtest: true, productionSecrets: [], faultPct: 10 }, { faultPct: 0 })!;
  const wantedSomeGotNone = faultModeVerdict(200, { loadtest: true, productionSecrets: [], faultPct: 0 }, { faultPct: 10 })!;
  const plainMismatch = faultModeVerdict(200, { loadtest: true, productionSecrets: [], faultPct: 5 }, { faultPct: 10 })!;
  const whys = [wantedNoneGotSome, wantedSomeGotNone, plainMismatch].map((r) =>
    r.ok ? "ok" : r.why,
  );
  eq(new Set(whys).size, 3, "the three fault mismatches say three different things");
  // And the quiet case: a steady pass against a clean deployment passes.
  assert(
    faultModeVerdict(200, { loadtest: true, productionSecrets: [], faultPct: 0 }, { faultPct: 0 }).ok,
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
  const ok = faultModeVerdict(200, { loadtest: true, productionSecrets: [], faultPct: 10 }, { faultPct: 10 });
  const step = faultPollStep(ok, 0);
  eq(step.action, "accept", "a deployment already reporting the percentage is accepted at once");
  eq(step.action === "accept" ? step.faultPct : -1, 10, "carrying what it reported");
}

{
  // The case this exists for: not yet, so wait.
  const notYet = faultModeVerdict(200, { loadtest: true, productionSecrets: [], faultPct: 0 }, { faultPct: 10 });
  assert(!notYet.ok && notYet.retriable, "a percentage that has not landed is retriable");
  const step = faultPollStep(notYet, 2_000);
  eq(step.action, "wait", "two seconds in, it waits rather than failing");
  assert(step.action === "wait" && step.waitMs > 0, "for a real interval");
}

{
  // And it STOPS. A read that retries forever hangs the run rather than failing it
  // (L110), and the deadline is what turns "not yet" into "never".
  const notYet = faultModeVerdict(200, { loadtest: true, productionSecrets: [], faultPct: 0 }, { faultPct: 10 });
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
    ["a deployment reporting no faultPct at all", 200, { loadtest: true, productionSecrets: [] }],
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
    { commit: "aaaaaaaaaaaa", loadtest: true, productionSecrets: [], faultPct: 10 },
    { faultPct: 10, commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  );
  assert(!stale.ok && stale.retriable, "a commit that has not landed is retriable");
  eq(faultPollStep(stale, 1_000).action, "wait", "and is waited out");
}

{
  // The give-up on a retriable verdict must not read like the terminal one: it
  // carries the original reading AND says the waiting is what makes it final.
  const notYet = faultModeVerdict(200, { loadtest: true, productionSecrets: [], faultPct: 0 }, { faultPct: 10 });
  const late = faultPollStep(notYet, FAULT_PROPAGATION_DEADLINE_MS);
  const terminal = faultPollStep(faultModeVerdict(401, {}, { faultPct: 10 }), 0);
  assert(
    late.action === "give-up" && terminal.action === "give-up" && late.why !== terminal.why,
    "the two ways of giving up say different things",
  );
}

// --- the window a guard probe plants to prove the OVERLAP constraint (#2274) --
//
// The preflight already plants an identical window, which proves the unique
// index. That says nothing about the overlap constraint, and the booking that
// actually caused #2274 had a DIFFERENT start ten minutes later, which uniqueness
// cannot see.

{
  // A 20 minute window shifts by 10: a different start, so the unique index cannot
  // be what refuses it, and still overlapping, so the new constraint must be.
  const w = overlappingProbeWindow("2026-09-15T17:50:00.000Z", "2026-09-15T18:10:00.000Z")!;
  assert(w !== null, "a normal window yields an overlapping probe");
  eq(w.startIso, "2026-09-15T18:00:00.000Z", "shifted by half its own length");
  eq(w.endIso, "2026-09-15T18:20:00.000Z", "and the end moves with it");
  // These are the exact instants of the live defect, which is the point.
  assert(w.startIso !== "2026-09-15T17:50:00.000Z", "the START differs, or the unique index would refuse it");
}

{
  // It must really OVERLAP, or the probe proves nothing. Checked as the ranges the
  // constraint compares rather than by eye.
  const a = { s: Date.parse("2026-09-15T17:50:00.000Z"), e: Date.parse("2026-09-15T18:10:00.000Z") };
  const w = overlappingProbeWindow("2026-09-15T17:50:00.000Z", "2026-09-15T18:10:00.000Z")!;
  const b = { s: Date.parse(w.startIso), e: Date.parse(w.endIso) };
  assert(a.s < b.e && b.s < a.e, "the two windows overlap on a half open reading");
  assert(b.s !== a.s, "and do not share a start");
}

{
  // Derived from the window, never a hard coded ten minutes, so it stays correct if
  // the seeded event type ever changes duration (L401).
  const hour = overlappingProbeWindow("2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z")!;
  eq(hour.startIso, "2026-09-15T09:30:00.000Z", "an hour long window shifts by thirty minutes");
  const ten = overlappingProbeWindow("2026-09-15T09:00:00.000Z", "2026-09-15T09:10:00.000Z")!;
  eq(ten.startIso, "2026-09-15T09:05:00.000Z", "and a ten minute window by five");
}

{
  // A window that cannot produce an overlapping copy yields NULL rather than a
  // window that would be refused by nothing: planting one would report the
  // constraint missing when it is present and working (L98).
  eq(overlappingProbeWindow("nonsense", "2026-09-15T18:10:00.000Z"), null, "an unreadable start yields nothing");
  eq(overlappingProbeWindow("2026-09-15T17:50:00.000Z", "nope"), null, "an unreadable end yields nothing");
  eq(
    overlappingProbeWindow("2026-09-15T17:50:00.000Z", "2026-09-15T17:50:00.000Z"),
    null,
    "a zero length window overlaps nothing, so there is no probe to plant",
  );
  eq(
    overlappingProbeWindow("2026-09-15T18:10:00.000Z", "2026-09-15T17:50:00.000Z"),
    null,
    "and neither does an inverted one",
  );
  // A one minute window cannot be shifted by a whole minute and still overlap, so
  // it is refused rather than producing a back to back pair the constraint allows.
  eq(
    overlappingProbeWindow("2026-09-15T09:00:00.000Z", "2026-09-15T09:01:00.000Z"),
    null,
    "a window too short to overlap a shifted copy yields nothing",
  );
}

// --- the deployment's own credentials (#2335) ---------------------------------
//
// The refusal that arrives FIRST, and the only one that can. A contaminated
// deployment is pointed at the right branch, answers on the right address and
// reports loadtest=true, so every other check here is correctly satisfied while it
// holds production's Slack token. `/api/smoke/version` is the one endpoint that
// answers without touching the database, which is exactly why it can still say so.

{
  const v = loadtestModeVerdict(200, {
    commit: "abc1234",
    loadtest: true,
    productionSecrets: ["SLACK_BOT_TOKEN", "GOOGLE_SA_PRIVATE_KEY"],
  });
  assert(!v.ok, "a deployment carrying production's own settings is refused");
  const why = v.ok ? "" : v.why;
  assert(why.includes("SLACK_BOT_TOKEN"), "and every name is reported, so the repair is clear");
  assert(why.includes("GOOGLE_SA_PRIVATE_KEY"), "including the second one");
  assert(
    why.includes(".env"),
    "and the message names the cause, a build tree holding an env file, rather than only the symptom",
  );
}

{
  // Absent is NOT clean, for the same reason an absent `loadtest` field is not
  // `false`: it is a deployment built before the check existed, and reading it as
  // "carrying nothing" is how a contaminated build would pass the one gate written
  // to catch it (L98).
  const v = loadtestModeVerdict(200, { commit: "abc1234", loadtest: true });
  assert(!v.ok, "a deployment that reports no productionSecrets field at all is refused");
  const why = v.ok ? "" : v.why;
  assert(
    why.includes("predates") || why.includes("older"),
    `and says the build is older than the check rather than accusing it, got ${why}`,
  );
  assert(
    !why.includes("SLACK_BOT_TOKEN"),
    "and names no setting, having measured none",
  );
}

{
  // A field of the wrong shape is its own outcome: something other than this route
  // answered, and telling somebody their deployment is contaminated would send them
  // hunting for a credential that was never reported.
  const v = loadtestModeVerdict(200, { loadtest: true, productionSecrets: "SLACK_BOT_TOKEN" });
  assert(!v.ok, "a productionSecrets field that is not a list is refused");
  const why = v.ok ? "" : v.why;
  assert(
    !why.includes("predates"),
    "on a reason of its own rather than borrowing the older-build one (L11)",
  );
}

{
  // And the quiet direction: a clean load test deployment is accepted, or this
  // refusal would stop every run there is.
  const v = loadtestModeVerdict(200, { commit: "abc1234", loadtest: true, productionSecrets: [] });
  assert(v.ok, "a load test deployment carrying none of them is accepted");
}

finish();

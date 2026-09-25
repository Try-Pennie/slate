// Run: node --experimental-strip-types scripts/test-twilio-sync.ts
//
// The Twilio half of the hourly roster job (#2097): the read, the flips, the writes
// and the order they happen in.
//
// EVERY FACT RIDES IN ONE PAYLOAD rather than a write each: two writes built from
// one base row would drop each other silently (L443). That is why the payloads
// below carry the debt tiers beside `redistribute`. #2152 put the tiers and the
// backend service there and added the flip a first tier asks for; #2218 took the
// retired legal value back out of it.
//
// TWO THINGS THIS PINS THAT NOTHING ELSE CAN.
//
// The ORDER of each flip's two writes, which is what makes a run that dies half way
// converge on the next hour rather than losing the agent. Turning somebody OFF
// writes the mark BEFORE the flip: a crash in between leaves a bookable agent who
// is marked, which the planner turns off again next hour. Turning them back ON
// flips BEFORE clearing the mark: a crash in between leaves a bookable agent still
// marked, which the planner plans again and the flip settles as a noop. Written the
// other way round, each of those crashes silently drops the agent out of the
// feature for good.
//
// And that a flip goes through the SHARED bookable service, never a direct write.
// Leaving the pool also has to stop the agent's Google calendar watches and prune
// their cached busy time (#239/#248), and that lives in the service. A raw update
// would leave Google notifying Slate about somebody it no longer books.
import { activationAllowance } from "@/lib/bookable/activation-allowance";
import { syncTwilioRedistribute, type TwilioSyncDeps } from "@/lib/twilio/sync";
import type { BookableResult } from "@/lib/bookable/service";
import { TwilioReadError } from "@/lib/twilio/client";
import type { TwilioRosterRow } from "@/lib/twilio/roster-plan";
import { assert, eq, finish } from "./lib/harness.ts";

const worker = (email: string, teams: string[]) => ({ attributes: JSON.stringify({ email, teams }) });

/** Injected, so the stamp the sweep is keyed on is a value a test can assert on. */
const NOW = "2026-09-09T12:00:00.000Z";

function row(over: Partial<TwilioRosterRow> = {}): TwilioRosterRow {
  return { id: "u1", email: "a@trypennie.com", bookable: true, deactivated: false, pending: false, isTest: false, attributes: {}, ...over };
}

/**
 * Records every call, in order, so the ORDER of the two writes is assertable.
 *
 * What the flip ANSWERS is a separate knob from the flip itself, because the
 * recording has to happen on every path: an override that returned `blocked`
 * without recording would leave the order assertion comparing against a stub that
 * never spoke, and it would pass while proving nothing.
 */
function deps(
  over: Partial<TwilioSyncDeps> = {},
  answer?: (userId: string, bookable: boolean) => BookableResult,
  sweepAnswer?: (userId: string) => { itemCount: number },
) {
  const calls: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const base: TwilioSyncDeps = {
    orgId: "org1",
    // #2302: a generous default, so every case written before the allowance existed
    // keeps the meaning it had. The cases that exercise the bound pass their own.
    allowance: activationAllowance(50),
    nowIso: () => NOW,
    // What the sweep ANSWERS is a separate knob from the sweep itself, for the same
    // reason the flip's is: the recording has to happen on every path, and an
    // override that returned a count without recording would leave the order
    // assertion comparing against a stub that never spoke.
    startCoverageSweep: async ({ outUserId, markedAtIso }) => {
      calls.push(`sweep:${outUserId}:${markedAtIso}`);
      return sweepAnswer ? sweepAnswer(outUserId) : { itemCount: 0 };
    },
    fetchWorkers: async () => [worker("a@trypennie.com", ["Redistribute"])],
    loadRoster: async () => [row()],
    applyBookable: async (userId, bookable) => {
      calls.push(`flip:${userId}:${bookable}`);
      return answer ? answer(userId, bookable) : { status: "applied", userId, bookable };
    },
    writeAttributes: async ({ userId, attributes, bookablePendingSince }) => {
      // The pending mark is recorded WITH the attributes rather than beside them,
      // because they are one statement and a test that could not see the pair would
      // pass on an implementation that wrote them separately (#2152).
      calls.push(`attrs:${userId}:${JSON.stringify(attributes)}${bookablePendingSince ? `:pending=${bookablePendingSince}` : ""}`);
    },
    recordAudit: (async (entry: Record<string, unknown>) => {
      audits.push(entry);
    }) as TwilioSyncDeps["recordAudit"],
    ...over,
  };
  return { deps: base, calls, audits };
}

// --- turning somebody off -----------------------------------------------------

{
  const d = deps();
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.turnedOff, ["a@trypennie.com"], "a bookable agent Twilio withholds is turned off");
  eq(
    d.calls,
    [
      `attrs:u1:{"redistribute_tagged":"Y","redistribute":"Y","redistribute_at":"${NOW}"}`,
      `sweep:u1:${NOW}`,
      "flip:u1:false",
    ],
    "the mark is written, then the coverage sweep is enqueued, then the flip: a crash anywhere in that order converges next hour",
  );
  eq(r.turnedBackOn.length, 0, "and nobody is turned back on");
  eq(d.audits.length, 1, "the flip is audited");
  eq((d.audits[0] as { action: string }).action, "agent.bookable", "as a bookable change, the same action the admin toggle records");
  const details = (d.audits[0] as { details: Record<string, unknown> }).details;
  eq(details.via, "twilio-sync", "attributed to the sync rather than to a person, since no human pressed anything");
  eq(details.reason, "redistribute", "naming the Twilio tag that decided it");
  eq(details.bookable, false, "and which way it went");
}

{
  const d = deps({}, () => ({ status: "not_found" }));
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.turnedOff.length, 0, "a flip the service could not find a row for is not reported as done");
}

// --- turning somebody back on -------------------------------------------------

const backOn = {
  fetchWorkers: async () => [worker("a@trypennie.com", ["Low Debt: 20k - 30k"])],
  loadRoster: async () => [row({ bookable: false, attributes: { redistribute: "Y", debt_team: ["low"] } })],
};

{
  const d = deps(backOn);
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.turnedBackOn, ["a@trypennie.com"], "an agent whose tag Twilio dropped is turned back on");
  eq(
    d.calls,
    ["flip:u1:true", 'attrs:u1:{"debt_team":["low"]}'],
    "the flip runs BEFORE the mark is cleared, so a refusal keeps the mark and retries",
  );
  eq((d.audits[0] as { details: Record<string, unknown> }).details.reason, "redistribute-removed", "audited with its own reason, not the same one as turning somebody off");
}

{
  // The refusal Dan called out: the activation gate turns down an agent with no
  // reachable Google calendar. The mark MUST survive it, or the retry is lost.
  const d = deps(backOn, (userId) => ({ status: "blocked", userId, reason: "google_unreachable" }));
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.reactivationRefused, ["a@trypennie.com"], "a refused reactivation is counted, so the banner can say it rather than Slack an hour later");
  eq(r.turnedBackOn.length, 0, "and is not reported as done");
  eq(d.calls, ["flip:u1:true"], "the mark is NOT cleared, so next hour tries again");
  eq(d.audits.length, 0, "and nothing is audited, because nothing changed");
}

{
  // The stale mark: somebody an admin turned back on by hand while the tag was
  // still off. The flip is a noop and the mark still has to go.
  const d = deps(
    { ...backOn, loadRoster: async () => [row({ bookable: true, attributes: { redistribute: "Y" } })] },
    (userId, bookable) => ({ status: "noop", userId, bookable }),
  );
  const r = await syncTwilioRedistribute(d.deps);
  eq(
    d.calls,
    ["flip:u1:true", 'attrs:u1:{"debt_team":["low"]}'],
    "a noop still clears the stale mark, and the payload carries the tiers the same tags gave",
  );
  eq(r.turnedBackOn.length, 0, "and is not reported as a change, because nothing changed");
  eq(d.audits.length, 0, "nor audited");
}

// --- one bad agent must not take the other eleven with it ---------------------

{
  // L73: independent steps sharing one handler each need their own boundary. This
  // ships against a backlog of TWELVE agents, so a single database or Google failure
  // on the third of them would leave nine agents Twilio withholds still bookable,
  // and the run would report as a Twilio read failure, which is a different fault
  // in a different system.
  const d = deps(
    {
      fetchWorkers: async () => [
        worker("a@trypennie.com", ["Redistribute"]),
        worker("b@trypennie.com", ["Redistribute"]),
        worker("c@trypennie.com", ["Redistribute"]),
      ],
      loadRoster: async () => [
        row({ id: "u1", email: "a@trypennie.com" }),
        row({ id: "u2", email: "b@trypennie.com" }),
        row({ id: "u3", email: "c@trypennie.com" }),
      ],
    },
    (userId) => {
      if (userId === "u2") throw new Error("database went away");
      return { status: "applied", userId, bookable: false };
    },
  );
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.turnedOff, ["a@trypennie.com", "c@trypennie.com"], "the agents either side of the failure are still flipped");
  eq(r.flipFailures, 1, "and the one that failed is counted rather than swallowed");
  assert(!r.turnedOff.includes("b@trypennie.com"), "the failed one is NOT reported as done, which is the half that would be a lie");
}

{
  // The mirror case on the way back in, since the two directions are different code.
  const d = deps(
    {
      fetchWorkers: async () => [worker("a@trypennie.com", []), worker("b@trypennie.com", [])],
      loadRoster: async () => [
        row({ id: "u1", email: "a@trypennie.com", bookable: false, attributes: { redistribute: "Y" } }),
        row({ id: "u2", email: "b@trypennie.com", bookable: false, attributes: { redistribute: "Y" } }),
      ],
    },
    (userId) => {
      if (userId === "u1") throw new Error("google went away");
      return { status: "applied", userId, bookable: true };
    },
  );
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.turnedBackOn, ["b@trypennie.com"], "a failure putting one agent back does not stop the next");
  eq(r.flipFailures, 1, "and it is counted");
  assert(
    !d.calls.includes('attrs:u1:{}'),
    "and the failed one keeps its mark, so next hour tries again rather than dropping them from the feature",
  );
}

// --- the read refuses, and nothing is written --------------------------------

{
  for (const failure of ["not-configured", "refused", "unreachable", "unreadable", "no-workers"] as const) {
    const d = deps({
      fetchWorkers: async () => {
        throw new TwilioReadError(failure, `stub ${failure}`);
      },
    });
    let threw = false;
    try {
      await syncTwilioRedistribute(d.deps);
    } catch (err) {
      threw = err instanceof TwilioReadError && err.failure === failure;
    }
    assert(threw, `a ${failure} read is rethrown by name rather than skipped`);
    eq(d.calls.length, 0, `and not one agent is flipped or written on a ${failure} read`);
  }
}

{
  // The read succeeded and the ROSTER could not be read. Refused for the same
  // reason in the mirror direction: an empty roster makes every marked agent look
  // absent and would flip nobody while reporting a clean run (L98).
  const d = deps({ loadRoster: async () => [] });
  let threw = "";
  try {
    await syncTwilioRedistribute(d.deps);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(threw.includes("no"), `an empty Slate roster refuses rather than reporting a quiet run (got: ${threw})`);
}

// --- what the run reports -----------------------------------------------------

{
  const d = deps({
    fetchWorkers: async () => [
      worker("a@trypennie.com", ["Redistribute"]),
      worker("b@trypennie.com", ["Brand New Tier"]),
      { attributes: "{not json" },
      { attributes: JSON.stringify({ teams: ["Redistribute"] }) },
    ],
    loadRoster: async () => [row(), row({ id: "u3", email: "c@trypennie.com", bookable: false, attributes: { redistribute: "Y" } })],
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.workers, 4, "every worker Twilio returned is counted");
  eq(r.addresses, 2, "and how many of them could be matched to an address");
  eq(r.corruptAttributes, 1, "a worker whose attributes are not JSON is counted as its own fault");
  eq(r.noEmail, 1, "and one carrying no email separately, because it is usually a queue entity and ordinary");
  eq(r.unmappedTags, ["Brand New Tier"], "a tag this mapping has never heard of is reported, never dropped");
  eq(r.markedWithNoWorker, ["c@trypennie.com"], "and a marked agent Twilio holds no worker for is named, since doing nothing is otherwise invisible");
}

// --- what the agent already has booked (#2115) ---------------------------------
// Taking somebody out of the pool strands whatever they have booked, and the admin
// toggle asks a person before doing it. This flip has nobody to ask, so it queues
// the same coverage sweep, on Dan's call (2026-09-09).

{
  const d = deps({}, undefined, () => ({ itemCount: 3 }));
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.coverageSweeps, [{ email: "a@trypennie.com", bookings: 3 }], "the sweep says how many calls it took, per agent");
  eq(r.coverageSweepFailures, 0, "and nothing failed");
}

{
  // A sweep that found nothing is not reported as work done, and is still
  // distinguishable from one that could not run, because the failures are counted
  // apart (L98, L11).
  const d = deps();
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.coverageSweeps.length, 0, "an agent holding nothing produces no line");
  eq(r.coverageSweepFailures, 0, "and no failure either, so the two are told apart");
  eq(r.turnedOff, ["a@trypennie.com"], "and the flip still happened");
}

{
  // THE ORDER THAT MAKES A CRASH SAFE. Enqueued BEFORE the flip, so a run that dies
  // in between leaves a marked and still bookable agent whom the next hour plans
  // again, reads the same stamp from, and converges onto the SAME sweep by the
  // unique key. Enqueued after the flip, that agent is no longer bookable, nothing
  // re-plans them, and the sweep is lost with nothing saying so.
  const d = deps();
  await syncTwilioRedistribute(d.deps);
  const sweep = d.calls.findIndex((c) => c.startsWith("sweep:"));
  const flip = d.calls.findIndex((c) => c.startsWith("flip:"));
  const attrs = d.calls.findIndex((c) => c.startsWith("attrs:"));
  assert(attrs < sweep && sweep < flip, `the order is mark, sweep, flip (got ${d.calls.join(" ")})`);
}

{
  // A sweep that could not be enqueued must NOT stop the flip. An agent Twilio
  // withholds who is still bookable misroutes a lead today, which is the sharper
  // harm; the bookings left behind are caught by `inactive_agent_bookings`, which
  // watches for exactly a not bookable agent still holding calls.
  const d = deps({}, undefined, () => {
    throw new Error("database went away");
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.coverageSweepFailures, 1, "the failure is counted rather than swallowed");
  eq(r.turnedOff, ["a@trypennie.com"], "and the agent is still taken out of the pool");
  eq(r.coverageSweeps.length, 0, "with nothing claimed about calls that were never queued");
}

{
  // The stamp the sweep is keyed on is the one in the attributes payload, not a
  // second reading of the clock. Two different values here would mean the retry
  // could never find the job it created.
  const d = deps({}, undefined, () => ({ itemCount: 1 }));
  await syncTwilioRedistribute(d.deps);
  const written = d.calls.find((c) => c.startsWith("attrs:"))!;
  const swept = d.calls.find((c) => c.startsWith("sweep:"))!;
  assert(written.includes(NOW) && swept.endsWith(NOW), "the stamp written and the stamp swept on are the same value");
}

{
  // Nobody is swept back INTO the pool: coming back off redistribute takes no
  // bookings from anybody.
  const d = deps(backOn, undefined, () => ({ itemCount: 9 }));
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.turnedBackOn, ["a@trypennie.com"], "the agent is put back in the pool");
  eq(r.coverageSweeps.length, 0, "and no coverage sweep is queued for them");
  assert(!d.calls.some((c) => c.startsWith("sweep:")), "the sweep is never even asked for");
}

// --- the routing attributes, and the flip a first tier asks for (#2152) --------

{
  const d = deps({
    fetchWorkers: async () => [worker("a@trypennie.com", ["Med Debt: 30k - 50k", "Beyond"])],
    loadRoster: async () => [row({ attributes: { debt_team: ["low"] } })],
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(
    d.calls,
    ['attrs:u1:{"debt_team":["medium"],"backend_service":["beyond"]}'],
    "one write carries every Twilio owned value, so nothing is written over the same column twice",
  );
  eq(r.tiersChanged, ["a@trypennie.com"], "the tier change is counted");
  eq(r.backendChanged, ["a@trypennie.com"], "and so is the backend one");
}

{
  // A count of a write that never happened is the defect (#1134), and it is worth
  // its own case because the payload was built either way.
  const d = deps({
    fetchWorkers: async () => [worker("a@trypennie.com", ["Med Debt: 30k - 50k"])],
    loadRoster: async () => [row({ attributes: { debt_team: ["low"] } })],
    writeAttributes: async () => {
      throw new Error("database went away");
    },
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.tiersChanged.length, 0, "a write that threw is not counted as a tier that changed");
  eq(r.attributeWriteFailures, 1, "it is counted as the failure it is");
}

{
  // #2182: the sync writes the tier and puts NOBODY in the pool. Becoming bookable
  // stays a Salesforce decision, because a Twilio tag says what somebody can be
  // routed for and never that they are taking calls (Dan, 2026-09-10).
  const d = deps({
    fetchWorkers: async () => [worker("a@trypennie.com", ["Low Debt: 20k - 30k"])],
    loadRoster: async () => [row({ bookable: false, attributes: { role: "Chatter Free User" } })],
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(
    d.calls,
    ['attrs:u1:{"role":"Chatter Free User","debt_team":["low"]}'],
    "the tier is written, and nothing else happens: no pending mark and no flip",
  );
  eq(r.tiersChanged, ["a@trypennie.com"], "the tier change is reported");
  eq(d.audits.length, 0, "and nothing is audited, because nobody entered the pool");
}

{
  // A row that needs no attribute change and no flip must not be written at all,
  // which is what keeps this from touching all 129 rows every hour.
  const d = deps({
    fetchWorkers: async () => [worker("a@trypennie.com", ["Low Debt: 20k - 30k"])],
    loadRoster: async () => [row({ bookable: true, attributes: { role: "Sales", debt_team: ["low"] } })],
  });
  await syncTwilioRedistribute(d.deps);
  eq(d.calls.length, 0, "an agent whose stored attributes already match their tags is left alone");
}

// --- #2302: the shared activation allowance -----------------------------------
// Since the calendar read joined the activation gate, every flip INTO the pool is
// several Google calls, and this sync runs in the same Worker invocation as the
// Salesforce one. An unbounded loop here would spend a budget the other half is
// also drawing on, so both take slots from ONE allowance.
//
// Only the way IN. Turning somebody off has to happen the hour Twilio says so: an
// agent Twilio withholds who is still bookable misroutes a lead today, and no
// budget argument outranks that.
{
  const many = Array.from({ length: 5 }, (_, i) => `n${i}@trypennie.com`);
  const shared = activationAllowance(2);
  const d = deps({
    fetchWorkers: async () => many.map((e) => worker(e, ["Low Debt: 20k - 30k"])),
    loadRoster: async () =>
      many.map((e, i) => row({ id: `u${i}`, email: e, bookable: false, attributes: { redistribute: "Y", debt_team: ["low"] } })),
    allowance: shared,
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.turnedBackOn.length, 2, "only as many are turned back on as the allowance permits");
  eq(r.reactivationDeferred.length, 3, "and the rest are named as left for next run, not dropped");
  eq(shared.spent(), 2, "the shared allowance records exactly what was spent");
  eq(
    d.calls.filter((c) => c.startsWith("flip:")).length,
    2,
    "the deferred ones are never attempted, so they cost no Google calls at all",
  );
}

{
  // The half that must NOT be bounded. A withheld agent left bookable misroutes a
  // lead the same day, so turning off is never held back by an allowance the other
  // direction spent.
  const many = Array.from({ length: 5 }, (_, i) => `o${i}@trypennie.com`);
  const spent = activationAllowance(0);
  const d = deps({
    fetchWorkers: async () => many.map((e) => worker(e, ["Redistribute"])),
    loadRoster: async () => many.map((e, i) => row({ id: `u${i}`, email: e })),
    allowance: spent,
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.turnedOff.length, 5, "every withheld agent is taken out of the pool even with no allowance left");
  eq(r.reactivationDeferred.length, 0, "and nothing is deferred, because nothing was going in");
}


// --- #2724: a reactivation that does not settle still clears the tag ---------
// The tag coming off must end the Regal call exemption even when the activation
// gate keeps refusing, so the unsettled path writes the Twilio facts with the mark
// KEPT, and only when something actually moved.
{
  const d = deps(
    {
      ...backOn,
      loadRoster: async () => [
        row({ bookable: false, attributes: { redistribute: "Y", debt_team: ["low"], redistribute_tagged: "Y" } }),
      ],
    },
    (userId) => ({ status: "blocked", userId, reason: "google_unreachable" }),
  );
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.reactivationRefused, ["a@trypennie.com"], "the refusal is still reported");
  eq(
    d.calls,
    ["flip:u1:true", 'attrs:u1:{"redistribute":"Y","debt_team":["low"]}'],
    "and the tag is cleared with the mark kept, after the flip was asked",
  );
  eq(r.flipFailures, 0, "and nothing counts as a failed flip");
}
{
  const shared = activationAllowance(0);
  const d = deps({
    ...backOn,
    allowance: shared,
    loadRoster: async () => [
      row({ bookable: false, attributes: { redistribute: "Y", debt_team: ["low"], redistribute_tagged: "Y" } }),
    ],
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.reactivationDeferred, ["a@trypennie.com"], "a deferred reactivation is still reported");
  eq(d.calls, ['attrs:u1:{"redistribute":"Y","debt_team":["low"]}'], "and still clears the tag without attempting the flip");
}
{
  // The held write has its own boundary (L73): a throw there is an attribute write
  // failure, and must not also report the same agent as a failed flip.
  const d = deps(
    {
      ...backOn,
      loadRoster: async () => [
        row({ bookable: false, attributes: { redistribute: "Y", debt_team: ["low"], redistribute_tagged: "Y" } }),
      ],
      writeAttributes: async () => {
        throw new Error("database went away");
      },
    },
    (userId) => ({ status: "blocked", userId, reason: "google_unreachable" }),
  );
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.reactivationRefused, ["a@trypennie.com"], "a refused reactivation whose held write throws is still reported as refused");
  eq(r.flipFailures, 0, "and is not also counted as a failed flip");
  eq(r.attributeWriteFailures, 1, "the held write is counted as the attribute write failure it is");
}
{
  // A withheld agent who was ALREADY out of the pool: no flip, and the tag lands.
  const d = deps({ loadRoster: async () => [row({ bookable: false })] });
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.turnedOff.length, 0, "nobody is flipped");
  eq(d.calls, ['attrs:u1:{"redistribute_tagged":"Y"}'], "and the tag is written for them anyway");
}

// --- #2735: the tag's own landings and clearings are in the run's report --------
// `redistribute_tagged` is what silences the Regal call pager, so a run that moved
// it must say so. Counted only once the write LANDED, and never for a rewrite that
// changed nothing a reader sees.

{
  const d = deps({ loadRoster: async () => [row({ bookable: false })] });
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.redistributeTagLanded, ["a@trypennie.com"], "a tag written for somebody already out of the pool is reported as landed");
  eq(r.redistributeTagCleared, [], "and nothing is reported as cleared");
}
{
  const d = deps();
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.redistributeTagLanded, ["a@trypennie.com"], "a tag landing through a turn off flip is reported too");
}
{
  const d = deps({
    fetchWorkers: async () => [worker("a@trypennie.com", ["Low Debt: 20k - 30k"])],
    loadRoster: async () => [row({ bookable: false, attributes: { debt_team: ["low"], redistribute_tagged: "Y" } })],
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.redistributeTagCleared, ["a@trypennie.com"], "a tag that came off is reported as cleared");
  eq(r.redistributeTagLanded, [], "and not as landed");
}
{
  const d = deps(
    {
      ...backOn,
      loadRoster: async () => [
        row({ bookable: false, attributes: { redistribute: "Y", debt_team: ["low"], redistribute_tagged: "Y" } }),
      ],
    },
    (userId) => ({ status: "blocked", userId, reason: "google_unreachable" }),
  );
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.redistributeTagCleared, ["a@trypennie.com"], "a tag cleared by the held write of a refused reactivation is reported");
}
{
  // The failure path: a write that threw moved nothing, so nothing is reported.
  const d = deps({
    loadRoster: async () => [row({ bookable: false })],
    writeAttributes: async () => {
      throw new Error("database went away");
    },
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(r.redistributeTagLanded, [], "a tag write that threw is not reported as landed");
  eq(r.attributeWriteFailures, 1, "it is counted as the failure it is");
}
{
  const d = deps({
    fetchWorkers: async () => [worker("a@trypennie.com", ["Low Debt: 20k - 30k"])],
    loadRoster: async () => [row({ bookable: false, attributes: { debt_team: ["low"], redistribute_tagged: "N" } })],
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(d.calls, ['attrs:u1:{"debt_team":["low"]}'], "a junk spelling of the tag is cleaned up");
  eq(r.redistributeTagCleared, [], "but it was never read as tagged, so nothing is reported as cleared");
}

// --- #2735: a worker that disappears is recorded, and its tag is kept ------------

{
  const d = deps({
    fetchWorkers: async () => [worker("b@trypennie.com", ["Low Debt: 20k - 30k"])],
    loadRoster: async () => [row({ bookable: false, attributes: { redistribute_tagged: "Y" } })],
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(
    d.calls,
    [`attrs:u1:{"redistribute_tagged":"Y","twilio_worker_missing_since":"${NOW}"}`],
    "the tag is kept and the absence is stamped, in one write",
  );
  eq(r.withoutWorker, ["a@trypennie.com"], "the row is still counted as without a worker");
  eq(r.redistributeTagCleared, [], "and the tag is not reported as cleared, because it was not");
}

// --- #2735 review: an uninformative read writes nothing ------------------------
// Every worker unreadable: the raw count is not zero, so the caller's empty read
// refusal does not fire, and the merged map is empty. Nothing about anybody is
// known, so a stored stamp, tag and tiers must all survive untouched.
{
  const d = deps({
    fetchWorkers: async () => [{ attributes: "{not json" }, { attributes: "{also not json" }],
    loadRoster: async () => [
      row({
        bookable: false,
        attributes: { debt_team: ["low"], redistribute_tagged: "Y", twilio_worker_missing_since: "2026-09-01T00:00:00.000Z" },
      }),
      row({ id: "u2", email: "b@trypennie.com", bookable: false, attributes: { redistribute_tagged: "Y" } }),
    ],
  });
  const r = await syncTwilioRedistribute(d.deps);
  eq(d.calls, [], "an uninformative read writes nothing: no stamp cleared and none added");
  eq(r.corruptAttributes, 2, "and the unreadable workers are still counted");
  eq(r.redistributeTagCleared, [], "and no tag is reported as cleared");
}

finish();

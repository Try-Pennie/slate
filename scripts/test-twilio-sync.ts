// Run: node --experimental-strip-types scripts/test-twilio-sync.ts
//
// The Twilio half of the hourly roster job (#2097): the read, the flips, the writes
// and the order they happen in.
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
import { syncTwilioRedistribute, type TwilioSyncDeps } from "@/lib/twilio/sync";
import type { BookableResult } from "@/lib/bookable/service";
import { TwilioReadError } from "@/lib/twilio/client";
import type { TwilioRosterRow } from "@/lib/twilio/roster-plan";
import { assert, eq, finish } from "./lib/harness.ts";

const worker = (email: string, teams: string[]) => ({ attributes: JSON.stringify({ email, teams }) });

function row(over: Partial<TwilioRosterRow> = {}): TwilioRosterRow {
  return { id: "u1", email: "a@trypennie.com", bookable: true, deactivated: false, isTest: false, attributes: {}, ...over };
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
) {
  const calls: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const base: TwilioSyncDeps = {
    orgId: "org1",
    fetchWorkers: async () => [worker("a@trypennie.com", ["Redistribute"])],
    loadRoster: async () => [row()],
    applyBookable: async (userId, bookable) => {
      calls.push(`flip:${userId}:${bookable}`);
      return answer ? answer(userId, bookable) : { status: "applied", userId, bookable };
    },
    writeAttributes: async (userId, attributes) => {
      calls.push(`attrs:${userId}:${JSON.stringify(attributes)}`);
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
  eq(d.calls, ['attrs:u1:{"redistribute":"Y"}', "flip:u1:false"], "the mark is written BEFORE the flip, so a crash between them converges next hour");
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
  eq(d.calls, ["flip:u1:true", 'attrs:u1:{"debt_team":["low"]}'], "the flip runs BEFORE the mark is cleared, so a refusal keeps the mark and retries");
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
  eq(d.calls, ["flip:u1:true", "attrs:u1:{}"], "a noop still clears the stale mark");
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

finish();

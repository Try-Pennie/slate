// What a burst driver reads from the deployment for the judge (#3429), driven offline:
// the confirm crowd rule the deployment declares, and the slot's bookable probe after
// a burst has settled. Both readers are pure, so every way of learning nothing is
// built here and seen to come out as its own non answer, never as a value (L98, L151).
//
// The fixtures are the shapes the deployment really sends: the version body is built
// around the route's own field name and vocabulary, and the probe body carries the
// fields `/api/bookings/bookable` returns (L48).
//
// Run: node --experimental-strip-types scripts/test-loadtest-burst-probe.ts
import {
  readCrowdRule,
  readBurstProbe,
  burstProbeVerdict,
  burstCrowdRule,
  type BurstProbe,
  type CrowdRuleReading,
} from "./loadtest/burst-probe.ts";
import { CONFIRM_CROWD_RULES } from "../src/lib/confirm-crowd-rule.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A version answer as the load test deployment sends it, with the rule it declares. */
function versionBody(rule: unknown): Record<string, unknown> {
  return {
    commit: "abc1234",
    loadtest: true,
    faultPct: 0,
    faultTargets: ["google-read"],
    faultTargetsUnknown: [],
    productionSecrets: [],
    postConfirmRecompute: "on",
    postConfirmRecomputeUnknown: null,
    ...(rule === undefined ? {} : { confirmCrowdRule: rule }),
  };
}

/** A bookable answer as `/api/bookings/bookable` sends it. */
function bookableBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bookable: false,
    reason: "slot_taken",
    requestedBucketCode: "500",
    effectiveBucketCode: null,
    tierFallback: false,
    rungsDropped: 0,
    wouldAssign: null,
    ...over,
  };
}

// --- the crowd rule the deployment declares --------------------------------------
{
  for (const rule of CONFIRM_CROWD_RULES) {
    eq(readCrowdRule(200, versionBody(rule)), { state: "read", value: rule }, `a deployment declaring ${rule} is read as ${rule}`);
  }
  const absent = readCrowdRule(200, versionBody(undefined));
  assert(absent.state === "absent" && absent.why.includes("#3429"), `a body with no rule is ABSENT, naming the change that added it (got ${JSON.stringify(absent)})`);
  const odd = readCrowdRule(200, versionBody("Walks"));
  assert(odd.state === "unreadable" && odd.why.includes('"Walks"'), `a value the vocabulary does not know is UNREADABLE with what was sent (got ${JSON.stringify(odd)})`);
  const refused = readCrowdRule(401, { error: "Unauthorized" });
  assert(refused.state === "unreadable" && refused.why.includes("401"), `a refused read is UNREADABLE with its status (got ${JSON.stringify(refused)})`);
  const notObject = readCrowdRule(200, "ok");
  assert(notObject.state === "unreadable", `a body that is not an object is UNREADABLE (got ${JSON.stringify(notObject)})`);
}

// --- the crowd rule across one burst's files -------------------------------------
{
  const walks: CrowdRuleReading = { state: "read", value: "walks" };
  const stops: CrowdRuleReading = { state: "read", value: "stops" };
  eq(burstCrowdRule([walks, walks, walks, walks]), { state: "read", value: "walks" }, "four drivers told one rule read as that rule");
  eq(
    burstCrowdRule([walks, { state: "unreadable", why: "timed out" }, walks, undefined]),
    { state: "read", value: "walks" },
    "a driver that could not read it does not stop the others' reading counting",
  );
  const split = burstCrowdRule([walks, stops, walks, walks]);
  assert(
    split.state === "unknown" && split.why.includes("walks") && split.why.includes("stops"),
    `two rules from one deployment are UNKNOWN, naming both (got ${JSON.stringify(split)})`,
  );
  const none = burstCrowdRule([undefined, { state: "absent", why: "the answer carries no confirmCrowdRule" }]);
  assert(
    none.state === "unknown" && none.why.includes("not recorded") && none.why.includes("no confirmCrowdRule"),
    `no rule read is UNKNOWN with every reason (got ${JSON.stringify(none)})`,
  );
  eq(burstCrowdRule([]).state, "unknown", "a burst with no files read no rule at all");
}

// --- one probe -------------------------------------------------------------------
{
  const at = 1_760_000_000_000;
  eq(
    readBurstProbe({ code: "500", sentAtMs: at, status: 200, body: bookableBody() }),
    { kind: "read", code: "500", sentAtMs: at, bookable: false, reason: "slot_taken", rungsDropped: 0, effectiveCode: null },
    "a slot the ladder is spent at is read as not bookable",
  );
  eq(
    readBurstProbe({
      code: "120",
      sentAtMs: at,
      status: 200,
      body: bookableBody({ bookable: true, reason: "available", effectiveBucketCode: "130", tierFallback: true, rungsDropped: 1 }),
    }),
    { kind: "read", code: "120", sentAtMs: at, bookable: true, reason: "available", rungsDropped: 1, effectiveCode: "130" },
    "a slot still bookable a rung down is read with the rung",
  );
  const outage = readBurstProbe({ code: "500", sentAtMs: at, status: 503, body: { code: "VERIFY_UNAVAILABLE" } });
  assert(
    outage.kind === "unreadable" && outage.why.includes("503") && outage.why.includes("VERIFY_UNAVAILABLE"),
    `a verify outage is UNREADABLE, never a confident no (got ${JSON.stringify(outage)})`,
  );
  const noFlag = readBurstProbe({ code: "500", sentAtMs: at, status: 200, body: bookableBody({ bookable: "false" }) });
  assert(noFlag.kind === "unreadable" && noFlag.why.includes("bookable"), `a bookable that is not a boolean is UNREADABLE (got ${JSON.stringify(noFlag)})`);
  const noRung = readBurstProbe({ code: "500", sentAtMs: at, status: 200, body: bookableBody({ rungsDropped: undefined }) });
  assert(noRung.kind === "unreadable" && noRung.why.includes("rungsDropped"), `a missing rung count is UNREADABLE, never zero (got ${JSON.stringify(noRung)})`);
  const negative = readBurstProbe({ code: "500", sentAtMs: at, status: 200, body: bookableBody({ rungsDropped: -1 }) });
  assert(negative.kind === "unreadable", `a negative rung count is UNREADABLE (got ${JSON.stringify(negative)})`);
  const noReason = readBurstProbe({ code: "500", sentAtMs: at, status: 200, body: bookableBody({ reason: 3 }) });
  assert(noReason.kind === "unreadable" && noReason.why.includes("reason"), `a reason that is not text is UNREADABLE (got ${JSON.stringify(noReason)})`);
  const notJson = readBurstProbe({ code: "500", sentAtMs: at, status: 200, body: null });
  assert(notJson.kind === "unreadable", `a 200 with no readable body is UNREADABLE (got ${JSON.stringify(notJson)})`);
}

// --- a burst's probes, judged together --------------------------------------------
{
  const settle = 1_760_000_032_000;
  const read = (over: Partial<Extract<BurstProbe, { kind: "read" }>> = {}): BurstProbe => ({
    kind: "read",
    code: "500",
    sentAtMs: settle + 10,
    bookable: false,
    reason: "slot_taken",
    rungsDropped: 0,
    effectiveCode: null,
    ...over,
  });
  const agree = burstProbeVerdict([read(), read({ code: "501" }), read(), read({ code: "501" })], settle);
  assert(
    agree.kind === "read" && agree.bookable === false && agree.reason === "slot_taken" && agree.readings === 4 && agree.unusable.length === 0,
    `four probes that agree are one reading (got ${JSON.stringify(agree)})`,
  );

  const partial = burstProbeVerdict([read(), { kind: "unreadable", code: "500", sentAtMs: settle + 5, why: "503 VERIFY_UNAVAILABLE" }, undefined], settle);
  assert(
    partial.kind === "read" && partial.readings === 1 && partial.unusable.length === 2,
    `a readable probe still concludes beside unusable ones, which are counted (got ${JSON.stringify(partial)})`,
  );

  const lowest = burstProbeVerdict(
    [read({ bookable: true, reason: "available", rungsDropped: 2, effectiveCode: "300" }), read({ bookable: true, reason: "available", rungsDropped: 1, effectiveCode: "400" })],
    settle,
  );
  assert(
    lowest.kind === "read" && lowest.bookable && lowest.rungsDropped === 1 && lowest.effectiveCode === "400",
    `two available answers keep the HIGHEST rung still free, the stronger accusation (got ${JSON.stringify(lowest)})`,
  );

  const disagree = burstProbeVerdict([read(), read({ bookable: true, reason: "available", rungsDropped: 1, effectiveCode: "400" })], settle);
  assert(
    disagree.kind === "unconcluded" && disagree.why.includes("disagree"),
    `probes that disagree about bookable conclude nothing (got ${JSON.stringify(disagree)})`,
  );

  const early = burstProbeVerdict([read({ sentAtMs: settle - 1 })], settle);
  assert(
    early.kind === "unconcluded" && early.why.includes("before the burst settled"),
    `a probe sent before the burst settled cannot judge it (got ${JSON.stringify(early)})`,
  );

  const nothing = burstProbeVerdict([undefined, { kind: "unreadable", code: "500", sentAtMs: settle + 5, why: "timed out" }], settle);
  assert(
    nothing.kind === "unconcluded" && nothing.why.includes("not recorded") && nothing.why.includes("timed out"),
    `no usable probe is UNCONCLUDED with every reason, never a pass (got ${JSON.stringify(nothing)})`,
  );
  eq(burstProbeVerdict([], settle).kind, "unconcluded", "a burst with no files has no probe");
}

finish();

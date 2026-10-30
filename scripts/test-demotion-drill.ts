// #3615: the daily drill that proves the reroute on ineligibility end to end, on the two test
// advisors only. Driven here over a fake world that runs the REAL decision functions, so the
// drill passes only when the pipeline does what it says, and each way it can fail is shown to
// produce its own reason (L1, L11): a drill that could not fail would be a stamp of nothing.
import {
  DRILL_REASONS,
  DRILL_TIER,
  firstTimeAllFree,
  runDemotionDrill,
  type DemotionDrillDeps,
  type DrillReason,
} from "../src/lib/booking/demotion-drill.ts";
import { unservedBookingIds, type RerouteCandidate } from "../src/lib/booking/reroute-eligibility.ts";
import type { Attributes } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const START = "2026-10-14T15:00:00.000Z";
const NOW = Date.parse("2026-10-12T11:00:00.000Z");

interface FakeBooking {
  id: string;
  status: string;
  assigned_user_id: string;
  manageToken: string;
  reverted: boolean;
}

/** A small world that behaves like Slate: the decision functions are the real ones. */
function world(sabotage: Partial<Record<"noMove" | "noAudit" | "noPin" | "noChange" | "moveBackRefused" | "noMoveBack" | "cancelThrows" | "restoreThrows", boolean>> = {}) {
  const agents = new Map<string, Attributes>([
    ["a", { debt_team: [DRILL_TIER] }],
    ["b", { debt_team: [DRILL_TIER] }],
  ]);
  const original = new Map([...agents].map(([k, v]) => [k, structuredClone(v)]));
  const bookings = new Map<string, FakeBooking>();
  const audits: { bookingId: string; action: string }[] = [];
  const jobs = new Map<string, { change: unknown; items: string[]; out: string }>();
  const calls: string[] = [];
  let writes = 0;

  const candidatesOf = (userId: string): RerouteCandidate[] =>
    [...bookings.values()]
      .filter((b) => b.assigned_user_id === userId && b.status === "confirmed" && !(b.reverted && b.assigned_user_id === userId))
      .map((b) => ({ bookingId: b.id, kind: "round_robin", criteria: { debt_team: DRILL_TIER }, isManualMember: false }));

  const deps: DemotionDrillDeps = {
    loadDrillAgents: async () => [...agents].map(([id, attributes]) => ({ id, email: `${id}@x.com`, attributes })),
    findSlot: async (agentIds) => {
      calls.push(`slot:${agentIds.join(",")}`);
      return START;
    },
    book: async (startIso, attendee) => {
      calls.push(`book:${startIso}:${attendee.email}`);
      bookings.set("bk1", { id: "bk1", status: "confirmed", assigned_user_id: "a", manageToken: "tok1", reverted: false });
      return { bookingId: "bk1", manageToken: "tok1", assignedUserId: "a" };
    },
    writeAttributes: async (userId, attrs) => {
      writes++;
      if (sabotage.restoreThrows && writes > 3) throw new Error("users write refused");
      agents.set(userId, attrs);
    },
    loadCandidates: async (userId) => candidatesOf(userId),
    startSweep: async ({ outUserId, attributes, change }) => {
      const items = unservedBookingIds(attributes, candidatesOf(outUserId));
      jobs.set("job1", { change: sabotage.noChange ? null : change, items, out: outUserId });
      return { jobId: "job1", itemCount: items.length };
    },
    processJob: async (jobId) => {
      const job = jobs.get(jobId)!;
      for (const id of job.items) {
        if (sabotage.noMove) continue;
        bookings.get(id)!.assigned_user_id = job.out === "a" ? "b" : "a";
        if (!sabotage.noAudit) audits.push({ bookingId: id, action: "booking.demotion_reroute" });
      }
    },
    loadBooking: async (id) => {
      const b = bookings.get(id);
      return b ? { status: b.status, assigned_user_id: b.assigned_user_id } : null;
    },
    loadJobChange: async (jobId) => jobs.get(jobId)?.change ?? null,
    sweepItem: async () =>
      sabotage.noMove
        ? { status: "unplaceable", detail: "No other advisor was available to take this appointment at its original time." }
        : { status: "moved", detail: null },
    auditActions: async (bookingId) => audits.filter((a) => a.bookingId === bookingId).map((a) => a.action),
    moveBack: async (bookingId) => {
      if (sabotage.moveBackRefused) return { kind: "refused", reason: "moved-since" };
      const b = bookings.get(bookingId)!;
      if (!sabotage.noMoveBack) b.assigned_user_id = "a";
      b.reverted = !sabotage.noPin;
      audits.push({ bookingId, action: "booking.demotion_reroute_reverted" });
      return { kind: "moved-back", toUserId: "a" };
    },
    pinnedFor: async (userId) =>
      new Set([...bookings.values()].filter((b) => b.reverted && b.assigned_user_id === userId).map((b) => b.id)),
    cancel: async (token) => {
      calls.push(`cancel:${token}`);
      if (sabotage.cancelThrows) throw new Error("google refused the cancel");
      for (const b of bookings.values()) if (b.manageToken === token) b.status = "cancelled";
    },
    nowMs: () => NOW,
    nonce: () => "n1",
  };
  return { deps, agents, original, bookings, audits, calls };
}

{
  const w = world();
  const r = await runDemotionDrill(w.deps);
  eq(r.reason, "passed", `the pipeline doing what it says passes (${r.detail})`);
  eq(w.bookings.get("bk1")?.status, "cancelled", "and the test call is cancelled afterwards");
  eq(JSON.stringify(w.agents.get("a")), JSON.stringify(w.original.get("a")), "and the demoted test advisor is restored exactly");
  assert(w.calls.some((c) => c.includes("smoketest+reroute-drill-n1@trypennie.com")), "booked as a per run alias of the smoke mailbox");
  // 2026-10-30: the drill booked a time only one advisor was free at, so the call could only land
  // on that one and the sweep rightly found nobody to take it. The time is asked of BOTH.
  eq(w.calls[0], "slot:a,b", "the time is one every drill advisor is free at");
  eq(
    w.audits.map((a) => a.action),
    ["booking.demotion_reroute", "booking.demotion_reroute_reverted"],
    "and both the move and the move back were audited",
  );
}

// Each failure, in its own words, and the cleanup still runs.
const failures: [Parameters<typeof world>[0], DrillReason][] = [
  [{ noMove: true }, "did-not-move"],
  [{ noAudit: true }, "no-audit"],
  [{ noChange: true }, "change-not-recorded"],
  [{ moveBackRefused: true }, "move-back-refused"],
  [{ noMoveBack: true }, "did-not-move-back"],
  [{ noPin: true }, "not-pinned"],
];
for (const [sabotage, reason] of failures) {
  const w = world(sabotage);
  const r = await runDemotionDrill(w.deps);
  eq(r.reason, reason, `${JSON.stringify(sabotage)} fails as ${reason} (${r.detail})`);
  eq(w.bookings.get("bk1")?.status, "cancelled", `${reason}: the test call is still cancelled`);
  eq(JSON.stringify(w.agents.get("a")), JSON.stringify(w.original.get("a")), `${reason}: the advisor is still restored`);
}

{
  // A cleanup that fails is said OVER a pass: what it leaves behind is a demoted test advisor or
  // a live test call, and a green drill must never hide that.
  const w = world({ cancelThrows: true });
  const r = await runDemotionDrill(w.deps);
  eq(r.reason, "cleanup-failed", "a cancel that fails is reported, not a pass");
  assert(r.detail.includes("google refused the cancel"), "naming what failed");
  eq(r.endedAs, "passed", "and saying what the drill itself had measured before the cleanup");
  const w2 = world({ restoreThrows: true });
  eq((await runDemotionDrill(w2.deps)).reason, "cleanup-failed", "so is a restore that fails");
}

{
  // Not set up: refused before anything is written.
  const w = world();
  w.deps.loadDrillAgents = async () => [{ id: "a", email: "a@x.com", attributes: { debt_team: [DRILL_TIER] } }];
  const r = await runDemotionDrill(w.deps);
  eq(r.reason, "not-seeded", "one drill advisor is not enough to move a call to another");
  eq(w.calls.length, 0, "and nothing is booked");
  w.deps.loadDrillAgents = async () => [
    { id: "a", email: "a@x.com", attributes: { debt_team: ["high"] } },
    { id: "b", email: "b@x.com", attributes: { debt_team: [DRILL_TIER] } },
  ];
  eq((await runDemotionDrill(w.deps)).reason, "not-seeded", "nor are two when one lacks the drill tier");
}

{
  const w = world();
  w.deps.findSlot = async () => null;
  const r = await runDemotionDrill(w.deps);
  eq(r.reason, "no-free-slot", "no free time on the drill bucket is its own reason");
  eq(w.calls.length, 0, "and nothing is booked");
}

{
  // A step that throws is reported with the step it was in, and cleans up.
  const w = world();
  w.deps.processJob = async () => {
    throw new Error("drain blew up");
  };
  const r = await runDemotionDrill(w.deps);
  eq(r.reason, "errored", "a throw is its own reason, never a pass");
  assert(r.detail.includes("drain blew up") && r.detail.includes("move"), `naming the step and the error (${r.detail})`);
  eq(w.bookings.get("bk1")?.status, "cancelled", "and still cleans up");
}

{
  // The booking landing on somebody outside the drill pool means the drill bucket is not
  // isolated: refused rather than demoting a stranger.
  const w = world();
  w.deps.book = async () => ({ bookingId: "bk1", manageToken: "tok1", assignedUserId: "stranger" });
  eq((await runDemotionDrill(w.deps)).reason, "booked-outside-drill", "a call on somebody outside the drill is never demoted");
}

{
  // A broken pipeline AND a failed cleanup: both are said, and the measured one is kept.
  const w = world({ noMove: true, cancelThrows: true });
  const r = await runDemotionDrill(w.deps);
  eq(r.reason, "cleanup-failed", "the cleanup failure is said");
  eq(r.endedAs, "did-not-move", "and the pipeline's own failure is carried, not lost");
}

{
  // A call that did not move says what the sweep itself recorded, so a busy advisor can never
  // read as a broken pipeline, nor the reverse (L11).
  const r = await runDemotionDrill(world({ noMove: true }).deps);
  assert(
    r.detail.includes("unplaceable") && r.detail.includes("No other advisor was available"),
    `the sweep's own status and reason are carried (${r.detail})`,
  );
  const w = world({ noMove: true });
  w.deps.sweepItem = async () => null;
  const none = await runDemotionDrill(w.deps);
  assert(none.detail.includes("recorded nothing"), `and a sweep with no record for the call says so (${none.detail})`);
}

{
  // The first time every advisor is free, in the first advisor's order.
  eq(firstTimeAllFree([["t1", "t2", "t3"], ["t2", "t3"]]), "t2", "the first time both share");
  eq(firstTimeAllFree([["t1"], ["t2"]]), null, "no shared time is none");
  eq(firstTimeAllFree([]), null, "no advisors is none");
  eq(firstTimeAllFree([["t1"], []]), null, "an advisor with no times leaves none");
}

eq(new Set(DRILL_REASONS).size, DRILL_REASONS.length, "every reason is listed once");

finish();

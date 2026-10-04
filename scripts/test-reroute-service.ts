// #3249: the reroute service, phase 3 of #3244.
//
// An admin corrects a booking's bucket from the booking page. Slate finds who
// should take it (phase 2's search), HOLDS that advisor for five minutes, and asks
// the admin to confirm. Confirm moves the booking through the existing reassign
// machinery with the corrected bucket, or, when the current advisor stays, corrects
// only the bucket and sends nothing. Every outcome reads distinctly: found and
// held, kept, nobody, the hold ran out, the advisor was taken at confirm, and a
// repeated confirm returns the first result.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reroute-service.ts
import {
  startReroute,
  confirmReroute,
  releaseReroute,
  currentReroute,
  RerouteRefusedError,
  type RerouteDeps,
} from "../src/lib/booking/reroute.ts";
import type { RerouteTarget } from "../src/lib/booking/orchestration.ts";
import type { Booking, Bucket, EventType } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const eventType = { id: "et1", duration_min: 20, buffer_before_min: 10, buffer_after_min: 10 } as unknown as EventType;
const bucketFor = (code: string) =>
  ({ id: `b${code}`, org_id: "org1", code, name: `name ${code}`, is_test: false, event_type_id: "et1" }) as unknown as Bucket;

const START = "2031-03-04T10:00:00.000Z";
const END = "2031-03-04T10:20:00.000Z";
const NOW = Date.parse("2031-03-04T09:00:00.000Z");
const baseBooking = {
  id: "K1", org_id: "org1", assigned_user_id: "CUR", agent_name: "Taylor Brooks", agent_email: "cur@x.com",
  gcal_event_id: "ev-cur", starts_at: START, ends_at: END, bucket_id: "b100", kind: "routed", status: "confirmed",
  routing_trace: null,
} as unknown as Booking;

const NAMES: Record<string, { name: string; email: string }> = {
  CUR: { name: "Taylor Brooks", email: "cur@x.com" },
  NEW: { name: "Morgan Reyes", email: "new@x.com" },
  NEXT: { name: "Casey Lin", email: "next@x.com" },
};

const moveTarget = (userId: string, code: string, rungs: number): RerouteTarget => ({
  outcome: rungs === 0 ? "move-in-requested" : "move-cascaded",
  bucket: bucketFor(code), eventType, rungsDropped: rungs, userId, email: NAMES[userId].email, candidates: [userId],
});

interface Opts {
  booking?: Partial<Booking> | null;
  targets?: RerouteTarget[];
  findThrows?: Error;
  placeRefused?: string;
  claim?: { refused?: string; result?: Record<string, unknown>; agent?: string; bucket?: string };
  free?: Set<string>;
  reassignThrows?: Error;
  swapRefused?: string;
  swapNotUpdated?: boolean;
  /** After a claim, what the hold read returns; default the claimed hold. */
  heldAfterClaim?: "missing";
  liveHold?: { holdId: string; agentUserId: string; targetBucketId: string; requestedBucketId: string; rungsDropped: number; expiresAt: string } | null;
}

function fake(o: Opts = {}) {
  const calls = {
    find: [] as string[],
    place: [] as { agentUserId: string; targetBucketId: string; requestedBucketId: string; rungsDropped: number }[],
    release: [] as string[],
    claim: [] as string[],
    verify: [] as { emails: string[]; from: string; to: string }[],
    reassign: [] as { email: string; reason: { code: string; detail: string | null }; reroute: unknown }[],
    keep: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
  };
  const targets = [...(o.targets ?? [])];
  const booking = o.booking === null ? null : ({ ...baseBooking, ...(o.booking ?? {}) } as Booking);
  const deps: RerouteDeps = {
    loadBookingById: async (id) => (booking && id === booking.id ? { booking, bucket: bucketFor("100"), eventType } : null),
    resolveBucketByCode: async (code) => (/^[1-5][0-3][0-2]$/.test(code) ? { bucket: bucketFor(code), eventType } : null),
    findTarget: async (_b, requested) => {
      calls.find.push(requested.bucket.code);
      if (o.findThrows) throw o.findThrows;
      const next = targets.shift();
      if (!next) throw new Error("test ran out of targets");
      return next;
    },
    placeHold: async (args) => {
      calls.place.push({ agentUserId: args.agentUserId, targetBucketId: args.targetBucketId, requestedBucketId: args.requestedBucketId, rungsDropped: args.rungsDropped });
      if (o.placeRefused) return { placed: false, refused: o.placeRefused as never };
      return { placed: true, holdId: `H${calls.place.length}`, expiresAt: new Date(NOW + 5 * 60_000).toISOString() };
    },
    releaseHold: async (bookingId) => {
      calls.release.push(bookingId);
      return { released: true };
    },
    claimHold: async (_org, _booking, holdId) => {
      calls.claim.push(holdId);
      const c = o.claim ?? {};
      return {
        refused: (c.refused ?? null) as never,
        result: c.result ?? null,
        agentUserId: c.refused ? null : (c.agent ?? "NEW"),
        targetBucketId: c.refused ? null : (c.bucket ?? "b512"),
      };
    },
    verifyFree: async (emails, from, to) => {
      calls.verify.push({ emails, from, to });
      const free = o.free ?? new Set(emails);
      return { free: new Set(emails.filter((e) => free.has(e))), unverified: new Set() };
    },
    agentById: async (id) => (NAMES[id] ? { id, ...NAMES[id] } : null),
    bucketById: async (id) => bucketFor(id.replace(/^b/, "")),
    reassign: async (_id, email, reason, reroute) => {
      calls.reassign.push({ email, reason, reroute });
      if (o.reassignThrows) throw o.reassignThrows;
    },
    keepSwap: async (args) => {
      calls.keep.push(args as unknown as Record<string, unknown>);
      return { refused: (o.swapRefused ?? null) as never, updated: !o.swapNotUpdated && !o.swapRefused };
    },
    insertBookingEvent: async (row) => {
      calls.events.push(row as unknown as Record<string, unknown>);
    },
    readLiveHold: async () => {
      if (o.liveHold !== undefined) return o.liveHold;
      if (o.heldAfterClaim === "missing") return null;
      return { holdId: "H1", agentUserId: "NEW", targetBucketId: "b512", requestedBucketId: "b512", rungsDropped: 0, expiresAt: new Date(NOW + 120_000).toISOString() };
    },
    now: () => NOW,
  };
  return { deps, calls };
}

const actor = { userId: "ADMIN" } as never;

async function main() {
  // --- start: someone new is found in the asked for bucket, and held ---
  {
    const { deps, calls } = fake({ targets: [moveTarget("NEW", "512", 0)] });
    const p = await startReroute(deps, { bookingId: "K1", bucketCode: "512", actor });
    eq(p.kind, "move", "a new advisor found is a move proposal");
    if (p.kind === "move") {
      eq(p.advisor.name, "Morgan Reyes", "naming the advisor found");
      eq(p.bucket.code, "512", "in the bucket they were found in");
      eq(p.requested.code, "512", "and the bucket that was asked for");
      eq(p.rungsDropped, 0, "with no tier dropped");
      eq(p.secondsRemaining, 300, "counting down from the server's own five minutes");
      eq(p.holdId, "H1", "carrying the hold the confirm will claim");
    }
    eq(calls.place.length, 1, "one hold is placed");
    eq(calls.place[0], { agentUserId: "NEW", targetBucketId: "b512", requestedBucketId: "b512", rungsDropped: 0 }, "on that advisor, in that bucket");
  }

  // --- start: a cascade says where it landed and how far it dropped ---
  {
    const { deps, calls } = fake({ targets: [moveTarget("NEW", "412", 1)] });
    const p = await startReroute(deps, { bookingId: "K1", bucketCode: "512", actor });
    assert(p.kind === "move" && p.bucket.code === "412" && p.requested.code === "512" && p.rungsDropped === 1, "a cascade names both buckets and the drop");
    eq(calls.place[0]?.requestedBucketId, "b512", "the hold records the bucket asked for");
    eq(calls.place[0]?.targetBucketId, "b412", "and the one actually used");
  }

  // --- start: the current advisor stays, and nothing is held ---
  for (const outcome of ["keep-in-requested", "keep-cascaded", "keep-last-resort"] as const) {
    const { deps, calls } = fake({ targets: [{ outcome, bucket: bucketFor("512"), eventType, rungsDropped: 0 }] });
    const p = await startReroute(deps, { bookingId: "K1", bucketCode: "512", actor });
    assert(p.kind === "keep", `${outcome} is a keep proposal`);
    if (p.kind === "keep") {
      eq(p.lastResort, outcome === "keep-last-resort", `${outcome}: lastResort says whether anyone else could take it`);
      eq(p.advisor.name, "Taylor Brooks", `${outcome}: naming the advisor who stays`);
    }
    eq(calls.place.length, 0, `${outcome}: no hold is placed for a keep`);
  }

  // --- start: a booking with nobody on it and nobody free is "none" ---
  {
    const { deps } = fake({
      booking: { assigned_user_id: null },
      targets: [{ outcome: "keep-last-resort", bucket: bucketFor("512"), eventType, rungsDropped: 0 }],
    });
    const p = await startReroute(deps, { bookingId: "K1", bucketCode: "512", actor });
    eq(p.kind, "none", "nobody to keep and nobody free reads as none, never a keep of nobody");
  }

  // --- start: refusals each carry their own code ---
  const refusedCode = async (o: Opts, input = { bookingId: "K1", bucketCode: "512", actor }) => {
    const { deps } = fake(o);
    try {
      await startReroute(deps, input);
      return null;
    } catch (e) {
      return e instanceof RerouteRefusedError ? e.code : `threw ${String(e)}`;
    }
  };
  eq(await refusedCode({ booking: null }), "booking_not_found", "an unknown booking is refused by name");
  eq(await refusedCode({ booking: { status: "cancelled" } }), "booking_inactive", "a cancelled booking is refused");
  eq(await refusedCode({ booking: { kind: "agent_link" } }), "agent_link", "an advisor link booking is refused: the lead chose that advisor");
  eq(await refusedCode({}, { bookingId: "K1", bucketCode: "999", actor }), "unknown_bucket", "a code that is no bucket is refused");
  eq(
    await refusedCode({ targets: [moveTarget("NEW", "512", 0)], placeRefused: "confirm_in_progress" }),
    "confirm_in_progress",
    "a placement refused by the database keeps the database's word",
  );
  {
    const { deps } = fake({ findThrows: new Error("verify unavailable") });
    let thrown: unknown = null;
    try {
      await startReroute(deps, { bookingId: "K1", bucketCode: "512", actor });
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof Error && !(thrown instanceof RerouteRefusedError), "a failed search throws as a fault, never reads as a refusal or a keep");
  }

  // --- confirm a move: claim, re-verify live over the BUFFERED window, then reassign ---
  {
    const { deps, calls } = fake({});
    const out = await confirmReroute(deps, { bookingId: "K1", holdId: "H1", bucketCode: null, note: "lead is Ultra High", actor });
    eq(out.kind, "moved", "a confirmed move answers moved");
    eq(calls.claim, ["H1"], "the hold is claimed first");
    eq(calls.verify[0]?.emails, ["new@x.com"], "the held advisor is verified live");
    eq(calls.verify[0]?.from, "2031-03-04T09:50:00.000Z", "from the start of the before buffer");
    eq(calls.verify[0]?.to, "2031-03-04T10:30:00.000Z", "to the end of the after buffer");
    eq(calls.reassign.length, 1, "then the existing reassign runs once");
    eq(calls.reassign[0]?.email, "new@x.com", "onto the held advisor");
    eq(calls.reassign[0]?.reason, { code: "bucket_correction", detail: "lead is Ultra High" }, "with the fixed reason and the admin's note");
    const rr = calls.reassign[0]?.reroute as { holdId: string; bucketId: string } | undefined;
    assert(rr?.holdId === "H1" && rr?.bucketId === "b512", "carrying the hold and the corrected bucket into the swap");
    eq(calls.release.length, 0, "a successful move releases nothing: the swap consumed the hold");
  }

  // --- confirm: the held advisor was booked meanwhile, so it searches again ---
  {
    const { deps, calls } = fake({ free: new Set(), targets: [moveTarget("NEXT", "412", 1)] });
    const out = await confirmReroute(deps, { bookingId: "K1", holdId: "H1", bucketCode: null, note: null, actor });
    eq(out.kind, "taken", "a held advisor no longer free reads as taken");
    if (out.kind === "taken") {
      eq(out.previous.name, "Morgan Reyes", "naming who was taken");
      assert(out.proposal.kind === "move" && out.proposal.advisor.name === "Casey Lin", "and offering the next person found");
    }
    eq(calls.release, ["K1"], "the stale hold is released before searching again");
    eq(calls.find, ["512"], "the search re-runs for the bucket the admin asked for");
    eq(calls.reassign.length, 0, "and nothing is moved without a fresh confirm");
  }

  // --- confirm: a verify that cannot read the calendar is a fault, never a move ---
  {
    const { deps, calls } = fake({});
    deps.verifyFree = async (emails) => ({ free: new Set(), unverified: new Set(emails) });
    let thrown: unknown = null;
    try {
      await confirmReroute(deps, { bookingId: "K1", holdId: "H1", bucketCode: null, note: null, actor });
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof Error, "an unreadable calendar at confirm throws");
    eq(calls.reassign.length, 0, "and moves nothing");
  }

  // --- confirm: a second confirm returns the first result ---
  {
    const { deps, calls } = fake({ claim: { refused: "hold_consumed", result: { outcome: "moved", agent_user_id: "NEW", bucket_code: "512" } } });
    const out = await confirmReroute(deps, { bookingId: "K1", holdId: "H1", bucketCode: null, note: null, actor });
    assert(out.kind === "moved" && out.advisor.name === "Morgan Reyes" && out.bucket.code === "512", "a consumed hold answers the stored move");
    eq(calls.reassign.length, 0, "without moving anything again");
  }

  // --- confirm: the hold ran out ---
  for (const refused of ["hold_expired", "hold_not_found"]) {
    const { deps, calls } = fake({ claim: { refused } });
    const out = await confirmReroute(deps, { bookingId: "K1", holdId: "H1", bucketCode: null, note: null, actor });
    eq(out.kind, "expired", `${refused} reads as the hold having run out`);
    eq(calls.reassign.length, 0, `${refused}: nothing is moved`);
  }

  // --- confirm: the lead moved their call meanwhile ---
  {
    const { deps } = fake({ claim: { refused: "booking_moved" } });
    let code: string | null = null;
    try {
      await confirmReroute(deps, { bookingId: "K1", holdId: "H1", bucketCode: null, note: null, actor });
    } catch (e) {
      code = e instanceof RerouteRefusedError ? e.code : "other";
    }
    eq(code, "booking_moved", "a booking rescheduled during the hold is refused by name");
  }

  // --- confirm: a reassign that fails after the claim releases the hold and rethrows ---
  {
    const { deps, calls } = fake({ reassignThrows: new Error("google down") });
    let thrown: unknown = null;
    try {
      await confirmReroute(deps, { bookingId: "K1", holdId: "H1", bucketCode: null, note: null, actor });
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof Error && /google down/.test(thrown.message), "the reassign's own failure surfaces");
    eq(calls.release, ["K1"], "and the hold is released so the advisor is free for leads again");
  }

  // --- confirm: ANY failure after the claim lets the held advisor go ---
  {
    const { deps, calls } = fake({});
    deps.verifyFree = async (emails) => ({ free: new Set(), unverified: new Set(emails) });
    await confirmReroute(deps, { bookingId: "K1", holdId: "H1", bucketCode: null, note: null, actor }).catch(() => undefined);
    eq(calls.release, ["K1"], "an unreadable calendar after the claim releases the hold rather than leaving the advisor blocked");
  }
  {
    const { deps, calls } = fake({});
    deps.agentById = async () => {
      throw new Error("users read failed");
    };
    await confirmReroute(deps, { bookingId: "K1", holdId: "H1", bucketCode: null, note: null, actor }).catch(() => undefined);
    eq(calls.release, ["K1"], "a failed read after the claim releases the hold too");
  }

  // --- confirm: a claimed hold that cannot be read back stops, never guesses the drop ---
  {
    const { deps, calls } = fake({ heldAfterClaim: "missing" });
    let thrown: unknown = null;
    try {
      await confirmReroute(deps, { bookingId: "K1", holdId: "H1", bucketCode: null, note: null, actor });
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof Error && !(thrown instanceof RerouteRefusedError), "a hold missing right after its claim is a fault");
    eq(calls.reassign.length, 0, "and nothing is moved on a guessed requested bucket or drop");
  }

  // --- keep: a booking with nobody on it says so, not "hold no longer active" ---
  {
    const { deps } = fake({ booking: { assigned_user_id: null, agent_email: null } });
    let code: string | null = null;
    try {
      await confirmReroute(deps, { bookingId: "K1", holdId: null, bucketCode: "512", note: null, actor });
    } catch (e) {
      code = e instanceof RerouteRefusedError ? e.code : "other";
    }
    eq(code, "no_current_advisor", "a keep with no advisor to keep has its own refusal");
  }

  // --- keep: a swap that changed nothing never reads as kept ---
  {
    const { deps, calls } = fake({ swapNotUpdated: true });
    let thrown: unknown = null;
    try {
      await confirmReroute(deps, { bookingId: "K1", holdId: null, bucketCode: "512", note: null, actor });
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof Error, "a keep swap that wrote nothing with no reason throws");
    eq(calls.events.length, 0, "and writes no history claiming the correction");
  }

  // --- confirm a keep: only the bucket changes, history says so, nothing is sent ---
  {
    const { deps, calls } = fake({});
    const out = await confirmReroute(deps, { bookingId: "K1", holdId: null, bucketCode: "512", note: "fix", actor });
    assert(out.kind === "kept" && out.bucket.code === "512", "a keep answers kept, in the corrected bucket");
    eq(calls.claim.length, 0, "a keep claims no hold");
    eq(calls.reassign.length, 0, "and runs no reassign");
    eq(calls.keep.length, 1, "the swap runs once as a keep");
    const k = calls.keep[0] as { userId: string; bucketId: string; holdId: string | null };
    assert(k.userId === "CUR" && k.bucketId === "b512" && k.holdId === null, "on the current advisor, the corrected bucket, with no hold");
    eq(calls.events.length, 1, "one history row is written");
    const ev = calls.events[0] as Record<string, unknown>;
    eq(ev.action, "bucket_corrected", "as a bucket correction");
    eq(ev.reason_code, "bucket_correction", "with the fixed reason");
    eq(ev.reason_detail, "fix", "and the note");
    eq(ev.from_bucket_id, "b100", "from the bucket it was in");
    eq(ev.to_bucket_id, "b512", "to the corrected one");
    eq(ev.from_agent_user_id, "CUR", "the advisor before");
    eq(ev.to_agent_user_id, "CUR", "and after are the same");
  }
  {
    const { deps, calls } = fake({ swapRefused: "booking_inactive" });
    let code: string | null = null;
    try {
      await confirmReroute(deps, { bookingId: "K1", holdId: null, bucketCode: "512", note: null, actor });
    } catch (e) {
      code = e instanceof RerouteRefusedError ? e.code : "other";
    }
    eq(code, "booking_inactive", "a keep the swap refuses keeps the swap's word");
    eq(calls.events.length, 0, "and writes no history");
  }
  {
    const { deps } = fake({});
    let code: string | null = null;
    try {
      await confirmReroute(deps, { bookingId: "K1", holdId: null, bucketCode: null, note: null, actor });
    } catch (e) {
      code = e instanceof RerouteRefusedError ? e.code : "other";
    }
    eq(code, "unknown_bucket", "a keep with no bucket to correct to is refused");
  }

  // --- release ---
  {
    const { deps, calls } = fake({});
    await releaseReroute(deps, "K1");
    eq(calls.release, ["K1"], "release drops the booking's live hold");
  }

  // --- current: a reload restores the confirm panel and its countdown ---
  {
    const { deps } = fake({
      liveHold: { holdId: "H9", agentUserId: "NEW", targetBucketId: "b412", requestedBucketId: "b512", rungsDropped: 1, expiresAt: new Date(NOW + 90_000).toISOString() },
    });
    const p = await currentReroute(deps, "K1");
    assert(p?.kind === "move" && p.holdId === "H9" && p.advisor.name === "Morgan Reyes", "a live hold comes back as the proposal it was");
    eq(p?.kind === "move" ? p.secondsRemaining : -1, 90, "with the time it has left");
    assert(p?.kind === "move" && p.bucket.code === "412" && p.requested.code === "512" && p.rungsDropped === 1, "and where it landed");
  }
  {
    const { deps } = fake({ liveHold: null });
    eq(await currentReroute(deps, "K1"), null, "no live hold reads as nothing to restore");
  }
}

await main();
finish();

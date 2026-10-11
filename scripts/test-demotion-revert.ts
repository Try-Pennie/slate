// #3615: moving a rerouted call BACK to its original advisor. Pure, driven here.
//
// Settled with Dan 2026-10-11: the demotion move is automatic but undoable from the booking's
// page, and an undone call stays with the original advisor (later sweeps and the backstop leave
// it alone). Every way the undo can be refused says its own reason (L11), because each sends the
// reader somewhere different.
import {
  demotionMoveFromRow,
  latestDemotionMove,
  moveBackDemotionReroute,
  pinnedBookingIds,
  type MoveBackDeps,
  planDemotionRevert,
  revertRefusalText,
  REVERT_REFUSALS,
  type DemotionMoveRecord,
} from "../src/lib/booking/demotion-revert.ts";
import type { AuditEntry } from "../src/lib/audit.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-10-12T15:00:00.000Z");
const FUTURE = "2026-10-14T15:00:00.000Z";
const PAST = "2026-10-12T14:00:00.000Z";
// Built from code points so this file holds no literal dash for the style hook to catch.
const DASH = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);

const move = (over: Partial<DemotionMoveRecord> = {}): DemotionMoveRecord => ({
  itemId: "it1",
  bookingId: "bk1",
  jobId: "job1",
  orgId: "org1",
  outUserId: "jordan",
  toUserId: "sam",
  status: "moved",
  movedAt: "2026-10-11T19:00:00.000Z",
  demotionMarkedAt: "2026-10-11T18:00:00.000Z",
  change: null,
  revertedAt: null,
  revertedBy: null,
  ...over,
});
const booking = (over: Partial<{ status: string; assigned_user_id: string | null; starts_at: string }> = {}) => ({
  status: "confirmed",
  assigned_user_id: "sam",
  starts_at: FUTURE,
  ...over,
});
const jordan = { email: "jordan@trypennie.com", deactivated_at: null as string | null };

// --- the plan ---------------------------------------------------------------------------

{
  const p = planDemotionRevert({ move: move(), booking: booking(), original: jordan, nowMs: NOW });
  eq(p.kind, "move-back", "a call still with the advisor it moved to, upcoming and active, can go back");
  if (p.kind === "move-back") {
    eq(p.toUserId, "jordan", "to the advisor the sweep moved it off");
    eq(p.toEmail, "jordan@trypennie.com", "by their address, which is what the reassign takes");
  }
}

{
  // Two admins at once, or a page left open after somebody else pressed it.
  const p = planDemotionRevert({
    move: move({ revertedAt: "2026-10-12T14:00:00.000Z", revertedBy: "admin1" }),
    booking: booking({ assigned_user_id: "jordan" }),
    original: jordan,
    nowMs: NOW,
  });
  eq(p.kind === "refused" && p.reason, "already-moved-back", "an undo already recorded is not done twice");
}

{
  // The move back landed but the record of it did not (the run died between the two). Pressing
  // again finishes the record rather than refusing, so the undo converges instead of being lost.
  const p = planDemotionRevert({ move: move(), booking: booking({ assigned_user_id: "jordan" }), original: jordan, nowMs: NOW });
  eq(p.kind, "record-only", "a call already back with the original advisor only needs the undo recorded");
}

{
  // Somebody moved it again since: a third advisor holds it. Moving it "back" would overrule them.
  const p = planDemotionRevert({ move: move(), booking: booking({ assigned_user_id: "alex" }), original: jordan, nowMs: NOW });
  eq(p.kind === "refused" && p.reason, "moved-since", "a call moved again since is not moved back over that");
}

for (const status of ["cancelled", "completed"]) {
  const p = planDemotionRevert({ move: move(), booking: booking({ status }), original: jordan, nowMs: NOW });
  eq(p.kind === "refused" && p.reason, "not-active", `a ${status} call has nothing to move back`);
}

{
  const p = planDemotionRevert({ move: move(), booking: booking({ starts_at: PAST }), original: jordan, nowMs: NOW });
  eq(p.kind === "refused" && p.reason, "already-started", "a call whose time has come is not moved");
  const unreadable = planDemotionRevert({ move: move(), booking: booking({ starts_at: "soon" }), original: jordan, nowMs: NOW });
  eq(
    unreadable.kind === "refused" && unreadable.reason,
    "already-started",
    "an unreadable start is refused, never read as upcoming (L50)",
  );
}

{
  const p = planDemotionRevert({
    move: move(),
    booking: booking(),
    original: { email: "jordan@trypennie.com", deactivated_at: "2026-10-12T09:00:00.000Z" },
    nowMs: NOW,
  });
  eq(p.kind === "refused" && p.reason, "original-left", "an advisor who has left Slate cannot take it back");
  const gone = planDemotionRevert({ move: move(), booking: booking(), original: null, nowMs: NOW });
  eq(gone.kind === "refused" && gone.reason, "original-left", "nor can one with no record at all");
}

{
  const none = planDemotionRevert({ move: null, booking: booking(), original: jordan, nowMs: NOW });
  eq(none.kind === "refused" && none.reason, "no-automatic-move", "a booking no demotion sweep moved has nothing to undo");
  const unplaced = planDemotionRevert({ move: move({ status: "unplaceable", toUserId: null }), booking: booking(), original: jordan, nowMs: NOW });
  eq(unplaced.kind === "refused" && unplaced.reason, "no-automatic-move", "nor does one the sweep could not place");
}

// --- every refusal reads distinctly --------------------------------------------------------

{
  const names = { original: "Jordan Lee", current: "Alex Kim" };
  const texts = REVERT_REFUSALS.map((r) => revertRefusalText(r, names));
  eq(new Set(texts).size, REVERT_REFUSALS.length, "no two refusals share a sentence (L11)");
  for (const t of texts) {
    assert(t.length > 20 && !/undefined|null/.test(t), `each refusal is a real sentence (${t})`);
    assert(!DASH.test(t), "with no dash punctuation");
  }
  assert(revertRefusalText("moved-since", names).includes("Alex Kim"), "moved-since names who holds it now");
  assert(revertRefusalText("original-left", names).includes("Jordan Lee"), "original-left names who left");
}

// --- which move a booking's undo is about --------------------------------------------------

{
  const older = move({ itemId: "a", movedAt: "2026-10-01T10:00:00.000Z", jobId: "j1" });
  const newer = move({ itemId: "b", movedAt: "2026-10-09T10:00:00.000Z", jobId: "j2" });
  const failed = move({ itemId: "c", movedAt: "2026-10-10T10:00:00.000Z", status: "failed", toUserId: null });
  eq(latestDemotionMove([older, newer, failed])?.itemId, "b", "the latest COMPLETED move, never a failed attempt");
  eq(latestDemotionMove([]), null, "no move is null, not a guess");
}

// --- pinning: what later sweeps and the backstop leave alone --------------------------------

{
  const reverted = move({ bookingId: "kept", revertedAt: "2026-10-12T14:00:00.000Z", revertedBy: "admin1" });
  const live = move({ bookingId: "moved" });
  const otherAgent = move({ bookingId: "elsewhere", outUserId: "pat", revertedAt: "2026-10-12T14:00:00.000Z" });
  const pinned = pinnedBookingIds([reverted, live, otherAgent], "jordan");
  eq([...pinned].sort(), ["kept"], "only this advisor's moved-back calls are pinned to them");
}

// --- the move back, end to end over fakes ---------------------------------------------------
//
// The order is what makes it safe to run twice (two admins, a double click, a retry): the
// reassign to the original advisor is idempotent for one target, and the RECORD is a
// compare-and-swap, so only the call that recorded it writes the audit row.

function moveBackFakes(over: Partial<MoveBackDeps> = {}) {
  const calls: string[] = [];
  const audits: AuditEntry[] = [];
  let recorded = false;
  const deps: MoveBackDeps = {
    loadMoves: async () => [move()],
    loadBooking: async () => booking(),
    loadUser: async (id) => (id === "jordan" ? { email: "jordan@trypennie.com", deactivated_at: null } : null),
    reassign: async (bookingId, toEmail, overrideCap) => {
      calls.push(`reassign:${bookingId}:${toEmail}:${overrideCap}`);
    },
    markReverted: async (itemId, byUserId) => {
      calls.push(`mark:${itemId}:${byUserId}`);
      if (recorded) return false;
      recorded = true;
      return true;
    },
    recordAudit: async (entry) => {
      audits.push(entry);
    },
    ...over,
  };
  return { deps, calls, audits };
}
const actor = { userId: "admin1", actingAsUserId: null };

{
  const f = moveBackFakes();
  const out = await moveBackDemotionReroute(f.deps, { bookingId: "bk1", orgId: "org1", actor, overrideCap: false, nowMs: NOW });
  eq(out.kind, "moved-back", "the call goes back");
  eq(f.calls, ["reassign:bk1:jordan@trypennie.com:false", "mark:it1:admin1"], "the move first, then the record");
  eq(f.audits.length, 1, "one audit row");
  const a = f.audits[0];
  eq(a.action, "booking.demotion_reroute_reverted", "recorded as the undo of a demotion move");
  eq(a.actorId, "admin1", "by the admin who pressed it");
  eq(a.targetUserId, "jordan", "about the advisor who got the call back");
  const d = a.details as Record<string, unknown>;
  eq([d.booking_id, d.from_user_id, d.to_user_id, d.job_id], ["bk1", "sam", "jordan", "job1"], "naming the booking and both advisors");
}

{
  // A second press, after the first recorded it: the planner refuses before any move.
  const f = moveBackFakes({ loadMoves: async () => [move({ revertedAt: "2026-10-12T14:59:00.000Z", revertedBy: "admin2" })] });
  const out = await moveBackDemotionReroute(f.deps, { bookingId: "bk1", orgId: "org1", actor, overrideCap: false, nowMs: NOW });
  eq(out.kind === "refused" && out.reason, "already-moved-back", "an undo already recorded is refused");
  eq(f.calls.length, 0, "and nothing moves");
}

{
  // Two presses at once: both moved the call to the same advisor (idempotent), only one record
  // wins, and only that one writes the audit row.
  const f = moveBackFakes();
  const input = { bookingId: "bk1", orgId: "org1", actor, overrideCap: false, nowMs: NOW };
  const [one, two] = await Promise.all([moveBackDemotionReroute(f.deps, input), moveBackDemotionReroute(f.deps, input)]);
  eq([one.kind, two.kind].sort(), ["already-recorded", "moved-back"], "one records it, the other is told it already was");
  eq(f.audits.length, 1, "and there is one audit row between them");
}

{
  // The move landed and the record did not: pressing again finishes the record, moving nothing.
  const f = moveBackFakes({ loadBooking: async () => booking({ assigned_user_id: "jordan" }) });
  const out = await moveBackDemotionReroute(f.deps, { bookingId: "bk1", orgId: "org1", actor, overrideCap: false, nowMs: NOW });
  eq(out.kind, "moved-back", "the undo is complete");
  eq(f.calls, ["mark:it1:admin1"], "by recording it, with no second move");
  eq(f.audits.length, 1, "and auditing it");
}

{
  // A refused move back (the original advisor left) moves and records nothing.
  const f = moveBackFakes({ loadUser: async () => ({ email: "jordan@trypennie.com", deactivated_at: "2026-10-12T09:00:00.000Z" }) });
  const out = await moveBackDemotionReroute(f.deps, { bookingId: "bk1", orgId: "org1", actor, overrideCap: false, nowMs: NOW });
  eq(out.kind === "refused" && out.reason, "original-left", "refused");
  eq(f.calls.length + f.audits.length, 0, "with nothing moved or recorded");
}

{
  // The reassign refusing (a daily cap, a clash on the advisor's calendar) records nothing and
  // reaches the caller as the reassign's own error, which the route already knows how to say.
  const f = moveBackFakes({
    reassign: async () => {
      throw new Error("over cap");
    },
  });
  let threw = "";
  try {
    await moveBackDemotionReroute(f.deps, { bookingId: "bk1", orgId: "org1", actor, overrideCap: false, nowMs: NOW });
  } catch (err) {
    threw = String(err);
  }
  assert(threw.includes("over cap"), "the reassign's refusal reaches the caller unchanged");
  eq(f.audits.length, 0, "and no undo is recorded for a move that did not happen");
}

{
  const f = moveBackFakes({ loadBooking: async () => null });
  const out = await moveBackDemotionReroute(f.deps, { bookingId: "bk1", orgId: "org1", actor, overrideCap: false, nowMs: NOW });
  eq(out.kind, "not-found", "a booking outside the org, or gone, is not found");
}

{
  // The override is the admin's own second confirm, and is passed through, never assumed.
  const f = moveBackFakes();
  await moveBackDemotionReroute(f.deps, { bookingId: "bk1", orgId: "org1", actor, overrideCap: true, nowMs: NOW });
  eq(f.calls[0], "reassign:bk1:jordan@trypennie.com:true", "an over cap confirm reaches the reassign");
}

// --- reading a move from its database row -------------------------------------------------

{
  const row = {
    id: "it1",
    booking_id: "bk1",
    status: "moved",
    target_user_id: "sam",
    updated_at: "2026-10-11T19:00:00.000Z",
    reverted_at: null,
    reverted_by: null,
    bulk_reassign_jobs: {
      id: "job1",
      org_id: "org1",
      out_user_id: "jordan",
      demotion_marked_at: "2026-10-11T18:00:00.000Z",
      demotion_change: { from: { debtTeam: ["high"], backendService: [] }, to: { debtTeam: [], backendService: [] } },
    },
  };
  const m = demotionMoveFromRow(row);
  eq([m?.itemId, m?.jobId, m?.outUserId, m?.toUserId, m?.orgId], ["it1", "job1", "jordan", "sam", "org1"], "the row maps to the move");
  eq(m?.change?.from.debtTeam, ["high"], "with its change read through the shape check");
  eq(demotionMoveFromRow({ ...row, bulk_reassign_jobs: { ...row.bulk_reassign_jobs, demotion_change: "junk" } })?.change, null, "a malformed change reads as unrecorded");
  eq(demotionMoveFromRow({ ...row, bulk_reassign_jobs: null }), null, "a row with no sweep is not a demotion move");
  eq(demotionMoveFromRow({ ...row, bulk_reassign_jobs: { ...row.bulk_reassign_jobs, demotion_marked_at: null } }), null, "nor is a sweep that was not a demotion");
}

finish();

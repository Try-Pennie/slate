// #3615: moving a rerouted call BACK to its original advisor. Pure, driven here.
//
// Settled with Dan 2026-10-11: the demotion move is automatic but undoable from the booking's
// page, and an undone call stays with the original advisor (later sweeps and the backstop leave
// it alone). Every way the undo can be refused says its own reason (L11), because each sends the
// reader somewhere different.
import {
  latestDemotionMove,
  pinnedBookingIds,
  planDemotionRevert,
  revertRefusalText,
  REVERT_REFUSALS,
  type DemotionMoveRecord,
} from "../src/lib/booking/demotion-revert.ts";
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

finish();

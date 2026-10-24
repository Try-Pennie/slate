import { describe, it, expect, vi, beforeEach } from "vitest";

// #1435: writing an event type and refreshing what the booker serves are ONE
// operation.
//
// Hit live on 2026-08-12: the description was updated, the database was correct, the
// admin screen showed the new text, and the booker went on serving the old one,
// because the event type rides inside the cached bucket_slots payload the read path
// serves. Editing the row is not the same as serving it.
//
// #3798 (L776): whether somebody else changed what is being saved is judged by the
// fields being saved, never by the row's updated_at, which a save of ANY field
// moves. The table here moves updated_at on every write, as the trigger does, so a
// write from elsewhere can be driven at any point, including between the store's
// read and its write.

const db = vi.hoisted(() => ({ table: null as FakeEventTypesTable | null }));
const invalidate = vi.hoisted(() => vi.fn(async () => 7));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => db.table!.client }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: invalidate }));

import { fakeEventTypesTable, type FakeEventTypesTable } from "../../../scripts/lib/fake-event-types-table";
import { EVENT_TYPE_SAVE_ATTEMPTS, updateEventType } from "./event-type-store";

/** The version the row holds when each case starts. */
const STAMP = "2026-10-03T10:00:00.123456+00:00";

const seed = () => ({
  id: "et1",
  org_id: "o1",
  name: "Consultation",
  description: "A friendly chat",
  duration_min: 20,
  buffer_before_min: 10,
  buffer_after_min: 10,
  min_notice_min: 120,
  updated_at: STAMP,
});

const table = () => db.table!;
const row = () => table().rows.find((r) => r.id === "et1")!;

/** Save a notice as an editor drawn from the seed row would. */
const saveNotice = (to: number, loaded = 120, id = "et1") =>
  updateEventType({ eventTypeId: id, orgId: "o1", patch: { min_notice_min: to }, loaded: { min_notice_min: loaded } });

describe("updateEventType (#1435, #3798)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.table = fakeEventTypesTable([seed()]);
    invalidate.mockResolvedValue(7);
  });

  it("writes the patch scoped to the org, guarded on the version it just read, and refreshes what the booker serves", async () => {
    const res = await updateEventType({
      eventTypeId: "et1",
      orgId: "o1",
      patch: { description: "A longer chat" },
      loaded: { description: "A friendly chat" },
    });
    expect(row().description).toBe("A longer chat");
    // Tenant scoping: the id alone would let one org edit another's event type.
    // And the stamp is the one this save READ, closing only the gap to its write.
    expect(table().updates[0]?.filters).toEqual([
      ["id", "et1"],
      ["org_id", "o1"],
      ["updated_at", STAMP],
    ]);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ count: 1, error: null, invalidated: true, changed: false });
  });

  // #3122: two editors of the SAME field. The second would silently overwrite the
  // first, so it is refused and told so, not "not found" or "saved".
  it("refuses when the field being saved no longer holds the value the editor loaded", async () => {
    table().writeElsewhere("et1", { min_notice_min: 30 });
    const res = await saveNotice(5);
    expect(res).toEqual({ count: 0, error: null, invalidated: false, changed: true });
    expect(row().min_notice_min).toBe(30);
    expect(table().updates).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  // #3798: the defect. A save of another field moved the row's stamp, and the
  // notice was refused over a description nobody editing the notice had touched.
  it("saves when only OTHER fields of the row changed since the editor loaded it", async () => {
    table().writeElsewhere("et1", { description: "Somebody else's copy", buffer_before_min: 15 });
    const res = await saveNotice(5);
    expect(res.changed).toBe(false);
    expect(res.count).toBe(1);
    expect(row()).toMatchObject({ min_notice_min: 5, description: "Somebody else's copy", buffer_before_min: 15 });
  });

  // A double submit, or two people making the same change: the field already holds
  // what is being saved, so nothing of anybody's is overwritten.
  it("does not refuse a field that already holds the value being saved", async () => {
    expect((await saveNotice(5)).count).toBe(1);
    const again = await saveNotice(5);
    expect(again).toMatchObject({ count: 1, error: null, changed: false });
    expect(row().min_notice_min).toBe(5);
  });

  // The stamp closes the few milliseconds between the read and the write. A write to
  // another field landing there makes the guarded write match nothing; the save
  // reads and judges again rather than turning it into a refusal.
  it("reads and judges again when another field is written between its read and its write", async () => {
    table().faults.beforeUpdate = () => table().writeElsewhere("et1", { description: "Landed in between" });
    const res = await saveNotice(5);
    expect(res).toEqual({ count: 1, error: null, invalidated: true, changed: false });
    expect(table().updates.map((u) => u.count)).toEqual([0, 1]);
    expect(row()).toMatchObject({ min_notice_min: 5, description: "Landed in between" });
  });

  it("refuses when the SAME field is written between its read and its write", async () => {
    table().faults.beforeUpdate = () => table().writeElsewhere("et1", { min_notice_min: 30 });
    const res = await saveNotice(5);
    expect(res.changed).toBe(true);
    expect(row().min_notice_min).toBe(30);
    expect(invalidate).not.toHaveBeenCalled();
  });

  // FAILURE PATH: the row never holds still. Bounded, and said as a failed save,
  // never as somebody having changed the notice, which nobody did.
  it("gives up after a bounded number of attempts and reports an error, not a refusal", async () => {
    const elsewhere = () => {
      table().writeElsewhere("et1", { name: `Renamed ${table().updates.length}` });
      table().faults.beforeUpdate = elsewhere;
    };
    table().faults.beforeUpdate = elsewhere;
    const res = await saveNotice(5);
    expect(res.changed).toBe(false);
    expect(res.count).toBe(0);
    expect(res.error?.message).toMatch(/changed under the save/);
    expect(table().updates).toHaveLength(EVENT_TYPE_SAVE_ATTEMPTS);
    expect(row().min_notice_min).toBe(120);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("CONTROL: a row that is not there at all is not reported as changed", async () => {
    const res = await saveNotice(5, 120, "gone");
    expect(res).toEqual({ count: 0, error: null, invalidated: false, changed: false });
    expect(table().updates).toEqual([]);
  });

  it("does not touch or refresh anything when the id belongs to another org", async () => {
    table().rows.push({ ...seed(), id: "someone-elses", org_id: "o2" });
    const res = await saveNotice(5, 120, "someone-elses");
    expect(res.count).toBe(0);
    expect(res.changed).toBe(false);
    expect(table().rows.find((r) => r.id === "someone-elses")?.min_notice_min).toBe(120);
    // Nothing was edited, so nothing is stale, and a mass invalidation costs a full
    // recompute cycle across every bucket.
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("surfaces an unreadable row as an error, never as not found or changed", async () => {
    table().faults.read = { message: "statement timeout" };
    const res = await saveNotice(5);
    expect(res.error?.message).toMatch(/statement timeout/);
    expect(res.changed).toBe(false);
    expect(table().updates).toEqual([]);
  });

  it("reports a database error on the write and refreshes nothing", async () => {
    table().faults.update = { message: "column does not exist" };
    const res = await updateEventType({
      eventTypeId: "et1",
      orgId: "o1",
      patch: { duration_min: 45 },
      loaded: { duration_min: 20 },
    });
    expect(res.error?.message).toBe("column does not exist");
    expect(res.count).toBe(0);
    expect(res.invalidated).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });

  // FAILURE PATH: the refresh itself fails. The row is committed and correct, so
  // failing the admin's save would leave them re-submitting a change that already
  // landed. It is reported rather than assumed, and the served copy still converges
  // as rows age past the freshness window.
  it("still reports the save when the refresh fails, and says the refresh did not happen", async () => {
    invalidate.mockRejectedValue(new Error("bucket_slots write failed"));
    const res = await saveNotice(60);
    expect(res.error).toBeNull();
    expect(res.count).toBe(1);
    expect(res.invalidated).toBe(false);
  });

  // A null count with no error is not a measurement of zero. Scoring it as zero
  // would retry a write that landed and skip the refresh, which is the original
  // defect arriving by a different door.
  it("refreshes when the count could not be measured, rather than assuming nothing changed", async () => {
    table().faults.nullCount = true;
    const res = await saveNotice(60);
    expect(table().updates).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(res.invalidated).toBe(true);
  });

  it("refreshes for a duration change too, which the org hours gate reads when judging fit", async () => {
    await updateEventType({ eventTypeId: "et1", orgId: "o1", patch: { duration_min: 60 }, loaded: { duration_min: 20 } });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  // tsc refuses this; a caller casting around it must not save blind.
  it("refuses to write a field it was not told the loaded value of", async () => {
    await expect(
      updateEventType({
        eventTypeId: "et1",
        orgId: "o1",
        patch: { min_notice_min: 5 },
        loaded: {} as { min_notice_min: number },
      }),
    ).rejects.toThrow(/no loaded value for min_notice_min/);
    expect(table().updates).toEqual([]);
  });
});

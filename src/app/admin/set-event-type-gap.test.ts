import { describe, it, expect, vi, beforeEach } from "vitest";

// setEventTypeGap: the gap an admin keeps between two calls on one advisor
// (BC, 2026-10-02: cal.com kept 10 minutes as a cap on capacity, and the move to
// Slate dropped it). One number sets BOTH buffers, because Slate pads only the
// call being offered: a buffer after alone still lets a new call start the minute
// an earlier one ends.
//
// The failure paths matter as much as the save. A redirect saying "saved" over a
// write that errored or matched nothing would leave advisors stacked while the
// admin believed the gap was in place (L12).
//
// Driven through an in-memory event_types whose updated_at moves on every write,
// as the trigger does (#3798), and judged by the row it leaves.
const db = vi.hoisted(() => ({ table: null as FakeEventTypesTable | null }));
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const markAllBucketSlotsStale = vi.hoisted(() => vi.fn(async () => 3));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => db.table!.client }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { fakeEventTypesTable, type FakeEventTypesTable } from "../../../scripts/lib/fake-event-types-table";
import { createEventType, setEventTypeGap } from "./actions";
import { refusedQuery } from "@/lib/admin/save-outcomes";
import { CHANGED_SINCE_OPENED, PAGE_OUT_OF_DATE, loadedFieldValue } from "@/lib/admin/edit-version";

/** The version the row holds when each case starts. */
const STAMP = "2026-10-03T10:00:00.123456+00:00";

const table = () => db.table!;
const row = () => table().rows.find((r) => r.id === "et1")!;

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  // #3798: the gap the editor was drawn with; a case removes it to test the refusal.
  fd.set("loaded_buffer_before_min", loadedFieldValue(0));
  fd.set("loaded_buffer_after_min", loadedFieldValue(0));
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.table = fakeEventTypesTable([
    {
      id: "et1",
      org_id: "o1",
      name: "Consultation",
      description: null,
      buffer_before_min: 0,
      buffer_after_min: 0,
      min_notice_min: 120,
      updated_at: STAMP,
    },
  ]);
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

/** The action always ends in a redirect, which the mock throws. */
async function run(entries: Record<string, string>): Promise<string> {
  try {
    await setEventTypeGap(form(entries));
  } catch (err) {
    return String((err as Error).message).replace("NEXT_REDIRECT:", "");
  }
  throw new Error("the action returned without redirecting");
}

describe("setEventTypeGap", () => {
  it("is admin only", async () => {
    auth.requireAdmin.mockRejectedValue(new Error("nope"));
    await expect(setEventTypeGap(form({ event_type_id: "et1", gap_min: "10" }))).rejects.toThrow();
    expect(table().updates).toEqual([]);
  });

  it("sets both buffers to the gap, scoped to the admin's org, and refreshes what the booker serves", async () => {
    const to = await run({ event_type_id: "et1", gap_min: "10" });
    expect(to).toBe("/admin/event-types?ok=event-type-gap");
    expect(table().updates[0]?.patch).toEqual({ buffer_before_min: 10, buffer_after_min: 10 });
    expect(table().updates[0]?.filters).toEqual([
      ["id", "et1"],
      ["org_id", "o1"],
      ["updated_at", STAMP],
    ]);
    expect(row()).toMatchObject({ buffer_before_min: 10, buffer_after_min: 10 });
    // The buffer rides in the cached slots payload, so the booker must rebuild.
    expect(markAllBucketSlotsStale).toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          event_type_id: "et1",
          from: { buffer_before_min: 0, buffer_after_min: 0 },
          to: { buffer_before_min: 10, buffer_after_min: 10 },
        }),
      }),
    );
  });

  it("accepts zero, which removes the gap", async () => {
    row().buffer_before_min = 10;
    row().buffer_after_min = 10;
    const fd = form({ event_type_id: "et1", gap_min: "0" });
    fd.set("loaded_buffer_before_min", loadedFieldValue(10));
    fd.set("loaded_buffer_after_min", loadedFieldValue(10));
    await setEventTypeGap(fd).catch(() => {});
    expect(row()).toMatchObject({ buffer_before_min: 0, buffer_after_min: 0 });
  });

  it.each(["", "abc", "-5", "7.5", "121"])("refuses %j without writing anything", async (gap) => {
    const to = await run({ event_type_id: "et1", gap_min: gap });
    expect(to).toContain("error=");
    expect(table().updates).toEqual([]);
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a request that names no event type", async () => {
    const to = await run({ gap_min: "10" });
    expect(to).toContain("error=");
    expect(table().updates).toEqual([]);
  });

  it("tells the admin when the write itself failed, and claims nothing", async () => {
    table().faults.update = { message: "connection lost" };
    const to = await run({ event_type_id: "et1", gap_min: "10" });
    expect(to).toContain("error=");
    expect(to).not.toContain("ok=");
    expect(recordAudit).not.toHaveBeenCalled();
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
  });

  it("tells the admin when the call type is not one of theirs", async () => {
    table().rows.push({ id: "someone-elses", org_id: "o2", buffer_before_min: 0, buffer_after_min: 0, updated_at: STAMP });
    const to = await run({ event_type_id: "someone-elses", gap_min: "10" });
    expect(to).toBe(`/admin/event-types${refusedQuery("That event type was not found.")}`);
    expect(table().updates).toEqual([]);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // #3122: another admin changed the GAP after this page was opened. Said as that,
  // and nothing is written, refreshed or audited.
  it("tells the admin somebody else changed the gap since they opened the page", async () => {
    table().writeElsewhere("et1", { buffer_before_min: 5, buffer_after_min: 5 });
    const to = await run({ event_type_id: "et1", gap_min: "10" });
    expect(to).toBe(`/admin/event-types${refusedQuery(CHANGED_SINCE_OPENED)}`);
    expect(row()).toMatchObject({ buffer_before_min: 5, buffer_after_min: 5 });
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // #3798: a save of the notice moved the row's stamp, which is no reason to refuse
  // a gap nobody else touched.
  it("saves the gap when only the notice changed since the page was opened", async () => {
    table().writeElsewhere("et1", { min_notice_min: 5 });
    const to = await run({ event_type_id: "et1", gap_min: "10" });
    expect(to).toBe("/admin/event-types?ok=event-type-gap");
    expect(row()).toMatchObject({ buffer_before_min: 10, buffer_after_min: 10, min_notice_min: 5 });
  });

  it("refuses a form that carried no loaded gap, before writing anything", async () => {
    const fd = form({ event_type_id: "et1", gap_min: "10" });
    fd.delete("loaded_buffer_after_min");
    let to = "";
    await setEventTypeGap(fd).catch((err: Error) => {
      to = err.message.replace("NEXT_REDIRECT:", "");
    });
    expect(to).toBe(`/admin/event-types${refusedQuery(PAGE_OUT_OF_DATE)}`);
    expect(table().updates).toEqual([]);
  });

  // A page drawn by the code before #3798 sends the record stamp and no field values.
  // Nothing says which gap that person was looking at, so the save is refused.
  it("refuses a form drawn before #3798, which sent only the record stamp", async () => {
    const fd = new FormData();
    fd.set("loaded_updated_at", STAMP);
    fd.set("event_type_id", "et1");
    fd.set("gap_min", "10");
    let to = "";
    await setEventTypeGap(fd).catch((err: Error) => {
      to = err.message.replace("NEXT_REDIRECT:", "");
    });
    expect(to).toBe(`/admin/event-types${refusedQuery(PAGE_OUT_OF_DATE)}`);
    expect(table().updates).toEqual([]);
  });
});

// The add form asks for the same one number, for the same reason: a buffer on one
// side alone still lets two calls touch.
describe("createEventType gap", () => {
  async function create(entries: Record<string, string>) {
    try {
      await createEventType(form(entries));
    } catch {
      // the redirect the mock throws
    }
    return table().inserted[0];
  }

  it("sets both buffers from the one gap field", async () => {
    const created = await create({ name: "Consult", gap_min: "10" });
    expect(created).toMatchObject({ buffer_before_min: 10, buffer_after_min: 10 });
  });

  it.each(["-5", "7.5", "9999", "abc"])("refuses a gap of %j and creates nothing", async (gap) => {
    let to = "";
    try {
      await createEventType(form({ name: "Consult", gap_min: gap }));
    } catch (err) {
      to = String((err as Error).message);
    }
    expect(to).toContain("error=");
    expect(table().inserted).toEqual([]);
  });

  it("records the gap it created with in the trail", async () => {
    await create({ name: "Consult", gap_min: "10" });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_type.created",
        details: expect.objectContaining({ buffer_before_min: 10, buffer_after_min: 10 }),
      }),
    );
  });

  it("leaves both at the column default when the gap is left blank", async () => {
    const created = await create({ name: "Consult" });
    expect(created).toMatchObject({ buffer_before_min: 0, buffer_after_min: 0 });
  });
});

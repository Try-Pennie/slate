import { describe, it, expect, vi, beforeEach } from "vitest";

// setEventTypeNotice: how far ahead of now the earliest offered time can be
// (#3003). It could only be set when an event type was created, so the live
// call type kept a 2 hour notice while cal.com let a lead book a few minutes
// out (Dan, 2026-10-02: "at least 5 minute in the future").
//
// The failure paths matter as much as the save. A redirect saying "saved" over a
// write that errored or matched nothing would leave leads unable to book the
// next hour while the admin believed it was open (L12).
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
import { setEventTypeNotice } from "./actions";
import { refusedQuery } from "@/lib/admin/save-outcomes";
import { CHANGED_SINCE_OPENED, PAGE_OUT_OF_DATE, loadedFieldValue } from "@/lib/admin/edit-version";

/** The version the row holds when each case starts. */
const STAMP = "2026-10-03T10:00:00.123456+00:00";

const table = () => db.table!;
const row = () => table().rows.find((r) => r.id === "et1")!;

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  // #3798: the notice the editor was drawn with; a case removes it to test the refusal.
  fd.set("loaded_min_notice_min", loadedFieldValue(120));
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
      buffer_before_min: 10,
      buffer_after_min: 10,
      min_notice_min: 120,
      updated_at: STAMP,
    },
  ]);
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

/** The action always ends in a redirect, which the mock throws. */
async function run(entries: Record<string, string>, fd = form(entries)): Promise<string> {
  try {
    await setEventTypeNotice(fd);
  } catch (err) {
    return String((err as Error).message).replace("NEXT_REDIRECT:", "");
  }
  throw new Error("the action returned without redirecting");
}

describe("setEventTypeNotice", () => {
  it("is admin only", async () => {
    auth.requireAdmin.mockRejectedValue(new Error("nope"));
    await expect(setEventTypeNotice(form({ event_type_id: "et1", min_notice_min: "5" }))).rejects.toThrow();
    expect(table().updates).toEqual([]);
  });

  it("sets the notice, scoped to the admin's org, and refreshes what the booker serves", async () => {
    const to = await run({ event_type_id: "et1", min_notice_min: "5" });
    expect(to).toBe("/admin/event-types?ok=event-type-notice");
    expect(table().updates[0]?.patch).toEqual({ min_notice_min: 5 });
    expect(table().updates[0]?.filters).toEqual([
      ["id", "et1"],
      ["org_id", "o1"],
      ["updated_at", STAMP],
    ]);
    expect(row().min_notice_min).toBe(5);
    // The cached slots were computed under the old notice, so a shorter one
    // offers nothing new near now until they rebuild.
    expect(markAllBucketSlotsStale).toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_type.notice",
        details: expect.objectContaining({
          event_type_id: "et1",
          from: { min_notice_min: 120 },
          to: { min_notice_min: 5 },
        }),
      }),
    );
  });

  it("accepts zero", async () => {
    await run({ event_type_id: "et1", min_notice_min: "0" });
    expect(row().min_notice_min).toBe(0);
  });

  it.each(["", "abc", "-5", "7.5", "1441"])("refuses %j without writing anything", async (notice) => {
    const to = await run({ event_type_id: "et1", min_notice_min: notice });
    expect(to).toContain("error=");
    expect(table().updates).toEqual([]);
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a request that names no event type", async () => {
    const to = await run({ min_notice_min: "5" });
    expect(to).toContain("error=");
    expect(table().updates).toEqual([]);
  });

  it("tells the admin when the write itself failed, and claims nothing", async () => {
    table().faults.update = { message: "connection lost" };
    const to = await run({ event_type_id: "et1", min_notice_min: "5" });
    expect(to).toContain("error=");
    expect(to).not.toContain("ok=");
    expect(recordAudit).not.toHaveBeenCalled();
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
  });

  it("tells the admin when the call type is not one of theirs", async () => {
    table().rows.push({ id: "someone-elses", org_id: "o2", min_notice_min: 120, updated_at: STAMP });
    const to = await run({ event_type_id: "someone-elses", min_notice_min: "5" });
    expect(to).toBe(`/admin/event-types${refusedQuery("That event type was not found.")}`);
    expect(table().updates).toEqual([]);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // #3122: another admin changed the NOTICE after this page was opened. Said as
  // that, and nothing is written, refreshed or audited.
  it("tells the admin somebody else changed the notice since they opened the page", async () => {
    table().writeElsewhere("et1", { min_notice_min: 30 });
    const to = await run({ event_type_id: "et1", min_notice_min: "5" });
    expect(to).toBe(`/admin/event-types${refusedQuery(CHANGED_SINCE_OPENED)}`);
    expect(row().min_notice_min).toBe(30);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // #3798: a save of the gap or the description moved the row's stamp, which is no
  // reason to refuse a notice nobody else touched.
  it("saves the notice when only the gap and the description changed since the page was opened", async () => {
    table().writeElsewhere("et1", { buffer_before_min: 15, buffer_after_min: 15 });
    table().writeElsewhere("et1", { description: "New copy" });
    const to = await run({ event_type_id: "et1", min_notice_min: "5" });
    expect(to).toBe("/admin/event-types?ok=event-type-notice");
    expect(row()).toMatchObject({ min_notice_min: 5, buffer_before_min: 15, description: "New copy" });
  });

  it("refuses a form that carried no loaded notice, before writing anything", async () => {
    const fd = form({ event_type_id: "et1", min_notice_min: "5" });
    fd.delete("loaded_min_notice_min");
    expect(await run({}, fd)).toBe(`/admin/event-types${refusedQuery(PAGE_OUT_OF_DATE)}`);
    expect(table().updates).toEqual([]);
  });

  it.each(["", "not json", "{}", "true"])("refuses a loaded notice of %j as out of date", async (raw) => {
    const fd = form({ event_type_id: "et1", min_notice_min: "5" });
    fd.set("loaded_min_notice_min", raw);
    expect(await run({}, fd)).toBe(`/admin/event-types${refusedQuery(PAGE_OUT_OF_DATE)}`);
    expect(table().updates).toEqual([]);
  });
});

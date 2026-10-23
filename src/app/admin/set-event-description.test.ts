import { describe, it, expect, vi, beforeEach } from "vitest";

// #1335: the setEventDescription admin action, which is what makes the copy a lead
// reads before booking editable without a deploy.
//
// The failure paths are the point here. A save that redirected to a cheerful "ok"
// having written nothing would leave the OLD copy in front of every lead while
// telling the author it had changed (L12), and there are two ways to write nothing:
// the update errors, or it matches no row because the id belongs to another org.
// Both are pinned, in both directions, along with the tenant scoping that makes the
// second case possible at all.
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
import { setEventDescription } from "./actions";
import { refusedQuery } from "@/lib/admin/save-outcomes";
import { CHANGED_SINCE_OPENED, PAGE_OUT_OF_DATE, loadedFieldValue } from "@/lib/admin/edit-version";

/** The version the row holds when each case starts. */
const STAMP = "2026-10-03T10:00:00.123456+00:00";

/** What the row held when the page was drawn: two paragraphs, so a line break is
 *  on the round trip the loaded value makes through the form. */
const LOADED_COPY = "Twenty minutes with a senior advisor.\n\nJoin from somewhere quiet.";

const table = () => db.table!;
const row = () => table().rows.find((r) => r.id === "et1")!;

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  // #3798: the description the editor was drawn with; a case removes it to test the refusal.
  fd.set("loaded_description", loadedFieldValue(LOADED_COPY));
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
      description: LOADED_COPY,
      buffer_before_min: 10,
      buffer_after_min: 10,
      min_notice_min: 120,
      updated_at: STAMP,
    },
  ]);
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

const DANS_COPY =
  "Twenty minutes with a senior advisor to confirm your income, then review the terms " +
  "and rates you may qualify for.\n\nA small ask: join from somewhere quiet, not while " +
  "driving, with access to a screen (phone, tablet, laptop, etc.).";

/** The action always ends in a redirect, which the mock throws. */
async function run(entries: Record<string, string>, fd = form(entries)): Promise<string> {
  try {
    await setEventDescription(fd);
  } catch (err) {
    return String((err as Error).message).replace("NEXT_REDIRECT:", "");
  }
  throw new Error("the action returned without redirecting");
}

describe("setEventDescription", () => {
  it("is admin only", async () => {
    auth.requireAdmin.mockRejectedValue(new Error("nope"));
    await expect(setEventDescription(form({ event_type_id: "et1", description: "x" }))).rejects.toThrow();
    expect(table().updates).toEqual([]);
  });

  it("saves the copy and scopes the write to the admin's own org", async () => {
    const to = await run({ event_type_id: "et1", description: DANS_COPY });
    // #1922: back to the page the form is on, not the dead /admin/settings.
    expect(to).toBe("/admin/booker-copy?ok=booker-copy");
    expect(table().updates[0]?.patch).toEqual({ description: DANS_COPY });
    // Both filters, or an admin could edit another org's copy by guessing an id.
    expect(table().updates[0]?.filters).toEqual([
      ["id", "et1"],
      ["org_id", "o1"],
      ["updated_at", STAMP],
    ]);
    expect(row().description).toBe(DANS_COPY);
    expect(recordAudit).toHaveBeenCalled();
    // The description rides in the cached slots payload, so the served copy is
    // converged now rather than only as rows age.
    expect(markAllBucketSlotsStale).toHaveBeenCalled();
  });

  it("clears the description when the field is left blank", async () => {
    await run({ event_type_id: "et1", description: "   \n " });
    // null, not "": an empty string would leave the booker rendering an empty panel.
    expect(row().description).toBeNull();
  });

  // A description that was never set is null, and the form must say null, not "",
  // or the first description ever written is refused as somebody else's change.
  it("saves over a description that was never set", async () => {
    row().description = null;
    const fd = form({ event_type_id: "et1", description: DANS_COPY });
    fd.set("loaded_description", loadedFieldValue(null));
    expect(await run({}, fd)).toBe("/admin/booker-copy?ok=booker-copy");
    expect(row().description).toBe(DANS_COPY);
  });

  it("refuses an over-long description without writing anything", async () => {
    const to = await run({ event_type_id: "et1", description: "x".repeat(5000) });
    expect(to).toContain("error=");
    expect(table().updates).toEqual([]);
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a request that names no event type", async () => {
    const to = await run({ description: DANS_COPY });
    expect(to).toContain("error=");
    expect(table().updates).toEqual([]);
  });

  // The failure path this test file exists for. A write that errored and still
  // redirected with a save outcome would tell the author their copy had changed while every
  // lead kept reading the old one.
  it("tells the author when the write itself failed, and claims nothing", async () => {
    table().faults.update = { message: "connection lost" };
    const to = await run({ event_type_id: "et1", description: DANS_COPY });
    expect(to).toContain("error=");
    expect(to).not.toContain("ok=");
    expect(recordAudit).not.toHaveBeenCalled();
    // And it does not invalidate every bucket over a save that did not happen.
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
  });

  // The other way to write nothing, which no error reports: the id matched no row
  // this org owns. Indistinguishable from success on the error field alone.
  it("tells the author when the save matched no row of theirs", async () => {
    table().rows.push({ id: "someone-elses", org_id: "o2", description: LOADED_COPY, updated_at: STAMP });
    const to = await run({ event_type_id: "someone-elses", description: DANS_COPY });
    expect(to).toBe(`/admin/booker-copy${refusedQuery("That event type was not found.")}`);
    expect(table().rows.find((r) => r.id === "someone-elses")?.description).toBe(LOADED_COPY);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // #3122: two admins editing the description at once. The second save would
  // overwrite the first, so it is refused and told so, not "not found".
  it("tells the author somebody else changed the description since they opened the page", async () => {
    table().writeElsewhere("et1", { description: "Somebody else's copy." });
    const to = await run({ event_type_id: "et1", description: DANS_COPY });
    expect(to).toBe(`/admin/booker-copy${refusedQuery(CHANGED_SINCE_OPENED)}`);
    expect(row().description).toBe("Somebody else's copy.");
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // #3798: the defect. A notice saved on the event types page moved the row's stamp,
  // and the description was refused and the typed text lost, though nobody had
  // touched the description.
  it("saves the description when only the notice changed since the page was opened", async () => {
    table().writeElsewhere("et1", { min_notice_min: 5 });
    expect(await run({ event_type_id: "et1", description: DANS_COPY })).toBe("/admin/booker-copy?ok=booker-copy");
    expect(row()).toMatchObject({ description: DANS_COPY, min_notice_min: 5 });
  });

  it("refuses a form that carried no loaded description, before writing anything", async () => {
    const fd = form({ event_type_id: "et1", description: DANS_COPY });
    fd.delete("loaded_description");
    expect(await run({}, fd)).toBe(`/admin/booker-copy${refusedQuery(PAGE_OUT_OF_DATE)}`);
    expect(table().updates).toEqual([]);
  });

  // Both directions, or an action wired to redirect to an error every time would
  // pass all three failure tests above (L1).
  it("still reports success on a save that really wrote a row", async () => {
    expect(await run({ event_type_id: "et1", description: DANS_COPY })).toBe(
      "/admin/booker-copy?ok=booker-copy",
    );
  });
});

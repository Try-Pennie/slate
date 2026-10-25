// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";

// #3798 (L776): three editors change one event type, each its own field. Gap and
// notice on /admin/event-types, the description on /admin/booker-copy. They used
// to send the ROW's `updated_at`, so a save of any one moved the stamp and every
// other open editor was refused as "someone saved a change here", over a field
// nobody had touched, and the typed text was lost on the redirect.
//
// Driven end to end: the REAL forms render what they submit, the REAL actions take
// it, and the store writes into an in-memory table whose `updated_at` moves on
// every write, as the trigger does. Judged by the row left behind.
const db = vi.hoisted(() => ({ table: null as FakeEventTypesTable | null }));
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => db.table!.client }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: vi.fn(async () => 3) }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { fakeEventTypesTable, type FakeEventTypesTable } from "../../../scripts/lib/fake-event-types-table";
import { setEventDescription, setEventTypeGap, setEventTypeNotice } from "./actions";
import { EventTypeGapForm } from "./event-types/EventTypeGapForm";
import { EventTypeNoticeForm } from "./event-types/EventTypeNoticeForm";
import { EventDescriptionForm } from "./booker-copy/EventDescriptionForm";
import { refusedQuery } from "@/lib/admin/save-outcomes";
import { CHANGED_SINCE_OPENED } from "@/lib/admin/edit-version";
import type { EventType } from "@/lib/db/types";

const OLD_COPY = "Twenty minutes with a senior advisor.\n\nJoin from somewhere quiet.";
const NEW_COPY = "Twenty minutes with a senior advisor to confirm your income.\n\nJoin from somewhere quiet.";

const ROW: EventType = {
  id: "et1",
  org_id: "o1",
  name: "Consultation",
  description: OLD_COPY,
  regal_type: "consult",
  duration_min: 20,
  buffer_before_min: 10,
  buffer_after_min: 10,
  min_notice_min: 120,
  daily_cap: null,
  slot_interval_min: 15,
  created_at: "2026-08-01T10:00:00.000000+00:00",
  updated_at: "2026-10-23T09:00:00.000000+00:00",
};

const row = () => db.table!.rows.find((r) => r.id === "et1")!;

/** The row as a page would draw it now: a snapshot, not a live reference. */
const drawn = () => ({ ...(row() as unknown as EventType) });

/**
 * Render one form, change the named fields as a person would, and return exactly
 * what it would submit. Unmounted straight away: the page is drawn, then saved
 * later, and nothing about the form may be read after that point.
 */
function submitted(ui: React.ReactElement, edits: Record<string, string>): FormData {
  const { container, unmount } = render(ui);
  const formEl = container.querySelector("form") as HTMLFormElement;
  for (const [name, value] of Object.entries(edits)) {
    const field = formEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
    if (!field) throw new Error(`the form has no field named ${name}`);
    field.value = value;
  }
  const fd = new FormData(formEl);
  unmount();
  return fd;
}

/** Where the action sent the person; every action ends in a redirect. */
async function save(action: (fd: FormData) => Promise<void>, fd: FormData): Promise<string> {
  try {
    await action(fd);
  } catch (err) {
    return String((err as Error).message).replace("NEXT_REDIRECT:", "");
  }
  throw new Error("the action returned without redirecting");
}

beforeEach(() => {
  vi.clearAllMocks();
  db.table = fakeEventTypesTable([{ ...ROW }]);
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});
afterEach(() => cleanup());

describe("event type editors judge a conflict by their own fields (#3798)", () => {
  it("saves the notice and the description from forms drawn before the gap was saved", async () => {
    // One admin opens both pages; all three forms are drawn from the same row.
    const first = drawn();
    const gap = submitted(<EventTypeGapForm eventType={first} />, { gap_min: "15" });
    const notice = submitted(<EventTypeNoticeForm eventType={first} />, { min_notice_min: "5" });
    const description = submitted(<EventDescriptionForm eventType={first} />, { description: NEW_COPY });

    expect(await save(setEventTypeGap, gap)).toBe("/admin/event-types?ok=event-type-gap");
    expect(row().updated_at).not.toBe(first.updated_at);

    // Neither of these touched the gap, so the gap's save is no conflict of theirs.
    expect(await save(setEventTypeNotice, notice)).toBe("/admin/event-types?ok=event-type-notice");
    expect(await save(setEventDescription, description)).toBe("/admin/booker-copy?ok=booker-copy");

    expect(row()).toMatchObject({
      buffer_before_min: 15,
      buffer_after_min: 15,
      min_notice_min: 5,
      description: NEW_COPY,
    });
  });

  it("saves the description when the row moved under it from somewhere else entirely", async () => {
    const first = drawn();
    const description = submitted(<EventDescriptionForm eventType={first} />, { description: NEW_COPY });
    db.table!.writeElsewhere("et1", { duration_min: 30 });

    expect(await save(setEventDescription, description)).toBe("/admin/booker-copy?ok=booker-copy");
    expect(row()).toMatchObject({ duration_min: 30, description: NEW_COPY });
  });

  // CONTROL: the refusal #3122 exists for still happens. Two notice editors drawn
  // from one row: the second save would overwrite the first, so it is refused and
  // the first value stays.
  it("CONTROL: refuses the second of two notice saves drawn from the same row", async () => {
    const first = drawn();
    const mine = submitted(<EventTypeNoticeForm eventType={first} />, { min_notice_min: "5" });
    const theirs = submitted(<EventTypeNoticeForm eventType={first} />, { min_notice_min: "30" });

    expect(await save(setEventTypeNotice, mine)).toBe("/admin/event-types?ok=event-type-notice");
    expect(await save(setEventTypeNotice, theirs)).toBe(`/admin/event-types${refusedQuery(CHANGED_SINCE_OPENED)}`);
    expect(row().min_notice_min).toBe(5);
  });

  it("CONTROL: refuses a description save over a description somebody else changed", async () => {
    const first = drawn();
    const mine = submitted(<EventDescriptionForm eventType={first} />, { description: NEW_COPY });
    db.table!.writeElsewhere("et1", { description: "Somebody else's copy." });

    expect(await save(setEventDescription, mine)).toBe(`/admin/booker-copy${refusedQuery(CHANGED_SINCE_OPENED)}`);
    expect(row().description).toBe("Somebody else's copy.");
  });
});

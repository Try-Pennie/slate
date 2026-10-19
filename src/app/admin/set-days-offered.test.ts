import { describe, it, expect, vi, beforeEach } from "vitest";

// #3922: the setDaysOffered admin action, which replaced setBookingHorizon (#216).
// The Days offered card saves two values with one button: how many open days every
// lead is offered, and the last resort's extra days, stored as the reach
// (`horizon_days` = offered + extra) so every existing reader of the horizon keeps
// working. Pinned: admin only; offered 1 to 7, extra 0 or more, the sum at most 7,
// each refusal naming the field by its label; a column scoped upsert on id=1; every
// precomputed row marked stale on a save (refresh on save, as before); an audit
// entry with what was saved. A refusal NEVER writes, refreshes or audits. Only
// DB/auth/audit/next and the invalidation helper are mocked.
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
const upsert = vi.hoisted(() =>
  vi.fn(async (_row: Record<string, unknown>, _opts: { onConflict: string }) => ({ error: null as { message: string } | null })),
);
const from = vi.hoisted(() => vi.fn(() => ({ upsert })));
const markAllBucketSlotsStale = vi.hoisted(() => vi.fn(async () => 3));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { setDaysOffered } from "./actions";
import { DAYS_OFFERED_SAVED, EXTRA_DAYS_LABEL, OFFERED_DAYS_LABEL } from "@/lib/admin/days-offered-copy";
import { SAVE_OUTCOME_COPY } from "@/lib/admin/save-outcomes";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

/** The reason a refusal redirected with, decoded. */
async function refusalOf(run: Promise<unknown>): Promise<string> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  const m = /error=([^&]*)/.exec(String(err));
  return m ? decodeURIComponent(m[1]!) : `(no refusal: ${String(err)})`;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

describe("setDaysOffered (#3922)", () => {
  it("rejects a non-admin caller and never writes or invalidates", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setDaysOffered(form({ offered_open_days: "3", last_resort_extra_days: "1" }))).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
  });

  it("saves both: the offered days, and the reach as offered plus extra (id=1 upsert), refreshes rows, audits, redirects ok", async () => {
    await expect(setDaysOffered(form({ offered_open_days: "4", last_resort_extra_days: "2" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/business-hours\?ok=days-offered/,
    );
    expect(upsert).toHaveBeenCalledTimes(1);
    const [row, opts] = upsert.mock.calls[0] as unknown as [Record<string, unknown>, { onConflict: string }];
    expect(row.id).toBe(1);
    expect(row.offered_open_days).toBe(4);
    // Every existing reader of the horizon keeps working: it is still the reach.
    expect(row.horizon_days).toBe(6);
    expect(row.updated_by).toBe("admin1");
    // Column-scoped: must NOT carry default_bucket_code or the kill switch.
    expect("default_bucket_code" in row).toBe(false);
    expect("public_booking_paused" in row).toBe(false);
    expect(opts.onConflict).toBe("id");
    expect(markAllBucketSlotsStale).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.settings",
        details: { offered_open_days: 4, last_resort_extra_days: 2, horizon_days: 6 },
      }),
    );
  });

  it("confirms the save in the card's own name", () => {
    expect(SAVE_OUTCOME_COPY["days-offered"]).toBe(DAYS_OFFERED_SAVED);
    expect(DAYS_OFFERED_SAVED).toBe("Days offered saved.");
  });

  // The dropdowns cannot produce these, so each is the server holding its own line
  // against a hand built post. Nothing is written, nothing refreshed, nothing audited.
  for (const [what, entries, names] of [
    ["offered below 1", { offered_open_days: "0", last_resort_extra_days: "1" }, [OFFERED_DAYS_LABEL]],
    ["offered above 7", { offered_open_days: "8", last_resort_extra_days: "0" }, [OFFERED_DAYS_LABEL]],
    ["a blank offered", { offered_open_days: "", last_resort_extra_days: "1" }, [OFFERED_DAYS_LABEL]],
    ["a negative extra", { offered_open_days: "3", last_resort_extra_days: "-1" }, [EXTRA_DAYS_LABEL]],
    ["a blank extra", { offered_open_days: "3", last_resort_extra_days: "" }, [EXTRA_DAYS_LABEL]],
    ["a sum above 7", { offered_open_days: "5", last_resort_extra_days: "3" }, [OFFERED_DAYS_LABEL, EXTRA_DAYS_LABEL]],
  ] as const) {
    it(`refuses ${what} on the page the form is on, naming the field, and writes nothing`, async () => {
      const reason = await refusalOf(setDaysOffered(form(entries)));
      for (const name of names) expect(reason.toLowerCase()).toContain(name.toLowerCase());
      const last = String(redirect.mock.calls.at(-1)?.[0]);
      expect(last).toMatch(/^\/admin\/business-hours\?error=/);
      expect(upsert).not.toHaveBeenCalled();
      expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });
  }

  // #2379: a refused write is said in the card's name, and neither audited nor
  // confirmed.
  it("refuses in the card's name when the database refuses the write", async () => {
    upsert.mockResolvedValueOnce({ error: { message: "permission denied" } });
    const reason = await refusalOf(setDaysOffered(form({ offered_open_days: "3", last_resort_extra_days: "1" })));
    expect(reason).toMatch(/^Days offered could not be saved/);
    expect(recordAudit).not.toHaveBeenCalled();
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
  });
});

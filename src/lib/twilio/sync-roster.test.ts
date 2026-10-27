import { describe, it, expect, vi } from "vitest";

// #4201: the placeholder advisor has no Twilio worker and is never bookable, so the
// Twilio roster read leaves it out. In the roster it would be reported every hour as
// a row with no worker and handed to the demotion planner as an advisor; the smoke
// test advisors stay, because the planner's own test exclusion is what keeps a real
// Twilio tag off them.

type Row = Record<string, unknown>;

const ROWS: Row[] = [
  { id: "u1", org_id: "org1", email: "a@x.com", bookable: true, deactivated_at: null, bookable_pending_since: null, is_test: false, is_placeholder: false, attributes: null },
  { id: "smoke", org_id: "org1", email: "smoke@x.com", bookable: true, deactivated_at: null, bookable_pending_since: null, is_test: true, is_placeholder: false, attributes: null },
  { id: "marcia", org_id: "org1", email: "marcia@x.com", bookable: false, deactivated_at: null, bookable_pending_since: null, is_test: false, is_placeholder: true, attributes: null },
];

const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/booking/settings", () => ({ readDemotionRerouteEnabled: async () => false }));
vi.mock("@/lib/booking/service", () => ({ startBulkReassign: vi.fn() }));
vi.mock("@/lib/booking/bulk-reassign-store", () => ({ demotionBookings: vi.fn(), rerouteCandidatesForAgent: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn() }));
vi.mock("@/lib/provision", () => ({ ensureDefaultOrg: async () => ({ id: "org1" }) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));

/** A `users` read that applies its own `.eq` filters to the rows, as PostgREST would. */
function fakeDb() {
  return {
    from: (table: string) => {
      expect(table).toBe("users");
      const filters: [string, unknown][] = [];
      const b = {
        select: () => b,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return b;
        },
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve({ data: ROWS.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null }).then(resolve),
      };
      return b;
    },
  };
}

import { defaultTwilioSyncDeps } from "@/lib/twilio/sync";

describe("the Twilio roster read (#4201)", () => {
  it("leaves the placeholder advisor out and keeps the smoke test advisor", async () => {
    admin.supabaseAdmin.mockReturnValue(fakeDb());
    const deps = await defaultTwilioSyncDeps("org1");
    const roster = await deps.loadRoster();
    expect(roster.map((r) => r.id)).toEqual(["u1", "smoke"]);
    expect(roster.find((r) => r.id === "smoke")?.isTest).toBe(true);
  });
});

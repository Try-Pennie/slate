import { describe, it, expect, vi, beforeEach } from "vitest";

// #4202: the live read of the placeholder advisor the coordinator's booking falls to.
// A failed read must THROW, never answer null: null is the "this team has no
// placeholder" refusal, which would then be told against a read that never ran.

let answer: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const filters: [string, unknown][] = [];

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    const chain = {
      select: () => chain,
      eq: (col: string, value: unknown) => {
        filters.push([col, value]);
        return chain;
      },
      maybeSingle: async () => answer,
    };
    return { from: () => chain };
  },
}));
// The booking service is not exercised here; its module graph is not loaded.
vi.mock("@/lib/booking/service", () => ({ realDeps: vi.fn(), pageBookingFailure: vi.fn() }));

import { findPlaceholderAdvisor } from "./placed-booking-service";

beforeEach(() => {
  answer = { data: null, error: null };
  filters.length = 0;
});

describe("findPlaceholderAdvisor (#4202)", () => {
  it("asks for the placeholder of this org in this world", async () => {
    answer = { data: { id: "p", is_placeholder: true, deactivated_at: null }, error: null };
    await expect(findPlaceholderAdvisor("org1", true)).resolves.toMatchObject({ id: "p" });
    expect(filters).toEqual([["org_id", "org1"], ["is_test", true], ["is_placeholder", true]]);
  });

  it("refuses a failed read rather than answering that there is no placeholder", async () => {
    answer = { data: null, error: { message: "canceling statement due to statement timeout" } };
    await expect(findPlaceholderAdvisor("org1", false)).rejects.toThrow(/statement timeout/);
  });

  it("answers null when the org has none", async () => {
    await expect(findPlaceholderAdvisor("org1", false)).resolves.toBeNull();
  });

  it("answers null for a placeholder that has been deactivated", async () => {
    answer = { data: { id: "p", is_placeholder: true, deactivated_at: "2026-10-01T00:00:00.000Z" }, error: null };
    await expect(findPlaceholderAdvisor("org1", false)).resolves.toBeNull();
  });
});

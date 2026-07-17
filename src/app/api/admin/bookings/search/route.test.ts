import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the booking lookup (#901). requireManager (the manager+ gate)
// and searchBookings are mocked so this exercises the glue: the 403 gate, the
// tenant-scoped call, the 200 shape, and the fail-loud 500 on a read fault.
const auth = vi.hoisted(() => ({
  requireManager: vi.fn(async () => ({ id: "mgr1", org_id: "org1" })),
}));
const search = vi.hoisted(() => ({ searchBookings: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/search", () => search);

import { GET } from "./route";
import { NotAuthorizedError } from "@/lib/auth/http";

function req(url: string) {
  return { nextUrl: new URL(url) } as Parameters<typeof GET>[0];
}

beforeEach(() => vi.clearAllMocks());

describe("GET /admin/bookings/search", () => {
  it("returns 403 when the caller is not a manager", async () => {
    auth.requireManager.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await GET(req("http://x/api/admin/bookings/search?q=jane"));
    expect(res.status).toBe(403);
    expect(search.searchBookings).not.toHaveBeenCalled();
  });

  it("searches within the caller's org and returns matches", async () => {
    const rows = [{ id: "b1", attendeeName: "Jane", agentName: "Jamie" }];
    search.searchBookings.mockResolvedValueOnce(rows);
    const res = await GET(req("http://x/api/admin/bookings/search?q=jane"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bookings: rows });
    expect(search.searchBookings).toHaveBeenCalledWith("org1", "jane");
  });

  it("passes an empty query through (searchBookings returns [])", async () => {
    search.searchBookings.mockResolvedValueOnce([]);
    const res = await GET(req("http://x/api/admin/bookings/search"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bookings: [] });
    expect(search.searchBookings).toHaveBeenCalledWith("org1", "");
  });

  it("returns 500 (not an empty 200) when the search throws", async () => {
    search.searchBookings.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req("http://x/api/admin/bookings/search?q=jane"));
    expect(res.status).toBe(500);
  });
});

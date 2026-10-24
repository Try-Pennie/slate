import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// HTTP wiring for the booking lookup (#901). requireManager (the manager+ gate)
// and searchBookings are mocked so this exercises the glue: the 403 gate, the
// tenant-scoped call, the 200 shape, and the fail-loud 500 on a read fault.
//
// #3399: the search term is a lead's email, name or phone, so it travels in the
// request BODY. Cloudflare records every request's full address, query string
// included, before this code runs, so a term in the address would sit in the
// Worker's logs whatever the route did with it. The old GET is refused by name.
const auth = vi.hoisted(() => ({
  requireManager: vi.fn(async () => ({ id: "mgr1", org_id: "org1" })),
}));
const search = vi.hoisted(() => ({ searchBookings: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/search", () => search);

import { GET, POST } from "./route";
import { NotAuthorizedError } from "@/lib/auth/http";

const URL_BASE = "https://slate.trypennie.app/api/admin/bookings/search";
const SAME_ORIGIN = {
  origin: "https://slate.trypennie.app",
  "sec-fetch-site": "same-origin",
  host: "slate.trypennie.app",
};

function post(body: unknown, headers: Record<string, string> = SAME_ORIGIN): NextRequest {
  return new NextRequest(URL_BASE, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /admin/bookings/search", () => {
  it("returns 403 when the caller is not a manager", async () => {
    auth.requireManager.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await POST(post({ q: "jane" }));
    expect(res.status).toBe(403);
    expect(search.searchBookings).not.toHaveBeenCalled();
  });

  it("searches within the caller's org on the term in the body", async () => {
    const rows = [{ id: "b1", attendeeName: "Jane", agentName: "Jamie" }];
    search.searchBookings.mockResolvedValueOnce({ rows, truncated: true });
    const res = await POST(post({ q: "jane" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bookings: rows, truncated: true });
    expect(search.searchBookings).toHaveBeenCalledWith("org1", "jane");
  });

  it("passes an empty term through (searchBookings returns no rows)", async () => {
    search.searchBookings.mockResolvedValueOnce({ rows: [], truncated: false });
    const res = await POST(post({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bookings: [], truncated: false });
    expect(search.searchBookings).toHaveBeenCalledWith("org1", "");
  });

  it("refuses a body that is not JSON with a 400, never an empty 200", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
    expect(search.searchBookings).not.toHaveBeenCalled();
  });

  it("refuses a request that says it came from another origin", async () => {
    const res = await POST(
      post({ q: "jane" }, { ...SAME_ORIGIN, origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
    expect(search.searchBookings).not.toHaveBeenCalled();
  });

  it("returns 500 (not an empty 200) when the search throws", async () => {
    search.searchBookings.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(post({ q: "jane" }));
    expect(res.status).toBe(500);
  });
});

describe("GET /admin/bookings/search (#3399)", () => {
  it("is refused by name, so a caller building the old address learns the rule", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/request body/i);
    expect(search.searchBookings).not.toHaveBeenCalled();
    expect(auth.requireManager).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the manager agent-list endpoint (#546), used by the reassign
// picker. Manager+ gated; returns the active agents the service resolves.
const auth = vi.hoisted(() => ({
  requireManager: vi.fn(async () => ({ org_id: "org1" })),
}));
const service = vi.hoisted(() => ({ listActiveAgents: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/service", () => service);

import { GET } from "./route";
import { NotAuthorizedError } from "@/lib/auth/http";

beforeEach(() => vi.clearAllMocks());

describe("GET /admin/agents", () => {
  it("is manager-gated and returns the active agents for the caller's org", async () => {
    service.listActiveAgents.mockResolvedValueOnce([
      { id: "1", name: "Amy", email: "amy@x.com", bookable: true },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).agents).toHaveLength(1);
    expect(auth.requireManager).toHaveBeenCalled();
    expect(service.listActiveAgents).toHaveBeenCalledWith("org1");
  });

  it("returns 403 when the caller is not manager+ (denial branch, #606)", async () => {
    auth.requireManager.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await GET();
    expect(res.status).toBe(403);
    expect(service.listActiveAgents).not.toHaveBeenCalled();
  });
});

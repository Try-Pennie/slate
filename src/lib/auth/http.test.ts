import { describe, it, expect } from "vitest";
import { NotAuthorizedError, forbiddenResponse } from "@/lib/auth/http";

// #606: a denied caller must get a clean 403, not a generic 500. forbiddenResponse
// is the single mapper the role-gated admin routes funnel their guard throw
// through; anything that isn't an authorization failure must still propagate
// (so a real server fault stays a 500).

describe("forbiddenResponse (#606)", () => {
  it("maps a NotAuthorizedError to a 403", async () => {
    const res = forbiddenResponse(new NotAuthorizedError());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Forbidden");
  });

  it("rethrows any other error (a real fault stays a 500)", () => {
    const boom = new Error("db exploded");
    expect(() => forbiddenResponse(boom)).toThrow(boom);
  });
});

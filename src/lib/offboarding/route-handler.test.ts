import { describe, it, expect, vi, beforeEach } from "vitest";

// Offboarding lifecycle endpoints. Focus: deactivating a user who doesn't exist
// in Slate is idempotent (the desired end state — not active — already holds),
// so it must return 200, NOT a 404 the caller treats as a failure. Reactivating
// a missing user IS a real error and stays 404. Service + env are mocked.

const env = vi.hoisted(() => ({ offboardingApiKey: vi.fn(() => "secret") }));
const svc = vi.hoisted(() => ({ applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/offboarding/service", () => svc);

import { makeLifecycleHandler } from "./route-handler";

function post(action: "deactivate" | "reactivate", body: unknown, auth = "Bearer secret") {
  const headers = new Headers({ "content-type": "application/json" });
  if (auth) headers.set("authorization", auth);
  return makeLifecycleHandler(action)(
    new Request("http://localhost/api/users/" + action, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }) as never,
  );
}

describe("offboarding lifecycle handler", () => {
  beforeEach(() => {
    env.offboardingApiKey.mockReturnValue("secret");
    svc.applyLifecycleByEmail.mockReset();
  });

  it("deactivating a non-existent user succeeds (200), not 404", async () => {
    svc.applyLifecycleByEmail.mockResolvedValue({ status: "not_found" });
    const res = await post("deactivate", { email: "gone@trypennie.com" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("not_found");
    expect(body.error).toBeUndefined();
  });

  it("reactivating a non-existent user is still a 404 error", async () => {
    svc.applyLifecycleByEmail.mockResolvedValue({ status: "not_found" });
    const res = await post("reactivate", { email: "gone@trypennie.com" });
    expect(res.status).toBe(404);
  });

  it("passes a successful deactivate through as 200", async () => {
    svc.applyLifecycleByEmail.mockResolvedValue({ status: "deactivated", userId: "u1" });
    const res = await post("deactivate", { email: "leaver@trypennie.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "deactivated", userId: "u1" });
  });

  it("requires a key (503) and rejects a bad one (401)", async () => {
    env.offboardingApiKey.mockReturnValue("");
    expect((await post("deactivate", { email: "x@y.com" })).status).toBe(503);
    env.offboardingApiKey.mockReturnValue("secret");
    expect((await post("deactivate", { email: "x@y.com" }, "Bearer wrong")).status).toBe(401);
  });
});

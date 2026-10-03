import { describe, it, expect, vi, beforeEach } from "vitest";

// Offboarding lifecycle endpoints. Focus: deactivating a user who doesn't exist
// in Slate is idempotent (the desired end state — not active — already holds),
// so it must return 200, NOT a 404 the caller treats as a failure. Reactivating
// a missing user IS a real error and stays 404. Service + env are mocked.

const env = vi.hoisted(() => ({ offboardingApiKey: vi.fn(() => "secret"), offboardingApiKey2: vi.fn(() => "") }));
const svc = vi.hoisted(() => ({ applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/offboarding/service", () => svc);

import { makeLifecycleHandler, makeLifecycleActionHandler } from "./route-handler";

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

function postAction(body: unknown, auth = "Bearer secret") {
  const headers = new Headers({ "content-type": "application/json" });
  if (auth) headers.set("authorization", auth);
  return makeLifecycleActionHandler()(
    new Request("http://localhost/api/users/lifecycle", {
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

// #282: one URL taking email + action (activate|deactivate), so the offboarding
// automation integrates against a single endpoint. Maps the API's activate word
// to the internal reactivate, and preserves the per-action not_found semantics
// (deactivate is idempotent -> 200; activate of a missing user -> 404).
describe("consolidated lifecycle action handler", () => {
  beforeEach(() => {
    env.offboardingApiKey.mockReturnValue("secret");
    svc.applyLifecycleByEmail.mockReset();
  });

  it("maps action 'activate' to a reactivate call", async () => {
    svc.applyLifecycleByEmail.mockResolvedValue({ status: "applied", userId: "u1", deactivate: false });
    const res = await postAction({ email: "rehire@trypennie.com", action: "activate" });
    expect(res.status).toBe(200);
    expect(svc.applyLifecycleByEmail).toHaveBeenCalledWith("rehire@trypennie.com", "reactivate");
  });

  it("maps action 'deactivate' to a deactivate call", async () => {
    svc.applyLifecycleByEmail.mockResolvedValue({ status: "applied", userId: "u1", deactivate: true });
    const res = await postAction({ email: "leaver@trypennie.com", action: "deactivate" });
    expect(res.status).toBe(200);
    expect(svc.applyLifecycleByEmail).toHaveBeenCalledWith("leaver@trypennie.com", "deactivate");
  });

  it("deactivating a non-existent user succeeds (200), activating one is 404", async () => {
    svc.applyLifecycleByEmail.mockResolvedValue({ status: "not_found" });
    expect((await postAction({ email: "gone@trypennie.com", action: "deactivate" })).status).toBe(200);
    expect((await postAction({ email: "gone@trypennie.com", action: "activate" })).status).toBe(404);
  });

  it("rejects a missing or unknown action with 400", async () => {
    expect((await postAction({ email: "x@y.com" })).status).toBe(400);
    expect((await postAction({ email: "x@y.com", action: "reactivate" })).status).toBe(400);
    expect((await postAction({ email: "x@y.com", action: "bookable" })).status).toBe(400);
    expect(svc.applyLifecycleByEmail).not.toHaveBeenCalled();
  });

  // #3116 (L738): a bracket lookup on a plain object finds inherited members, so
  // "constructor" resolved to Object and was passed on as a truthy action, which
  // the state machine then read as a reactivate.
  it("refuses an inherited property name as an action with 400", async () => {
    for (const action of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      const res = await postAction({ email: "x@y.com", action });
      expect(res.status, action).toBe(400);
    }
    expect(svc.applyLifecycleByEmail).not.toHaveBeenCalled();
  });

  it("requires an email (400)", async () => {
    expect((await postAction({ action: "deactivate" })).status).toBe(400);
  });

  it("requires a key (503) and rejects a bad one (401)", async () => {
    env.offboardingApiKey.mockReturnValue("");
    expect((await postAction({ email: "x@y.com", action: "deactivate" })).status).toBe(503);
    env.offboardingApiKey.mockReturnValue("secret");
    expect((await postAction({ email: "x@y.com", action: "deactivate" }, "Bearer wrong")).status).toBe(401);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// #281 route: Bearer-authed (BOOKABLE_API_KEY), email + boolean bookable. Maps
// the service result to HTTP: not_found -> 404, blocked -> 409, applied/noop ->
// 200. A non-boolean bookable is a 400 (never coerce "false" to truthy). Service
// + env are mocked.

const env = vi.hoisted(() => ({ bookableApiKey: vi.fn(() => "secret"), bookableApiKey2: vi.fn(() => "") }));
const svc = vi.hoisted(() => ({ applyBookableByEmail: vi.fn() }));
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/bookable/service", () => svc);

import { POST } from "./route";

function post(body: unknown, auth = "Bearer secret") {
  const headers = new Headers({ "content-type": "application/json" });
  if (auth) headers.set("authorization", auth);
  return POST(
    new Request("http://localhost/api/users/bookable", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }) as never,
  );
}

describe("POST /api/users/bookable", () => {
  beforeEach(() => {
    env.bookableApiKey.mockReturnValue("secret");
    svc.applyBookableByEmail.mockReset();
  });

  it("requires a key (503) and rejects a bad one (401)", async () => {
    env.bookableApiKey.mockReturnValue("");
    expect((await post({ email: "a@b.com", bookable: true })).status).toBe(503);
    env.bookableApiKey.mockReturnValue("secret");
    expect((await post({ email: "a@b.com", bookable: true }, "Bearer wrong")).status).toBe(401);
    expect(svc.applyBookableByEmail).not.toHaveBeenCalled();
  });

  it("requires an email (400) and a boolean bookable (400)", async () => {
    expect((await post({ bookable: true })).status).toBe(400);
    expect((await post({ email: "a@b.com" })).status).toBe(400);
    expect((await post({ email: "a@b.com", bookable: "true" })).status).toBe(400);
    expect(svc.applyBookableByEmail).not.toHaveBeenCalled();
  });

  it("passes email + boolean to the service and returns 200 on applied", async () => {
    svc.applyBookableByEmail.mockResolvedValue({ status: "applied", userId: "u1", bookable: true });
    const res = await post({ email: "agent@trypennie.com", bookable: true });
    expect(res.status).toBe(200);
    expect(svc.applyBookableByEmail).toHaveBeenCalledWith("agent@trypennie.com", true);
  });

  it("maps a not_found result to 404", async () => {
    svc.applyBookableByEmail.mockResolvedValue({ status: "not_found" });
    expect((await post({ email: "nobody@trypennie.com", bookable: true })).status).toBe(404);
  });

  it("maps a blocked (google unreachable) result to 409", async () => {
    svc.applyBookableByEmail.mockResolvedValue({ status: "blocked", userId: "u1", reason: "google_unreachable" });
    const res = await post({ email: "gone@trypennie.com", bookable: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: "blocked", reason: "google_unreachable" });
  });
});

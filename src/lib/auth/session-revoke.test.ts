import { describe, it, expect, vi, beforeEach } from "vitest";

// #2378: offboarding wrote the row and stopped there, so a departed manager kept
// a Supabase session that middleware refreshed on every request. This is the half
// that stops them minting a new one.
//
// Everything here is asserted against the ARGUMENTS the Supabase auth admin API
// is called with, not against a wrapper's own return value, because the value of
// this module is entirely in what it sends: a call with the wrong duration, or on
// the wrong key, would return exactly the same thing.

const admin = vi.hoisted(() => ({
  updateUserById: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ auth: { admin } }),
}));

import {
  revokeSupabaseSessions,
  restoreSupabaseSessions,
  SESSION_BAN_DURATIONS,
} from "./session-revoke";

const AUTH = "auth-abc";

beforeEach(() => {
  admin.updateUserById.mockReset();
  admin.updateUserById.mockResolvedValue({ data: { user: { id: AUTH } }, error: null });
});

describe("revoking Supabase session access (#2378)", () => {
  it("bans the auth user, keyed on auth_user_id", async () => {
    expect(await revokeSupabaseSessions(AUTH)).toBe("revoked");
    expect(admin.updateUserById).toHaveBeenCalledTimes(1);
    expect(admin.updateUserById).toHaveBeenCalledWith(AUTH, {
      ban_duration: SESSION_BAN_DURATIONS.revoke,
    });
  });

  it("uses a duration GoTrue reads as permanent, not a zero length one", async () => {
    await revokeSupabaseSessions(AUTH);
    const [, attrs] = admin.updateUserById.mock.calls[0] as [string, { ban_duration: string }];
    // A Go duration in hours. "0h" or "none" would be a ban that ends immediately,
    // which is the shape of this control shipping inert.
    expect(attrs.ban_duration).toMatch(/^\d+h$/);
    expect(Number(attrs.ban_duration.replace("h", ""))).toBeGreaterThan(24 * 365 * 10);
  });

  it("lifts the ban on a restore, by name rather than by waiting it out", async () => {
    expect(await restoreSupabaseSessions(AUTH)).toBe("restored");
    expect(admin.updateUserById).toHaveBeenCalledWith(AUTH, { ban_duration: "none" });
  });

  // Assume it runs twice. The row write and this call are two steps with no
  // transaction between them, so the caller runs this whenever the end state is
  // "deactivated" rather than only on the transition.
  it("is idempotent: a second revoke writes the same thing and does not throw", async () => {
    await revokeSupabaseSessions(AUTH);
    await revokeSupabaseSessions(AUTH);
    expect(admin.updateUserById).toHaveBeenCalledTimes(2);
    expect(admin.updateUserById.mock.calls[0]).toEqual(admin.updateUserById.mock.calls[1]);
  });

  it("does not call the auth API at all for somebody who never signed in", async () => {
    expect(await revokeSupabaseSessions(null)).toBe("no-auth-account");
    expect(await restoreSupabaseSessions(null)).toBe("no-auth-account");
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });
});

// THE FAILURE PATH. This is an external API reached on an offboarding path, so
// the interesting question is not what it does when it works. A swallowed error
// here reports that access was removed when it was not, which is the whole defect
// one layer along (L397).
describe("a refused auth admin call is raised, never swallowed (#2378)", () => {
  it("throws when the API returns an error, naming the auth user and the reason", async () => {
    admin.updateUserById.mockResolvedValue({
      data: { user: null },
      error: { message: "invalid API key" },
    });

    await expect(revokeSupabaseSessions(AUTH)).rejects.toThrow(/invalid API key/);
    await expect(revokeSupabaseSessions(AUTH)).rejects.toThrow(AUTH);
  });

  it("throws on a failed restore too", async () => {
    admin.updateUserById.mockResolvedValue({
      data: { user: null },
      error: { message: "service unavailable" },
    });

    await expect(restoreSupabaseSessions(AUTH)).rejects.toThrow(/service unavailable/);
  });

  it("lets a thrown transport failure through rather than turning it into a success", async () => {
    admin.updateUserById.mockRejectedValue(new TypeError("fetch failed"));

    await expect(revokeSupabaseSessions(AUTH)).rejects.toThrow(/fetch failed/);
  });

  // The control beside the three refusals (L159): the same call with the API
  // answering normally resolves, so they cannot be passing because this module
  // throws unconditionally.
  it("resolves when the API answers normally", async () => {
    admin.updateUserById.mockResolvedValue({ data: { user: { id: AUTH } }, error: null });
    await expect(revokeSupabaseSessions(AUTH)).resolves.toBe("revoked");
  });
});

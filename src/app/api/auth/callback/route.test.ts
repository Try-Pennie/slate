import { describe, it, expect, vi, beforeEach } from "vitest";

// #1648: provisioning REFUSES rather than degrading, and the refusal lands on a
// person signing in. What they see is the part a unit test on provisionUser
// cannot cover, and it has to be three things at once:
//
//   - not a raw error. A thrown provisionUser used to leave this handler, which
//     is a 500 page mid sign-in;
//   - not a silent new identity. The whole point of the refusal is that nobody is
//     signed in as a second row;
//   - not a live session either. The code exchange has already set the session
//     cookies by this point, so leaving them puts the person on an internal page
//     with no Slate row behind it, where every later request resolves the session
//     by auth_user_id and finds nothing. That reads as a broken app, not as a
//     sign-in that did not complete.
//
// The happy path is asserted in the same file, because a handler that redirected
// everyone to the error page would satisfy the refusal assertions on its own.

const provision = vi.hoisted(() => ({ provisionUser: vi.fn() }));
const google = vi.hoisted(() => ({ ensureWatches: vi.fn(async () => "ok") }));
const env = vi.hoisted(() => ({ googleHostedDomain: () => "trypennie.com" }));
const signOut = vi.hoisted(() => vi.fn(async () => {}));
const exchangeCodeForSession = vi.hoisted(() => vi.fn());
const server = vi.hoisted(() => ({
  supabaseServer: async () => ({ auth: { exchangeCodeForSession, signOut } }),
}));
const logged = vi.hoisted(() => ({ errors: [] as string[] }));
const logger = vi.hoisted(() => ({
  log: {
    info: () => {},
    warn: () => {},
    error: (tag: string, fields: Record<string, unknown>) => {
      logged.errors.push(`${tag} ${String(fields.msg)}`);
    },
  },
}));

vi.mock("@/lib/provision", () => provision);
vi.mock("@/lib/google/sync", () => google);
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/supabase/server", () => server);
vi.mock("@/lib/log", () => logger);

import { GET } from "./route";

const SESSION = {
  session: {
    user: {
      id: "auth-1",
      email: "agent@trypennie.com",
      user_metadata: { email_verified: true, full_name: "An Agent" },
    },
  },
};

// The handler reads only `req.nextUrl`, and a real NextRequest is not
// constructible outside a server runtime, so hand it the URL it asks for.
function request() {
  return {
    nextUrl: new URL("https://slate.trypennie.app/api/auth/callback?code=abc"),
  } as never;
}

beforeEach(() => {
  provision.provisionUser.mockReset();
  signOut.mockReset();
  logged.errors.length = 0;
  exchangeCodeForSession.mockResolvedValue({ data: SESSION, error: null });
});

describe("auth callback when provisioning refuses (#1648)", () => {
  it("sends the person back to sign in with a readable error, not a raw failure", async () => {
    provision.provisionUser.mockRejectedValue(
      new Error('read failed [user by email (first pass)]: canceling statement'),
    );

    const res = await GET(request());

    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("https://slate.trypennie.app/login?error=provision_failed");
    // The error page is keyed on a code the login page maps to plain copy, so no
    // part of the thrown message may travel to the browser.
    expect(location).not.toMatch(/read failed|canceling statement/);
  });

  it("clears the session the code exchange just set", async () => {
    provision.provisionUser.mockRejectedValue(new Error("refused"));

    await GET(request());

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("keeps the detail server-side rather than dropping it", async () => {
    provision.provisionUser.mockRejectedValue(new Error("refused"));

    await GET(request());

    expect(logged.errors).toEqual(["auth-callback provisioning refused"]);
  });

  it("never warms calendars for a sign-in it refused", async () => {
    provision.provisionUser.mockRejectedValue(new Error("refused"));

    await GET(request());

    expect(google.ensureWatches).not.toHaveBeenCalled();
  });

  it("still signs a normal login in, so the refusal is not the only outcome", async () => {
    provision.provisionUser.mockResolvedValue({
      id: "user-1",
      role: "agent",
      theme_preference: "system",
    });

    const res = await GET(request());

    expect(res.headers.get("location")).toBe("https://slate.trypennie.app/me");
    expect(signOut).not.toHaveBeenCalled();
    expect(logged.errors).toEqual([]);
  });
});

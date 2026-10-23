import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SESSION_IDLE_MS,
  SESSION_SEEN_COOKIE,
  SESSION_STARTED_COOKIE,
  SESSION_TIME_BOX_MS,
} from "@/lib/auth/session-age";

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
const env = vi.hoisted(() => ({ googleHostedDomain: vi.fn((): string => "trypennie.com") }));
const signOut = vi.hoisted(() => vi.fn(async (_opts?: unknown) => {}));
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

// #3526: the one alert this handler sends, for a sign in refused as a different
// Google account.
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
}));

vi.mock("@/lib/provision", () => provision);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/google/sync", () => google);
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/supabase/server", () => server);
vi.mock("@/lib/log", () => logger);

import { GET } from "./route";
import { ME_TABS } from "@/lib/me/nav";
import { GoogleAccountMismatchError } from "@/lib/auth/google-identity";

const SESSION = {
  session: {
    user: {
      id: "auth-1",
      email: "agent@trypennie.com",
      user_metadata: { email_verified: true, full_name: "An Agent" },
      identities: [{ provider: "google", identity_data: { sub: "sub-1" } }],
    },
  },
};

/** A session for one test, with its own identities and metadata (#3526). */
function sessionWithIdentities(
  identities: { provider: string; identity_data?: Record<string, unknown> }[],
  meta: Record<string, unknown> = {},
) {
  return {
    data: {
      session: {
        user: {
          ...SESSION.session.user,
          user_metadata: { ...SESSION.session.user.user_metadata, ...meta },
          identities,
        },
      },
    },
    error: null,
  };
}

// The handler reads only `req.nextUrl`, and a real NextRequest is not
// constructible outside a server runtime, so hand it the URL it asks for.
function request() {
  return {
    nextUrl: new URL("https://slate.trypennie.app/api/auth/callback?code=abc"),
  } as never;
}

beforeEach(() => {
  env.googleHostedDomain.mockReset();
  env.googleHostedDomain.mockReturnValue("trypennie.com");
  provision.provisionUser.mockReset();
  dispatch.sendThrottledAlert.mockReset();
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

    expect(res.headers.get("location")).toBe(
      `https://slate.trypennie.app${ME_TABS[0].href}`,
    );
    expect(signOut).not.toHaveBeenCalled();
    expect(logged.errors).toEqual([]);
  });
});

// #3083: the domain gate fails CLOSED, in both of the ways it used to fail open.
describe("auth callback domain gate (#3083)", () => {
  function sessionWith(meta: Record<string, unknown>, email = "agent@trypennie.com") {
    return {
      data: { session: { user: { id: "auth-1", email, user_metadata: meta, identities: SESSION.session.user.identities } } },
      error: null,
    };
  }

  it("refuses a sign-in whose email_verified claim is absent", async () => {
    exchangeCodeForSession.mockResolvedValue(sessionWith({ full_name: "An Agent" }));

    const res = await GET(request());

    expect(res.headers.get("location")).toBe(
      "https://slate.trypennie.app/login?error=domain_not_allowed",
    );
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(provision.provisionUser).not.toHaveBeenCalled();
  });

  it("refuses a claim that is anything other than true", async () => {
    for (const claim of [false, "true", 1, null]) {
      signOut.mockReset();
      exchangeCodeForSession.mockResolvedValue(sessionWith({ email_verified: claim }));
      const res = await GET(request());
      expect(res.headers.get("location"), String(claim)).toBe(
        "https://slate.trypennie.app/login?error=domain_not_allowed",
      );
    }
    expect(provision.provisionUser).not.toHaveBeenCalled();
  });

  it("refuses every sign-in when the domain is not configured, rather than allowing any", async () => {
    env.googleHostedDomain.mockImplementation(() => {
      throw new Error("GOOGLE_HOSTED_DOMAIN is not set");
    });

    const res = await GET(request());

    expect(res.headers.get("location")).toBe(
      "https://slate.trypennie.app/login?error=sign_in_unavailable",
    );
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(provision.provisionUser).not.toHaveBeenCalled();
    expect(logged.errors).toEqual(["auth-callback sign-in domain not configured"]);
  });

  it("still signs in a verified in-domain account", async () => {
    provision.provisionUser.mockResolvedValue({ id: "user-1", role: "agent", theme_preference: "system" });

    const res = await GET(request());

    expect(res.headers.get("location")).toBe(`https://slate.trypennie.app${ME_TABS[0].href}`);
    expect(provision.provisionUser).toHaveBeenCalledTimes(1);
  });
});

// #3526: a sign in whose Google account is not the one the Slate account was set
// up with is a different person on a reused address. Provisioning refuses it; this
// handler is where the person is told, the session goes, and somebody is alerted.
describe("auth callback when the Google account is not the one on record (#3526)", () => {
  const mismatch = () =>
    new GoogleAccountMismatchError({
      userId: "user-9",
      email: "agent@trypennie.com",
      reason: "different-account",
    });

  it("sends the person back to sign in with its own message, and clears the session", async () => {
    provision.provisionUser.mockRejectedValue(mismatch());
    // Not reset between tests in this file, so earlier sign ins have called it.
    google.ensureWatches.mockClear();

    const res = await GET(request());

    expect(res.headers.get("location")).toBe(
      "https://slate.trypennie.app/login?error=google_account_changed",
    );
    expect(signOut).toHaveBeenCalledTimes(1);
    // Only this sign in's session: a global sign out would also end the real
    // owner's sessions on an auth user GoTrue linked by address.
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(google.ensureWatches).not.toHaveBeenCalled();
    expect(res.cookies.get(SESSION_STARTED_COOKIE)).toBeUndefined();
  });

  it("alerts on the account's own key, naming the address", async () => {
    provision.provisionUser.mockRejectedValue(mismatch());

    await GET(request());

    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldownMs, text] = dispatch.sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe("sign_in_google_account_mismatch:user-9");
    expect(cooldownMs).toBeGreaterThan(0);
    expect(text).toContain("agent@trypennie.com");
  });

  it("still refuses and redirects when the alert itself cannot be sent", async () => {
    provision.provisionUser.mockRejectedValue(mismatch());
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));

    const res = await GET(request());

    expect(res.headers.get("location")).toBe(
      "https://slate.trypennie.app/login?error=google_account_changed",
    );
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(logged.errors).toContain("auth-callback different google account alert failed");
  });

  // `user_metadata` is writable by whoever holds the session and is not refreshed
  // when GoTrue links a second identity, so the account id comes from the Google
  // identities GoTrue keeps for the auth user, every one of them.
  it("takes the account id from the Google identities, never from user_metadata", async () => {
    provision.provisionUser.mockResolvedValue({ id: "user-1", role: "agent", theme_preference: "system" });
    exchangeCodeForSession.mockResolvedValue(
      sessionWithIdentities(
        [
          { provider: "google", identity_data: { sub: "ident-sub" } },
          { provider: "email", identity_data: { sub: "email-sub" } },
        ],
        { sub: "meta-sub", provider_id: "meta-sub" },
      ),
    );

    await GET(request());

    expect(provision.provisionUser).toHaveBeenCalledWith(
      expect.objectContaining({ googleSubs: ["ident-sub"] }),
    );
  });

  it("hands provisioning every Google identity, so two on one auth user can be refused", async () => {
    provision.provisionUser.mockResolvedValue({ id: "user-1", role: "agent", theme_preference: "system" });
    exchangeCodeForSession.mockResolvedValue(
      sessionWithIdentities([
        { provider: "google", identity_data: { sub: "sub-a" } },
        { provider: "google", identity_data: { sub: "sub-b" } },
      ]),
    );

    await GET(request());

    expect(provision.provisionUser).toHaveBeenCalledWith(
      expect.objectContaining({ googleSubs: ["sub-a", "sub-b"] }),
    );
  });

  it("refuses a session with no Google identity before provisioning anything", async () => {
    exchangeCodeForSession.mockResolvedValue(sessionWithIdentities([], { sub: "meta-sub" }));

    const res = await GET(request());

    expect(provision.provisionUser).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(res.headers.get("location")).toBe("https://slate.trypennie.app/login?error=sign_in_unavailable");
    expect(logged.errors).toContain("auth-callback sign in carried no google identity");
  });

  it("sends no such alert for any other refusal", async () => {
    provision.provisionUser.mockRejectedValue(new Error("refused"));

    await GET(request());

    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });
});

// #3084: the sign in is where the 30 day clock starts, so the callback stamps it, and
// stamps it only on a sign in it actually completed. A refused sign in carrying a fresh
// stamp would hand the next session on that browser a clock it never earned.
describe("auth callback session stamps (#3084)", () => {
  const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps the sign in time and the first use, both httpOnly, on a completed sign in", async () => {
    provision.provisionUser.mockResolvedValue({ id: "user-1", role: "agent", theme_preference: "system" });

    const res = await GET(request());

    for (const [name, maxAge] of [
      [SESSION_STARTED_COOKIE, SESSION_TIME_BOX_MS / 1000],
      [SESSION_SEEN_COOKIE, SESSION_IDLE_MS / 1000],
    ] as const) {
      const c = res.cookies.get(name);
      expect(c?.value, name).toBe(String(NOW));
      expect(c?.httpOnly, name).toBe(true);
      expect(c?.maxAge, name).toBe(maxAge);
    }
  });

  it("stamps nothing on a refused sign in", async () => {
    provision.provisionUser.mockRejectedValue(new Error("refused"));

    const res = await GET(request());

    expect(res.cookies.get(SESSION_STARTED_COOKIE)).toBeUndefined();
    expect(res.cookies.get(SESSION_SEEN_COOKIE)).toBeUndefined();
  });
});

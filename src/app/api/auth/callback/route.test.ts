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

const provision = vi.hoisted(() => ({ provisionUser: vi.fn(), linkCoordinator: vi.fn() }));
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
import { GoogleAccountMismatchError, SeveralGoogleAccountsError } from "@/lib/auth/google-identity";
import { SEVERAL_GOOGLE_ACCOUNTS_LOGIN_ERROR } from "@/lib/auth/google-identity-copy";
import { PlaceholderAccountError } from "@/lib/auth/active-session";
import { PLACEHOLDER_ACCOUNT_LOGIN_ERROR } from "@/lib/auth/landing";
import { DeactivatedAccountError } from "@/lib/auth/active-session";
import {
  CoordinatorNotInvitedError,
  MICROSOFT_ACCOUNT_CHANGED_LOGIN_ERROR,
  MICROSOFT_NOT_INVITED_LOGIN_ERROR,
  MicrosoftAccountMismatchError,
} from "@/lib/auth/microsoft-identity";
import { LAST_SIGN_IN_PAGE_COOKIE, LAST_SIGN_IN_PAGE_MAX_AGE_S, SIGN_IN_FROM_COOKIE } from "@/lib/auth/sign-in-page";

/** The partner sign in page, where a refused Microsoft sign in lands (#4379). */
const PARTNER_PAGE = "https://slate.trypennie.app/partner/sign-in";

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

// The handler reads only `req.nextUrl` and `req.cookies`, and a real NextRequest is
// not constructible outside a server runtime, so hand it the URL and cookies it asks for.
function request(opts: { url?: string; cookies?: Record<string, string> } = {}) {
  const cookies = opts.cookies ?? {};
  return {
    nextUrl: new URL(opts.url ?? "https://slate.trypennie.app/api/auth/callback?code=abc"),
    cookies: {
      get: (name: string) => (Object.hasOwn(cookies, name) ? { name, value: cookies[name] } : undefined),
    },
  } as never;
}

beforeEach(() => {
  env.googleHostedDomain.mockReset();
  env.googleHostedDomain.mockReturnValue("trypennie.com");
  provision.provisionUser.mockReset();
  provision.linkCoordinator.mockReset();
  google.ensureWatches.mockClear();
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

  // Two Google accounts on one sign in can never succeed by trying again, so the
  // person is told so in its own words, whether or not a Slate account exists yet.
  it("tells a sign in with two Google accounts and no account yet its own message, not a retry", async () => {
    provision.provisionUser.mockRejectedValue(new SeveralGoogleAccountsError());

    const res = await GET(request());

    expect(res.headers.get("location")).toBe(
      `https://slate.trypennie.app/login?error=${SEVERAL_GOOGLE_ACCOUNTS_LOGIN_ERROR}`,
    );
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(logged.errors).toContain("auth-callback refused several google accounts on a new sign in");
  });

  // On an existing account it is the takeover shape, so Pennie is still alerted on
  // that account's key, and the person still gets the two accounts message.
  it("alerts on an existing account refused for two Google accounts, with the same message", async () => {
    provision.provisionUser.mockRejectedValue(
      new GoogleAccountMismatchError({ userId: "user-9", email: "agent@trypennie.com", reason: "several-accounts" }),
    );

    const res = await GET(request());

    expect(res.headers.get("location")).toBe(
      `https://slate.trypennie.app/login?error=${SEVERAL_GOOGLE_ACCOUNTS_LOGIN_ERROR}`,
    );
    expect(dispatch.sendThrottledAlert.mock.calls[0]?.[0]).toBe("sign_in_google_account_mismatch:user-9");
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

// #4205: a scheduling coordinator lands on their one page, and nobody signs in as the
// placeholder advisor. Each beside the ordinary sign in it differs from (L159).
describe("auth callback for a coordinator, and for the placeholder advisor (#4205)", () => {
  it("lands a coordinator on the coordinator page, never their own pages or the console", async () => {
    provision.provisionUser.mockResolvedValue({ id: "coord-1", role: "coordinator", theme_preference: "system" });
    const res = await GET(request());
    expect(res.headers.get("location")).toBe("https://slate.trypennie.app/coordinator");

    provision.provisionUser.mockResolvedValue({ id: "user-1", role: "agent", theme_preference: "system" });
    expect((await GET(request())).headers.get("location")).toBe(`https://slate.trypennie.app${ME_TABS[0].href}`);
  });

  it("refuses a sign in on the placeholder advisor's address, ends the session, and says it plainly", async () => {
    provision.provisionUser.mockRejectedValue(new PlaceholderAccountError());
    google.ensureWatches.mockClear();
    const res = await GET(request());
    expect(res.headers.get("location")).toBe(
      `https://slate.trypennie.app/login?error=${PLACEHOLDER_ACCOUNT_LOGIN_ERROR}`,
    );
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(google.ensureWatches).not.toHaveBeenCalled();
  });
});

// #4379: an invited coordinator signs in with their own company Microsoft account. The
// exchange is routed by the identities GoTrue keeps on the auth user (never by anything
// the browser sent), a Microsoft sign in only ever LINKS an existing coordinator row,
// and a refused one leaves no session behind. Each refusal sits beside the same sign in
// admitted (L159).
describe("auth callback for a coordinator's Microsoft sign in (#4379)", () => {
  const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);
  const COORD_EMAIL = "dana.coordinator@partner.example";

  function microsoftSession(
    over: { email?: string; meta?: Record<string, unknown>; identities?: { provider: string; identity_data?: Record<string, unknown> }[] } = {},
  ) {
    return {
      data: {
        session: {
          user: {
            id: "auth-ms-1",
            email: over.email ?? COORD_EMAIL,
            user_metadata: { email_verified: true, full_name: "Dana Coordinator", ...over.meta },
            identities: over.identities ?? [{ provider: "azure", identity_data: { sub: "ms-sub-1" } }],
          },
        },
      },
      error: null,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    exchangeCodeForSession.mockResolvedValue(microsoftSession());
    provision.linkCoordinator.mockResolvedValue({ id: "coord-1", role: "coordinator", theme_preference: "dark" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("links the coordinator and lands them on the coordinator page with the same stamps as Google", async () => {
    const res = await GET(request());

    expect(provision.linkCoordinator).toHaveBeenCalledWith({
      authUserId: "auth-ms-1",
      email: COORD_EMAIL,
      microsoftSub: "ms-sub-1",
    });
    expect(provision.provisionUser).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("https://slate.trypennie.app/coordinator");
    expect(signOut).not.toHaveBeenCalled();
    for (const name of [SESSION_STARTED_COOKIE, SESSION_SEEN_COOKIE]) {
      expect(res.cookies.get(name)?.value, name).toBe(String(NOW));
      expect(res.cookies.get(name)?.httpOnly, name).toBe(true);
    }
    expect(res.cookies.get("slate-theme")?.value).toBe("dark");
    // A coordinator's calendar is not Pennie's to read: nothing is warmed for them.
    expect(google.ensureWatches).not.toHaveBeenCalled();
  });

  it("refuses a trypennie.com address through Microsoft, ending only this session", async () => {
    exchangeCodeForSession.mockResolvedValue(microsoftSession({ email: "someone@trypennie.com" }));

    const res = await GET(request());

    // Back on the partner page, whose button they pressed, which points them at /login.
    expect(res.headers.get("location")).toBe(`${PARTNER_PAGE}?error=domain_not_allowed`);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(provision.linkCoordinator).not.toHaveBeenCalled();
    expect(res.cookies.get(SESSION_STARTED_COOKIE)).toBeUndefined();
  });

  it("refuses an address Microsoft has not verified, before anything is linked", async () => {
    for (const claim of [undefined, false, "true"]) {
      signOut.mockReset();
      exchangeCodeForSession.mockResolvedValue(microsoftSession({ meta: { email_verified: claim } }));
      const res = await GET(request());
      expect(res.headers.get("location"), String(claim)).toBe(`${PARTNER_PAGE}?error=sign_in_unavailable`);
      expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    }
    expect(provision.linkCoordinator).not.toHaveBeenCalled();
    expect(logged.errors).toContain("auth-callback microsoft sign in carried an unverified address");
  });

  it("refuses every Microsoft sign in when the company domain is not configured", async () => {
    env.googleHostedDomain.mockImplementation(() => {
      throw new Error("GOOGLE_HOSTED_DOMAIN is not set");
    });
    const res = await GET(request());
    expect(res.headers.get("location")).toBe(`${PARTNER_PAGE}?error=sign_in_unavailable`);
    expect(provision.linkCoordinator).not.toHaveBeenCalled();
  });

  it("refuses an auth user holding a Google and a Microsoft account, whichever it signed in with", async () => {
    for (const email of ["someone@trypennie.com", COORD_EMAIL]) {
      signOut.mockReset();
      exchangeCodeForSession.mockResolvedValue(
        microsoftSession({
          email,
          identities: [
            { provider: "google", identity_data: { sub: "g-1" } },
            { provider: "azure", identity_data: { sub: "ms-sub-1" } },
          ],
        }),
      );
      const res = await GET(request());
      expect(res.headers.get("location"), email).toBe("https://slate.trypennie.app/login?error=sign_in_unavailable");
      expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    }
    expect(provision.linkCoordinator).not.toHaveBeenCalled();
    expect(provision.provisionUser).not.toHaveBeenCalled();
    expect(logged.errors).toContain("auth-callback sign in carried both a google and a microsoft account");
  });

  it("sends that refusal back to the partner page when the sign in started there", async () => {
    // The identities cannot say which button was pressed, so the page's own mark decides.
    exchangeCodeForSession.mockResolvedValue(
      microsoftSession({
        identities: [
          { provider: "google", identity_data: { sub: "g-1" } },
          { provider: "azure", identity_data: { sub: "ms-sub-1" } },
        ],
      }),
    );
    const res = await GET(request({ cookies: { [SIGN_IN_FROM_COOKIE]: "partner" } }));
    expect(res.headers.get("location")).toBe(`${PARTNER_PAGE}?error=sign_in_unavailable`);
  });

  it("refuses two Microsoft accounts on one sign in", async () => {
    exchangeCodeForSession.mockResolvedValue(
      microsoftSession({
        identities: [
          { provider: "azure", identity_data: { sub: "ms-a" } },
          { provider: "azure", identity_data: { sub: "ms-b" } },
        ],
      }),
    );
    const res = await GET(request());
    expect(res.headers.get("location")).toBe(`${PARTNER_PAGE}?error=sign_in_unavailable`);
    expect(provision.linkCoordinator).not.toHaveBeenCalled();
  });

  // Each settled refusal gets its own message, and none leaves a session behind.
  it.each([
    ["an address nobody invited", new CoordinatorNotInvitedError(), MICROSOFT_NOT_INVITED_LOGIN_ERROR],
    ["a removed coordinator", new DeactivatedAccountError(), "account_deactivated"],
    ["the placeholder advisor's address", new PlaceholderAccountError(), PLACEHOLDER_ACCOUNT_LOGIN_ERROR],
    [
      "a different Microsoft account",
      new MicrosoftAccountMismatchError({ userId: "coord-1", why: "a different Microsoft account" }),
      MICROSOFT_ACCOUNT_CHANGED_LOGIN_ERROR,
    ],
    ["a link that could not be written", new Error("read failed [link coordinator]: timeout"), "provision_failed"],
  ])("refuses %s, ends this session, and says so in its own words", async (_what, err, code) => {
    provision.linkCoordinator.mockRejectedValue(err);
    const res = await GET(request());
    // On the partner page, never /login: the staff page's only button is Google.
    expect(res.headers.get("location")).toBe(`${PARTNER_PAGE}?error=${code}`);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(res.cookies.get(SESSION_STARTED_COOKIE)).toBeUndefined();
    expect(res.headers.get("location")).not.toMatch(/timeout|read failed/);
  });

  it("still routes a Google sign in to provisioning, never to the coordinator link", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: SESSION, error: null });
    provision.provisionUser.mockResolvedValue({ id: "user-1", role: "agent", theme_preference: "system" });
    await GET(request());
    expect(provision.provisionUser).toHaveBeenCalledTimes(1);
    expect(provision.linkCoordinator).not.toHaveBeenCalled();
  });

  it("keeps a Google refusal on /login even if the partner page's mark is still set", async () => {
    // The identities are what decide once the exchange has run; the mark never overrules them.
    exchangeCodeForSession.mockResolvedValue({ data: SESSION, error: null });
    provision.provisionUser.mockRejectedValue(new DeactivatedAccountError());
    const res = await GET(request({ cookies: { [SIGN_IN_FROM_COOKIE]: "partner" } }));
    expect(res.headers.get("location")).toBe("https://slate.trypennie.app/login?error=account_deactivated");
  });
});

// #4379: before the exchange nothing says which provider this was, so a hand off that came back
// with no code (Microsoft refused it, or the person cancelled) or would not exchange goes back to
// the page its button was on, read from the mark that page set.
describe("auth callback before it knows the provider (#4379)", () => {
  it.each([
    ["no code", "https://slate.trypennie.app/api/auth/callback?error=access_denied", "missing_code"],
    ["a code that would not exchange", undefined, "exchange_failed"],
  ])("sends %s from the partner page back there", async (_what, url, code) => {
    exchangeCodeForSession.mockResolvedValue({ data: { session: null }, error: { message: "bad code" } });
    const res = await GET(request({ url, cookies: { [SIGN_IN_FROM_COOKIE]: "partner" } }));
    expect(res.headers.get("location")).toBe(`${PARTNER_PAGE}?error=${code}`);
  });

  it.each([
    ["no mark at all", {}],
    ["a mark that is not exactly partner", { [SIGN_IN_FROM_COOKIE]: "https://evil.example" }],
  ])("sends them to /login with %s", async (_what, cookies) => {
    exchangeCodeForSession.mockResolvedValue({ data: { session: null }, error: { message: "bad code" } });
    const noCode = await GET(request({ url: "https://slate.trypennie.app/api/auth/callback", cookies }));
    expect(noCode.headers.get("location")).toBe("https://slate.trypennie.app/login?error=missing_code");
    const failed = await GET(request({ cookies }));
    expect(failed.headers.get("location")).toBe("https://slate.trypennie.app/login?error=exchange_failed");
  });
});

// #4398: a signed out or aged out coordinator was sent to /login, whose only button is Google.
// The browser now records which sign in page its last SUCCESSFUL sign in belongs to, written
// here and only on a completed sign in: partner for a coordinator's Microsoft sign in, cleared
// by a Google one. A refusal leaves it as it was, because it records success, not attempts.
describe("auth callback records which sign in page this browser last succeeded on (#4398)", () => {
  const microsoftCoordinator = {
    data: {
      session: {
        user: {
          id: "auth-ms-1",
          email: "dana.coordinator@partner.example",
          user_metadata: { email_verified: true, full_name: "Dana Coordinator" },
          identities: [{ provider: "azure", identity_data: { sub: "ms-sub-1" } }],
        },
      },
    },
    error: null,
  };

  it("records partner for a coordinator's Microsoft sign in, server only, outlasting the session", async () => {
    exchangeCodeForSession.mockResolvedValue(microsoftCoordinator);
    provision.linkCoordinator.mockResolvedValue({ id: "coord-1", role: "coordinator", theme_preference: "system" });

    const res = await GET(request());

    expect(res.headers.get("location")).toBe("https://slate.trypennie.app/coordinator");
    const c = res.cookies.get(LAST_SIGN_IN_PAGE_COOKIE);
    expect(c?.value).toBe("partner");
    expect(c?.httpOnly).toBe(true);
    expect(c?.path).toBe("/");
    expect(c?.sameSite).toBe("lax");
    expect(c?.maxAge).toBe(LAST_SIGN_IN_PAGE_MAX_AGE_S);
    expect(c?.maxAge).toBeGreaterThan(SESSION_TIME_BOX_MS / 1000);
  });

  it.each([
    ["an advisor", "agent"],
    ["an admin", "admin"],
    ["a coordinator on a Pennie Google account", "coordinator"],
  ])("clears it when %s signs in with Google", async (_who, role) => {
    provision.provisionUser.mockResolvedValue({ id: "user-1", role, theme_preference: "system" });

    const res = await GET(request({ cookies: { [LAST_SIGN_IN_PAGE_COOKIE]: "partner" } }));

    const c = res.cookies.get(LAST_SIGN_IN_PAGE_COOKIE);
    expect(c?.value).toBe("");
    expect(c?.maxAge).toBe(0);
    expect(c?.path).toBe("/");
    // Next re-reads a route handler's Set-Cookie and drops a Max-Age of 0 (measured in the
    // browser check), so the header that removes it must carry a past Expires as well.
    const header = res.headers.getSetCookie().find((h) => h.startsWith(`${LAST_SIGN_IN_PAGE_COOKIE}=`)) ?? "";
    expect(header).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  });

  it("leaves it alone on a refused sign in, either way", async () => {
    provision.provisionUser.mockRejectedValue(new DeactivatedAccountError());
    expect((await GET(request())).cookies.get(LAST_SIGN_IN_PAGE_COOKIE)).toBeUndefined();

    exchangeCodeForSession.mockResolvedValue(microsoftCoordinator);
    provision.linkCoordinator.mockRejectedValue(new CoordinatorNotInvitedError());
    expect((await GET(request())).cookies.get(LAST_SIGN_IN_PAGE_COOKIE)).toBeUndefined();

    exchangeCodeForSession.mockResolvedValue({ data: { session: null }, error: { message: "bad code" } });
    expect((await GET(request())).cookies.get(LAST_SIGN_IN_PAGE_COOKIE)).toBeUndefined();
  });
});

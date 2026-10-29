// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

// #592: the middleware runs on /admin, /me, /login (its matcher) and must stamp
// the clickjacking + hardening headers onto their responses. Supabase + env are
// mocked so this exercises only the header wiring, not the session refresh.
// A spy rather than a plain function: #2565 needs to assert that the booker does
// NOT pay the session refresh, which is a statement about whether this was CALLED.
type CookieSetter = (toSet: { name: string; value: string; options: Record<string, unknown> }[]) => void;
const signOut = vi.hoisted(() => vi.fn(async (): Promise<{ error: null }> => ({ error: null })));
const ssr = vi.hoisted(() => ({
  createServerClient: vi.fn((_url: string, _key: string, _opts: { cookies: { setAll: CookieSetter } }) => ({
    auth: { getUser: async () => ({ data: { user: null } }), signOut },
  })),
}));
vi.mock("@supabase/ssr", () => ssr);
// #3137: the frame lock switch and the framing record, both database backed, stubbed so
// these drive only what the middleware does with them.
const frameGuard = vi.hoisted(() => ({
  readFrameLock: vi.fn(async () => false),
  recordFramingObservation: vi.fn((_obs: { origin: string; surface: string }, _defer: (work: Promise<unknown>) => void) => {}),
}));
vi.mock("@/lib/embed/frame-guard", () => frameGuard);
vi.mock("@/lib/env", () => ({
  publicSupabaseUrl: () => "https://project.supabase.co",
  publicSupabasePublishableKey: () => "sb_publishable_test",
}));

import { NextRequest } from "next/server";
import { afterEach, beforeEach } from "vitest";
import {
  SESSION_IDLE_MS,
  SESSION_SEEN_COOKIE,
  SESSION_STARTED_COOKIE,
  SESSION_TIME_BOX_MS,
} from "@/lib/auth/session-age";
import { frameAncestorSources } from "@/lib/embed/frame-policy";
import { middleware } from "@/middleware";
import { SECURITY_HEADERS } from "@/lib/security-headers";

describe("middleware security headers (#592)", () => {
  it("stamps every security header onto a staff-page response", async () => {
    const res = await middleware(new NextRequest("https://slate.test/admin"));
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
  });

  it("denies framing (clickjacking) via both the modern and legacy header", async () => {
    const res = await middleware(new NextRequest("https://slate.test/login"));
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

/**
 * #2575: the script policy, ENFORCED, on the lead pages and the staff paths.
 * These drive the middleware itself rather than asserting on a constant, because
 * the things that can go wrong here (breaking the embed, Next never seeing a
 * nonce, a staff page losing its framing rule) are all properties of what it SETS.
 */
const LEAD_PAGES = ["/book", "/book?xbc=411", "/booking/manage/tok-abc"];
const STAFF_PAGES = ["/admin", "/admin/agents", "/me", "/me/time-off", "/login"];

const nonceOf = (policy: string | null) => /'nonce-([^']+)'/.exec(policy ?? "")?.[1];
const directive = (policy: string | null, name: string) =>
  (policy ?? "")
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));

describe("the enforced script policy (#2575)", () => {
  it.each([...LEAD_PAGES, ...STAFF_PAGES])("enforces script-src with this request's nonce on %s", async (path) => {
    const res = await middleware(new NextRequest(`https://slate.test${path}`));
    const policy = res.headers.get("content-security-policy");
    expect(directive(policy, "script-src")).toContain("'strict-dynamic'");
    expect(nonceOf(policy)).toBeTruthy();
    // One header, not two. A report only copy beside it would be a second policy
    // reporting a different nonce's worth of noise.
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    expect(res.headers.get("reporting-endpoints")).toContain("/api/csp-report");
  });

  it.each([...LEAD_PAGES, ...STAFF_PAGES])("hands Next the SAME enforcing policy on %s, so it nonces its scripts", async (path) => {
    // Next reads the nonce from the REQUEST's content-security-policy while
    // rendering. A request header that differed from the response header would
    // nonce the scripts with a value the browser then refuses: a blank page.
    const res = await middleware(new NextRequest(`https://slate.test${path}`));
    const sent = res.headers.get("x-middleware-request-content-security-policy");
    expect(sent).toBe(res.headers.get("content-security-policy"));
    expect(res.headers.get("x-middleware-request-content-security-policy-report-only")).toBeNull();
  });

  it.each(LEAD_PAGES)("gives %s no frame-ancestors, so the embed keeps working", async (path) => {
    const res = await middleware(new NextRequest(`https://slate.test${path}`));
    expect(res.headers.get("content-security-policy")).not.toContain("frame-ancestors");
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("lets only Slate's own pages frame the demo booker (#3718, Dan 2026-10-15)", async () => {
    // The demo pieces page frames /demo through the real widget.js; no other site may.
    const res = await middleware(new NextRequest("https://slate.test/demo"));
    expect(directive(res.headers.get("content-security-policy"), "frame-ancestors")).toBe("frame-ancestors 'self'");
    // The legacy header says the same, for a browser that reads only that one.
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    // Only the demo booker itself: any other page under /demo keeps the default refusal.
    const other = await middleware(new NextRequest("https://slate.test/demo-anything"));
    expect(directive(other.headers.get("content-security-policy"), "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it.each(STAFF_PAGES)("keeps %s unframeable, inside the one enforcing header", async (path) => {
    const res = await middleware(new NextRequest(`https://slate.test${path}`));
    expect(directive(res.headers.get("content-security-policy"), "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("lets the staff pages reach Supabase, and gives the lead pages no such allowance", async () => {
    // /login builds a Supabase browser client; the booker builds none.
    const staff = await middleware(new NextRequest("https://slate.test/login"));
    expect(directive(staff.headers.get("content-security-policy"), "connect-src")).toBe(
      "connect-src 'self' https://project.supabase.co",
    );
    const lead = await middleware(new NextRequest("https://slate.test/book"));
    expect(directive(lead.headers.get("content-security-policy"), "connect-src")).toBe("connect-src 'self'");
  });

  it("treats the partner sign in page like /login: Supabase reachable, never framed (#4379)", async () => {
    // It builds the same Supabase browser client to start the Microsoft redirect.
    const res = await middleware(new NextRequest("https://slate.test/partner/sign-in"));
    const policy = res.headers.get("content-security-policy");
    expect(directive(policy, "connect-src")).toBe("connect-src 'self' https://project.supabase.co");
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(nonceOf(policy)).toBeTruthy();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // Only that page: the rest of /partner is not a sign in page and gets no such allowance.
    const other = await middleware(new NextRequest("https://slate.test/partner/elsewhere"));
    expect(directive(other.headers.get("content-security-policy"), "connect-src")).toBe("connect-src 'self'");
  });

  it("keeps the policy on a staff response the session refresh replaced", async () => {
    // A cookie refresh REASSIGNS the response. Headers stamped before that would
    // be lost, leaving a signed in page with no policy and no framing rule.
    ssr.createServerClient.mockImplementationOnce((_url, _key, opts) => ({
      auth: {
        getUser: async () => {
          opts.cookies.setAll([{ name: "sb-token", value: "fresh", options: {} }]);
          return { data: { user: null } };
        },
        signOut,
      },
    }));
    const res = await middleware(new NextRequest("https://slate.test/admin"));
    expect(res.cookies.get("sb-token")?.value).toBe("fresh");
    expect(directive(res.headers.get("content-security-policy"), "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(nonceOf(res.headers.get("content-security-policy"))).toBe(
      nonceOf(res.headers.get("x-middleware-request-content-security-policy")),
    );
  });

  it("mints a fresh nonce per request", async () => {
    const a = nonceOf((await middleware(new NextRequest("https://slate.test/book"))).headers.get("content-security-policy"));
    const b = nonceOf((await middleware(new NextRequest("https://slate.test/book"))).headers.get("content-security-policy"));
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("does NOT refresh the Supabase session on the booker, which is the hot path", async () => {
    // The matcher had to widen to reach /book. Paying an auth round trip on every
    // embed load to set a header would be a real cost on the surface this policy
    // is most about.
    ssr.createServerClient.mockClear();

    await middleware(new NextRequest("https://slate.test/book?xbc=411"));
    expect(ssr.createServerClient).not.toHaveBeenCalled();

    await middleware(new NextRequest("https://slate.test/admin"));
    expect(ssr.createServerClient).toHaveBeenCalled();
  });
});

/**
 * #3084: a staff sign in ends 30 days after it started, or after 7 days without a staff
 * request. Driven through the middleware with a pinned clock, on both sides of each
 * boundary, because what matters is what a real request meets: a redirect to sign in
 * with a sentence, the session's cookies gone, and the refresh token revoked.
 */
describe("staff session age limits (#3084)", () => {
  const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
  const SESSION = "sb-project-auth-token";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    signOut.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const staffRequest = (path: string, cookies: Record<string, string | number>) =>
    new NextRequest(`https://slate.test${path}`, {
      headers: {
        cookie: Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
    });

  const signedIn = (startedMsAgo: number, seenMsAgo: number) => ({
    [SESSION]: "token",
    [SESSION_STARTED_COOKIE]: NOW - startedMsAgo,
    [SESSION_SEEN_COOKIE]: NOW - seenMsAgo,
  });

  const expectRefused = async (res: Response, error: string) => {
    // 303, never 307: a 307 makes the browser repeat a server action's POST against
    // /login. 303 turns any method into a GET of the sign in page.
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("error")).toBe(error);
    const cleared = res.headers
      .getSetCookie()
      .filter((c) => /Max-Age=0/i.test(c))
      .map((c) => c.split("=")[0]);
    expect(cleared).toEqual(expect.arrayContaining([SESSION, SESSION_STARTED_COOKIE, SESSION_SEEN_COOKIE]));
    // The refresh token is revoked too, so a copy of the cookie dies with this one.
    expect(signOut).toHaveBeenCalled();
    // The redirect is still a staff response: it keeps the framing rule.
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  };

  // A session Supabase still recognises. The default mock answers "no user", which is a
  // dead session, so the restamp cases override it.
  const liveSession = () =>
    ssr.createServerClient.mockImplementationOnce(() => ({
      auth: { getUser: async () => ({ data: { user: { id: "auth-1" } } }) as never, signOut },
    }));

  it("does not restamp the last use of a session Supabase no longer recognises", async () => {
    const res = await middleware(staffRequest("/admin", signedIn(60_000, 60_000)));
    expect(res.status).toBe(200);
    expect(res.cookies.get(SESSION_SEEN_COOKIE)).toBeUndefined();
  });

  it("admits a session one millisecond inside 30 days, and restamps its last use", async () => {
    liveSession();
    const res = await middleware(staffRequest("/admin", signedIn(SESSION_TIME_BOX_MS - 1, 60_000)));
    expect(res.status).toBe(200);
    expect(signOut).not.toHaveBeenCalled();
    const seen = res.cookies.get(SESSION_SEEN_COOKIE);
    expect(seen?.value).toBe(String(NOW));
    expect(seen?.httpOnly).toBe(true);
    expect(seen?.maxAge).toBe(SESSION_IDLE_MS / 1000);
  });

  it("refuses a session exactly 30 days after sign in, however recently it was used", async () => {
    await expectRefused(await middleware(staffRequest("/admin/agents", signedIn(SESSION_TIME_BOX_MS, 0))), "session_expired");
  });

  it("admits one millisecond short of 7 idle days and refuses at 7", async () => {
    const inside = await middleware(staffRequest("/me", signedIn(10 * 86_400_000, SESSION_IDLE_MS - 1)));
    expect(inside.status).toBe(200);
    await expectRefused(await middleware(staffRequest("/me", signedIn(10 * 86_400_000, SESSION_IDLE_MS))), "session_idle");
  });

  // #4205: the coordinator page is a staff surface, so its session ages out like the
  // console's, and an outside site may not frame it.
  it("ages a session out on the coordinator page as on every other staff page", async () => {
    const inside = await middleware(staffRequest("/coordinator", signedIn(10 * 86_400_000, SESSION_IDLE_MS - 1)));
    expect(inside.status).toBe(200);
    await expectRefused(await middleware(staffRequest("/coordinator", signedIn(10 * 86_400_000, SESSION_IDLE_MS))), "session_idle");
  });

  it("answers an aged session's server action POST with a 303, so the browser does not re-POST to /login", async () => {
    const req = new NextRequest("https://slate.test/admin/agents", {
      method: "POST",
      headers: {
        cookie: Object.entries(signedIn(SESSION_TIME_BOX_MS, 0))
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
    });
    await expectRefused(await middleware(req), "session_expired");
  });

  it("refuses a session that carries no sign in stamp, rather than starting its clock now", async () => {
    await expectRefused(await middleware(staffRequest("/admin", { [SESSION]: "token" })), "session_ended");
  });

  it("leaves a visitor who never signed in alone, so they are not told they were signed out", async () => {
    const res = await middleware(staffRequest("/admin", {}));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(SESSION_SEEN_COOKIE)).toBeUndefined();
  });

  it("never redirects the sign in page to itself", async () => {
    const res = await middleware(staffRequest("/login", signedIn(SESSION_TIME_BOX_MS * 2, SESSION_IDLE_MS * 2)));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("never sends somebody on the partner sign in page away to /login either (#4379)", async () => {
    const res = await middleware(
      staffRequest("/partner/sign-in", signedIn(SESSION_TIME_BOX_MS * 2, SESSION_IDLE_MS * 2)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still clears the session when the revoke itself fails", async () => {
    signOut.mockImplementationOnce(async () => {
      throw new Error("auth server unreachable");
    });
    await expectRefused(await middleware(staffRequest("/admin", signedIn(SESSION_TIME_BOX_MS + 1, 0))), "session_expired");
  });
});

/**
 * #3137: OBSERVE who frames the booker, and LOCK framing to the allow list behind a
 * stored switch that defaults off. The lock must cover every page the booker can move
 * to inside its frame, so each of them is driven here, not only /book.
 */
describe("framing the booker (#3137)", () => {
  const BOOKER_PAGES = [
    "/book?xbc=411",
    "/book/advisor/abc123",
    "/booking/0b1c2d",
    "/booking/manage/tok-abc",
    "/booking/manage/tok-abc/rebook",
  ];

  beforeEach(() => {
    frameGuard.readFrameLock.mockReset();
    frameGuard.readFrameLock.mockResolvedValue(false);
    frameGuard.recordFramingObservation.mockReset();
  });

  const framed = (path: string, referer: string | null, dest = "iframe") =>
    new NextRequest(`https://slate.test${path}`, {
      headers: { "sec-fetch-dest": dest, ...(referer ? { referer } : {}) },
    });

  it.each(BOOKER_PAGES)("leaves %s frameable by anyone while the lock is off", async (path) => {
    const res = await middleware(framed(path, "https://anywhere.example/"));
    expect(res.headers.get("content-security-policy")).not.toContain("frame-ancestors");
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it.each(BOOKER_PAGES)("limits %s to Slate and the allow list once the lock is on", async (path) => {
    frameGuard.readFrameLock.mockResolvedValue(true);
    const res = await middleware(framed(path, "https://www.trypennie.com/"));
    expect(directive(res.headers.get("content-security-policy"), "frame-ancestors")).toBe(
      ["frame-ancestors", ...frameAncestorSources()].join(" "),
    );
    // The lock rides in the SAME policy Next reads the nonce from.
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(
      res.headers.get("content-security-policy"),
    );
    // No X-Frame-Options: it cannot express an allow list, and DENY would black out
    // the partners the list exists to admit.
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("never reads the switch on a staff page, which is unframeable whatever it says", async () => {
    frameGuard.readFrameLock.mockResolvedValue(true);
    const res = await middleware(new NextRequest("https://slate.test/admin"));
    expect(frameGuard.readFrameLock).not.toHaveBeenCalled();
    expect(directive(res.headers.get("content-security-policy"), "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("records the framing origin and the page, after the response, for a framed load", async () => {
    const waitUntil = vi.fn();
    await middleware(
      framed("/booking/manage/tok-abc", "https://partner.example/landing?email=jane%40x.com"),
      { waitUntil } as never,
    );
    expect(frameGuard.recordFramingObservation).toHaveBeenCalledWith(
      { origin: "https://partner.example", surface: "manage" },
      expect.any(Function),
    );
    // Whatever write the recorder makes is handed to THIS request's waitUntil, so it
    // outlives the response.
    const defer = frameGuard.recordFramingObservation.mock.calls[0][1];
    const work = Promise.resolve();
    defer(work);
    expect(waitUntil).toHaveBeenCalledWith(work);
  });

  it("records a framed load whether the lock is on or off", async () => {
    frameGuard.readFrameLock.mockResolvedValue(true);
    await middleware(framed("/book", "https://partner.example/"));
    expect(frameGuard.recordFramingObservation).toHaveBeenCalledTimes(1);
  });

  it("records nothing for a top level visit or a staff page", async () => {
    await middleware(framed("/book", "https://partner.example/", "document"));
    await middleware(framed("/admin", "https://partner.example/"));
    expect(frameGuard.recordFramingObservation).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

// #592: the middleware runs on /admin, /me, /login (its matcher) and must stamp
// the clickjacking + hardening headers onto their responses. Supabase + env are
// mocked so this exercises only the header wiring, not the session refresh.
// A spy rather than a plain function: #2565 needs to assert that the booker does
// NOT pay the session refresh, which is a statement about whether this was CALLED.
type CookieSetter = (toSet: { name: string; value: string; options: Record<string, unknown> }[]) => void;
const ssr = vi.hoisted(() => ({
  createServerClient: vi.fn((_url: string, _key: string, _opts: { cookies: { setAll: CookieSetter } }) => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  })),
}));
vi.mock("@supabase/ssr", () => ssr);
vi.mock("@/lib/env", () => ({
  publicSupabaseUrl: () => "https://project.supabase.co",
  publicSupabasePublishableKey: () => "sb_publishable_test",
}));

import { NextRequest } from "next/server";
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

  it("keeps the policy on a staff response the session refresh replaced", async () => {
    // A cookie refresh REASSIGNS the response. Headers stamped before that would
    // be lost, leaving a signed in page with no policy and no framing rule.
    ssr.createServerClient.mockImplementationOnce((_url, _key, opts) => ({
      auth: {
        getUser: async () => {
          opts.cookies.setAll([{ name: "sb-token", value: "fresh", options: {} }]);
          return { data: { user: null } };
        },
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

// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

// #592: the middleware runs on /admin, /me, /login (its matcher) and must stamp
// the clickjacking + hardening headers onto their responses. Supabase + env are
// mocked so this exercises only the header wiring, not the session refresh.
// A spy rather than a plain function: #2565 needs to assert that the booker does
// NOT pay the session refresh, which is a statement about whether this was CALLED.
const ssr = vi.hoisted(() => ({
  createServerClient: vi.fn(() => ({
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
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

/**
 * #2565: the script policy, shipped REPORT ONLY. These drive the middleware
 * itself rather than asserting on a constant, because the three things that can
 * go wrong here (enforcing by accident, breaking the embed, or reporting noise
 * because Next never saw a nonce) are all properties of what it SETS.
 */
describe("the report only script policy (#2565)", () => {
  const nonceOf = (policy: string | null) => /'nonce-([^']+)'/.exec(policy ?? "")?.[1];

  it("reports and does NOT enforce on the booker", async () => {
    const res = await middleware(new NextRequest("https://slate.test/book"));
    expect(res.headers.get("content-security-policy-report-only")).toContain("script-src");
    // The enforcing header must carry nothing but the framing rule it already
    // carried. A script-src landing there would black out whatever it got wrong,
    // which on the booker is somebody else's page.
    expect(res.headers.get("content-security-policy") ?? "").not.toContain("script-src");
  });

  it("leaves the staff pages exactly as they were, which is measured and not an oversight", async () => {
    // Next reads the nonce from the ENFORCING header first and only falls back to
    // the report only one. The staff paths already serve an enforcing
    // frame-ancestors (#592), so it wins, carries no nonce, and Next applies none:
    // measured 0 of 26 script tags nonced on /login against 25 of 26 on /book. A
    // report only header there would report every one of them on every load.
    const res = await middleware(new NextRequest("https://slate.test/admin"));
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("gives the booker no frame-ancestors, so the embed keeps working", async () => {
    const res = await middleware(new NextRequest("https://slate.test/book?xbc=411"));
    expect(res.headers.get("content-security-policy-report-only")).not.toContain("frame-ancestors");
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("mints a fresh nonce per request", async () => {
    const a = nonceOf((await middleware(new NextRequest("https://slate.test/book"))).headers.get("content-security-policy-report-only"));
    const b = nonceOf((await middleware(new NextRequest("https://slate.test/book"))).headers.get("content-security-policy-report-only"));
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("declares the reporting endpoint, so report-to has somewhere to go", async () => {
    const res = await middleware(new NextRequest("https://slate.test/book"));
    expect(res.headers.get("reporting-endpoints")).toContain("/api/csp-report");
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

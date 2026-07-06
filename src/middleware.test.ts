// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

// #592: the middleware runs on /admin, /me, /login (its matcher) and must stamp
// the clickjacking + hardening headers onto their responses. Supabase + env are
// mocked so this exercises only the header wiring, not the session refresh.
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));
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

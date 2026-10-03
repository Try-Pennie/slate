// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// #3136: the script policy and the framing rule are set by the middleware, so a page its
// matcher does not reach ships with neither, and nothing reports it. The matcher is
// inverted to cover everything except /api, Next's own assets and static files, and this
// asks Next ITSELF whether each route the app serves is matched, enumerated from src/app so
// a page added tomorrow is covered by construction (L96).
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/env", () => ({
  publicSupabaseUrl: () => "https://project.supabase.co",
  publicSupabasePublishableKey: () => "sb_publishable_test",
}));

import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { config, middleware } from "@/middleware";

const APP = join(process.cwd(), "src", "app");

/** Every URL the app serves outside /api: a page, or a route handler. Dynamic segments
 *  are filled with a plain token, and route groups drop out of the path as Next does. */
function servedUrls(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...servedUrls(p));
      continue;
    }
    if (!/^(page|route)\.tsx?$/.test(name)) continue;
    const segments = relative(APP, dir)
      .split(sep)
      .filter((s) => s && !/^\(.*\)$/.test(s))
      .map((s) => (/^\[.*\]$/.test(s) ? "abc123" : s));
    if (segments[0] === "api") continue;
    out.push(`/${segments.join("/")}`);
  }
  return out;
}

const URLS = servedUrls(APP);

describe("the middleware matcher reaches every page (#3136)", () => {
  it("found the app's pages", () => {
    expect(URLS).toContain("/");
    expect(URLS).toContain("/book");
    expect(URLS.length).toBeGreaterThan(30);
  });

  it.each(URLS)("matches %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
  });

  it.each([
    "/api",
    "/api/availability",
    "/api/health",
    "/_next/static/chunks/main.js",
    "/_next/image",
    "/widget.js",
    "/icon.svg",
    "/brand/logo.png",
    "/embed-example.html",
  ])("leaves %s alone, since it renders no page", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });
});

describe("a page outside the booker refuses framing by default (#3136)", () => {
  it.each(["/", "/dev/preview", "/some-new-page"])("denies framing on %s", async (path) => {
    const res = await middleware(new NextRequest(`https://slate.test${path}`));
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it.each(["/book", "/book/advisor/abc", "/booking/00Q000000000001", "/booking/manage/tok"])(
    "leaves %s frameable, since the booker is an embed",
    async (path) => {
      const res = await middleware(new NextRequest(`https://slate.test${path}`));
      expect(res.headers.get("content-security-policy")).not.toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options")).toBeNull();
    },
  );
});

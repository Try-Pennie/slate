// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3112: the auth cookies were written with @supabase/ssr's defaults (readable by script,
// 400 days, no explicit Secure). The session is only ever needed on the server, so every
// cookie a SERVER client writes is httpOnly, Secure in production, SameSite=Lax and clamped
// to the idle limit, and the one browser client (which only starts the Google redirect and
// writes the PKCE verifier from script) is never httpOnly, or the verifier would be dropped
// and sign in would break.
//
// The library is mocked to capture what each client is built with and to drive its
// `setAll` the way it really does: with its own defaults, maxAge 400 days included, which
// it forces over any cookieOptions.maxAge.
type SetAll = (toSet: { name: string; value: string; options: Record<string, unknown> }[]) => void;
const LIBRARY_DEFAULTS = { path: "/", sameSite: "lax", httpOnly: false, maxAge: 400 * 24 * 60 * 60 };
const built = vi.hoisted(() => ({
  server: [] as { cookieOptions?: Record<string, unknown>; setAll: SetAll }[],
  browser: [] as { cookieOptions?: Record<string, unknown> }[],
  /** When set, getUser writes a session the way a token refresh does. */
  refreshOnGetUser: false,
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _u: string,
    _k: string,
    opts: { cookieOptions?: Record<string, unknown>; cookies: { setAll: SetAll } },
  ) => {
    built.server.push({ cookieOptions: opts.cookieOptions, setAll: opts.cookies.setAll });
    return {
      auth: {
        getUser: async () => {
          if (built.refreshOnGetUser) {
            opts.cookies.setAll([
              {
                name: "sb-project-auth-token",
                value: "refreshed",
                options: { path: "/", sameSite: "lax", httpOnly: false, maxAge: 400 * 24 * 60 * 60 },
              },
            ]);
          }
          return { data: { user: null } };
        },
      },
    };
  },
  createBrowserClient: (_u: string, _k: string, opts?: { cookieOptions?: Record<string, unknown> }) => {
    built.browser.push({ cookieOptions: opts?.cookieOptions });
    return {};
  },
}));
vi.mock("@/lib/env", () => ({
  publicSupabaseUrl: () => "https://project.supabase.co",
  publicSupabasePublishableKey: () => "sb_publishable_test",
}));
const store = vi.hoisted(() => ({ set: vi.fn(), getAll: vi.fn(() => []) }));
vi.mock("next/headers", () => ({ cookies: async () => store }));

import { NextRequest } from "next/server";
import { supabaseServer } from "./server";
import { supabaseBrowser } from "./browser";
import { middleware } from "@/middleware";
import { AUTH_COOKIE_MAX_AGE_SECONDS } from "./cookie-options";

beforeEach(() => {
  built.server.length = 0;
  built.browser.length = 0;
  built.refreshOnGetUser = false;
  store.set.mockClear();
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

describe("auth cookies a server client writes (#3112)", () => {
  it("supabaseServer, which the sign in callback exchanges through, writes them hardened", async () => {
    await supabaseServer();
    const client = built.server.at(-1)!;
    expect(client.cookieOptions).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax" });

    client.setAll([{ name: "sb-project-auth-token", value: "v", options: { ...LIBRARY_DEFAULTS } }]);
    expect(store.set).toHaveBeenCalledWith(
      "sb-project-auth-token",
      "v",
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
      }),
    );
  });

  it("keeps a removal a removal", async () => {
    await supabaseServer();
    built.server
      .at(-1)!
      .setAll([{ name: "sb-project-auth-token", value: "", options: { ...LIBRARY_DEFAULTS, maxAge: 0 } }]);
    expect(store.set.mock.calls[0]![2]).toMatchObject({ maxAge: 0 });
  });

  it("the middleware's refresh puts the same attributes on the Set-Cookie header", async () => {
    built.refreshOnGetUser = true;
    const res = await middleware(new NextRequest("https://slate.test/admin"));
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain("sb-project-auth-token=refreshed");
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(header).toContain(`Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`);
  });

  it("is not Secure on a development server, which answers on plain http", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await supabaseServer();
    built.server
      .at(-1)!
      .setAll([{ name: "sb-project-auth-token", value: "v", options: { ...LIBRARY_DEFAULTS } }]);
    expect(store.set.mock.calls[0]![2]).toMatchObject({ httpOnly: true, secure: false });
  });
});

describe("the browser client that starts sign in (#3112)", () => {
  it("is never httpOnly, so the PKCE verifier it writes from script survives", () => {
    supabaseBrowser();
    expect(built.browser.at(-1)!.cookieOptions).toMatchObject({ httpOnly: false, sameSite: "lax" });
  });
});

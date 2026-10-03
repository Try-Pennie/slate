// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

// #3112: making the session cookies httpOnly is only safe if sign in still works, and sign in
// is a PKCE hand off between the two clients: the BROWSER client writes a code verifier from
// script before the Google redirect, and the SERVER client reads it back in the callback and
// exchanges the code for a session. This drives that hand off through the REAL @supabase/ssr
// and auth clients, with only Supabase's token endpoint stubbed, and asserts both halves: the
// verifier reaches the server, and the session the exchange writes comes back httpOnly.
vi.mock("@/lib/env", () => ({
  publicSupabaseUrl: () => "https://project.supabase.co",
  publicSupabasePublishableKey: () => "sb_publishable_test",
}));

/** The callback's cookie jar: what the browser sent, and what the response sets. */
const jar = vi.hoisted(() => ({
  sent: [] as { name: string; value: string }[],
  set: [] as { name: string; value: string; options: Record<string, unknown> }[],
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => jar.sent,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.set.push({ name, value, options });
    },
  }),
}));

import { supabaseBrowser } from "./browser";
import { supabaseServer } from "./server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function fakeJwt(sub: string): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, exp, aud: "authenticated", role: "authenticated" })}.sig`;
}

describe("sign in still completes with httpOnly session cookies (#3112)", () => {
  it("hands the PKCE verifier from the browser to the callback, and the session comes back httpOnly", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // 1. The login page starts the redirect. The verifier is written from script.
    const browser = supabaseBrowser();
    const { data, error } = await browser.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: "https://slate.test/api/auth/callback", skipBrowserRedirect: true },
    });
    expect(error).toBeNull();
    expect(data.url).toContain("code_challenge=");
    const verifier = document.cookie
      .split("; ")
      .map((c) => c.split("="))
      .find(([name]) => name!.endsWith("-code-verifier"));
    expect(verifier, "the verifier cookie was written by script, so it is not httpOnly").toBeTruthy();

    // 2. The browser sends its cookies to the callback, which exchanges the code.
    jar.sent = document.cookie.split("; ").map((c) => {
      const i = c.indexOf("=");
      return { name: c.slice(0, i), value: decodeURIComponent(c.slice(i + 1)) };
    });
    let exchangedWith: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        exchangedWith = JSON.parse(String(init?.body ?? "{}"));
        const user = { id: "auth-1", aud: "authenticated", email: "agent@trypennie.com" };
        return new Response(
          JSON.stringify({
            access_token: fakeJwt("auth-1"),
            refresh_token: "refresh-1",
            token_type: "bearer",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const server = await supabaseServer();
    const exchange = await server.auth.exchangeCodeForSession("the-code");
    expect(exchange.error).toBeNull();
    expect(exchangedWith).toMatchObject({ auth_code: "the-code", code_verifier: expect.any(String) });

    // 3. The session cookie the callback sets is httpOnly and Secure.
    const session = jar.set.filter((c) => /-auth-token(\.\d+)?$/.test(c.name) && c.value);
    expect(session.length).toBeGreaterThan(0);
    for (const c of session) {
      expect(c.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax" });
    }
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// #1031: the sign-out action must (1) sign out of Supabase, (2) clear Slate's
// own session cookies (the "view as" cookie + the theme cookie), and (3) on a
// FAILED Supabase revoke, still clear the local Supabase auth cookies itself:
// auth-js early-returns before removing them when the network revoke errors
// (GoTrueClient _signOut), so a lost/shared machine would otherwise keep a live
// session. Then land on /login.

const signOutMock = vi.fn(async () => ({ error: null as { message: string } | null }));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({ auth: { signOut: signOutMock } }),
}));

const store = vi.hoisted(() => {
  const map = new Map<string, { name: string; value: string }>();
  return {
    map,
    getAll: vi.fn(() => [...map.values()]),
    get: vi.fn((name: string) => map.get(name)),
    delete: vi.fn((name: string) => map.delete(name)),
  };
});
vi.mock("next/headers", () => ({ cookies: async () => store }));

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));

const warn = vi.fn();
vi.mock("@/lib/log", () => ({ log: { warn: (...a: unknown[]) => warn(...a) } }));

import { signOut } from "@/app/auth-actions";
import { LAST_SIGN_IN_PAGE_COOKIE } from "@/lib/auth/sign-in-page";

beforeEach(() => {
  vi.clearAllMocks();
  store.map.clear();
});

describe("signOut (#1031)", () => {
  it("signs out, clears the Slate cookies, and redirects to /login", async () => {
    store.map.set("slate_impersonate", { name: "slate_impersonate", value: "x" });
    store.map.set("slate-theme", { name: "slate-theme", value: "dark" });

    await signOut();

    expect(signOutMock).toHaveBeenCalledTimes(1);
    const deleted = store.delete.mock.calls.map((c) => c[0]);
    expect(deleted).toContain("slate_impersonate");
    expect(deleted).toContain("slate-theme");
    // #3084: the session age stamps go too, so the next sign in on this browser
    // starts its own clock rather than meeting a stale one.
    expect(deleted).toContain("slate-signed-in-at");
    expect(deleted).toContain("slate-last-seen-at");
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(warn).not.toHaveBeenCalled();
  });

  it("when the Supabase revoke fails, still clears the local sb- auth cookies, logs, and redirects", async () => {
    signOutMock.mockResolvedValueOnce({ error: { message: "network down" } });
    store.map.set("sb-abc-auth-token", { name: "sb-abc-auth-token", value: "jwt" });
    store.map.set("sb-abc-auth-token.0", { name: "sb-abc-auth-token.0", value: "chunk" });
    store.map.set("slate_impersonate", { name: "slate_impersonate", value: "x" });
    store.map.set("slate-theme", { name: "slate-theme", value: "dark" });

    await signOut();

    const deleted = store.delete.mock.calls.map((c) => c[0]);
    expect(deleted).toContain("sb-abc-auth-token");
    expect(deleted).toContain("sb-abc-auth-token.0");
    expect(deleted).toContain("slate_impersonate");
    expect(deleted).toContain("slate-theme");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  // #4398: a coordinator who signs in with Microsoft and signs out must land on the page they
  // can sign back in on, not /login, whose only button is Google. The record of which page
  // this browser last signed in on is kept: it says which page to show, and lets nobody in.
  it("lands a browser that last signed in on the partner page back there, and keeps that record", async () => {
    store.map.set(LAST_SIGN_IN_PAGE_COOKIE, { name: LAST_SIGN_IN_PAGE_COOKIE, value: "partner" });

    await signOut();

    expect(redirect).toHaveBeenCalledWith("/partner/sign-in");
    expect(store.delete.mock.calls.map((c) => c[0])).not.toContain(LAST_SIGN_IN_PAGE_COOKIE);
  });

  it("lands on /login when that record is anything but exactly partner", async () => {
    store.map.set(LAST_SIGN_IN_PAGE_COOKIE, { name: LAST_SIGN_IN_PAGE_COOKIE, value: "https://evil.example" });

    await signOut();

    expect(redirect).toHaveBeenCalledWith("/login");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// #2100: this write was unchecked, so a theme that never reached the account
// resolved exactly like one that did. The control catches a rejection and says
// so, which only works if a failed write actually rejects.

const store = vi.hoisted(() => ({
  set: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: async () => store }));

const auth = vi.hoisted(() => ({ user: { id: "user-1" } as { id: string } | null }));
vi.mock("@/lib/auth", () => ({ realCurrentUser: async () => auth.user }));

const db = vi.hoisted(() => ({
  error: null as { message: string } | null,
  updated: [] as unknown[],
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      update: (values: unknown) => {
        db.updated.push(values);
        return { eq: async () => ({ error: db.error }) };
      },
    }),
  }),
}));

import { setThemePreference } from "@/app/theme-actions";

beforeEach(() => {
  store.set.mockClear();
  db.error = null;
  db.updated = [];
  auth.user = { id: "user-1" };
});

describe("setThemePreference", () => {
  it("records the preference on the account", async () => {
    await setThemePreference("dark");

    expect(db.updated).toEqual([{ theme_preference: "dark" }]);
  });

  it("mirrors it into the cookie so the next load paints it before hydration", async () => {
    await setThemePreference("dark");

    expect(store.set).toHaveBeenCalledWith(
      "slate-theme",
      "dark",
      expect.objectContaining({ path: "/", sameSite: "lax" }),
    );
  });

  it("rejects when the account write fails, rather than resolving as though it saved", async () => {
    db.error = { message: "permission denied" };

    await expect(setThemePreference("dark")).rejects.toThrow(/theme/i);
  });

  it("rejects when there is nobody signed in to record it against", async () => {
    auth.user = null;

    await expect(setThemePreference("dark")).rejects.toThrow(/signed in/i);
  });

  it("refuses a value outside the vocabulary instead of writing it", async () => {
    await expect(setThemePreference("purple")).rejects.toThrow(/purple/);
    expect(db.updated).toEqual([]);
  });

  it("writes the real user's row, so an admin viewing as somebody cannot change their theme", async () => {
    // The action deliberately resolves the REAL user rather than who the page is
    // rendered for. The other half of that decision, that the control is absent
    // while impersonating, lives in AccountMenu.test.tsx.
    auth.user = { id: "admin-1" };

    await setThemePreference("light");

    expect(db.updated).toEqual([{ theme_preference: "light" }]);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// The root sends a signed in person to their surface and anybody else to sign in (#4412:
// to the sign in page this browser last used, so a partner coordinator whose session the
// gate refused is not sent to the Google only staff login).

const auth = vi.hoisted(() => ({ coordinatorDeskUser: vi.fn(), currentUser: vi.fn() }));
const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }));
const jar = vi.hoisted(() => ({ lastSignInPage: undefined as string | undefined }));
vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "slate_last_sign_in_page" && jar.lastSignInPage !== undefined ? { name, value: jar.lastSignInPage } : undefined,
  }),
}));

import Home from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  auth.currentUser.mockResolvedValue(null);
  auth.coordinatorDeskUser.mockResolvedValue(null);
  jar.lastSignInPage = undefined;
});

describe("the root, signed out (#4412)", () => {
  it("sends a browser with no record to the staff sign in page", async () => {
    await expect(Home()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("sends a partner's browser to the partner sign in page", async () => {
    jar.lastSignInPage = "partner";
    await expect(Home()).rejects.toThrow("NEXT_REDIRECT:/partner/sign-in");
  });

  it("sends any other record to the staff sign in page", async () => {
    jar.lastSignInPage = "staff";
    await expect(Home()).rejects.toThrow("NEXT_REDIRECT:/login");
  });
});

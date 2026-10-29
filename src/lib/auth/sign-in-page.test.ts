import { describe, it, expect } from "vitest";
import {
  PARTNER_SIGN_IN_PATH,
  SIGN_IN_FROM_COOKIE,
  STAFF_SIGN_IN_PATH,
  isSignInPath,
  signInFromCookie,
  signInPageFromCookie,
  signInPathFor,
} from "./sign-in-page";

// Slate has two sign in pages (#4379): /login for staff, Google only, and the partner page for
// invited coordinators, Microsoft only. A sign in that comes back refused must land on the page
// whose button was pressed, or the person reads the reason beside a button they cannot use.
describe("the two sign in pages", () => {
  it("are /login for staff and /partner/sign-in for partners", () => {
    expect(signInPathFor("staff")).toBe(STAFF_SIGN_IN_PATH);
    expect(STAFF_SIGN_IN_PATH).toBe("/login");
    expect(signInPathFor("partner")).toBe(PARTNER_SIGN_IN_PATH);
    expect(PARTNER_SIGN_IN_PATH).toBe("/partner/sign-in");
  });

  it("are both sign in paths, and nothing under them is", () => {
    expect(isSignInPath("/login")).toBe(true);
    expect(isSignInPath("/partner/sign-in")).toBe(true);
    expect(isSignInPath("/partner")).toBe(false);
    expect(isSignInPath("/partner/sign-in/x")).toBe(false);
    expect(isSignInPath("/coordinator")).toBe(false);
  });
});

describe("the mark saying which page a sign in started from", () => {
  it("reads partner only for exactly that value, and staff for anything else", () => {
    expect(signInPageFromCookie("partner")).toBe("partner");
    for (const v of [undefined, "", "staff", "Partner", "partner ", "/admin", "https://evil.example"]) {
      expect(signInPageFromCookie(v), String(v)).toBe("staff");
    }
  });

  it("is written for the partner page as a short lived, whole site, lax cookie", () => {
    const c = signInFromCookie("partner", "https:");
    expect(c.startsWith(`${SIGN_IN_FROM_COOKIE}=partner;`)).toBe(true);
    expect(c).toContain("path=/");
    expect(c).toMatch(/max-age=600(;|$)/);
    expect(c).toContain("samesite=lax");
    expect(c).toContain("secure");
  });

  it("is cleared by the staff page, and is not Secure on plain http (local dev)", () => {
    const c = signInFromCookie("staff", "http:");
    expect(c.startsWith(`${SIGN_IN_FROM_COOKIE}=;`)).toBe(true);
    expect(c).toMatch(/max-age=0(;|$)/);
    expect(c).not.toContain("secure");
  });
});

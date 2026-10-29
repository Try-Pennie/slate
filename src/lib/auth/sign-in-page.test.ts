import { describe, it, expect } from "vitest";
import {
  LAST_SIGN_IN_PAGE_COOKIE,
  LAST_SIGN_IN_PAGE_MAX_AGE_S,
  PARTNER_SIGN_IN_PATH,
  SIGN_IN_FROM_COOKIE,
  STAFF_SIGN_IN_PATH,
  isSignInPath,
  lastSignInPageCookieOptions,
  signInFromCookie,
  signInPageFromCookie,
  signInPathFor,
  signInPathForBrowser,
} from "./sign-in-page";
import { SESSION_TIME_BOX_MS } from "./session-age";

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

// #4398: a coordinator signed out (or aged out) on /coordinator was sent to /login, whose only
// button is Google, so they could not get back in. The browser now remembers which page its last
// sign in SUCCEEDED from, and a signed out visit goes back there. A hint for which page to show,
// never an authorisation: the session gate and the callback decide who gets in.
describe("the record of which page this browser last signed in from (#4398)", () => {
  it("sends the browser to the partner page only for exactly partner, and to /login for anything else", () => {
    expect(signInPathForBrowser("partner")).toBe(PARTNER_SIGN_IN_PATH);
    for (const v of [undefined, null, "", "staff", "Partner", "partner ", "/admin", "https://evil.example", "//evil.example"]) {
      expect(signInPathForBrowser(v), String(v)).toBe(STAFF_SIGN_IN_PATH);
    }
  });

  it("is a different cookie from the ten minute mark a page sets as its redirect starts", () => {
    // That mark is set before anybody has signed in; this one is a record of a success.
    expect(LAST_SIGN_IN_PAGE_COOKIE).not.toBe(SIGN_IN_FROM_COOKIE);
  });

  it("outlasts the longest a session can live, so an aged out coordinator is still sent home", () => {
    expect(LAST_SIGN_IN_PAGE_MAX_AGE_S).toBeGreaterThan(SESSION_TIME_BOX_MS / 1000);
    // Chrome keeps no cookie past 400 days, so asking for longer buys nothing.
    expect(LAST_SIGN_IN_PAGE_MAX_AGE_S).toBeLessThanOrEqual(400 * 24 * 60 * 60);
  });

  it("is written by the server only, for the whole site, and sent on a link followed from elsewhere", () => {
    const o = lastSignInPageCookieOptions(LAST_SIGN_IN_PAGE_MAX_AGE_S);
    expect(o.httpOnly).toBe(true);
    expect(o.path).toBe("/");
    // Lax, not Strict: a coordinator opening /coordinator from a bookmark or another site
    // is a cross site navigation, and Strict would drop the cookie on exactly that visit.
    expect(o.sameSite).toBe("lax");
    expect(o.maxAge).toBe(LAST_SIGN_IN_PAGE_MAX_AGE_S);
    expect("expires" in o).toBe(false);
  });

  it("is cleared with an Expires in the past as well as Max-Age 0, which Next drops on the way out", () => {
    const o = lastSignInPageCookieOptions(0);
    expect(o.maxAge).toBe(0);
    expect(o.expires?.getTime()).toBe(0);
  });
});

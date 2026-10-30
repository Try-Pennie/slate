// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import LoginPage from "@/app/login/page";
import { sessionRefusalLoginError } from "@/lib/auth/session-age";
import {
  GOOGLE_ACCOUNT_CHANGED_LOGIN_ERROR,
  GOOGLE_ACCOUNT_CHANGED_MESSAGE,
  SEVERAL_GOOGLE_ACCOUNTS_LOGIN_ERROR,
  SEVERAL_GOOGLE_ACCOUNTS_MESSAGE,
} from "@/lib/auth/google-identity-copy";

// #626: signing in hands off to Google via a full-page redirect that can't be
// aborted. If that redirect wedges, the button must not sit on "Redirecting…"
// forever — a distinct still-alive cue with a retry appears at ~10s.
// #631: a signInWithOAuth that fails outright (returns an error or throws)
// must re-enable the button and surface an inline error immediately, not leave
// it stuck on "Redirecting…" until the watchdog eventually fires.

// #1648 added a fourth bounce-back code, so the params are mutable per test: a
// message nothing renders is a message nobody reads.
const params = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => params.current }));

const signInWithOAuth = vi.fn();
vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowser: () => ({ auth: { signInWithOAuth } }),
}));

afterEach(() => {
  signInWithOAuth.mockReset();
  params.current = new URLSearchParams();
  vi.useRealTimers();
});

function clickSignIn() {
  return fireEvent.click(
    screen.getByRole("button", { name: /continue with google/i }),
  );
}

describe("LoginPage", () => {
  it("shows a still-working cue with a retry when the OAuth redirect wedges", async () => {
    signInWithOAuth.mockImplementation(() => new Promise(() => {})); // never redirects
    vi.useFakeTimers();
    render(<LoginPage />);

    clickSignIn();
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(/taking longer than expected/i)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(10000); });

    expect(screen.getByRole("status").textContent).toMatch(/taking longer than expected/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("re-enables the button and shows an error when signInWithOAuth returns an error", async () => {
    signInWithOAuth.mockResolvedValue({ error: { message: "network blip" } });
    render(<LoginPage />);

    clickSignIn();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("alert").textContent).toMatch(/couldn't reach/i);
    expect(
      (screen.getByRole("button", { name: /continue with google/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByRole("button", { name: /redirecting/i })).toBeNull();
  });

  it("re-enables the button and shows an error when signInWithOAuth throws", async () => {
    signInWithOAuth.mockRejectedValue(new Error("network down"));
    render(<LoginPage />);

    clickSignIn();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("alert").textContent).toMatch(/couldn't reach/i);
    expect(
      (screen.getByRole("button", { name: /continue with google/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("stays in the redirecting state on success", async () => {
    signInWithOAuth.mockResolvedValue({ error: null });
    render(<LoginPage />);

    clickSignIn();
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (screen.getByRole("button", { name: /redirecting/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  // #659: the instant inline error (#631) and the ~10s still-working cue (#626)
  // are driven by two independent state paths. The stall cue only renders while
  // `loading` is true, and the failure path flips `loading` off in the same
  // batch as it sets the error, which also tears down the watchdog. So the two
  // can never occupy the screen at once. Both cues carry distinct ARIA roles
  // (status for the cue, alert for the error), so their coexistence is
  // observable: these tests lock the invariant against a future regression.
  const bothCuesShown = () =>
    screen.queryByRole("status") !== null && screen.queryByRole("alert") !== null;

  it("never shows the stall cue and the error banner together when a failure lands at the 10s boundary", async () => {
    let resolveOAuth: (v: { error: { message: string } }) => void = () => {};
    signInWithOAuth.mockImplementation(
      () =>
        new Promise((res) => {
          resolveOAuth = res as typeof resolveOAuth;
        }),
    );
    vi.useFakeTimers();
    render(<LoginPage />);

    clickSignIn();
    await act(async () => { await Promise.resolve(); });
    expect(bothCuesShown()).toBe(false);

    // Trip the watchdog and land the failure in the same flush, the exact race
    // the issue asks about: resetting loading must win, so the cue never shows.
    await act(async () => {
      vi.advanceTimersByTime(10000);
      resolveOAuth({ error: { message: "network blip" } });
      await Promise.resolve();
    });

    expect(bothCuesShown()).toBe(false);
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't reach/i);
    expect(screen.queryByText(/taking longer than expected/i)).toBeNull();
    expect(
      (screen.getByRole("button", { name: /continue with google/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("swaps the already-visible stall cue for the error banner without ever showing both", async () => {
    let resolveOAuth: (v: { error: { message: string } }) => void = () => {};
    signInWithOAuth.mockImplementation(
      () =>
        new Promise((res) => {
          resolveOAuth = res as typeof resolveOAuth;
        }),
    );
    vi.useFakeTimers();
    render(<LoginPage />);

    clickSignIn();
    await act(async () => { await Promise.resolve(); });

    // Watchdog fires first while the redirect is still pending: the cue shows,
    // no error yet.
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByRole("status").textContent).toMatch(/taking longer than expected/i);
    expect(screen.queryByRole("alert")).toBeNull();

    // The failure then lands: the cue must be torn down as the error appears,
    // never coexisting with it.
    await act(async () => {
      resolveOAuth({ error: { message: "network blip" } });
      await Promise.resolve();
    });

    expect(bothCuesShown()).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't reach/i);
  });
});

// The partner sign in page shares this page's frame and got its own panel words (#4399) and
// a way to this page (#4411); this page keeps exactly what it had.
describe("LoginPage stays the staff page", () => {
  it("keeps the staff page's words on the photograph panel", () => {
    render(<LoginPage />);

    const welcome = screen.getByText("Welcome back.");
    expect(welcome.nextElementSibling?.textContent).toBe(
      "Manage your availability and let the right calls find you.",
    );
    expect(document.body.textContent).not.toMatch(/Booking for Pennie/);
  });

  // #4411: the partner page's way to the staff page is the partner page's alone.
  it("carries no link to itself", () => {
    render(<LoginPage />);

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Pennie staff\?/);
  });
});

// The callback bounces a refused sign-in here rather than throwing (#1648). What
// arrives is a code, so the page has to have copy for it: an unmapped code renders
// NOTHING, which leaves the person back on the sign-in screen with no explanation
// and the same button they just pressed.
describe("LoginPage sign-in error copy", () => {
  it("explains a refused provisioning as something to try again", () => {
    params.current = new URLSearchParams("error=provision_failed");
    render(<LoginPage />);

    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toMatch(/try signing in again/i);
    // Nothing technical, and nothing that reads as their account being wrong.
    expect(alert).not.toMatch(/error|failed|unwrap|constraint|organization/i);
  });

  it("explains an unconfigured sign-in domain as something an admin must fix (#3083)", () => {
    params.current = new URLSearchParams("error=sign_in_unavailable");
    render(<LoginPage />);

    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toMatch(/admin/i);
    expect(alert).not.toMatch(/GOOGLE_HOSTED_DOMAIN|env|configured/i);
  });

  // #3084: every reason the middleware can sign somebody out for lands here with its
  // own sentence, enumerated from the judge's own reasons so a new one cannot ship
  // without copy.
  it.each([
    ["time-box", /30 days/],
    ["idle", /7 days/],
    ["unstamped", /signed out/i],
  ] as const)("explains a session ended for %s in its own words", (reason, words) => {
    params.current = new URLSearchParams(`error=${sessionRefusalLoginError(reason)}`);
    render(<LoginPage />);

    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toMatch(words);
    expect(alert).toMatch(/sign in again/i);
  });

  // #4409: the partner sign in page now shows these same sentences, read from one shared
  // place. This page's words must come through that move character for character.
  it.each([
    ["time-box", "You were signed out because it has been 30 days since you signed in. Please sign in again."],
    ["idle", "You were signed out because Slate was not used on this device for 7 days. Please sign in again."],
    ["unstamped", "You were signed out. Please sign in again."],
  ] as const)("still says exactly what it always said for a session ended for %s", (reason, sentence) => {
    params.current = new URLSearchParams(`error=${sessionRefusalLoginError(reason)}`);
    render(<LoginPage />);

    expect(screen.getByRole("alert").textContent).toBe(sentence);
  });

  // #3526: a Google account that is not the one this Slate account was set up
  // with. Not a retry, which can never work; it names the person who can change
  // the answer, and says nothing about whose account it is.
  it("explains a different Google account as something an admin links, not a retry", () => {
    params.current = new URLSearchParams(`error=${GOOGLE_ACCOUNT_CHANGED_LOGIN_ERROR}`);
    render(<LoginPage />);

    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toBe(GOOGLE_ACCOUNT_CHANGED_MESSAGE);
    expect(alert).toMatch(/admin/i);
    expect(alert).not.toMatch(/try again|sign in again|sub\b|identifier/i);
  });

  it("explains two Google accounts on one sign in as something an admin sorts out, not a retry", () => {
    params.current = new URLSearchParams(`error=${SEVERAL_GOOGLE_ACCOUNTS_LOGIN_ERROR}`);
    render(<LoginPage />);

    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toBe(SEVERAL_GOOGLE_ACCOUNTS_MESSAGE);
    expect(alert).toMatch(/admin/i);
    expect(alert).not.toMatch(/try again|sign in again|try signing in/i);
  });

  // The code arrives in the address, so anybody can send a link carrying any value.
  // A lookup that walks the prototype found an OBJECT for these and React threw.
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "renders no banner, and does not crash, for the crafted code %s",
    (code) => {
      params.current = new URLSearchParams(`error=${code}`);
      expect(() => render(<LoginPage />)).not.toThrow();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("renders no banner for a code it has no copy for", () => {
    params.current = new URLSearchParams("error=not_a_real_code");
    render(<LoginPage />);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// #1046: signing in requests only what signing in needs.
//
// Slate reads calendars through domain-wide delegation with a service account, and
// stores no OAuth tokens for the person signing in (nothing anywhere reads
// provider_token). So a calendar.events scope on the login request is a write
// permission over every staff member's calendar that the app never exercises, asked
// for and re-consented at every sign-in.
//
// Asserted on the ARGUMENTS rather than on a rendered result, because that is where
// the request lives: nothing a person can see changes, so a scope creeping back in
// would be invisible to every other test in this file.
describe("what the sign-in asks Google for (#1046)", () => {
  function optionsFromClick() {
    signInWithOAuth.mockResolvedValue({ error: null });
    render(<LoginPage />);
    clickSignIn();
    const call = signInWithOAuth.mock.calls[0] as [
      { provider: string; options: { scopes?: string; queryParams?: Record<string, string>; redirectTo?: string } },
    ];
    return call[0];
  }

  it("asks for no calendar access at all", () => {
    const arg = optionsFromClick();

    expect(arg.provider).toBe("google");
    // Any calendar scope, not just the two that were here: the point is that this
    // request grants nothing over anybody's calendar.
    expect(arg.options.scopes ?? "").not.toMatch(/calendar/i);
  });

  it("does not ask for offline access or force a consent screen", () => {
    const arg = optionsFromClick();
    const qp = arg.options.queryParams ?? {};

    // access_type=offline asks for a refresh token nothing here stores, and
    // prompt=consent re-shows the grant screen to every person on every sign-in.
    expect(qp.access_type).toBeUndefined();
    expect(qp.prompt).toBeUndefined();
  });

  it("still sends the callback and the hosted-domain hint", () => {
    // The positive control. Stripping the scopes must not take the rest of the
    // request with it: without redirectTo the code never comes back, and the hd
    // hint is what puts a person on the Pennie account picker (the real domain gate
    // is server side, #589).
    const arg = optionsFromClick();

    expect(arg.options.redirectTo).toMatch(/\/api\/auth\/callback$/);
    const hd = process.env.NEXT_PUBLIC_GOOGLE_HOSTED_DOMAIN;
    if (hd) expect(arg.options.queryParams?.hd).toBe(hd);
  });
});

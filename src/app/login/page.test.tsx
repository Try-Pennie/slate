// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import LoginPage from "@/app/login/page";

// #626: signing in hands off to Google via a full-page redirect that can't be
// aborted. If that redirect wedges, the button must not sit on "Redirecting…"
// forever — a distinct still-alive cue with a retry appears at ~10s.
// #631: a signInWithOAuth that fails outright (returns an error or throws)
// must re-enable the button and surface an inline error immediately, not leave
// it stuck on "Redirecting…" until the watchdog eventually fires.

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const signInWithOAuth = vi.fn();
vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowser: () => ({ auth: { signInWithOAuth } }),
}));

afterEach(() => {
  signInWithOAuth.mockReset();
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

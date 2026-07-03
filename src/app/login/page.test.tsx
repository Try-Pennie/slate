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
});

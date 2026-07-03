import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import LoginPage from "@/app/login/page";

// #626: signing in hands off to Google via a full-page redirect that can't be
// aborted. If that redirect wedges, the button must not sit on "Redirecting…"
// forever — a distinct still-alive cue with a retry appears at ~10s.

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const signInWithOAuth = vi.fn(() => new Promise(() => {})); // never redirects
vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowser: () => ({ auth: { signInWithOAuth } }),
}));

afterEach(() => vi.useRealTimers());

describe("LoginPage", () => {
  it("shows a still-working cue with a retry when the OAuth redirect wedges", async () => {
    vi.useFakeTimers();
    render(<LoginPage />);

    fireEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(/taking longer than expected/i)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(10000); });

    expect(screen.getByRole("status").textContent).toMatch(/taking longer than expected/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    vi.useRealTimers();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// The one sign in button both sign in pages use (#4379): Google on /login, Microsoft on the
// partner page. Its states are pinned on each page's own tests; this pins what only the shared
// button decides, the mark that says which page a sign in started from. The callback reads it
// only where nothing better can say, a hand off that came back with no code or one that would
// not exchange, so the person lands back on the page whose button they pressed.
const signInWithOAuth = vi.fn();
vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowser: () => ({ auth: { signInWithOAuth } }),
}));

import { OAuthSignInButton } from "./OAuthSignInButton";
import { SIGN_IN_FROM_COOKIE } from "@/lib/auth/sign-in-page";

beforeEach(() => {
  cleanup();
  signInWithOAuth.mockReset();
  signInWithOAuth.mockResolvedValue({ error: null });
  document.cookie = `${SIGN_IN_FROM_COOKIE}=; path=/; max-age=0`;
});

async function press(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
  await act(async () => {
    await Promise.resolve();
  });
}

describe("which page a sign in started from", () => {
  it("is marked partner by the Microsoft button", async () => {
    render(<OAuthSignInButton provider="azure" />);
    await press(/continue with microsoft/i);
    expect(document.cookie).toContain(`${SIGN_IN_FROM_COOKIE}=partner`);
  });

  it("is cleared by the Google button, so a staff sign in after a partner one comes back to /login", async () => {
    render(<OAuthSignInButton provider="azure" />);
    await press(/continue with microsoft/i);
    cleanup();
    render(<OAuthSignInButton provider="google" />);
    await press(/continue with google/i);
    expect(document.cookie).not.toContain(`${SIGN_IN_FROM_COOKIE}=`);
  });

  it("is written before the redirect starts, since nothing runs on this page after it", async () => {
    let cookieAtCall = "";
    signInWithOAuth.mockImplementation(async () => {
      cookieAtCall = document.cookie;
      return { error: null };
    });
    render(<OAuthSignInButton provider="azure" />);
    await press(/continue with microsoft/i);
    expect(cookieAtCall).toContain(`${SIGN_IN_FROM_COOKIE}=partner`);
  });
});

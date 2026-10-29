// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// The partner sign in page (#4379), settled as docs/design/partner-sign-in.html: the call
// center partner's scheduling coordinators sign in here with their work Microsoft account.
//
// D1: one way in, Microsoft, and no Google button (staff keep /login, D3). D2: the heading and
// line, word for word. Every refusal the callback sends a Microsoft sign in back with lands HERE
// with its own sentence, and the button has the same three states as the staff page's: working,
// failed, and still working after ten seconds with a retry (#626, #631).
const hdrs = vi.hoisted(() => ({ host: "slate.trypennie.app" }));
vi.mock("next/headers", () => ({ headers: async () => new Map([["host", hdrs.host]]) }));

const signInWithOAuth = vi.fn();
vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowser: () => ({ auth: { signInWithOAuth } }),
}));

import PartnerSignInPage, { metadata, dynamic } from "./page";
import {
  MICROSOFT_ACCOUNT_CHANGED_LOGIN_ERROR,
  MICROSOFT_ACCOUNT_CHANGED_MESSAGE,
  MICROSOFT_NOT_INVITED_LOGIN_ERROR,
  MICROSOFT_NOT_INVITED_MESSAGE,
} from "@/lib/auth/microsoft-identity";
import { PARTNER_SIGN_IN_COPY, PARTNER_SIGN_IN_REFUSALS } from "@/lib/auth/partner-sign-in-copy";
import { SIGN_IN_FROM_COOKIE } from "@/lib/auth/sign-in-page";

const renderPage = async (sp: Record<string, string> = {}) =>
  render(await PartnerSignInPage({ searchParams: Promise.resolve(sp) }));

const microsoftButton = () => screen.getByRole("button", { name: /continue with microsoft/i });

beforeEach(() => {
  cleanup();
  signInWithOAuth.mockReset();
  hdrs.host = "slate.trypennie.app";
  delete process.env.SLATE_DESIGN_FIXTURES;
  document.cookie = `${SIGN_IN_FROM_COOKIE}=; path=/; max-age=0`;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the partner sign in page (#4379, D1 and D2)", () => {
  it("offers exactly one way in, Continue with Microsoft, and no Google button", async () => {
    await renderPage();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Continue with Microsoft");
    expect(document.body.textContent).not.toMatch(/google/i);
  });

  it("is headed Sign in to book calls, with the settled line under it", async () => {
    await renderPage();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Sign in to book calls");
    expect(h1.nextElementSibling?.textContent).toBe(
      "Sign in with your work Microsoft account to book calls for Pennie's customers.",
    );
    expect(PARTNER_SIGN_IN_COPY.heading).toBe(h1.textContent);
  });

  it("renders per request and names itself in the tab", () => {
    // A prerendered page carries no CSP nonce, so its scripts would all be refused (#2575).
    expect(dynamic).toBe("force-dynamic");
    // Its own tab title, the card's heading: /login's is "Sign in".
    expect(metadata.title).toBe(PARTNER_SIGN_IN_COPY.heading);
  });
});

describe("the refusals a Microsoft sign in comes back with", () => {
  it.each([
    [MICROSOFT_NOT_INVITED_LOGIN_ERROR, MICROSOFT_NOT_INVITED_MESSAGE],
    [MICROSOFT_ACCOUNT_CHANGED_LOGIN_ERROR, MICROSOFT_ACCOUNT_CHANGED_MESSAGE],
  ])("shows %s in its own words", async (code, sentence) => {
    await renderPage({ error: code });
    expect(screen.getByRole("alert").textContent).toBe(sentence);
  });

  it("sends somebody on a Pennie address to the staff sign in, by a link", async () => {
    await renderPage({ error: "domain_not_allowed" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Pennie staff sign in with Google/);
    const link = alert.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/login");
    // Still exactly one button: the way to the staff page is a link, never a Google button.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("gives every code the callback can send here a sentence of its own", async () => {
    // The codes the callback's Microsoft path refuses with, plus the two it sends before it
    // knows the provider. Each must render something, or the person is back on the page with
    // no explanation and the same button they just pressed.
    const codes = [
      MICROSOFT_NOT_INVITED_LOGIN_ERROR,
      MICROSOFT_ACCOUNT_CHANGED_LOGIN_ERROR,
      "domain_not_allowed",
      "account_deactivated",
      "placeholder_account",
      "sign_in_unavailable",
      "provision_failed",
      "exchange_failed",
      "missing_code",
    ];
    const seen = new Map<string, string>();
    for (const code of codes) {
      cleanup();
      await renderPage({ error: code });
      seen.set(code, screen.getByRole("alert").textContent ?? "");
    }
    expect(Object.keys(PARTNER_SIGN_IN_REFUSALS).sort()).toEqual([...codes].sort());
    // Distinct causes, distinct messages (L11): only the two incomplete hand offs share one.
    const settled = codes.filter((c) => c !== "exchange_failed" && c !== "missing_code");
    expect(new Set(settled.map((c) => seen.get(c))).size).toBe(settled.length);
    // Written for a partner: nobody here can ask "a Slate admin", and nothing says Google but
    // the one line pointing a Pennie address at the staff page.
    for (const [code, text] of seen) {
      expect(text, code).not.toMatch(/Slate admin/);
      if (code !== "domain_not_allowed") expect(text, code).not.toMatch(/google/i);
    }
  });

  it.each(["__proto__", "constructor", "toString", "not_a_real_code"])(
    "renders no banner, and does not crash, for the code %s",
    async (code) => {
      await renderPage({ error: code });
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
});

describe("the Microsoft button", () => {
  async function clickWith(result: () => Promise<unknown>) {
    signInWithOAuth.mockImplementation(result);
    await renderPage();
    fireEvent.click(microsoftButton());
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("asks Supabase for Microsoft, the email scope alone, and the one callback", async () => {
    await clickWith(async () => ({ error: null }));
    expect(signInWithOAuth).toHaveBeenCalledTimes(1);
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "azure",
      options: { scopes: "email", redirectTo: `${window.location.origin}/api/auth/callback` },
    });
  });

  it("marks this browser as signing in from the partner page, so a failed hand off comes back here", async () => {
    await clickWith(async () => ({ error: null }));
    expect(document.cookie).toContain(`${SIGN_IN_FROM_COOKIE}=partner`);
  });

  it("stays in the redirecting state on success", async () => {
    await clickWith(async () => ({ error: null }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: /redirecting/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("re-enables the button and says so when Supabase returns an error", async () => {
    await clickWith(async () => ({ error: { message: "network blip" } }));
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't reach/i);
    expect((microsoftButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("re-enables the button and says so when the call throws", async () => {
    await clickWith(async () => {
      throw new Error("network down");
    });
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't reach/i);
    expect((microsoftButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a still working cue with a retry when the redirect wedges", async () => {
    vi.useFakeTimers();
    await clickWith(() => new Promise(() => {}));
    expect(screen.queryByText(/taking longer than expected/i)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByRole("status").textContent).toMatch(/taking longer than expected/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(signInWithOAuth).toHaveBeenCalledTimes(2);
  });
});

describe("the design's frame (?frame=)", () => {
  const themeScripts = () =>
    Array.from(document.querySelectorAll("script")).filter((s) => /data-theme|dataset\.theme|setAttribute/.test(s.textContent ?? ""));

  it("is never drawn from a deployment", async () => {
    process.env.SLATE_DESIGN_FIXTURES = "1";
    hdrs.host = "slate.trypennie.app";
    await renderPage({ frame: "f1" });
    expect(themeScripts()).toHaveLength(0);
  });

  it("draws the settled frame, in the light theme, on this machine behind the flag", async () => {
    process.env.SLATE_DESIGN_FIXTURES = "1";
    hdrs.host = "localhost:3000";
    await renderPage({ frame: "f1" });
    expect(themeScripts().length).toBe(1);
    expect(themeScripts()[0]!.textContent).toContain("light");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

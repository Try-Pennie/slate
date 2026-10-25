// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The account menu reaches two server actions and a portalled panel. Only the
// actions need mocking: the panel is real, because whether the theme control is
// in it is exactly what these assert.
vi.mock("@/app/theme-actions", () => ({ setThemePreference: vi.fn() }));
vi.mock("@/app/auth-actions", () => ({ signOut: vi.fn() }));

import { AccountMenu } from "@/components/AccountMenu";
import { labelInNameMismatches } from "@/components/ui/label-in-name.test-support";

// #2100: while an admin is viewing as somebody else, the theme control read the
// IMPERSONATED person's preference and wrote the ADMIN's account. Each half was
// defensible alone (the page shows who you are viewing as; an admin must not
// rewrite somebody else's theme) and together they could never agree, so the
// control showed a value it could not change and every change was invisible to
// it. Dan settled it on 2026-09-08: the control is absent while impersonating.

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  document.documentElement.removeAttribute("data-theme");
  document.cookie = "slate-theme=; path=/; max-age=0";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openMenu(props: Partial<Parameters<typeof AccountMenu>[0]> = {}) {
  render(
    <AccountMenu
      email="admin@trypennie.com"
      role="admin"
      themePreference="light"
      calendar="na"
      {...props}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /account and settings/i }));
}

describe("AccountMenu", () => {
  it("offers the theme control when you are signed in as yourself", async () => {
    await openMenu();

    expect(screen.getByRole("radiogroup", { name: /theme/i })).toBeTruthy();
  });

  it("has no theme control at all while viewing as somebody else", async () => {
    await openMenu({ impersonating: true });

    expect(screen.queryByRole("radiogroup", { name: /theme/i })).toBeNull();
    // Not merely hidden or disabled: a control that is present and refuses is a
    // control somebody presses twice before reading anything (L109).
    expect(screen.queryByRole("radio", { name: /^light$/i })).toBeNull();
  });

  it("still shows who you are viewing as, and the way out is elsewhere", async () => {
    await openMenu({ impersonating: true, email: "agent@trypennie.com" });

    // Removing the control must not remove the menu: the identity it names is
    // how somebody checks who they are currently acting as.
    expect(screen.getByText("agent@trypennie.com")).toBeTruthy();
  });
});

// #3917 (L786): with no photo the trigger DRAWS the initials, and a person driving
// by voice says what they see ("click AD"), so the button's name must contain them.
describe("AccountMenu trigger name", () => {
  it("contains the initials it draws when there is no photo", () => {
    const { container } = render(
      <AccountMenu email="admin@trypennie.com" role="admin" themePreference="light" calendar="na" photoSrc={null} />,
    );
    expect(container.textContent).toContain("AD");
    expect(labelInNameMismatches(container)).toEqual([]);
    expect(screen.getByRole("button", { name: /account and settings/i })).toBeTruthy();
  });

  it("keeps the same name over a photo, where nothing is drawn in words", () => {
    const { container } = render(
      <AccountMenu email="admin@trypennie.com" role="admin" themePreference="light" calendar="na" photoSrc="/p.jpg" />,
    );
    expect(labelInNameMismatches(container)).toEqual([]);
    expect(screen.getByRole("button", { name: /account and settings/i })).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// #1746: the theme control was a native <select> mounted INSIDE the already-open
// account menu, so choosing a theme opened a browser-drawn popup over the app's
// own popup. Nothing about that second layer can be styled, so it read as a piece
// of the operating system pasted into Slate.
//
// The replacement is an inline segmented radio group. These tests pin the four
// behaviours that are easy to lose in a restyle (instant apply, the no-flash
// cookie, the account persist, and live tracking while on System), the
// accessibility contract, and the failure path where the persist rejects.

const actions = vi.hoisted(() => ({ setThemePreference: vi.fn() }));
vi.mock("@/app/theme-actions", () => actions);

import { ThemeToggle } from "@/components/ThemeToggle";

/** jsdom implements no matchMedia, and this control's System state depends on it. */
function stubMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => mql));
  return {
    /** Flip the device and fire the change, as the OS would. */
    flip(next: boolean) {
      mql.matches = next;
      act(() => {
        for (const fn of listeners) fn();
      });
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.setThemePreference.mockResolvedValue(undefined);
  document.documentElement.removeAttribute("data-theme");
  document.cookie = "slate-theme=; path=/; max-age=0";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThemeToggle", () => {
  it("is a radio group named Theme, not a dropdown", () => {
    stubMatchMedia(false);
    const { container } = render(<ThemeToggle preference="light" />);

    // The whole point of #1746: no second, browser-drawn layer.
    expect(container.querySelector("select")).toBeNull();
    const group = screen.getByRole("radiogroup", { name: /theme/i });
    expect(group).toBeTruthy();
  });

  it("offers System, Light and Dark as three visible segments", () => {
    stubMatchMedia(false);
    render(<ThemeToggle preference="light" />);

    for (const name of [/^system$/i, /^light$/i, /^dark$/i]) {
      expect(screen.getByRole("radio", { name })).toBeTruthy();
    }
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("marks the account's current preference as the checked segment", () => {
    stubMatchMedia(false);
    render(<ThemeToggle preference="dark" />);

    // No jest-dom in this repo (it would load into every jsdom file), so the
    // native property is read directly.
    const checkedOf = (name: RegExp) =>
      (screen.getByRole("radio", { name }) as HTMLInputElement).checked;
    expect(checkedOf(/^dark$/i)).toBe(true);
    expect(checkedOf(/^light$/i)).toBe(false);
    expect(checkedOf(/^system$/i)).toBe(false);
  });

  it("groups the three segments under one name, which is what gives the browser arrow-key navigation", () => {
    // jsdom implements no arrow-key roving for radios, so the behaviour itself
    // cannot be driven here. A shared `name` is the mechanism the browser uses
    // to provide it (and to enforce single selection), so that is what is pinned.
    stubMatchMedia(false);
    render(<ThemeToggle preference="system" />);

    const names = new Set(
      screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).name),
    );
    expect(names.size).toBe(1);
    expect([...names][0]).toBeTruthy();
  });

  it("shows the selection by weight as well as colour", () => {
    stubMatchMedia(false);
    render(<ThemeToggle preference="dark" />);

    // Colour alone must not carry the state (WCAG 1.4.1). The checked segment's
    // label differs from an unchecked one in font weight, a non-colour property.
    const checked = screen.getByRole("radio", { name: /^dark$/i });
    const unchecked = screen.getByRole("radio", { name: /^light$/i });
    const weightOf = (el: HTMLElement) =>
      [...(el.closest("label")?.querySelector("span")?.classList ?? [])].filter((c) =>
        c.includes("font-"),
      );
    expect(weightOf(checked)).not.toEqual(weightOf(unchecked));
  });

  it("applies the chosen theme to the document root immediately", async () => {
    stubMatchMedia(false);
    render(<ThemeToggle preference="light" />);

    await userEvent.click(screen.getByRole("radio", { name: /^dark$/i }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("writes the slate-theme cookie so the next load does not flash", async () => {
    stubMatchMedia(false);
    render(<ThemeToggle preference="light" />);

    await userEvent.click(screen.getByRole("radio", { name: /^dark$/i }));

    expect(document.cookie).toContain("slate-theme=dark");
  });

  it("persists the choice to the account", async () => {
    stubMatchMedia(false);
    render(<ThemeToggle preference="light" />);

    await userEvent.click(screen.getByRole("radio", { name: /^dark$/i }));

    expect(actions.setThemePreference).toHaveBeenCalledWith("dark");
  });

  it("resolves System against the device rather than to a fixed theme", () => {
    stubMatchMedia(true);
    render(<ThemeToggle preference="system" />);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("keeps following the device while on System", () => {
    const media = stubMatchMedia(false);
    render(<ThemeToggle preference="system" />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    media.flip(true);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("stops following the device once an explicit theme is chosen", async () => {
    const media = stubMatchMedia(false);
    render(<ThemeToggle preference="system" />);

    await userEvent.click(screen.getByRole("radio", { name: /^light$/i }));
    media.flip(true);

    // Pinned to light: a device flip must not move an explicit choice.
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("still applies and remembers the theme locally when the account persist fails", async () => {
    stubMatchMedia(false);
    actions.setThemePreference.mockRejectedValue(new Error("offline"));
    render(<ThemeToggle preference="light" />);

    // A rejected persist must not throw out of the click handler, and must not
    // undo the local apply: the worst case is that the NEXT device starts from
    // the account's old value, not that this one stops working.
    await userEvent.click(screen.getByRole("radio", { name: /^dark$/i }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.cookie).toContain("slate-theme=dark");
  });

  it("gives every segment a 44px target", () => {
    stubMatchMedia(false);
    render(<ThemeToggle preference="light" />);

    for (const radio of screen.getAllByRole("radio")) {
      const label = radio.closest("label");
      expect([...(label?.classList ?? [])].join(" ")).toMatch(/min-h-11|h-11/);
    }
  });
});

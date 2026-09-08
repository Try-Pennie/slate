// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";

import { ThemeSync } from "@/components/ThemeSync";

// #2100. Following the device while somebody is on System used to live INSIDE
// the theme control, which lives inside the account menu, which renders nothing
// while closed. So the one thing that had to be alive for the whole visit only
// existed while a popup was open, and its mount effect re-applied a stale value
// every time that popup reopened, undoing whatever the person had just chosen.
//
// It lives here now: always mounted, never in a panel, and it reads the CURRENT
// preference from the cookie at the moment the device changes rather than
// holding a copy from when the page was rendered.

/** jsdom implements no matchMedia, and the whole point of this component is one. */
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
  document.documentElement.removeAttribute("data-theme");
  document.cookie = "slate-theme=; path=/; max-age=0";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThemeSync", () => {
  it("repaints when the device flips and the preference is System", () => {
    const media = stubMatchMedia(false);
    render(<ThemeSync preference="system" />);

    media.flip(true);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("leaves an explicit choice alone when the device flips", () => {
    // The state that matters: the page was rendered for somebody on System, and
    // they have since chosen Light. The server prop still says system, so a
    // component holding that copy would repaint dark underneath them.
    const media = stubMatchMedia(false);
    document.cookie = "slate-theme=light; path=/";
    // What the choice already left on the document, as the control does.
    document.documentElement.setAttribute("data-theme", "light");
    render(<ThemeSync preference="system" />);

    media.flip(true);

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("does not repaint for somebody whose preference is an explicit theme", () => {
    const media = stubMatchMedia(false);
    document.cookie = "slate-theme=dark; path=/";
    // What the header's boot script left on the document before the first paint.
    document.documentElement.setAttribute("data-theme", "dark");
    render(<ThemeSync preference="dark" />);

    media.flip(true);
    media.flip(false);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("paints nothing at all until the device actually changes", () => {
    // The theme is already on the document before this ever runs: the header's
    // boot script applies it before the first paint. Repainting on mount would
    // be the defect this component was extracted from.
    stubMatchMedia(true);
    document.documentElement.setAttribute("data-theme", "light");

    render(<ThemeSync preference="system" />);

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("stops listening when it unmounts", () => {
    const media = stubMatchMedia(false);
    const view = render(<ThemeSync preference="system" />);
    expect(media.listenerCount()).toBe(1);

    view.unmount();

    expect(media.listenerCount()).toBe(0);
  });
});

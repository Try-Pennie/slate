// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Drives the real widget.js IIFE in jsdom.
// #593: slate:resize was applied from ANY frame/origin (unlike the
// success/escape branches, which require e.source === the active iframe).
// #628: the modal loader spun forever with no timeout/failure if the iframe
// never loaded — it must convert to a plain-language error + retry.

// Vitest runs from the repo root; read the shipped IIFE verbatim.
const widgetSrc = readFileSync(resolve("public/widget.js"), "utf8");

// Load the IIFE ONCE for the file: it attaches document/window listeners, so
// re-evaluating per test would stack duplicate handlers (one click → N modals).
beforeAll(() => {
  delete (window as unknown as { Cal?: unknown }).Cal;
  new Function(widgetSrc)();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function openModal(): HTMLIFrameElement {
  const trigger = document.createElement("button");
  trigger.setAttribute("data-cal-link", "router?xbc=411");
  document.body.appendChild(trigger);
  trigger.click(); // delegated listener builds the modal
  return document.querySelector("iframe") as HTMLIFrameElement;
}

const loaderEl = () =>
  document.querySelector<HTMLElement>(".slate-widget-loader");
const retryBtn = () =>
  Array.from(document.querySelectorAll("button")).find((b) =>
    /try again/i.test(b.textContent || ""),
  );

describe("widget.js resize source guard (#593)", () => {
  it("honors slate:resize only from the active iframe's window", () => {
    const iframe = openModal();
    expect(iframe).toBeTruthy();

    // A spoofed resize from some OTHER window must be ignored.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "slate:resize", height: 999 },
        source: window as Window, // not the active iframe
      }),
    );
    expect(iframe.style.height).toBe("");

    // A resize from the active iframe's contentWindow is applied.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "slate:resize", height: 640 },
        source: iframe.contentWindow,
      }),
    );
    expect(iframe.style.height).toBe("640px");
  });
});

describe("widget.js loader timeout + retry (#628)", () => {
  it("converts the spinner to an error with a retry after the load timeout", () => {
    vi.useFakeTimers();
    const iframe = openModal();

    // Starts in the loading state.
    expect(loaderEl()).toBeTruthy();
    expect(loaderEl()!.getAttribute("role")).toBe("status");
    expect(retryBtn()).toBeUndefined();

    // The iframe never fires load; the timeout must convert it.
    vi.advanceTimersByTime(12000);

    const loader = loaderEl();
    expect(loader).toBeTruthy(); // still shown, now as an error
    expect(loader!.getAttribute("role")).toBe("alert");
    expect(loader!.textContent || "").toMatch(/couldn.t load|try again/i);
    expect(retryBtn()).toBeTruthy();
    // Iframe is retained (retry reloads it), not blanked.
    expect(iframe.getAttribute("src")).toMatch(/\/book\?/);
  });

  it("retry returns to loading and re-arms the timeout", () => {
    vi.useFakeTimers();
    openModal();
    vi.advanceTimersByTime(12000);
    expect(retryBtn()).toBeTruthy();

    retryBtn()!.click();

    // Back to loading, error cleared.
    expect(loaderEl()!.getAttribute("role")).toBe("status");
    expect(retryBtn()).toBeUndefined();

    // The timer is re-armed: waiting again re-shows the error.
    vi.advanceTimersByTime(12000);
    expect(loaderEl()!.getAttribute("role")).toBe("alert");
    expect(retryBtn()).toBeTruthy();
  });

  it("clears the timeout on successful load (no error)", () => {
    vi.useFakeTimers();
    const iframe = openModal();

    iframe.dispatchEvent(new Event("load"));
    expect(loaderEl()).toBeNull(); // loader removed on load

    vi.advanceTimersByTime(30000);
    expect(loaderEl()).toBeNull();
    expect(retryBtn()).toBeUndefined();
  });

  it("still converts to the error under reduced motion", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    })) as unknown as typeof window.matchMedia;
    try {
      vi.useFakeTimers();
      openModal();
      // Reduced motion uses the plain "Loading…" text, still role=status.
      expect(loaderEl()!.getAttribute("role")).toBe("status");
      expect(loaderEl()!.textContent || "").toMatch(/loading/i);

      vi.advanceTimersByTime(12000);
      expect(loaderEl()!.getAttribute("role")).toBe("alert");
      expect(retryBtn()).toBeTruthy();
    } finally {
      window.matchMedia = original;
    }
  });
});

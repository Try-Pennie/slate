// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMBED_MESSAGE, LINK_FAILED } from "@/lib/embed/lifecycle-events";

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

// #251: prefetch availability so the picker feels instant on open. widget.js
// warms GET <origin>/api/availability?bucket=<xbc> on trigger intent (and on
// render), fire-and-forget, before the modal opens. It must never throw into the
// host page and must warm each bucket at most once.
describe("widget.js availability prefetch (#251)", () => {
  it("warms /api/availability on trigger intent (pointerover), once per bucket", () => {
    const fetchSpy = vi.fn((..._args: unknown[]) => Promise.resolve({} as Response));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const trigger = document.createElement("button");
    trigger.setAttribute("data-cal-link", "router?xbc=771");
    document.body.appendChild(trigger);

    trigger.dispatchEvent(new Event("pointerover", { bubbles: true }));

    const calls = fetchSpy.mock.calls.filter((c) =>
      /\/api\/availability\?bucket=771$/.test(String(c[0])),
    );
    expect(calls).toHaveLength(1);

    // A second intent event must NOT re-warm the same bucket.
    trigger.dispatchEvent(new Event("focusin", { bubbles: true }));
    const after = fetchSpy.mock.calls.filter((c) =>
      /\/api\/availability\?bucket=771$/.test(String(c[0])),
    );
    expect(after).toHaveLength(1);
  });

  it("does not warm when the trigger carries no bucket (xbc)", () => {
    const fetchSpy = vi.fn((..._args: unknown[]) => Promise.resolve({} as Response));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const trigger = document.createElement("button");
    trigger.setAttribute("data-cal-link", "router?form=abc"); // no xbc
    document.body.appendChild(trigger);

    trigger.dispatchEvent(new Event("pointerover", { bubbles: true }));

    const calls = fetchSpy.mock.calls.filter((c) => /\/api\/availability/.test(String(c[0])));
    expect(calls).toHaveLength(0);
  });
});

describe("widget.js error beacon (#1368)", () => {
  // If widget.js throws while opening the modal, the customer taps the button and
  // nothing happens. No request reaches Slate, so every server side detector stays
  // green while the booking is lost. This is the only signal for that.
  //
  // Deliberately NOT a window.onerror: widget.js runs in the HOST page, where a
  // global handler would collect trypennie's own errors rather than Slate's.

  function withBrokenModal(run: () => void): void {
    // Break something openModal touches, so the delegated handler throws.
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag === "iframe") throw new Error("iframe blocked by host CSP");
      return original(tag);
    }) as typeof document.createElement);
    try {
      run();
    } finally {
      vi.mocked(document.createElement).mockRestore();
    }
  }

  it("reports a throw from the modal trigger instead of failing silently", () => {
    const beacon = vi.fn((_url: string, _body?: BodyInit) => true);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    (window as unknown as { Cal: (...a: unknown[]) => void }).Cal("init", "", {
      origin: "https://slate.example",
    });

    withBrokenModal(() => {
      const trigger = document.createElement("button");
      trigger.setAttribute("data-cal-link", "router?xbc=411");
      document.body.appendChild(trigger);
      // The host page must not see the throw either.
      expect(() => trigger.click()).not.toThrow();
    });

    expect(beacon).toHaveBeenCalled();
    const [url] = beacon.mock.calls[0];
    expect(String(url)).toBe("https://slate.example/api/client-errors");
    vi.unstubAllGlobals();
  });

  it("does not report anything while the modal opens normally", () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    openModal();
    expect(beacon).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// #2658: the booker lifecycle, announced under cal.com's own event names so the
// host's one GTM listener needs no Slate branch. The raw `slate:*` names are what
// the Booker posts; the widget maps each onto cal.com's name. The mapping is
// pinned from BOTH sides: the constants imported above are what the Booker uses,
// and the assertions read what the real widget.js emits.
type CalFn = (method: string, args: { action: string; callback: (e: unknown) => void }) => void;
type Emitted = { detail: { type: string; data: unknown } };

/** Register a fresh listener on the global `Cal("on", ...)` surface. */
function calOn(action: string) {
  const cb = vi.fn<(e: Emitted) => void>();
  (window as unknown as { Cal: CalFn }).Cal("on", { action, callback: cb as (e: unknown) => void });
  return cb;
}

let nsSeq = 0;
/** Open the modal under a namespace nobody else in this file has used, so the
 *  per namespace open count starts at zero for this test. */
function openModalIn(ns: string): HTMLIFrameElement {
  const trigger = document.createElement("button");
  trigger.setAttribute("data-cal-link", "router?xbc=411");
  trigger.setAttribute("data-cal-namespace", ns);
  document.body.appendChild(trigger);
  trigger.click();
  return document.querySelector("iframe") as HTMLIFrameElement;
}
const freshNs = () => `lifecycle-${++nsSeq}`;

function closeModal() {
  (document.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click();
}

function fromActiveFrame(iframe: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: iframe.contentWindow }));
}

const eventsOf = (cb: ReturnType<typeof calOn>) => cb.mock.calls.map((c) => c[0].detail);

describe("widget.js booker lifecycle events (#2658)", () => {
  it("delivers every event to an on('*') wildcard listener, each carrying its own type", () => {
    const all = calOn("*");
    const iframe = openModalIn(freshNs());
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookerViewed, data: { slotsLoaded: false } });
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookerReady, data: { slotsLoaded: true } });
    const types = eventsOf(all).map((d) => d.type);
    expect(types).toContain("navigatedToBooker");
    expect(types).toContain("bookerViewed");
    expect(types).toContain("bookerReady");
  });

  it("announces navigatedToBooker when a trigger is clicked, before the modal opens", () => {
    const navigated = calOn("navigatedToBooker");
    let modalAtEmit: Element | null = "unset" as unknown as Element;
    navigated.mockImplementation(() => {
      modalAtEmit = document.querySelector(".slate-widget-modal");
    });
    openModalIn(freshNs());
    expect(navigated).toHaveBeenCalledTimes(1);
    expect(eventsOf(navigated)[0]).toEqual({ type: "navigatedToBooker", data: {} });
    expect(modalAtEmit).toBeNull();
  });

  it("announces bookerReopened on the second open of a namespace only, never the first", () => {
    const reopened = calOn("bookerReopened");
    const ns = freshNs();
    openModalIn(ns);
    expect(reopened).not.toHaveBeenCalled();
    closeModal();
    openModalIn(ns);
    expect(reopened).toHaveBeenCalledTimes(1);
    expect(eventsOf(reopened)[0]).toEqual({ type: "bookerReopened", data: {} });
  });

  it("announces bookerReloaded on the iframe's second load only, never the first", () => {
    const reloaded = calOn("bookerReloaded");
    const iframe = openModalIn(freshNs());
    iframe.dispatchEvent(new Event("load"));
    expect(reloaded).not.toHaveBeenCalled();
    iframe.dispatchEvent(new Event("load"));
    expect(reloaded).toHaveBeenCalledTimes(1);
    expect(eventsOf(reloaded)[0]).toEqual({ type: "bookerReloaded", data: {} });
  });

  it("re-emits the Booker's bookerViewed, bookerReady, linkFailed and bookingCancelled under cal.com's names", () => {
    const viewed = calOn("bookerViewed");
    const ready = calOn("bookerReady");
    const failed = calOn("linkFailed");
    const cancelled = calOn("bookingCancelled");
    const iframe = openModalIn(freshNs());

    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookerViewed, data: { slotsLoaded: false } });
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookerReady, data: { slotsLoaded: true } });
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.linkFailed, data: LINK_FAILED.availabilityFailed });
    const booking = {
      uid: "bk-1",
      startTime: "2026-10-01T15:00:00.000Z",
      endTime: "2026-10-01T15:30:00.000Z",
      cancellationReason: "schedule_conflict",
    };
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookingCancelled, data: { booking } });

    expect(eventsOf(viewed)).toEqual([{ type: "bookerViewed", data: { slotsLoaded: false } }]);
    expect(eventsOf(ready)).toEqual([{ type: "bookerReady", data: { slotsLoaded: true } }]);
    expect(eventsOf(failed)).toEqual([
      { type: "linkFailed", data: { code: "availability_failed", msg: LINK_FAILED.availabilityFailed.msg } },
    ]);
    expect(eventsOf(cancelled)).toEqual([{ type: "bookingCancelled", data: { booking } }]);
  });

  it("ignores a lifecycle message from any window but the active iframe (parity with #593)", () => {
    const viewed = calOn("bookerViewed");
    const cancelled = calOn("bookingCancelled");
    openModalIn(freshNs());
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: EMBED_MESSAGE.bookerViewed, data: { slotsLoaded: true } },
        source: window as Window,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: EMBED_MESSAGE.bookingCancelled, data: { booking: { uid: "spoof" } } },
        source: window as Window,
      }),
    );
    expect(viewed).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
  });

  const successData = (outcome: string) => ({
    booking: {
      id: "bk-9",
      startsAt: "2026-10-01T15:00:00.000Z",
      endsAt: "2026-10-01T15:30:00.000Z",
      manageUrl: "https://slate.test/booking/manage/t",
      isTest: true,
    },
    salesforceId: "003xx",
    outcome,
  });
  const v2Shape = {
    uid: "bk-9",
    startTime: "2026-10-01T15:00:00.000Z",
    endTime: "2026-10-01T15:30:00.000Z",
    status: "confirmed",
    isTest: true,
  };

  it("keeps bookingSuccessful byte for byte and derives bookingSuccessfulV2 from outcome created", () => {
    const legacy = calOn("bookingSuccessful");
    const v2 = calOn("bookingSuccessfulV2");
    const movedV2 = calOn("rescheduleBookingSuccessfulV2");
    const iframe = openModalIn(freshNs());
    const data = successData("created");
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookingSuccessful, data });

    expect(eventsOf(legacy)).toEqual([{ type: "bookingSuccessful", data }]);
    expect(eventsOf(v2)).toEqual([{ type: "bookingSuccessfulV2", data: v2Shape }]);
    expect(movedV2).not.toHaveBeenCalled();
  });

  it("announces a moved call as rescheduleBookingSuccessfulV2 and NEVER as bookingSuccessfulV2", () => {
    const legacy = calOn("bookingSuccessful");
    const v2 = calOn("bookingSuccessfulV2");
    const movedV2 = calOn("rescheduleBookingSuccessfulV2");
    const iframe = openModalIn(freshNs());
    const data = successData("rescheduled");
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookingSuccessful, data });

    expect(eventsOf(legacy)).toEqual([{ type: "bookingSuccessful", data }]);
    expect(v2).not.toHaveBeenCalled();
    expect(eventsOf(movedV2)).toEqual([{ type: "rescheduleBookingSuccessfulV2", data: v2Shape }]);
  });

  it("derives neither V2 event from an outcome it does not know, while still keeping bookingSuccessful", () => {
    const legacy = calOn("bookingSuccessful");
    const v2 = calOn("bookingSuccessfulV2");
    const movedV2 = calOn("rescheduleBookingSuccessfulV2");
    const iframe = openModalIn(freshNs());
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookingSuccessful, data: successData("something-else") });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(v2).not.toHaveBeenCalled();
    expect(movedV2).not.toHaveBeenCalled();
  });

  it("announces linkFailed itself when the iframe never loads, with the widget's own code", () => {
    vi.useFakeTimers();
    const failed = calOn("linkFailed");
    openModalIn(freshNs());
    vi.advanceTimersByTime(12000);
    expect(eventsOf(failed)).toHaveLength(1);
    expect(eventsOf(failed)[0].type).toBe("linkFailed");
    const data = eventsOf(failed)[0].data as { code: string; msg: string };
    expect(data.code).toBe("load_timeout");
    expect(data.msg.length).toBeGreaterThan(0);
  });

  it("announces linkFailed when the iframe reports a load error", () => {
    const failed = calOn("linkFailed");
    const iframe = openModalIn(freshNs());
    iframe.dispatchEvent(new Event("error"));
    expect(eventsOf(failed)).toHaveLength(1);
    expect((eventsOf(failed)[0].data as { code: string }).code).toBe("load_error");
  });
});

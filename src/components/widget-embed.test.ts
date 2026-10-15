// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMBED_MESSAGE, INLINE_PIECES, LINK_FAILED, PIECE_MESSAGE } from "@/lib/embed/lifecycle-events";
import { PARTNER_KEYS } from "@/lib/booking/partner-keys";

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

/** The overlay currently on screen; a hidden one carries aria-hidden="true". */
const SHOWN_OVERLAY = '.slate-widget-overlay:not([aria-hidden="true"])';
const shownOverlay = () => document.querySelector<HTMLElement>(SHOWN_OVERLAY);
const shownIframe = () =>
  document.querySelector<HTMLIFrameElement>(`${SHOWN_OVERLAY} iframe`);

afterEach(() => {
  vi.useRealTimers();
  // Close whatever is still open before wiping the body (#2678): a frame is kept
  // hidden across close and reopen now, so an open modal left behind would keep
  // its document keydown listener and its scroll lock into the next test.
  document
    .querySelectorAll<HTMLButtonElement>(`${SHOWN_OVERLAY} button[aria-label="Close"]`)
    .forEach((b) => b.click());
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
      // #2750: the booking's OWN ids as stored, deliberately unlike the page's
      // below, so a payload that took the page's id cannot pass.
      salesforceId: "00QOriginal0001",
      externalId: "00QOriginalExt1",
    },
    salesforceId: "00QSecondPage01",
    outcome,
  });
  const v2Shape = {
    uid: "bk-9",
    startTime: "2026-10-01T15:00:00.000Z",
    endTime: "2026-10-01T15:30:00.000Z",
    status: "confirmed",
    isTest: true,
    salesforceId: "00QOriginal0001",
    externalId: "00QOriginalExt1",
  };

  // #2750: a lead who submits twice holds two lead records, and moving the call
  // they already had from the second page keeps the call on the FIRST lead. The
  // host's confirmed page looks the booking up by id AND lead id, and the lookup
  // refuses a booking the id it is given does not own (#2657), so the event must
  // carry the booking's own lead id while the message's page level salesforceId
  // stays the page's.
  it("carries the moved call's ORIGINAL lead id on the V2 event, and the page's on the raw message", () => {
    const legacy = calOn("bookingSuccessful");
    const movedV2 = calOn("rescheduleBookingSuccessfulV2");
    const iframe = openModalIn(freshNs());
    const data = successData("rescheduled");
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookingSuccessful, data });

    const [raw] = eventsOf(legacy) as Array<{ data: typeof data }>;
    expect(raw.data.salesforceId).toBe("00QSecondPage01");
    expect(raw.data.booking.salesforceId).toBe("00QOriginal0001");
    const [moved] = eventsOf(movedV2) as Array<{ data: { salesforceId: string; externalId: string } }>;
    expect(moved.data.salesforceId).toBe("00QOriginal0001");
    expect(moved.data.externalId).toBe("00QOriginalExt1");
  });

  it("answers null for a booking id the response lacks, and never borrows the page's", () => {
    const v2 = calOn("bookingSuccessfulV2");
    const iframe = openModalIn(freshNs());
    const data = successData("created");
    const booking: Record<string, unknown> = { ...data.booking };
    delete booking.salesforceId;
    delete booking.externalId;
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookingSuccessful, data: { ...data, booking } });

    const [fresh] = eventsOf(v2) as Array<{ data: Record<string, unknown> }>;
    expect(fresh.data).toHaveProperty("salesforceId", null);
    expect(fresh.data).toHaveProperty("externalId", null);
  });

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

// #2678: one frame per namespace, kept across close and reopen the way cal.com
// keeps its pre-rendered modal. hide() hides the overlay instead of removing it,
// so a reopen for the same link shows the SAME iframe: the Booker inside keeps
// its chosen day, time and typed details, and bookerViewed / bookerReady fire
// once per page load instead of once per open. #2677 rides along: the open is
// counted after it succeeded, never before a call that can throw.
describe("widget.js keeps the modal frame across close and reopen (#2678, #2677)", () => {
  function clickTrigger(ns: string, link = "router?xbc=411"): HTMLButtonElement {
    const trigger = document.createElement("button");
    trigger.setAttribute("data-cal-link", link);
    trigger.setAttribute("data-cal-namespace", ns);
    document.body.appendChild(trigger);
    trigger.click();
    return trigger;
  }
  const closeShown = () =>
    (document.querySelector(`${SHOWN_OVERLAY} button[aria-label="Close"]`) as HTMLButtonElement).click();
  const overlayOf = (iframe: HTMLIFrameElement) =>
    iframe.closest(".slate-widget-overlay") as HTMLElement;

  it("reopening the same link shows the same iframe and announces only navigatedToBooker and bookerReopened", () => {
    const navigated = calOn("navigatedToBooker");
    const viewed = calOn("bookerViewed");
    const ready = calOn("bookerReady");
    const reopened = calOn("bookerReopened");
    const reloaded = calOn("bookerReloaded");
    const ns = freshNs();

    clickTrigger(ns);
    const first = shownIframe()!;
    first.dispatchEvent(new Event("load"));
    fromActiveFrame(first, { type: EMBED_MESSAGE.bookerViewed, data: { slotsLoaded: false } });
    fromActiveFrame(first, { type: EMBED_MESSAGE.bookerReady, data: { slotsLoaded: true } });
    closeShown();
    clickTrigger(ns);

    // The very same element, not a new one built from the same link.
    expect(shownIframe()).toBe(first);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(navigated).toHaveBeenCalledTimes(2);
    expect(reopened).toHaveBeenCalledTimes(1);
    expect(viewed).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
    // A reopen is not a reload: the frame loaded once.
    expect(reloaded).not.toHaveBeenCalled();
  });

  it("hides the overlay with aria-hidden and returns focus to the trigger on close, and shows it again on reopen", () => {
    const ns = freshNs();
    const trigger = clickTrigger(ns);
    const overlay = shownOverlay()!;
    expect(overlay.getAttribute("aria-hidden")).toBeNull();
    expect(overlay.style.display).not.toBe("none");

    closeShown();
    expect(overlay.isConnected).toBe(true); // kept, not removed
    expect(overlay.style.display).toBe("none");
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");

    clickTrigger(ns);
    expect(shownOverlay()).toBe(overlay);
    expect(overlay.getAttribute("aria-hidden")).toBeNull();
    expect(overlay.style.display).not.toBe("none");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(overlay.querySelector('button[aria-label="Close"]'));
  });

  it("builds a new frame when the link changes for the same namespace and drops the old one", () => {
    const ns = freshNs();
    clickTrigger(ns, "router?xbc=411");
    const first = shownIframe()!;
    closeShown();
    clickTrigger(ns, "router?xbc=412");
    const second = shownIframe()!;
    expect(second).not.toBe(first);
    expect(second.getAttribute("src")).toMatch(/xbc=412/);
    expect(first.isConnected).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("builds a second frame for a second namespace and keeps the first one hidden", () => {
    const a = freshNs();
    const b = freshNs();
    clickTrigger(a);
    const first = shownIframe()!;
    closeShown();
    clickTrigger(b);
    const second = shownIframe()!;
    expect(second).not.toBe(first);
    expect(document.querySelectorAll("iframe")).toHaveLength(2);
    expect(overlayOf(first).getAttribute("aria-hidden")).toBe("true");
    expect(overlayOf(second).getAttribute("aria-hidden")).toBeNull();
  });

  it("ignores Escape and slate:escape while the frame is hidden, and success from a hidden frame", () => {
    const success = calOn("bookingSuccessful");
    const ns = freshNs();
    const trigger = clickTrigger(ns);
    const iframe = shownIframe()!;
    const overlay = overlayOf(iframe);
    closeShown();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    fromActiveFrame(iframe, { type: "slate:escape" });
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookingSuccessful, data: { outcome: "created", booking: {} } });

    expect(overlay.style.display).toBe("none");
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(trigger);
    expect(success).not.toHaveBeenCalled();
    // And it still reopens afterwards.
    clickTrigger(ns);
    expect(shownIframe()).toBe(iframe);
  });

  it("applies slate:resize from a hidden frame and re-emits a lifecycle message that arrives while hidden", () => {
    const ready = calOn("bookerReady");
    const ns = freshNs();
    clickTrigger(ns);
    const iframe = shownIframe()!;
    closeShown();

    fromActiveFrame(iframe, { type: "slate:resize", height: 720 });
    expect(iframe.style.height).toBe("720px");

    // The availability answered after the lead closed: the frame IS ready, and
    // it will never say so again, so the stage is announced now.
    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookerReady, data: { slotsLoaded: true } });
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("starts no load timer on the reopen of a loaded frame", () => {
    vi.useFakeTimers();
    const failed = calOn("linkFailed");
    const ns = freshNs();
    clickTrigger(ns);
    shownIframe()!.dispatchEvent(new Event("load"));
    closeShown();
    clickTrigger(ns);
    vi.advanceTimersByTime(30000);
    expect(failed).not.toHaveBeenCalled();
    expect(retryBtn()).toBeUndefined();
  });

  it("re-arms the load timer on the reopen of a frame that never loaded", () => {
    vi.useFakeTimers();
    const failed = calOn("linkFailed");
    const ns = freshNs();
    clickTrigger(ns);
    vi.advanceTimersByTime(5000);
    closeShown(); // closing during the load stops the clock
    vi.advanceTimersByTime(30000);
    expect(failed).not.toHaveBeenCalled();
    clickTrigger(ns);
    vi.advanceTimersByTime(12000);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(retryBtn()).toBeTruthy();
  });

  it("never announces bookerReopened for the first open that succeeds after one that threw (#2677)", () => {
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: vi.fn(() => true) });
    const navigated = calOn("navigatedToBooker");
    const reopened = calOn("bookerReopened");
    const ns = freshNs();

    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag === "iframe") throw new Error("iframe blocked by host CSP");
      return original(tag);
    }) as typeof document.createElement);
    try {
      clickTrigger(ns);
    } finally {
      vi.mocked(document.createElement).mockRestore();
    }
    expect(shownIframe()).toBeNull();

    clickTrigger(ns);
    expect(shownIframe()).toBeTruthy();
    expect(navigated).toHaveBeenCalledTimes(2);
    expect(reopened).not.toHaveBeenCalled();

    // Two successful opens still announce it exactly once.
    closeShown();
    clickTrigger(ns);
    expect(reopened).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("widget.js forwards the booking source (#2072)", () => {
  it("carries source from the trigger's link onto the booker URL, where /book copies it into prefill", () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("data-cal-link", "router?xbc=411&source=offerhub");
    trigger.setAttribute("data-cal-namespace", "source-2072");
    document.body.appendChild(trigger);
    trigger.click();
    const src = new URL(shownIframe()!.getAttribute("src")!);
    expect(src.pathname).toBe("/book");
    expect(src.searchParams.get("source")).toBe("offerhub");
    expect(src.searchParams.get("xbc")).toBe("411");
  });
});

describe("widget.js honours data-cal-config metadata on the trigger (#2716)", () => {
  // The table lives in widget.js, which cannot import PARTNER_KEYS (it is a
  // dependency free static asset), so it is read out of the shipped file here and
  // held against the constant in BOTH directions (L41): a partner key with no
  // metadata spelling, or an entry naming something that is not a partner key,
  // fails.
  function metadataTable(): Record<string, string> {
    const start = widgetSrc.indexOf("// slate-partner-metadata: start");
    const end = widgetSrc.indexOf("// slate-partner-metadata: end");
    if (start < 0 || end < start) throw new Error("widget.js has no slate-partner-metadata block");
    const out: Record<string, string> = {};
    for (const m of widgetSrc.slice(start, end).matchAll(/^\s*(\w+):\s*"([^"]+)",?\s*$/gm)) {
      out[m[1]] = m[2];
    }
    return out;
  }

  function openWith(link: string, config: string | null, ns: string): URL {
    const trigger = document.createElement("button");
    trigger.setAttribute("data-cal-link", link);
    trigger.setAttribute("data-cal-namespace", ns);
    if (config !== null) trigger.setAttribute("data-cal-config", config);
    document.body.appendChild(trigger);
    trigger.click();
    const iframe = shownIframe();
    if (!iframe) throw new Error("the modal did not open");
    return new URL(iframe.getAttribute("src")!);
  }

  it("maps every partner key, and only partner keys, from a metadata name", () => {
    const table = metadataTable();
    expect(Object.keys(table).sort()).toEqual(Object.values(PARTNER_KEYS).sort());
    // The metadata spelling is pinned here, from outside the code (L70): it is
    // what trypennie's BookButton puts in data-cal-config, following cal.com.
    expect(table[PARTNER_KEYS.submissionId]).toBe("sfdc_submission_id");
    expect(table[PARTNER_KEYS.regalProfileId]).toBe("regal_profile_id");
  });

  it("puts both metadata keys on the booking URL under Slate's names, and layout and pageType nowhere", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = JSON.stringify({
      layout: "month_view",
      "cal.embed.pageType": "user.event.booking.slots",
      "metadata[sfdc_submission_id]": "a0G5x00000AbCdEQAU",
      "metadata[regal_profile_id]": "rp_01HZY3",
    });
    const src = openWith("router?xbc=411", config, "config-2716-both");
    expect(src.searchParams.get(PARTNER_KEYS.submissionId)).toBe("a0G5x00000AbCdEQAU");
    expect(src.searchParams.get(PARTNER_KEYS.regalProfileId)).toBe("rp_01HZY3");
    expect(src.searchParams.get("xbc")).toBe("411");
    expect(src.searchParams.has("layout")).toBe(false);
    expect(src.searchParams.has("cal.embed.pageType")).toBe(false);
    expect(src.searchParams.has("metadata[sfdc_submission_id]")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still opens when the config attribute is unreadable, or is JSON that is not an object, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [i, bad] of ["{not json", "null", "[1,2]", '"metadata[sfdc_submission_id]"', ""].entries()) {
      const src = openWith("router?xbc=411", bad, `config-2716-bad-${i}`);
      expect(src.pathname).toBe("/book");
      expect(src.searchParams.get("xbc")).toBe("411");
      expect(src.searchParams.has(PARTNER_KEYS.submissionId)).toBe(false);
    }
    const mentions = warn.mock.calls.filter((c) => c.map(String).join(" ").includes("not a JSON object"));
    expect(mentions).toHaveLength(1);
    warn.mockRestore();
  });

  it("says nothing about a trigger that carries no config at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = openWith("router?xbc=411", null, "config-2716-none");
    expect(src.searchParams.get("xbc")).toBe("411");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops an unknown metadata key and says so on the console once, not once per open", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = JSON.stringify({ "metadata[utm_campaign_2716]": "spring", "metadata[sfdc_submission_id]": "a0G5" });
    const first = openWith("router?xbc=411", config, "config-2716-unknown");
    expect(first.searchParams.has("utm_campaign_2716")).toBe(false);
    expect(first.searchParams.has("metadata[utm_campaign_2716]")).toBe(false);
    expect(first.searchParams.get(PARTNER_KEYS.submissionId)).toBe("a0G5");
    document.querySelector<HTMLButtonElement>(`${SHOWN_OVERLAY} button[aria-label="Close"]`)!.click();
    openWith("router?xbc=411", config, "config-2716-unknown");
    const mentions = warn.mock.calls.filter((c) => c.map(String).join(" ").includes("utm_campaign_2716"));
    expect(mentions).toHaveLength(1);
    warn.mockRestore();
  });

  it("lets a URL parameter win over the config on a collision", () => {
    const config = JSON.stringify({
      "metadata[sfdc_submission_id]": "from-config",
      "metadata[regal_profile_id]": "rp-from-config",
    });
    const src = openWith(`router?xbc=411&${PARTNER_KEYS.submissionId}=from-link`, config, "config-2716-collide");
    expect(src.searchParams.get(PARTNER_KEYS.submissionId)).toBe("from-link");
    expect(src.searchParams.get(PARTNER_KEYS.regalProfileId)).toBe("rp-from-config");
  });

  it("forwards no key for a blank or non string metadata value", () => {
    const config = JSON.stringify({ "metadata[sfdc_submission_id]": "   ", "metadata[regal_profile_id]": { id: "x" } });
    const src = openWith("router?xbc=411", config, "config-2716-blank");
    expect(src.searchParams.has(PARTNER_KEYS.submissionId)).toBe(false);
    expect(src.searchParams.has(PARTNER_KEYS.regalProfileId)).toBe(false);
  });
});

// Trypennie sends the lead to its own confirmation page the moment a Slate
// booking lands, and the modal stayed open while that page loaded, so the lead
// saw Slate's confirmation flash under the host's loader (Dan, 2026-09-29).
// cal.com's embed answers `cal("closeModal")` for exactly this, and a host
// written against it must get the same answer from Slate.
describe("widget.js closes the modal on the host's command (closeModal)", () => {
  type AnyCal = ((...args: unknown[]) => void) & { ns: Record<string, (...args: unknown[]) => void> };
  const cal = () => (window as unknown as { Cal: AnyCal }).Cal;
  const created = {
    booking: { id: "bk-close", startsAt: "2026-10-01T15:00:00.000Z", endsAt: "2026-10-01T15:30:00.000Z", salesforceId: "00QClose000001" },
    salesforceId: "00QClose000001",
    outcome: "created",
  };

  function expectClosed(overlay: HTMLElement) {
    // Hidden the way the close button hides it: kept, out of the tree, scroll back.
    expect(overlay.isConnected).toBe(true);
    expect(overlay.style.display).toBe("none");
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(document.body.style.overflow).toBe("");
  }

  it("closes the namespace's open modal on Cal.ns[ns]('closeModal')", () => {
    const ns = freshNs();
    cal()("init", ns, { origin: "https://slate.test" });
    openModalIn(ns);
    const overlay = shownOverlay()!;
    expect(overlay).not.toBeNull();

    cal().ns[ns]("closeModal");
    expectClosed(overlay);
    expect(shownOverlay()).toBeNull();
  });

  it("closes the open modal on the global Cal('closeModal')", () => {
    openModalIn(freshNs());
    const overlay = shownOverlay()!;

    cal()("closeModal");
    expectClosed(overlay);
  });

  it("does not close another namespace's modal", () => {
    const mine = freshNs();
    const other = freshNs();
    cal()("init", other, { origin: "https://slate.test" });
    openModalIn(mine);
    const overlay = shownOverlay()!;

    cal().ns[other]("closeModal");
    expect(shownOverlay()).toBe(overlay);
  });

  it("does nothing, and does not throw, when no modal is open", () => {
    const ns = freshNs();
    cal()("init", ns, { origin: "https://slate.test" });
    expect(() => cal().ns[ns]("closeModal")).not.toThrow();
    expect(() => cal()("closeModal")).not.toThrow();
    expect(shownOverlay()).toBeNull();
  });

  it("closes the modal when called from inside the host's booking callback, which is where trypennie calls it", () => {
    const ns = freshNs();
    cal()("init", ns, { origin: "https://slate.test" });
    let closedInside = false;
    cal()("on", {
      action: "bookingSuccessfulV2",
      callback: () => {
        cal().ns[ns]("closeModal");
        closedInside = shownOverlay() === null;
      },
    });
    const iframe = openModalIn(ns);
    const overlay = shownOverlay()!;

    fromActiveFrame(iframe, { type: EMBED_MESSAGE.bookingSuccessful, data: created });
    expect(closedInside).toBe(true);
    expectClosed(overlay);
  });

  it("reopens the same frame after a host close, like any other close", () => {
    const ns = freshNs();
    cal()("init", ns, { origin: "https://slate.test" });
    const first = openModalIn(ns);
    cal().ns[ns]("closeModal");

    openModalIn(ns);
    expect(shownIframe()).toBe(first);
  });
});

// #2679: the frame is built, hidden, on the trigger's first hover, focus or
// touch, so the click only shows it. cal.com pre renders its modal the same way.
// The pre build must be invisible to the lead AND to the host: nothing on
// screen, nothing focusable, no scroll lock, no key taken, and no event announced
// until the first show, because a hover is not a view.
describe("widget.js pre builds the modal frame on the trigger's first intent (#2679)", () => {
  function hoverTrigger(ns: string, link = "router?xbc=411", type = "pointerover"): HTMLButtonElement {
    const trigger = document.createElement("button");
    trigger.setAttribute("data-cal-link", link);
    trigger.setAttribute("data-cal-namespace", ns);
    document.body.appendChild(trigger);
    trigger.dispatchEvent(new Event(type, { bubbles: true }));
    return trigger;
  }
  const hiddenIframes = () =>
    Array.from(document.querySelectorAll<HTMLIFrameElement>('.slate-widget-overlay[aria-hidden="true"] iframe'));

  it("builds one hidden frame on the first hover, with nothing on screen and nothing announced", () => {
    const all = calOn("*");
    const ns = freshNs();
    (document.activeElement as HTMLElement | null)?.blur?.();
    const focusedBefore = document.activeElement;
    hoverTrigger(ns);

    expect(shownOverlay()).toBeNull();
    const built = hiddenIframes();
    expect(built).toHaveLength(1);
    expect(built[0].getAttribute("src")).toMatch(/\/book\?.*xbc=411/);
    const overlay = built[0].closest(".slate-widget-overlay") as HTMLElement;
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    // Hidden by visibility, never display:none, so the Booker inside lays out
    // at its real width before the click rather than at a zero width viewport.
    expect(overlay.style.visibility).toBe("hidden");
    expect(overlay.style.display).not.toBe("none");
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(focusedBefore);
    expect(all).not.toHaveBeenCalled();
  });

  it("shows a pre built frame visibly on the click, and hides it with display:none on close like any kept frame", () => {
    const ns = freshNs();
    const trigger = hoverTrigger(ns);
    trigger.click();
    const overlay = shownOverlay()!;
    expect(overlay.style.visibility).toBe("visible");
    expect(overlay.style.display).toBe("flex");
    closeModal();
    expect(overlay.style.display).toBe("none");
  });

  it("drops a held load timeout when the pre built frame loads after all before anyone opened it", () => {
    vi.useFakeTimers();
    const failed = calOn("linkFailed");
    const ns = freshNs();
    const trigger = hoverTrigger(ns);
    vi.advanceTimersByTime(12000);
    hiddenIframes()[0].dispatchEvent(new Event("load"));

    trigger.click();
    expect(failed).not.toHaveBeenCalled();
    expect(loaderEl()).toBeNull();
    expect(retryBtn()).toBeUndefined();
  });

  it("builds it at most once however many intent events arrive", () => {
    const ns = freshNs();
    const trigger = hoverTrigger(ns);
    trigger.dispatchEvent(new Event("focusin", { bubbles: true }));
    trigger.dispatchEvent(new Event("touchstart", { bubbles: true }));
    trigger.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("builds it on a touch too, for a device with no hover", () => {
    const ns = freshNs();
    const trigger = hoverTrigger(ns, "router?xbc=411", "touchstart");
    const built = hiddenIframes()[0];
    expect(built).toBeTruthy();
    trigger.click();
    expect(shownIframe()).toBe(built);
  });

  it("the first click shows the pre built frame, announcing navigatedToBooker and not bookerReopened", () => {
    const navigated = calOn("navigatedToBooker");
    const reopened = calOn("bookerReopened");
    const ns = freshNs();
    const trigger = hoverTrigger(ns);
    const built = hiddenIframes()[0];

    trigger.click();
    expect(shownIframe()).toBe(built);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(navigated).toHaveBeenCalledTimes(1);
    expect(reopened).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(shownOverlay()!.querySelector('button[aria-label="Close"]'));
  });

  it("holds the booker's lifecycle messages from a frame nobody has opened, and announces them on the first show, after navigatedToBooker", () => {
    const all = calOn("*");
    const ns = freshNs();
    const trigger = hoverTrigger(ns);
    const built = hiddenIframes()[0];

    fromActiveFrame(built, { type: EMBED_MESSAGE.bookerViewed, data: { slotsLoaded: false } });
    fromActiveFrame(built, { type: EMBED_MESSAGE.bookerReady, data: { slotsLoaded: true } });
    expect(all).not.toHaveBeenCalled();

    trigger.click();
    expect(eventsOf(all)).toEqual([
      { type: "navigatedToBooker", data: {} },
      { type: "bookerViewed", data: { slotsLoaded: false } },
      { type: "bookerReady", data: { slotsLoaded: true } },
    ]);

    // Shown once: a close and reopen announces nothing held a second time.
    closeModal();
    trigger.click();
    expect(eventsOf(all).map((d) => d.type)).toEqual([
      "navigatedToBooker",
      "bookerViewed",
      "bookerReady",
      "navigatedToBooker",
      "bookerReopened",
    ]);
  });

  it("never announces what a pre built frame said when it is replaced before anyone opened it", () => {
    const viewed = calOn("bookerViewed");
    const ns = freshNs();
    hoverTrigger(ns, "router?xbc=411");
    const built = hiddenIframes()[0];
    fromActiveFrame(built, { type: EMBED_MESSAGE.bookerViewed, data: { slotsLoaded: false } });

    // A click on another link for the same namespace replaces the frame.
    const other = document.createElement("button");
    other.setAttribute("data-cal-link", "router?xbc=412");
    other.setAttribute("data-cal-namespace", ns);
    document.body.appendChild(other);
    other.click();

    expect(built.isConnected).toBe(false);
    expect(shownIframe()!.getAttribute("src")).toMatch(/xbc=412/);
    expect(viewed).not.toHaveBeenCalled();
  });

  it("lets no load timeout fire on a pre built frame that is replaced before anyone opened it", () => {
    vi.useFakeTimers();
    const ns = freshNs();
    hoverTrigger(ns, "router?xbc=411");
    const thrownAway = hiddenIframes()[0].closest(".slate-widget-overlay") as HTMLElement;

    const other = document.createElement("button");
    other.setAttribute("data-cal-link", "router?xbc=412");
    other.setAttribute("data-cal-namespace", ns);
    document.body.appendChild(other);
    other.click();
    shownIframe()!.dispatchEvent(new Event("load"));

    vi.advanceTimersByTime(12000);
    expect(thrownAway.isConnected).toBe(false);
    expect(thrownAway.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not replace a namespace's existing frame on the hover of a different link", () => {
    const ns = freshNs();
    const first = document.createElement("button");
    first.setAttribute("data-cal-link", "router?xbc=411");
    first.setAttribute("data-cal-namespace", ns);
    document.body.appendChild(first);
    first.click();
    const kept = shownIframe()!;
    closeModal();

    hoverTrigger(ns, "router?xbc=412");
    expect(kept.isConnected).toBe(true);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);

    // Clicking the first link again still finds the frame it left.
    first.click();
    expect(shownIframe()).toBe(kept);
  });

  it("measures the load timeout from the pre build, and reports a frame that never loaded on the first open, not before", () => {
    vi.useFakeTimers();
    const failed = calOn("linkFailed");
    const ns = freshNs();
    const trigger = hoverTrigger(ns);
    trigger.focus();

    vi.advanceTimersByTime(12000);
    // Nobody has opened it: nothing announced, and focus not pulled into a
    // hidden retry button.
    expect(failed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(eventsOf(failed)[0]).toEqual({
      type: "linkFailed",
      data: { code: "load_timeout", msg: "The booking form did not load in time" },
    });
    expect(loaderEl()!.getAttribute("role")).toBe("alert");
    expect(retryBtn()).toBeTruthy();
  });

  it("a click before the pre build's clock runs out keeps the same clock rather than starting a new one", () => {
    vi.useFakeTimers();
    const failed = calOn("linkFailed");
    const ns = freshNs();
    const trigger = hoverTrigger(ns);
    vi.advanceTimersByTime(8000);
    trigger.click();
    vi.advanceTimersByTime(4000);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("a frame that loaded while hidden opens with no loader and no clock", () => {
    vi.useFakeTimers();
    const failed = calOn("linkFailed");
    const reloaded = calOn("bookerReloaded");
    const ns = freshNs();
    const trigger = hoverTrigger(ns);
    hiddenIframes()[0].dispatchEvent(new Event("load"));

    trigger.click();
    expect(loaderEl()).toBeNull();
    vi.advanceTimersByTime(30000);
    expect(failed).not.toHaveBeenCalled();
    expect(reloaded).not.toHaveBeenCalled();
  });

  it("takes no key from the host page while the pre built frame is hidden", () => {
    const ns = freshNs();
    const trigger = hoverTrigger(ns);
    trigger.focus();

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);

    trigger.blur();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("a pre build that throws leaves the click to build and open as before", () => {
    const ns = freshNs();
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag === "iframe") throw new Error("iframe blocked by host CSP");
      return original(tag);
    }) as typeof document.createElement);
    let trigger: HTMLButtonElement | null = null;
    try {
      expect(() => {
        trigger = hoverTrigger(ns);
      }).not.toThrow();
    } finally {
      vi.mocked(document.createElement).mockRestore();
    }
    expect(document.querySelectorAll(".slate-widget-overlay")).toHaveLength(0);
    (trigger as HTMLButtonElement | null)!.click();
    expect(shownIframe()).toBeTruthy();
  });
});

// #3718: cal.com's inline embed, `Cal("inline", { elementOrSelector, calLink, config })`,
// draws the booker INSIDE an element on the host page instead of in a modal. It shares
// the modal's URL builder, so every parameter rule above holds for it too, and its
// messages are taken only from frames this file built, exactly as the modal's are.
describe("widget.js inline embed (#3718)", () => {
  type CalFn = ((...args: unknown[]) => void) & { ns: Record<string, (...args: unknown[]) => void> };
  const cal = () => (window as unknown as { Cal: CalFn }).Cal;
  const slot = (id = "slot") => {
    const el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
    return el;
  };
  const inlineIframe = (el: HTMLElement) => el.querySelector<HTMLIFrameElement>("iframe");
  const srcParams = (f: HTMLIFrameElement) => new URL(f.getAttribute("src")!).searchParams;

  it("draws the booker inside the element, with the compact layout and the host's origin", () => {
    const el = slot();
    cal()("inline", { elementOrSelector: "#slot", calLink: "router?xbc=411" });
    const f = inlineIframe(el);
    expect(f).toBeTruthy();
    expect(new URL(f!.getAttribute("src")!).pathname).toBe("/book");
    const p = srcParams(f!);
    expect(p.get("xbc")).toBe("411");
    expect(p.get("layout")).toBe("inline");
    expect(p.get("embed")).toBe("1");
    expect(p.get("parentOrigin")).toBe(window.location.origin);
    // Nothing is opened over the page: inline is not a modal.
    expect(document.querySelector(".slate-widget-overlay")).toBeNull();
  });

  it("takes an element as well as a selector, and maps the config's partner metadata", () => {
    const el = slot("by-element");
    cal()("inline", {
      elementOrSelector: el,
      calLink: "router?xbc=411",
      config: { "metadata[sfdc_submission_id]": "a0XUi000001" },
    });
    expect(srcParams(inlineIframe(el)!).get("submissionId")).toBe("a0XUi000001");
  });

  it("uses the namespace's origin and theme when called through Cal.ns", () => {
    const el = slot("ns-slot");
    cal()("init", "inlinetest", { origin: "https://slate.example" });
    cal().ns.inlinetest("ui", { theme: "dark" });
    cal().ns.inlinetest("inline", { elementOrSelector: "#ns-slot", calLink: "router?xbc=411" });
    const f = inlineIframe(el)!;
    expect(new URL(f.getAttribute("src")!).origin).toBe("https://slate.example");
    expect(srcParams(f).get("theme")).toBe("dark");
  });

  it("forwards cal.com's per theme colours for the page's theme: the card's background and the button", () => {
    const el = slot("colours");
    cal()("init", "colourtest", { origin: "https://slate.example" });
    cal().ns.colourtest("ui", {
      theme: "dark",
      brandColor: "#82D0FF",
      cssVarsPerTheme: { light: { "cal-bg": "#FFF4D6", "cal-brand": "#000000" }, dark: { "cal-bg": "#1D212F", "cal-brand": "#FFD166" } },
    });
    cal().ns.colourtest("inline", { elementOrSelector: "#colours", calLink: "router?xbc=411" });
    const p = srcParams(inlineIframe(el)!);
    expect(p.get("bg")).toBe("#1D212F");
    // The theme's own button colour wins over the single brandColor, as on cal.com.
    expect(p.get("brand")).toBe("#FFD166");
  });

  it("keeps brandColor, and sends no background, when the page sets no per theme colours", () => {
    const el = slot("plain-colours");
    cal()("init", "plaincolours", { origin: "https://slate.example" });
    cal().ns.plaincolours("ui", { brandColor: "#000000" });
    cal().ns.plaincolours("inline", { elementOrSelector: "#plain-colours", calLink: "router?xbc=411" });
    const p = srcParams(inlineIframe(el)!);
    expect([p.get("brand"), p.has("bg")]).toEqual(["#000000", false]);
  });

  it("replaces its own frame when called again for the same element, rather than stacking", () => {
    const el = slot();
    cal()("inline", { elementOrSelector: "#slot", calLink: "router?xbc=411" });
    cal()("inline", { elementOrSelector: "#slot", calLink: "router?xbc=512" });
    const all = el.querySelectorAll("iframe");
    expect(all.length).toBe(1);
    expect(srcParams(all[0]!).get("xbc")).toBe("512");
  });

  it("leaves the modal's booking address exactly as it was: no layout, which is trypennie's pop up", () => {
    const iframe = openModal();
    expect(new URL(iframe.getAttribute("src")!).searchParams.has("layout")).toBe(false);
  });

  it("says so, and offers Try again, when the booker never loads, rather than leaving a blank box", () => {
    vi.useFakeTimers();
    const el = slot();
    const failures: unknown[] = [];
    cal()("on", { action: "linkFailed", callback: (e: { detail: { data: unknown } }) => failures.push(e.detail.data) });
    cal()("inline", { elementOrSelector: "#slot", calLink: "router?xbc=411" });
    vi.advanceTimersByTime(12000);
    expect(failures).toContainEqual({ code: "load_timeout", msg: "The booking form did not load in time" });
    expect(el.textContent).toMatch(/couldn.t load the booking form/i);
    const retry = Array.from(el.querySelectorAll("button")).find((b) => /try again/i.test(b.textContent || ""));
    expect(retry).toBeTruthy();
    retry!.click();
    // Try again hides the message and shows the frame, reloading it.
    expect(el.querySelector<HTMLElement>('[role="alert"]')!.style.display).toBe("none");
    expect(inlineIframe(el)!.style.display).toBe("block");
  });

  it("judges each Try again afresh, announcing a second failure as it did the first", () => {
    vi.useFakeTimers();
    const el = slot();
    const failures: unknown[] = [];
    cal()("on", { action: "linkFailed", callback: (e: { detail: { data: unknown } }) => failures.push(e.detail.data) });
    cal()("inline", { elementOrSelector: "#slot", calLink: "router?xbc=411" });
    vi.advanceTimersByTime(12000);
    Array.from(el.querySelectorAll("button")).find((b) => /try again/i.test(b.textContent || ""))!.click();
    vi.advanceTimersByTime(12000);
    expect(failures).toHaveLength(2);
    expect(el.querySelector<HTMLElement>('[role="alert"]')!.style.display).toBe("block");
  });

  it("takes the notice down and shows the booker when it loads after the notice went up", () => {
    vi.useFakeTimers();
    const el = slot();
    cal()("inline", { elementOrSelector: "#slot", calLink: "router?xbc=411" });
    vi.advanceTimersByTime(12000);
    expect(el.querySelector<HTMLElement>('[role="alert"]')!.style.display).toBe("block");
    inlineIframe(el)!.dispatchEvent(new Event("load"));
    expect(el.querySelector<HTMLElement>('[role="alert"]')!.style.display).toBe("none");
    expect(inlineIframe(el)!.style.display).toBe("block");
  });

  it("announces no failure for a booker that loaded", () => {
    vi.useFakeTimers();
    const el = slot();
    const failures: unknown[] = [];
    cal()("on", { action: "linkFailed", callback: (e: { detail: { data: unknown } }) => failures.push(e.detail.data) });
    cal()("inline", { elementOrSelector: "#slot", calLink: "router?xbc=411" });
    inlineIframe(el)!.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(12000);
    expect(failures).toEqual([]);
  });

  it("does nothing, and throws nothing, when the element is not on the page", () => {
    expect(() => cal()("inline", { elementOrSelector: "#missing", calLink: "router?xbc=411" })).not.toThrow();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("sizes its frame from the booker's resize, and only from that frame", () => {
    const el = slot();
    cal()("inline", { elementOrSelector: "#slot", calLink: "router?xbc=411" });
    const f = inlineIframe(el)!;
    window.dispatchEvent(new MessageEvent("message", { data: { type: "slate:resize", height: 999 }, source: window as Window }));
    expect(f.style.height).not.toBe("999px");
    window.dispatchEvent(new MessageEvent("message", { data: { type: "slate:resize", height: 512 }, source: f.contentWindow }));
    expect(f.style.height).toBe("512px");
  });

  it("announces a booking from its frame under both success events, and ignores any other window", () => {
    const el = slot();
    const seen: string[] = [];
    cal()("on", { action: "*", callback: (e: { detail: { type: string } }) => seen.push(e.detail.type) });
    cal()("inline", { elementOrSelector: "#slot", calLink: "router?xbc=411" });
    const f = inlineIframe(el)!;
    const data = { outcome: "created", booking: { id: "b1", startsAt: "s", endsAt: "e" } };
    window.dispatchEvent(new MessageEvent("message", { data: { type: "slate:bookingSuccessful", data }, source: window as Window }));
    expect(seen).not.toContain("bookingSuccessful");
    window.dispatchEvent(new MessageEvent("message", { data: { type: "slate:bookingSuccessful", data }, source: f.contentWindow }));
    expect(seen).toContain("bookingSuccessful");
    expect(seen).toContain("bookingSuccessfulV2");
  });

  it("announces the booker's stages at once, since an inline booker is on screen from the start", () => {
    const el = slot();
    const seen: string[] = [];
    cal()("on", { action: "bookerViewed", callback: (e: { detail: { type: string } }) => seen.push(e.detail.type) });
    cal()("inline", { elementOrSelector: "#slot", calLink: "router?xbc=411" });
    const f = inlineIframe(el)!;
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: EMBED_MESSAGE.bookerViewed, data: { slotsLoaded: false } }, source: f.contentWindow }),
    );
    expect(seen).toEqual(["bookerViewed"]);
  });
});

// #3718, Geoff 2026-10-15: the card split into two pieces a page places separately,
// the times and the Call me now row, each just its tile. Picking a time, View more
// times and a Call me now press each open the pop up booker, which the piece asks
// for with `slate:openBooker`, taken only from a piece frame this file built.
describe("widget.js inline pieces (#3718)", () => {
  type CalFn = ((...args: unknown[]) => void) & { ns: Record<string, (...args: unknown[]) => void> };
  const cal = () => (window as unknown as { Cal: CalFn }).Cal;
  const slot = (id: string) => {
    const el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
    return el;
  };
  const frameIn = (el: HTMLElement) => el.querySelector<HTMLIFrameElement>("iframe")!;
  const srcParams = (f: HTMLIFrameElement) => new URL(f.getAttribute("src")!).searchParams;
  const LINK = "router?xbc=411&external_id=00QUi000010889ZMAQ&email=maria%40example.com&callMeNow=above";
  const piece = (id: string, which: string) => {
    const el = slot(id);
    cal()("inline", { elementOrSelector: `#${id}`, calLink: LINK, config: { piece: which } });
    return frameIn(el);
  };
  const ask = (source: Window | null, data: unknown) =>
    window.dispatchEvent(new MessageEvent("message", { data: { type: PIECE_MESSAGE.openBooker, data }, source }));

  it("asks for the named piece, and takes no room until the piece says how tall it is", () => {
    const f = piece("times", "times");
    const p = srcParams(f);
    expect(p.get("layout")).toBe("inline");
    expect(p.get("piece")).toBe("times");
    expect(f.style.minHeight).toBe("0px");
    // The tile fills its frame, so the frame carries the tile's rounded corners.
    expect(f.style.borderRadius).toBe("16px");
    expect(srcParams(piece("cmn", "callMeNow")).get("piece")).toBe("callMeNow");
  });

  it("ignores a piece it does not know, and draws the whole card", () => {
    const f = piece("odd", "everything");
    expect(srcParams(f).get("piece")).toBeNull();
    expect(f.style.minHeight).toBe("360px");
  });

  it("opens the pop up booker on the details step for the time the lead picked", () => {
    const f = piece("times", "times");
    ask(f.contentWindow, { slot: "2026-10-16T14:30:00.000Z" });
    const m = shownIframe();
    expect(m).toBeTruthy();
    const p = srcParams(m!);
    expect(p.get("slot")).toBe("2026-10-16T14:30:00.000Z");
    expect(p.get("xbc")).toBe("411");
    expect(p.get("external_id")).toBe("00QUi000010889ZMAQ");
    // The full booker, not another card.
    expect(p.get("layout")).toBeNull();
    expect(p.get("piece")).toBeNull();
    expect(p.get("callMeNow")).toBeNull();
  });

  it("opens the pop up booker on a day for View more times", () => {
    const f = piece("times", "times");
    ask(f.contentWindow, { day: "2026-10-16" });
    const p = srcParams(shownIframe()!);
    expect(p.get("day")).toBe("2026-10-16");
    expect(p.get("slot")).toBeNull();
  });

  it("opens a narrow pop up that makes the Call me now request and shows its confirmation", () => {
    const f = piece("cmn", "callMeNow");
    ask(f.contentWindow, { callMeNow: "press" });
    const m = shownIframe()!;
    const p = srcParams(m);
    expect(p.get("layout")).toBe("inline");
    expect(p.get("callMeNow")).toBe("above");
    expect(p.get("cmnPress")).toBe("1");
    expect(p.get("piece")).toBeNull();
    expect(shownOverlay()!.querySelector<HTMLElement>(".slate-widget-modal")!.style.width).toContain("520px");
  });

  it("opens nothing for a request from any window it did not build, or one it cannot read", () => {
    const f = piece("times", "times");
    ask(window as Window, { slot: "2026-10-16T14:30:00.000Z" });
    expect(shownIframe()).toBeNull();
    ask(f.contentWindow, { slot: 42 });
    expect(shownIframe()).toBeNull();
    ask(f.contentWindow, { callMeNow: "please" });
    expect(shownIframe()).toBeNull();
  });

  it("draws a demo link from Slate's demo booker, and opens its pop up there too", () => {
    const el = slot("demo");
    cal()("inline", { elementOrSelector: "#demo", calLink: "demo?callMeNow=above", config: { piece: "times" } });
    const f = frameIn(el);
    expect(new URL(f.getAttribute("src")!).pathname).toBe("/demo");
    ask(f.contentWindow, { slot: "2026-10-16T14:30:00.000Z" });
    expect(new URL(shownIframe()!.getAttribute("src")!).pathname).toBe("/demo");
    // Any other link is the real booker, as before.
    expect(new URL(piece("real", "times").getAttribute("src")!).pathname).toBe("/book");
  });

  it("holds its own copy of the message and the piece names to the app's", () => {
    // widget.js imports nothing, so it carries its own copy; a drift would leave a
    // piece asking for a pop up nobody opens.
    expect(widgetSrc).toContain(`var OPEN_BOOKER = "${PIECE_MESSAGE.openBooker}";`);
    expect(widgetSrc).toContain(`var PIECES = ${JSON.stringify([...INLINE_PIECES]).replace(/,/g, ", ")};`);
  });

  it("opens nothing for a request from the whole card, which handles its own steps", () => {
    const el = slot("card");
    cal()("inline", { elementOrSelector: "#card", calLink: LINK });
    ask(frameIn(el).contentWindow, { slot: "2026-10-16T14:30:00.000Z" });
    expect(shownIframe()).toBeNull();
  });
});


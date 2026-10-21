// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #3706: a host's prerender usually reaches widget.js through the loader stub's
// queue, because the host calls it as soon as its own page is ready, which can be
// before widget.js has downloaded. The queue is drained near the TOP of widget.js,
// before the frame code below it has run its setup, so a prerender drained there
// must wait for the file to finish rather than build half a frame or none.
//
// Its own file because widget.js is evaluated once per file (it attaches document
// listeners), and this case needs the stub in place BEFORE that one evaluation.

const widgetSrc = readFileSync(resolve("public/widget.js"), "utf8");
const ORIGIN = "https://slate.test";
const FORM = "255a083e-529e-42e1-ba94-9556fae95fe4";

type Stub = ((...args: unknown[]) => void) & {
  ns: Record<string, (...args: unknown[]) => void>;
  q?: unknown[];
  loaded?: boolean;
  config?: { forwardQueryParams?: boolean };
};
type Emitted = { detail: { type: string; data: unknown } };

const events: Emitted[] = [];

beforeAll(() => {
  delete (window as unknown as { Cal?: unknown }).Cal;
  // The cal.com loader stub, as trypennie's slateLoaderScript writes it, minus the
  // script tag it appends: it queues every command until the real script runs.
  const w = window as unknown as { Cal: Stub };
  w.Cal = function (...ar: unknown[]) {
    const c = w.Cal;
    if (!c.loaded) {
      c.ns = {};
      c.q = c.q || [];
      c.loaded = true;
    }
    if (ar[0] === "init") {
      const api = function (...a: unknown[]) {
        (api as unknown as { q: unknown[] }).q.push(a);
      } as unknown as Stub & { q: unknown[] };
      api.q = [];
      const namespace = ar[1];
      if (typeof namespace === "string") {
        c.ns[namespace] = c.ns[namespace] || api;
        (c.ns[namespace] as unknown as { q: unknown[] }).q.push(ar);
        c.q!.push(["initNamespace", namespace]);
      } else c.q!.push(ar);
      return;
    }
    c.q!.push(ar);
  } as Stub;
  w.Cal.config = { forwardQueryParams: true };
  w.Cal("init", "review", { origin: ORIGIN });
  w.Cal.ns.review("ui", { hideEventTypeDetails: false, layout: "month_view" });
  w.Cal("on", { action: "*", callback: (e: Emitted) => events.push(e) });
  w.Cal.ns.review("prerender", {
    calLink: `router?form=${FORM}&xbc=411`,
    type: "modal",
    calOrigin: "https://trypennie.cal.com",
    pageType: "team.event.booking.slots",
    options: { backgroundSlotsFetch: true },
  });
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({} as Response)));
  new Function(widgetSrc)();
});

describe("widget.js builds a prerender the loader stub queued before it loaded (#3706)", () => {
  it("builds the hidden frame once the file has loaded, announcing nothing", () => {
    const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe");
    expect(iframes).toHaveLength(1);
    const src = new URL(iframes[0].getAttribute("src")!);
    expect(src.origin).toBe(ORIGIN);
    expect(src.searchParams.get("xbc")).toBe("411");
    const overlay = iframes[0].closest(".slate-widget-overlay") as HTMLElement;
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(events).toEqual([]);
  });

  it("the first click shows that same frame", () => {
    const built = document.querySelector("iframe");
    const el = document.createElement("div");
    el.setAttribute("data-cal-link", `router?form=${FORM}&xbc=411`);
    el.setAttribute("data-cal-namespace", "review");
    document.body.appendChild(el);
    el.click();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    const shown = document.querySelector('.slate-widget-overlay:not([aria-hidden="true"]) iframe');
    expect(shown).toBe(built);
    expect(events.map((e) => e.detail.type)).toEqual(["navigatedToBooker"]);
  });
});

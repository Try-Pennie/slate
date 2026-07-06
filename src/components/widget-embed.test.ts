import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #593: widget.js applied slate:resize from ANY frame/origin (unlike the
// success/escape branches, which already require e.source === the active
// iframe). A hostile co-embedded frame could therefore oscillate the booking
// iframe. This drives the real IIFE in jsdom and asserts the source guard.

// Vitest runs from the repo root; read the shipped IIFE verbatim.
const widgetSrc = readFileSync(resolve("public/widget.js"), "utf8");

function loadWidget() {
  // The IIFE reads/writes window.Cal and attaches a message listener.
  new Function(widgetSrc)();
}

function openModal(): HTMLIFrameElement {
  const trigger = document.createElement("button");
  trigger.setAttribute("data-cal-link", "router?xbc=411");
  document.body.appendChild(trigger);
  trigger.click(); // delegated listener builds the modal
  return document.querySelector("iframe") as HTMLIFrameElement;
}

describe("widget.js resize source guard (#593)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // A same-origin default so bookingUrl() resolves cleanly.
    delete (window as unknown as { Cal?: unknown }).Cal;
    loadWidget();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

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

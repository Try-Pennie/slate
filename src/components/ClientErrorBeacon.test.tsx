// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// The browser half of the client error beacon (#1368).
//
// It lives inside SLATE's own document (the standalone /book page, and the same
// page inside the embed iframe), which is the only place a global handler is
// honest: widget.js runs in the HOST page, where window.onerror would capture
// trypennie's own errors rather than Slate's.
//
// The failure this must not have is a loop. A page throwing in a render cycle
// can fire thousands of times a second, and a beacon that forwards each one turns
// a broken page into a self-inflicted flood.

const fetchMock = vi.hoisted(() => vi.fn());

import { ClientErrorBeacon, MAX_REPORTS_PER_PAGE } from "./ClientErrorBeacon";

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Fire a real ErrorEvent the way the browser would. */
function throwInPage(message: string): void {
  window.dispatchEvent(
    new ErrorEvent("error", { message, filename: "/main.js", lineno: 12, colno: 9 }),
  );
}

describe("ClientErrorBeacon", () => {
  it("reports an uncaught error to the beacon endpoint", async () => {
    render(<ClientErrorBeacon page="/book/411" bucketCode="411" />);
    throwInPage("Cannot read properties of undefined");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/client-errors");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      kind: "error",
      message: "Cannot read properties of undefined",
      page: "/book/411",
      bucketCode: "411",
      line: 12,
      col: 9,
    });
  });

  it("reports an unhandled promise rejection", async () => {
    render(<ClientErrorBeacon page="/book/411" />);
    const event = new Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = new Error("network died");
    window.dispatchEvent(event);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      kind: "unhandledrejection",
      message: expect.stringContaining("network died"),
    });
  });

  it("scrubs contact data before it leaves the page", async () => {
    render(<ClientErrorBeacon page="/book/411" />);
    throwInPage("rejected jane@example.com on 555-123-4567");

    const body = fetchMock.mock.calls[0][1].body;
    expect(body).not.toContain("jane@example.com");
    expect(body).not.toContain("123-4567");
  });

  it("stops after a bounded number of reports, so a throwing render cannot flood", async () => {
    render(<ClientErrorBeacon page="/book/411" />);
    for (let i = 0; i < MAX_REPORTS_PER_PAGE + 20; i++) throwInPage(`boom ${i}`);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_REPORTS_PER_PAGE);
  });

  it("reports one identical error once, however many times it repeats", async () => {
    render(<ClientErrorBeacon page="/book/411" />);
    throwInPage("the same failure");
    throwInPage("the same failure");
    throwInPage("the same failure");

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never lets its own failure surface to the page", async () => {
    fetchMock.mockRejectedValue(new Error("beacon endpoint down"));
    render(<ClientErrorBeacon page="/book/411" />);
    // A rejected post that nobody caught would itself become an
    // unhandledrejection, which this component listens for: a self-feeding loop.
    expect(() => throwInPage("boom")).not.toThrow();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops listening once the page unmounts", async () => {
    const { unmount } = render(<ClientErrorBeacon page="/book/411" />);
    unmount();
    throwInPage("after unmount");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders nothing", async () => {
    const { container } = render(<ClientErrorBeacon page="/book/411" />);
    expect(container.innerHTML).toBe("");
  });
});

// #2641: an origin mismatch is two bare origins, never free text, so the contact
// scrub must not touch it: a preview host carrying seven digits would otherwise be
// rewritten and the server could no longer read the pair.
describe("postClientReport and the origin mismatch report", () => {
  it("sends the pair exactly as built, digits and all", async () => {
    const { postClientReport } = await import("./ClientErrorBeacon");
    const sent = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    global.fetch = sent as unknown as typeof fetch;
    const message = "declared https://trypennie.com, framed by https://pr-1234567.preview.example";
    postClientReport({ kind: "origin_mismatch", message, page: "/book/411" });
    expect(JSON.parse(String(sent.mock.calls[0][1]?.body)).message).toBe(message);
  });

  it("still scrubs every other kind", async () => {
    const { postClientReport } = await import("./ClientErrorBeacon");
    const sent = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    global.fetch = sent as unknown as typeof fetch;
    postClientReport({ kind: "error", message: "failed for 2155550100", page: "/book/411" });
    expect(JSON.parse(String(sent.mock.calls[0][1]?.body)).message).not.toContain("2155550100");
  });
});

// #3046: for a ResizeObserver loop warning the browser sets `ErrorEvent.filename`
// to the PAGE's own address, and on /book the query string carries the lead's
// name, email and phone, percent encoded so no contact shape matches it. The
// query string and fragment must not leave the page, in any field.
describe("a page address carrying the lead's details (#3046)", () => {
  const PAGE_URL =
    "https://slate.trypennie.app/book?name=Dana%20Lee&email=dana%40example.com&phone=%28215%29%20555-0100";
  const LEAKS = ["?", "#confirm", "name=", "Dana", "Lee", "dana", "%40", "example.com", "%28", "555", "0100"];

  function sentBody(): string {
    return String(fetchMock.mock.calls[0][1].body);
  }

  it("drops the query string and fragment from the source the browser names", async () => {
    render(<ClientErrorBeacon page="/book" />);
    window.dispatchEvent(
      new ErrorEvent("error", { message: "boom", filename: `${PAGE_URL}#confirm`, lineno: 12, colno: 3 }),
    );
    const body = sentBody();
    for (const leak of LEAKS) expect(body).not.toContain(leak);
    // CONTROL: the path survives, so the report can still be diagnosed.
    expect(JSON.parse(body).source).toBe("https://slate.trypennie.app/book");
  });

  it("drops it from a stack frame inside the message and the stack, keeping line and column", async () => {
    render(<ClientErrorBeacon page="/book" />);
    const error = new Error(`failed at ${PAGE_URL}:12:3`);
    error.stack = `Error: failed\n    at submit (${PAGE_URL}:12:3)`;
    window.dispatchEvent(new ErrorEvent("error", { message: error.message, error }));
    const body = sentBody();
    for (const leak of LEAKS) expect(body).not.toContain(leak);
    const parsed = JSON.parse(body);
    expect(parsed.message).toBe("failed at https://slate.trypennie.app/book:12:3");
    expect(parsed.stack).toContain("(https://slate.trypennie.app/book:12:3)");
  });

  it("drops it from the page a caller names, whoever calls", async () => {
    const { postClientReport } = await import("./ClientErrorBeacon");
    postClientReport({ kind: "error", message: "boom", page: "/book?email=dana%40example.com" });
    expect(JSON.parse(sentBody()).page).toBe("/book");
  });
});

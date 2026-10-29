import { describe, it, expect, vi, beforeEach } from "vitest";
import { CLIENT_ERROR_ADDRESS_POLICY } from "@/lib/rate-limit-core";

// The client error beacon endpoint (#1368).
//
// This is a PUBLIC, unauthenticated write surface reachable by anyone who can
// load the booker, which is the whole internet, and it can cause a Slack
// message. So the tests that matter are the ones about what it refuses:
//
//  - it fails CLOSED when the rate limiter cannot vouch for the caller (unlike
//    booking, which fails open, because a dropped beacon report is harmless and
//    an unbounded public path to Slack is not);
//  - it never echoes anything back, so it cannot be used as an oracle;
//  - it accepts nothing unbounded, and scrubs contact data server side even
//    though the page already scrubbed it.

const reportInternalError = vi.hoisted(() => vi.fn());
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
);
const allowRequest = vi.hoisted(() => vi.fn());
// #1974: the count that decides whether a catch is worth waking anybody for. It
// is mocked rather than driven here because its own behaviour (the atomic
// increment, the fail-open) is pinned in `src/lib/api/boundary-count.test.ts`;
// what these tests pin is that the route HONOURS the answer.
const countBoundaryCatch = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ repeated: boolean; count: number | null; measured: boolean }> => ({
      repeated: true,
      count: 5,
      measured: true,
    }),
  ),
);
const clientIp = vi.hoisted(() => vi.fn(() => "1.2.3.4"));

vi.mock("@/lib/api/errors", () => ({ reportInternalError }));
const sendThrottledInfo = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
);
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, sendThrottledInfo }));
// #2755: the count of reports from pages Slate does not serve, mocked for the
// same reason as the boundary count (its own behaviour is pinned beside it).
const countUnrecognisedPageReport = vi.hoisted(() =>
  vi.fn(async (): Promise<{ count: number | null; measured: boolean }> => ({ count: 3, measured: true })),
);
// #3323: the opaque script error count is driven for real, end to end, in
// route.opaque.test.ts; nothing in this file sends an opaque report, so this
// stand in refuses rather than answers if one ever reaches it.
const countOpaqueScriptError = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("route.test.ts sent an opaque report; that path is tested in route.opaque.test.ts");
  }),
);
// The unattributed rejection count is driven for real in route.foreign.test.ts, for
// the same reason; this stand in refuses if a report here ever reaches it.
const countUnattributedRejection = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("route.test.ts sent an unattributed rejection; that path is tested in route.foreign.test.ts");
  }),
);
vi.mock("@/lib/api/boundary-count", () => ({
  countBoundaryCatch,
  countUnrecognisedPageReport,
  countOpaqueScriptError,
  countUnattributedRejection,
  BOUNDARY_WINDOW_MS: 30 * 60_000,
  OPAQUE_BURST_THRESHOLD: 5,
  OPAQUE_BURST_WINDOW_MS: 15 * 60_000,
  UNATTRIBUTED_REJECTION_BURST_THRESHOLD: 5,
  UNATTRIBUTED_REJECTION_WINDOW_MS: 15 * 60_000,
}));
vi.mock("@/lib/rate-limit", () => ({
  allowRequest,
  clientIp,
  CLIENT_ERROR_RATE_RULES: [{ prefix: "clienterr:h", windowSeconds: 3600, max: 60 }],
}));
// #2660: whether the reported bucket is a test bucket, answered by the one
// module the outcome tally already asks (only the server decides, off
// `buckets.is_test`). Real unless a case says otherwise.
const resolveTestTraffic = vi.hoisted(() => vi.fn(async (): Promise<boolean> => false));
vi.mock("@/lib/monitor/test-traffic", () => ({ resolveTestTraffic }));

import { POST } from "./route";
import { log } from "@/lib/log";
import { shortErrorReason, DIAGNOSTIC_REASON_CHARS } from "@/lib/notify/error-text";
import { unexpectedFaultAlert } from "@/lib/notify/misc-alert-copy";
import { PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";

const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];

// A real Request: the route reads its body through the capped reader (#3135).
const post = (body: unknown) =>
  POST(
    new Request("https://slate.test/api/client-errors", {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
  );

const REPORT = {
  kind: "error",
  message: "Cannot read properties of undefined",
  page: "/book/411",
  stack: "at submit (main.js:1:20)",
};

beforeEach(() => {
  vi.clearAllMocks();
  allowRequest.mockResolvedValue(true);
  countBoundaryCatch.mockResolvedValue({ repeated: true, count: 5, measured: true });
  countUnrecognisedPageReport.mockResolvedValue({ count: 3, measured: true });
  resolveTestTraffic.mockResolvedValue(false);
});

// #2755: the page path is text anybody can post, so the alert key must come from
// Slate's own route list. Before this, every invented path minted its own key,
// its own throttle bucket and its own alert_state rows, and the per key cooldown
// bounded none of the total.
describe("a report from a page Slate does not serve (#2755)", () => {
  it("lands in other, and two invented paths share one key", async () => {
    await post({ ...REPORT, page: "/wp-login.php" });
    await post({ ...REPORT, page: "/xmlrpc/deep/path" });
    expect(reportInternalError.mock.calls[0]![1]).toBe("client_error:other");
    expect(reportInternalError.mock.calls[1]![1]).toBe("client_error:other");
  });

  it("is counted, and the count leads the alert detail so a storm reads as one line with its size", async () => {
    countUnrecognisedPageReport.mockResolvedValueOnce({ count: 40, measured: true });
    await post({ ...REPORT, page: "/wp-login.php" });
    expect(countUnrecognisedPageReport).toHaveBeenCalledWith("client_error:other");
    expect(String(reportInternalError.mock.calls[0]![0])).toMatch(/^Error: 40 reports from pages Slate does not serve/);
  });

  it("says it could not count rather than naming a figure", async () => {
    countUnrecognisedPageReport.mockResolvedValueOnce({ count: null, measured: false });
    await post({ ...REPORT, page: "/wp-login.php" });
    expect(String(reportInternalError.mock.calls[0]![0])).toMatch(/could not count/);
    expect(reportInternalError).toHaveBeenCalledOnce();
  });

  it("CONTROL: a real route keeps its own key and is not counted as invented", async () => {
    await post({ ...REPORT, page: "/book/411" });
    expect(reportInternalError.mock.calls[0]![1]).toBe("client_error:book");
    expect(countUnrecognisedPageReport).not.toHaveBeenCalled();
    expect(String(reportInternalError.mock.calls[0]![0])).not.toMatch(/does not serve/);
  });

  it("a boundary catch on an invented path is counted and keyed under boundary_error:other", async () => {
    await post({ kind: "boundary", message: "digest 1", page: "/nope" });
    expect(countBoundaryCatch).toHaveBeenCalledWith("boundary_error:other");
    expect(sendThrottledAlert.mock.calls[0]![0]).toBe("boundary_error:other");
  });
});

// #2660: a partner's staging page is the population most likely to throw (an old
// browser, a host policy blocking a chunk), and with any origin admitted the
// volume is theirs to choose. Every monitor resolves test-ness through the
// bucket; this route did not, so each of those would have paged about a customer
// who could not book. A test bucket's errors go to the log and the info channel,
// never to the pager; a real bucket's path is untouched (both in one fixture).
describe("a client error on a test bucket (#2660)", () => {
  it("whispers on the info channel and never pages, for a boundary catch", async () => {
    resolveTestTraffic.mockResolvedValueOnce(true);
    const res = await post({ kind: "boundary", message: "digest 1", page: "/book", bucketCode: PUBLIC_TEST });
    expect(res.status).toBe(204);
    expect(resolveTestTraffic).toHaveBeenCalledWith({ by: "bucket", code: PUBLIC_TEST });
    expect(sendThrottledInfo).toHaveBeenCalledTimes(1);
    expect(sendThrottledInfo.mock.calls[0]![0]).toBe("client_error_test_bucket");
    expect(sendThrottledInfo.mock.calls[0]![2]).toContain(PUBLIC_TEST);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(reportInternalError).not.toHaveBeenCalled();
    expect(countBoundaryCatch).not.toHaveBeenCalled();
  });

  it("whispers and never pages, for an ordinary client error too", async () => {
    resolveTestTraffic.mockResolvedValueOnce(true);
    await post({ ...REPORT, bucketCode: PUBLIC_TEST });
    expect(sendThrottledInfo).toHaveBeenCalledTimes(1);
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it("CONTROL: a real bucket's error still pages the way it always did", async () => {
    await post({ ...REPORT, bucketCode: "411" });
    expect(resolveTestTraffic).toHaveBeenCalledWith({ by: "bucket", code: "411" });
    expect(reportInternalError).toHaveBeenCalledOnce();
    expect(sendThrottledInfo).not.toHaveBeenCalled();
  });

  it("does not ask about a report that names no bucket, and pages it as real", async () => {
    await post({ ...REPORT, bucketCode: null });
    expect(resolveTestTraffic).not.toHaveBeenCalled();
    expect(reportInternalError).toHaveBeenCalledOnce();
  });
});

// #1974: a page whose error boundary caught something reports through here too,
// so a page that throws for everybody after a deploy SPEAKS. Before this, the
// boundary logged and nothing else: one stray fault and a broken deploy arrived
// on the same path and looked identical, and the second stayed invisible for as
// long as it lasted.
describe("a boundary catch (#1974)", () => {
  const BOUNDARY = { kind: "boundary", message: "digest 3847221905", page: "/admin" };

  // ONE CATCH IS NOT A SIGNAL. A stale bundle after a deploy, a chunk that
  // failed to load, one person's extension: each is exactly one catch on one
  // load. Paging on it teaches the reader to skip the channel (L36), which is
  // what makes the real break invisible.
  it("does not page on the first catch on a page", async () => {
    countBoundaryCatch.mockResolvedValueOnce({ repeated: false, count: 1, measured: true });
    const res = await post(BOUNDARY);
    expect(res.status).toBe(204);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    // The LOG line is still written for every catch: the forensic trail is what
    // makes a single stray fault findable, and it costs nobody's attention.
    expect(countBoundaryCatch).toHaveBeenCalledWith("boundary_error:admin");
  });

  // THE COUNTER FAILING OPEN. It is the alerting path: a counter hiccup that
  // silently withheld the page would mute the one detector for a page nobody
  // can use, so an unmeasured run pages and the copy says the scope is unknown.
  it("pages when the count could not be taken, saying the scope is unknown", async () => {
    countBoundaryCatch.mockResolvedValueOnce({ repeated: true, count: null, measured: false });
    await post(BOUNDARY);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert.mock.calls[0]![2]).toMatch(/could not count/);
  });

  it("carries the measured figure into the message", async () => {
    countBoundaryCatch.mockResolvedValueOnce({ repeated: true, count: 11, measured: true });
    await post(BOUNDARY);
    expect(sendThrottledAlert.mock.calls[0]![2]).toMatch(/11 loads/);
  });

  it("alerts, naming the page somebody is looking at", async () => {
    const res = await post(BOUNDARY);
    expect(res.status).toBe(204);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, text] = sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe("boundary_error:admin");
    expect(cooldown).toBeGreaterThan(0);
    expect(text).toMatch(/\/admin/);
    // It must not claim a 500. Nothing returned a status code; a person was
    // shown a screen, and the reader's next move differs (L11).
    expect(text).not.toMatch(/500/);
    expect(text).toMatch(/error screen|failed to render/i);
  });

  // ITS OWN KEY SPACE. A broken admin page and a broken booker bundle are
  // different failures with different audiences, and sharing a cooldown would
  // let one silence the other for its whole length.
  it("does not share a cooldown with the booker's beacon", async () => {
    await post(BOUNDARY);
    await post({ ...REPORT, page: "/book/411" });
    const boundaryKey = sendThrottledAlert.mock.calls[0]?.[0];
    const beaconKey = reportInternalError.mock.calls[0]?.[1];
    expect(boundaryKey).toBe("boundary_error:admin");
    expect(beaconKey).toBe("client_error:book");
    expect(boundaryKey).not.toBe(beaconKey);
  });

  // The generic path is untouched, which is what stops this being a rewrite of
  // the beacon rather than an addition to it.
  it("leaves an ordinary client error on the path it was already on", async () => {
    await post(REPORT);
    expect(reportInternalError).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  // Everything the endpoint already refuses still applies: it is the same public
  // surface, and a boundary report is not more trusted than any other.
  it("is dropped when the limiter cannot vouch for the caller", async () => {
    allowRequest.mockResolvedValue(false);
    const res = await post(BOUNDARY);
    expect(res.status).toBe(204);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("says nothing back, on every path", async () => {
    const res = await post(BOUNDARY);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});

describe("POST /api/client-errors", () => {
  it("accepts a well formed report and raises it as an internal error", async () => {
    const res = await post(REPORT);
    expect(res.status).toBe(204);
    expect(reportInternalError).toHaveBeenCalledOnce();
    const [err, context] = reportInternalError.mock.calls[0];
    expect(context).toBe("client_error:book");
    expect(String(err)).toContain("Cannot read properties of undefined");
  });

  it("returns no body at all, so it cannot be used to probe anything", async () => {
    const res = await post(REPORT);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("fails CLOSED when over the rate limit: the report is dropped, not forwarded", async () => {
    allowRequest.mockResolvedValue(false);
    const res = await post(REPORT);
    expect(res.status).toBe(204);
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the limiter itself throws", async () => {
    // A limiter outage must not become an open public path to Slack. Dropping a
    // beacon report costs nothing; the ordinary alerts still cover real outages.
    allowRequest.mockRejectedValue(new Error("rate_limit_hit failed"));
    const res = await post(REPORT);
    expect(res.status).toBe(204);
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it("drops an unusable report without telling the caller why", async () => {
    for (const body of [null, {}, { kind: "error" }, { kind: "nope", message: "x", page: "/book" }]) {
      const res = await post(body);
      expect(res.status).toBe(204);
    }
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it("drops a body that is not JSON at all", async () => {
    const res = await POST(
      new Request("https://slate.test/api/client-errors", {
        method: "POST",
        body: "{not json",
      }) as unknown as Parameters<typeof POST>[0],
    );
    expect(res.status).toBe(204);
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it("scrubs contact data server side, not trusting the page to have done it", async () => {
    await post({
      kind: "error",
      message: "rejected jane@example.com",
      stack: "at submit with 555-123-4567",
      page: "/book/411",
    });
    const text = String(reportInternalError.mock.calls[0][0]);
    expect(text).not.toContain("jane@example.com");
    expect(text).not.toContain("123-4567");
  });

  it("keys every booker bucket onto one context, so a broken bundle is one alert", async () => {
    await post({ ...REPORT, page: "/book/411" });
    await post({ ...REPORT, page: "/book/412" });
    expect(reportInternalError.mock.calls[0][1]).toBe(reportInternalError.mock.calls[1][1]);
  });

  it("counts the request against the limiter before doing any work", async () => {
    await post(REPORT);
    expect(allowRequest).toHaveBeenCalledWith(
      // #1557: the beacon fails closed on a caller it cannot identify, and says so at the key.
      { kind: "address", ip: "1.2.3.4", policy: CLIENT_ERROR_ADDRESS_POLICY },
      expect.any(Array),
    );
  });
});

// #2641: a host that declared a different origin from the one that framed the
// Booker loses the resize and the success message for every lead, with nothing
// logged by the browser. The page reports the pair; this is what the server does
// with it. It is NOT an internal error, and must not be worded as one (L11).
describe("POST /api/client-errors origin mismatch (#2641)", () => {
  const MISMATCH = {
    kind: "origin_mismatch",
    message: "declared https://trypennie.com, framed by https://www.trypennie.com",
    page: "/book/411",
  };

  it("sends one throttled info message naming both origins, and no internal error", async () => {
    const res = await post(MISMATCH);
    expect(res.status).toBe(204);
    expect(reportInternalError).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(sendThrottledInfo).toHaveBeenCalledTimes(1);
    const [key, cooldown, text] = sendThrottledInfo.mock.calls[0];
    // One fixed key, so a public endpoint cannot mint a key per forged pair.
    expect(key).toBe("embed_origin_mismatch");
    expect(cooldown).toBeGreaterThan(0);
    expect(text).toContain("https://trypennie.com");
    expect(text).toContain("https://www.trypennie.com");
  });

  it("drops a report whose message is not exactly two origins, so free text never reaches Slack", async () => {
    const res = await post({ ...MISMATCH, message: "declared https://a.test, framed by <!channel> https://b.test" });
    expect(res.status).toBe(204);
    expect(sendThrottledInfo).not.toHaveBeenCalled();
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it("still answers 204 when Slack cannot be reached, and logs that it could not tell anybody", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    sendThrottledInfo.mockRejectedValueOnce(new Error("slack 503"));
    const res = await post(MISMATCH);
    expect(res.status).toBe(204);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("origin mismatch info failed"), expect.anything());
    // The mismatch itself was logged before the send was attempted, so the pair is
    // on the record even when the message is not.
    logged.mockRestore();
  });

  it("logs the pair on every report, whether or not the message is sent", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await post(MISMATCH);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('msg="embed origin mismatch"'));
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('framed_by="https://www.trypennie.com"'));
    warned.mockRestore();
  });

  // The contact data scrub rewrites any run of seven or more digits, and preview
  // and staging hosts routinely carry one. The report is two bare origins, never
  // free text, so it must reach the parser as sent, or the host this feature
  // exists for is the one whose report is dropped.
  it("keeps a preview host whose name carries a long run of digits", async () => {
    await post({ ...MISMATCH, message: "declared https://trypennie.com, framed by https://pr-1234567.preview.example" });
    expect(sendThrottledInfo).toHaveBeenCalledTimes(1);
    expect(sendThrottledInfo.mock.calls[0][2]).toContain("https://pr-1234567.preview.example");
  });

  it("logs a report it could not read as two origins, rather than dropping it in silence", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await post({ ...MISMATCH, message: "declared https://a.test, framed by <!channel> https://b.test" });
    expect(sendThrottledInfo).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('msg="unreadable origin mismatch report"'));
    // Never the posted text itself: the endpoint is public.
    expect(warned).not.toHaveBeenCalledWith(expect.stringContaining("<!channel>"));
    warned.mockRestore();
  });

  it("is still refused by the rate limiter first", async () => {
    allowRequest.mockResolvedValue(false);
    await post(MISMATCH);
    expect(sendThrottledInfo).not.toHaveBeenCalled();
  });
});

// #3046: a browser on an old bundle, or anybody with curl, can still post the
// page's address with its query string, which on /book carries the lead's name,
// email and phone, percent encoded so no contact shape matches. The server strips
// it from every field before anything is logged, stored or alerted.
describe("a report carrying the lead's details in a page address (#3046)", () => {
  const PAGE_URL =
    "https://slate.trypennie.app/book?name=Dana%20Lee&email=dana%40example.com&phone=%28215%29%20555-0100";
  const LEAKS = ["?", "name=", "Dana", "Lee", "dana", "%40", "example.com", "%28", "555", "0100"];

  /** The alert exactly as it would be rendered, from the real copy builders. */
  function renderedAlert(): string {
    const [err, context] = reportInternalError.mock.calls[0] as [Error, string];
    return unexpectedFaultAlert(context, shortErrorReason(err, { maxChars: DIAGNOSTIC_REASON_CHARS }));
  }

  /** Everything the chokepoint receives: what it logs, and what it alerts. */
  function everythingReported(): string {
    const [err] = reportInternalError.mock.calls[0] as [Error, string];
    return `${err.message}\n${err.stack ?? ""}\n${renderedAlert()}`;
  }

  it("strips the query string from the source before it reaches the alert", async () => {
    await post({ kind: "error", message: "boom", page: "/book", source: PAGE_URL, line: 12, col: 3 });
    const text = everythingReported();
    for (const leak of LEAKS) expect(text).not.toContain(leak);
    // CONTROL: the path and position survive, so it can still be diagnosed.
    expect(renderedAlert()).toContain("https://slate.trypennie.app/book:12:3");
  });

  it("strips it from a stack frame inside the message and the stack", async () => {
    await post({
      kind: "error",
      message: `failed at ${PAGE_URL}:12:3`,
      stack: `Error: failed\n    at submit (${PAGE_URL}:12:3)`,
      page: "/book",
    });
    const text = everythingReported();
    for (const leak of LEAKS) expect(text).not.toContain(leak);
    expect(text).toContain("failed at https://slate.trypennie.app/book:12:3");
    expect(text).toContain("(https://slate.trypennie.app/book:12:3)");
  });

  it("strips it from the page field too, and still keys on the surface", async () => {
    await post({ kind: "error", message: "boom", page: "/book?name=Dana%20Lee&email=dana%40example.com" });
    const text = everythingReported();
    for (const leak of LEAKS) expect(text).not.toContain(leak);
    expect(reportInternalError.mock.calls[0]![1]).toBe("client_error:book");
  });
});

// #3046: the browser raises a ResizeObserver loop warning when the embed's resize
// watcher defers one size update to the next frame. Nothing failed for the lead,
// so it is logged and never pages.
describe("the harmless ResizeObserver loop warnings (#3046)", () => {
  for (const message of [
    "ResizeObserver loop completed with undelivered notifications",
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop limit exceeded",
  ]) {
    it(`logs and does not page: ${message}`, async () => {
      const info = vi.spyOn(log, "info").mockImplementation(() => {});
      const res = await post({ kind: "error", message, page: "/book", source: PAGE_URL_FOR_RO });
      expect(res.status).toBe(204);
      expect(info).toHaveBeenCalledWith("client-errors", expect.objectContaining({ page: "/book" }));
      expect(JSON.stringify(info.mock.calls)).not.toContain("dana");
      expect(reportInternalError).not.toHaveBeenCalled();
      expect(sendThrottledAlert).not.toHaveBeenCalled();
      expect(sendThrottledInfo).not.toHaveBeenCalled();
      info.mockRestore();
    });
  }

  it("CONTROL: an ordinary error still pages", async () => {
    await post({ kind: "error", message: "Cannot read properties of undefined", page: "/book" });
    expect(reportInternalError).toHaveBeenCalledOnce();
  });

  it("matches the message exactly, so an error that merely mentions it still pages", async () => {
    await post({ kind: "error", message: "ResizeObserver loop limit exceeded while saving the booking", page: "/book" });
    expect(reportInternalError).toHaveBeenCalledOnce();
  });
});

const PAGE_URL_FOR_RO = "https://slate.trypennie.app/book?email=dana%40example.com";

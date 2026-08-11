import { describe, it, expect, vi, beforeEach } from "vitest";

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
const allowRequest = vi.hoisted(() => vi.fn());
const clientIp = vi.hoisted(() => vi.fn(() => "1.2.3.4"));

vi.mock("@/lib/api/errors", () => ({ reportInternalError }));
vi.mock("@/lib/rate-limit", () => ({
  allowRequest,
  clientIp,
  CLIENT_ERROR_RATE_RULES: [{ prefix: "clienterr:h", windowSeconds: 3600, max: 60 }],
}));

import { POST } from "./route";

const post = (body: unknown) =>
  POST({
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0]);

const REPORT = {
  kind: "error",
  message: "Cannot read properties of undefined",
  page: "/book/411",
  stack: "at submit (main.js:1:20)",
};

beforeEach(() => {
  vi.clearAllMocks();
  allowRequest.mockResolvedValue(true);
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
    const res = await POST({
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    } as unknown as Parameters<typeof POST>[0]);
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
    expect(allowRequest).toHaveBeenCalledWith("1.2.3.4", expect.any(Array));
  });
});

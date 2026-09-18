import { describe, it, expect, vi, beforeEach } from "vitest";

const limiter = vi.hoisted(() => ({
  allowRequest: vi.fn(async () => true),
  clientIp: vi.fn(() => "203.0.113.7"),
  CSP_REPORT_RATE_RULES: [{ prefix: "csp:m", windowSeconds: 60, max: 20 }],
}));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/rate-limit", () => limiter);
vi.mock("@/lib/log", () => ({ log: logged }));

import { POST } from "./route";

function req(body: unknown, contentType = "application/csp-report") {
  return new Request("https://slate.trypennie.app/api/csp-report", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const LEGACY = {
  "csp-report": {
    "document-uri": "https://slate.trypennie.app/book?xbc=411",
    "violated-directive": "script-src",
    "blocked-uri": "https://evil.test/x.js",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  limiter.allowRequest.mockResolvedValue(true);
});

describe("POST /api/csp-report (#2565)", () => {
  it("records the violation with the directive and what was blocked", async () => {
    const res = await POST(req(LEGACY));

    expect(res.status).toBe(204);
    expect(logged.warn).toHaveBeenCalledWith(
      "csp-report",
      expect.objectContaining({ directive: "script-src", blocked: "https://evil.test/x.js" }),
    );
  });

  it("never logs a booking manage token out of a reported URL", async () => {
    // The manage page's URL IS a credential. #2564 took it out of the warehouse;
    // an endpoint the whole internet can post to must not put it in the logs.
    await POST(
      req({
        "csp-report": {
          "document-uri": "https://slate.trypennie.app/booking/manage/tok-secret",
          referrer: "https://slate.trypennie.app/booking/manage/tok-secret",
          "violated-directive": "img-src",
        },
      }),
    );

    expect(JSON.stringify(logged.warn.mock.calls)).not.toContain("tok-secret");
    expect(JSON.stringify(logged.warn.mock.calls)).toContain("[redacted]");
  });

  it("reads the modern Reporting API shape as well as the legacy one", async () => {
    // A browser family that reports in a shape this cannot read is a browser
    // family reporting nothing, which looks exactly like one with nothing to
    // report.
    await POST(
      req([{ type: "csp-violation", body: { documentURL: "https://slate.trypennie.app/book", effectiveDirective: "style-src", blockedURL: "inline" } }]),
    );

    expect(logged.warn).toHaveBeenCalledWith(
      "csp-report",
      expect.objectContaining({ directive: "style-src" }),
    );
  });

  it("returns 204 and records NOTHING when the rate limiter refuses", async () => {
    limiter.allowRequest.mockResolvedValue(false);

    const res = await POST(req(LEGACY));

    expect(res.status).toBe(204);
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the rate limiter itself throws", async () => {
    // This is a public path anyone can post to. A limiter that cannot vouch for
    // the caller means the report is dropped, because an unmetered public path
    // that writes costs more than one lost report.
    limiter.allowRequest.mockRejectedValue(new Error("limiter unreachable"));

    const res = await POST(req(LEGACY));

    expect(res.status).toBe(204);
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("returns 204 for a body that is not JSON, and records nothing", async () => {
    const res = await POST(req("not json at all"));

    expect(res.status).toBe(204);
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("answers 204 with no body on EVERY path, so it is no oracle for what is accepted", async () => {
    const bodies: unknown[] = [LEGACY, "garbage", null, { nonsense: true }];
    for (const b of bodies) {
      const res = await POST(req(b));
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    }
  });
});

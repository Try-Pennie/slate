import { describe, it, expect, vi, beforeEach } from "vitest";

// #2243: the address Slate SAW, echoed back so a load run can attribute its write
// 429s. A CI runner behind egress NAT cannot work that out for itself.
//
// The gate is the feature. Echoing a caller's address back has no business on a
// production response, so BOTH directions are here: with the flag on the header is
// present, and with the flag off nothing is added at all. One without the other
// would be satisfied by a helper wired to a single answer (L1).
//
// The flag is set in `vi.hoisted` rather than at module scope, and the difference
// is not style: ES module imports are evaluated BEFORE any statement in the module
// body, so a plain assignment here runs after `loadtest-stub.ts` has already read
// the variable and `LOADTEST` is false in a file that looks like it set it.
// `vi.hoisted` runs before the imports.
vi.hoisted(() => {
  process.env.SLATE_LOADTEST = "true";
});

import { stampSeenIp, SEEN_IP_HEADER } from "./loadtest-echo";

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

beforeEach(() => vi.clearAllMocks());

describe("the seen-IP echo under SLATE_LOADTEST", () => {
  it("stamps the address the rate limiter keys on", () => {
    const res = stampSeenIp(new Response("ok"), headers({ "cf-connecting-ip": "203.0.113.9" }));
    expect(res.headers.get(SEEN_IP_HEADER)).toBe("203.0.113.9");
  });

  it("reads the address the same way the limiter does, so the two cannot disagree", () => {
    // No cf-connecting-ip (a local run): `clientIp` falls back to the first hop of
    // x-forwarded-for, and the echo must report the SAME value the ceiling used,
    // never the header it happens to find first.
    const res = stampSeenIp(
      new Response("ok"),
      headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }),
    );
    expect(res.headers.get(SEEN_IP_HEADER)).toBe("198.51.100.4");
  });

  it("reports the shared bucket by name when the caller cannot be identified", () => {
    // "unknown" is a real, named value in the limiter: an address it cannot read is
    // a SHARED counter. A run told nothing would read the blank as its own address.
    const res = stampSeenIp(new Response("ok"), headers({}));
    expect(res.headers.get(SEEN_IP_HEADER)).toBe("unknown");
  });

  it("returns the same response, so a call site can wrap a return", () => {
    const original = new Response("ok", { status: 429 });
    const returned = stampSeenIp(original, headers({ "cf-connecting-ip": "203.0.113.9" }));
    expect(returned).toBe(original);
    expect(returned.status).toBe(429);
  });

  it("does not fail a booking when the response head cannot be written", () => {
    // An immutable head loses one attribution and must not lose the booking.
    const res = new Response("ok");
    Object.defineProperty(res, "headers", {
      value: {
        set() {
          throw new TypeError("immutable");
        },
      },
    });
    expect(() => stampSeenIp(res, headers({ "cf-connecting-ip": "203.0.113.9" }))).not.toThrow();
  });
});

describe("the same helper with the flag OFF", () => {
  it("adds nothing at all", async () => {
    // The control (L1). Without it every case above is satisfied by a helper that
    // always stamps, and the header would ship to production.
    vi.resetModules();
    process.env.SLATE_LOADTEST = "false";
    try {
      const off = await import("./loadtest-echo");
      const res = off.stampSeenIp(new Response("ok"), headers({ "cf-connecting-ip": "203.0.113.9" }));
      expect(res.headers.get(SEEN_IP_HEADER)).toBeNull();
    } finally {
      process.env.SLATE_LOADTEST = "true";
      vi.resetModules();
    }
  });
});

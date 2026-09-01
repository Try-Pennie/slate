import { describe, it, expect, vi, beforeEach } from "vitest";

// #1046: the cookie authed admin mutation routes carry no CSRF token. What keeps a
// third party page from making a manager's browser POST a cancellation is that
// Supabase's SSR cookies default to SameSite=Lax, which is a library default this
// repo asserts nowhere. These routes now also check where the request came from.
//
// The rule under test is deliberately asymmetric, and both halves matter:
//
//   * a request that SAYS it is not same origin is refused, and
//   * a request that says NOTHING is allowed through.
//
// The second half is not laxness, it is the blast radius: a guard that refused
// every header-less request would refuse curl, the smoke scripts, and anything
// hitting these routes without a browser, which is a working guard that breaks
// operations. So it is asserted as explicitly as the refusals.

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { warn: logWarn, error: vi.fn(), info: vi.fn() } }));

import {
  sameOriginVerdict,
  crossOriginRefusal,
  CROSS_ORIGIN_MESSAGE,
} from "./same-origin";

const HOST = "slate.trypennie.app";

function headers(over: Partial<Record<"origin" | "secFetchSite" | "host", string | null>> = {}) {
  return { origin: null, secFetchSite: null, host: HOST, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sameOriginVerdict allows the real thing", () => {
  it("allows Slate's own UI: same-origin plus a matching Origin", () => {
    const v = sameOriginVerdict(
      headers({ origin: `https://${HOST}`, secFetchSite: "same-origin" }),
    );
    expect(v.ok).toBe(true);
  });

  it("allows a caller that sends neither header, so scripts keep working", () => {
    expect(sameOriginVerdict(headers()).ok).toBe(true);
  });

  it("ignores the port and the path on the Origin, and the case of the host", () => {
    expect(
      sameOriginVerdict(headers({ origin: "http://LOCALHOST:3000", host: "localhost:3000" })).ok,
    ).toBe(true);
  });

  it("refuses a matching host on a DIFFERENT port", () => {
    // Origin includes the port, so a different port is a different origin. Pinned
    // because a comparison written on the hostname alone would pass this.
    const v = sameOriginVerdict(headers({ origin: "http://localhost:4000", host: "localhost:3000" }));
    expect(v.ok).toBe(false);
  });
});

describe("sameOriginVerdict refuses everything that says it is elsewhere", () => {
  it("refuses cross-site", () => {
    const v = sameOriginVerdict(headers({ secFetchSite: "cross-site" }));
    expect(v).toEqual({ ok: false, reason: "Sec-Fetch-Site: cross-site" });
  });

  it("refuses same-site, because a sibling subdomain is not this app", () => {
    const v = sameOriginVerdict(headers({ secFetchSite: "same-site" }));
    expect(v.ok).toBe(false);
  });

  it("refuses none, because a mutation from Slate's UI is never page-less", () => {
    const v = sameOriginVerdict(headers({ secFetchSite: "none" }));
    expect(v.ok).toBe(false);
  });

  it("refuses an Origin whose host is not the Host the request arrived on", () => {
    const v = sameOriginVerdict(headers({ origin: "https://evil.example" }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("evil.example");
  });

  it("refuses the literal string null, which a sandboxed iframe sends", () => {
    const v = sameOriginVerdict(headers({ origin: "null" }));
    expect(v.ok).toBe(false);
  });

  it("refuses an Origin it cannot compare, when Host is missing", () => {
    // A guard that cannot measure must not pass. Without this the missing-Host case
    // would fall through to allowed, which is the one shape an attacker controls
    // least but the one a broken proxy produces most.
    const v = sameOriginVerdict(headers({ origin: "https://evil.example", host: null }));
    expect(v.ok).toBe(false);
  });

  it("refuses a cross-site Sec-Fetch-Site even when the Origin matches", () => {
    // Both signals are consulted; neither can be used to vouch for the other.
    const v = sameOriginVerdict(
      headers({ origin: `https://${HOST}`, secFetchSite: "cross-site" }),
    );
    expect(v.ok).toBe(false);
  });
});

describe("crossOriginRefusal", () => {
  function req(h: Record<string, string>) {
    return { headers: new Headers(h) };
  }

  it("returns null for a same-origin request, and logs nothing", () => {
    const res = crossOriginRefusal(
      req({ origin: `https://${HOST}`, "sec-fetch-site": "same-origin", host: HOST }),
      "admin/test",
    );
    expect(res).toBeNull();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("returns a 403 naming no header, and records the reason in the log", async () => {
    const res = crossOriginRefusal(
      req({ origin: "https://evil.example", "sec-fetch-site": "cross-site", host: HOST }),
      "admin/test",
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(await res!.json()).toEqual({ error: CROSS_ORIGIN_MESSAGE });

    // The client is told nothing about which signal refused it; the log carries it.
    expect(CROSS_ORIGIN_MESSAGE).not.toContain("Origin");
    expect(logWarn).toHaveBeenCalledTimes(1);
    const [tag, fields] = logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(tag).toBe("same-origin");
    expect(fields.route).toBe("admin/test");
    expect(String(fields.reason)).toContain("cross-site");
  });
});

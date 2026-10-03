import { describe, it, expect, vi, beforeEach } from "vitest";

// #3106: the landing pages' identity lookup is throttled per address, and over the ceiling
// the page draws the booker with no prefill rather than refusing the lead.
const landingIdentityAllowed = vi.hoisted(() => vi.fn(async (_ip: string) => true));
vi.mock("@/lib/rate-limit", async () => {
  const core = await import("@/lib/rate-limit-core");
  return { clientIp: core.clientIp, landingIdentityAllowed };
});

import { landingLookupId } from "./landing-identity-gate";

const headers = (ip: string) => async () => new Headers({ "cf-connecting-ip": ip });

beforeEach(() => {
  landingIdentityAllowed.mockReset();
  landingIdentityAllowed.mockResolvedValue(true);
});

describe("landingLookupId (#3106)", () => {
  it("hands back the id when the caller is under the ceiling", async () => {
    await expect(landingLookupId("00Q000000000001", headers("203.0.113.5"))).resolves.toBe(
      "00Q000000000001",
    );
    expect(landingIdentityAllowed).toHaveBeenCalledWith("203.0.113.5");
  });

  it("hands back no id over the ceiling, so nothing about the lead is read", async () => {
    landingIdentityAllowed.mockResolvedValue(false);
    await expect(landingLookupId("00Q000000000001", headers("203.0.113.5"))).resolves.toBe("");
  });

  it("spends nothing on a link that names nobody", async () => {
    const readHeaders = vi.fn(headers("203.0.113.5"));
    await expect(landingLookupId("  ", readHeaders)).resolves.toBe("");
    expect(landingIdentityAllowed).not.toHaveBeenCalled();
    // Not even the request headers, so a page with no id needs no request scope for this.
    expect(readHeaders).not.toHaveBeenCalled();
  });

  it("keys an IPv6 caller on its /64, so rotating inside it buys no fresh allowance", async () => {
    await landingLookupId("00Q000000000001", headers("2001:db8:1:2::aaaa"));
    await landingLookupId("00Q000000000002", headers("2001:db8:1:2::bbbb"));
    expect(landingIdentityAllowed.mock.calls.map((c) => c[0])).toEqual([
      "2001:db8:1:2::/64",
      "2001:db8:1:2::/64",
    ]);
  });
});

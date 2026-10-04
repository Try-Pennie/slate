import { describe, it, expect, vi } from "vitest";

// #3144 (L742): a delegated token is cached for most of an hour, so Google can
// refuse it while the cache still says it is good. The call that met the refusal
// must be retried once on a fresh token, never failed: failing it loses that
// call's work while the next call, minted afresh, succeeds and the outage reads
// as having healed itself. Exactly once, so a second refusal surfaces.

import { sendWithTokenRetry } from "./token-retry";

vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

/** A token source handing out t1, t2, ... and recording what it was told was refused. */
function tokens() {
  const rejectedSeen: (string | undefined)[] = [];
  let n = 0;
  const getToken = vi.fn(async (rejected?: string) => {
    rejectedSeen.push(rejected);
    n += 1;
    return `t${n}`;
  });
  return { getToken, rejectedSeen };
}

describe("sendWithTokenRetry (#3144)", () => {
  it("retries a call whose token was refused, once, on a fresh token", async () => {
    const { getToken, rejectedSeen } = tokens();
    const sentWith: string[] = [];
    const res = await sendWithTokenRetry(getToken, async (token) => {
      sentWith.push(token);
      return new Response(token === "t1" ? "expired" : "ok", { status: token === "t1" ? 401 : 200 });
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(sentWith).toEqual(["t1", "t2"]);
    // The refresh names the refused token, so the cache drops THAT one only.
    expect(rejectedSeen).toEqual([undefined, "t1"]);
  });

  it("hands a second refusal back to the caller rather than looping", async () => {
    const { getToken } = tokens();
    const sentWith: string[] = [];
    const res = await sendWithTokenRetry(getToken, async (token) => {
      sentWith.push(token);
      return new Response("still refused", { status: 401 });
    });
    // The caller's own failure path reads this status and throws loudly.
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("still refused");
    expect(sentWith).toEqual(["t1", "t2"]);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("does not retry a refusal a fresh token cannot fix (403), or a success", async () => {
    // The control: a wrapper that retried every failure would satisfy the cases
    // above while doubling every permission error and rate limit.
    for (const status of [200, 403, 404, 429, 503]) {
      const { getToken } = tokens();
      const send = vi.fn(async () => new Response("", { status }));
      const res = await sendWithTokenRetry(getToken, send);
      expect(res.status).toBe(status);
      expect(send).toHaveBeenCalledTimes(1);
      expect(getToken).toHaveBeenCalledTimes(1);
    }
  });

  it("fails loudly when the refresh itself is refused", async () => {
    const getToken = vi.fn(async (rejected?: string) => {
      if (rejected) throw new Error("Delegated token failed: 400 invalid_grant");
      return "t1";
    });
    const send = vi.fn(async () => new Response("", { status: 401 }));
    await expect(sendWithTokenRetry(getToken, send)).rejects.toThrow(/invalid_grant/);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// #3098: a failed alert send is still caught, and now it is RECORDED. The send
// throws on purpose for a misconfigured key (#2656); a bare catch used to drop
// that with no line anywhere.
const logged = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../log.ts", () => logged);

import { logAlertSendFailure, logAllClearFailure } from "./send-failure";

beforeEach(() => vi.clearAllMocks());

describe("alert send failure handlers (#3098)", () => {
  it("logs the key and passes the error itself through", async () => {
    const err = new Error("empty_tier has no usable cooldown (undefined), so it was not sent");
    await Promise.reject(err).catch(logAlertSendFailure("empty_tier:low"));
    expect(logged.log.error).toHaveBeenCalledTimes(1);
    const [tag, fields, passed] = logged.log.error.mock.calls[0]!;
    expect(tag).toBe("alert-dispatch");
    expect(fields).toMatchObject({ key: "empty_tier:low" });
    expect(passed).toBe(err);
  });

  it("still resolves, so the caller carries on", async () => {
    await expect(
      Promise.reject(new Error("db down")).catch(logAlertSendFailure("k")),
    ).resolves.toBeUndefined();
  });

  it("names every key of a failed batched all-clear and answers that nothing cleared", async () => {
    const cleared = await Promise.reject<string[]>(new Error("db down")).catch(
      logAllClearFailure(["a", "b"]),
    );
    expect(cleared).toEqual([]);
    expect(logged.log.error.mock.calls[0]![1]).toMatchObject({ key: "a,b" });
  });

  it("logs nothing when the send succeeded", async () => {
    await Promise.resolve().catch(logAlertSendFailure("k"));
    expect(logged.log.error).not.toHaveBeenCalled();
  });
});

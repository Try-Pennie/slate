import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// #3102: the delegated token mint had no deadline, and every Google call starts
// with one, so a hung token endpoint held the confirm path as surely as a hung
// calendar did. A real key is generated here so the mint signs for real; only the
// token endpoint is faked, as a fetch that never answers, on fake timers.

const env = vi.hoisted(() => ({ key: "" }));
vi.mock("@/lib/env", () => ({
  googleSaClientEmail: () => "sa@x.iam.gserviceaccount.com",
  googleSaPrivateKey: () => env.key,
}));

import { getDelegatedToken, DELEGATED_TOKEN_TIMEOUT_MS, GMAIL_SEND_SCOPE } from "./dwd";
import { DeadlineExceededError } from "@/lib/fetch-within-deadline";

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  env.key = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PRIVATE KEY-----`;
});

describe("getDelegatedToken deadline (#3102)", () => {
  // Signing is real async work, not a timer, so the clock is only advanced once
  // the request has actually been sent.
  let sent: Promise<void>;
  beforeEach(() => {
    vi.useFakeTimers();
    let markSent = () => {};
    sent = new Promise((r) => (markSent = r));
    vi.stubGlobal("fetch", () => {
      markSent();
      return new Promise<Response>(() => {});
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function outcomeAfter(p: Promise<unknown>, ms: number) {
    let outcome: unknown = "pending";
    p.then(
      () => (outcome = "resolved"),
      (e: unknown) => (outcome = e),
    );
    await sent;
    await vi.advanceTimersByTimeAsync(ms - 1);
    const before = outcome;
    await vi.advanceTimersByTimeAsync(1);
    return { before, after: outcome };
  }

  it("gives up on a hung token endpoint at its default deadline", async () => {
    // A distinct address per test, so the module's token cache cannot answer.
    const { before, after } = await outcomeAfter(
      getDelegatedToken("hung-default@x.com", GMAIL_SEND_SCOPE),
      DELEGATED_TOKEN_TIMEOUT_MS,
    );
    expect(before).toBe("pending");
    expect(after).toBeInstanceOf(DeadlineExceededError);
    expect((after as DeadlineExceededError).label).toBe("google token mint");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds the mint to the deadline its caller passes", async () => {
    const { before, after } = await outcomeAfter(getDelegatedToken("hung-named@x.com", undefined, 500), 500);
    expect(before).toBe("pending");
    expect(after).toBeInstanceOf(DeadlineExceededError);
    expect((after as DeadlineExceededError).timeoutMs).toBe(500);
  });
});

// #3144 (L742): a caller told its cached token was refused names that token, and
// the cache drops it and mints afresh. Only THAT token: a concurrent caller that
// already replaced it must get the replacement, not force a needless third mint.
describe("getDelegatedToken after a refused token (#3144)", () => {
  let mints: number;
  beforeEach(() => {
    mints = 0;
    vi.stubGlobal("fetch", async () => {
      mints += 1;
      return new Response(JSON.stringify({ access_token: `tok-${mints}`, expires_in: 3600 }), { status: 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("answers from the cache until told the token was refused, then mints a new one", async () => {
    const who = "refused-once@x.com";
    expect(await getDelegatedToken(who)).toBe("tok-1");
    expect(await getDelegatedToken(who)).toBe("tok-1");
    expect(mints).toBe(1);
    expect(await getDelegatedToken(who, undefined, undefined, "tok-1")).toBe("tok-2");
    expect(mints).toBe(2);
    // The new token is what the cache now holds for everybody else.
    expect(await getDelegatedToken(who)).toBe("tok-2");
    expect(mints).toBe(2);
  });

  it("keeps a replacement another caller already minted", async () => {
    const who = "refused-twice@x.com";
    await getDelegatedToken(who);
    await getDelegatedToken(who, undefined, undefined, "tok-1");
    // A second caller whose request also went out on tok-1 reports it late.
    expect(await getDelegatedToken(who, undefined, undefined, "tok-1")).toBe("tok-2");
    expect(mints).toBe(2);
  });

  it("drops only the scope that was refused", async () => {
    const who = "refused-scope@x.com";
    await getDelegatedToken(who);
    await getDelegatedToken(who, GMAIL_SEND_SCOPE);
    expect(mints).toBe(2);
    await getDelegatedToken(who, GMAIL_SEND_SCOPE, undefined, "tok-2");
    expect(await getDelegatedToken(who)).toBe("tok-1");
    expect(mints).toBe(3);
  });
});

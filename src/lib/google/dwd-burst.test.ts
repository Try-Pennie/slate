import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// #3123: a burst of requests for one delegated identity must share ONE token mint.
// The token cache stored only results, so N requests arriving before the first mint
// returned each signed a JWT and called Google's token endpoint. The fetch here is
// held open by the test, so every call in the burst is genuinely concurrent.

let pem = "";
vi.mock("@/lib/env", () => ({
  googleSaClientEmail: () => "sa@example.iam.gserviceaccount.com",
  googleSaPrivateKey: () => pem,
}));

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;
});

type Held = { resolve: (r: Response) => void };
let held: Held[] = [];

beforeEach(() => {
  held = [];
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => held.push({ resolve }))),
  );
});

/** Lets the signing (Web Crypto) inside each mint reach its fetch. */
async function untilFetches(n: number): Promise<void> {
  for (let i = 0; i < 200 && held.length < n; i++) await new Promise((r) => setTimeout(r, 1));
}

const ok = (token: string) =>
  new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });

describe("getDelegatedToken under a burst", () => {
  it("mints once for five concurrent requests for the same identity", async () => {
    const { getDelegatedToken } = await import("@/lib/google/dwd");
    const burst = Promise.all(Array.from({ length: 5 }, () => getDelegatedToken("a@trypennie.com")));
    await untilFetches(1);
    // Give any extra mints the chance to reach fetch before counting.
    await new Promise((r) => setTimeout(r, 20));
    expect(held.length).toBe(1);
    held[0].resolve(ok("tok-1"));
    expect(await burst).toEqual(["tok-1", "tok-1", "tok-1", "tok-1", "tok-1"]);
  });

  it("does not share a mint between two identities", async () => {
    const { getDelegatedToken } = await import("@/lib/google/dwd");
    const a = getDelegatedToken("a@trypennie.com");
    const b = getDelegatedToken("b@trypennie.com");
    await untilFetches(2);
    expect(held.length).toBe(2);
    held[0].resolve(ok("tok-a"));
    held[1].resolve(ok("tok-b"));
    expect(new Set([await a, await b])).toEqual(new Set(["tok-a", "tok-b"]));
  });

  it("rejects every caller of a failed mint, then retries on the next request", async () => {
    const { getDelegatedToken } = await import("@/lib/google/dwd");
    const burst = Promise.allSettled([getDelegatedToken("c@trypennie.com"), getDelegatedToken("c@trypennie.com")]);
    await untilFetches(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(held.length).toBe(1);
    held[0].resolve(new Response('{"error":"unauthorized_client"}', { status: 401 }));
    const settled = await burst;
    expect(settled.every((s) => s.status === "rejected")).toBe(true);

    const retry = getDelegatedToken("c@trypennie.com");
    await untilFetches(2);
    expect(held.length).toBe(2);
    held[1].resolve(ok("tok-c"));
    expect(await retry).toBe("tok-c");
  });

  // A caller joining a mint somebody else started is still held to ITS OWN
  // deadline: sharing must never let a call wait longer than its own mint would.
  it("holds a caller that joins a slower mint to its own deadline", async () => {
    const { getDelegatedToken } = await import("@/lib/google/dwd");
    const { DeadlineExceededError } = await import("@/lib/fetch-within-deadline");
    const leader = getDelegatedToken("d@trypennie.com", undefined, 60_000);
    await untilFetches(1);
    const joiner = getDelegatedToken("d@trypennie.com", undefined, 20);
    await expect(joiner).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(held.length).toBe(1);
    held[0].resolve(ok("tok-d"));
    expect(await leader).toBe("tok-d");
  });

  // The other direction: the LEADER's deadline is the shorter one. Its mint giving
  // up says nothing about the joiner, which still has time, so the joiner mints for
  // itself rather than failing on a deadline it never had.
  it("never fails a joiner on the leader's shorter deadline", async () => {
    const { getDelegatedToken } = await import("@/lib/google/dwd");
    const { DeadlineExceededError } = await import("@/lib/fetch-within-deadline");
    const leader = getDelegatedToken("e@trypennie.com", undefined, 20);
    await untilFetches(1);
    const joiner = getDelegatedToken("e@trypennie.com", undefined, 60_000);
    await expect(leader).rejects.toBeInstanceOf(DeadlineExceededError);
    await untilFetches(2);
    expect(held.length).toBe(2);
    held[1].resolve(ok("tok-e"));
    expect(await joiner).toBe("tok-e");
  });
});

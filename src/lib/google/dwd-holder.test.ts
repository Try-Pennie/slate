import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// #3512: the three tiers a delegated token is read from, in order: the isolate's own
// cache, the shared holder, a mint. A confirm on an isolate with no token for its advisor
// used to mint on the lead's path; now it reads the holder and mints only when the holder
// has nothing, or cannot answer in time, exactly as it did before. The holder is replaced
// with a fake (or the real client over a fake binding), the token endpoint with a stubbed
// fetch, and the work run after a response is captured so each case runs it by hand.

const env = vi.hoisted(() => ({ key: "" }));
vi.mock("@/lib/env", () => ({
  googleSaClientEmail: () => "sa@x.iam.gserviceaccount.com",
  googleSaPrivateKey: () => env.key,
}));

type Read = import("./token-holder").HolderRead;
const live = vi.hoisted(() => ({
  client: null as null | {
    read: (key: string, waitMs: number) => Promise<Read>;
    put: (key: string, token: string, expMs: number) => Promise<"stored" | "kept">;
  },
  jobs: [] as { label: string; work: () => Promise<unknown> }[],
}));
vi.mock("@/lib/google/token-holder-live", () => ({
  tokenHolder: () => live.client,
  tokenHolderBackground: (label: string, work: () => Promise<unknown>) => live.jobs.push({ label, work }),
}));

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  env.key = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PRIVATE KEY-----`;
});

const HOUR = 3_600_000;

/** A holder that answers from a map, recording every read and put. */
function fakeHolder(initial: Record<string, { token: string; expMs: number; refresh?: boolean }> = {}) {
  const held = new Map(Object.entries(initial));
  const reads: { key: string; waitMs: number }[] = [];
  const puts: { key: string; token: string; expMs: number }[] = [];
  return {
    reads,
    puts,
    held,
    client: {
      async read(key: string, waitMs: number): Promise<Read> {
        reads.push({ key, waitMs });
        const h = held.get(key);
        return h ? { kind: "hit", token: h.token, expMs: h.expMs, refresh: h.refresh ?? false } : { kind: "miss" };
      },
      async put(key: string, token: string, expMs: number) {
        puts.push({ key, token, expMs });
        held.set(key, { token, expMs });
        return "stored" as const;
      },
    },
  };
}

let mints: number;
let lines: string[];
function mintAnswers(status = 200) {
  vi.stubGlobal("fetch", async () => {
    mints += 1;
    return status === 200
      ? new Response(JSON.stringify({ access_token: `minted-${mints}`, expires_in: 3600 }), { status: 200 })
      : new Response('{"error":"backendError"}', { status });
  });
}

async function load() {
  return import("./dwd");
}
async function runJobs() {
  const jobs = live.jobs.splice(0);
  return Promise.allSettled(jobs.map((j) => j.work()));
}
const tagged = (tag: string) => lines.filter((l) => l.includes(`tag=${tag} `));

beforeEach(() => {
  vi.resetModules();
  mints = 0;
  lines = [];
  live.client = null;
  live.jobs = [];
  const keep = (line: unknown) => {
    if (typeof line === "string") lines.push(line);
  };
  vi.spyOn(console, "info").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ADVISOR = "advisor@trypennie.com";

describe("the holder answers before a mint is needed (#3512)", () => {
  it("serves an isolate with no token from the holder, and mints nothing", async () => {
    const { getDelegatedToken, CALENDAR_SCOPE } = await load();
    const h = fakeHolder({ [`${CALENDAR_SCOPE}\n${ADVISOR}`]: { token: "held", expMs: Date.now() + HOUR } });
    live.client = h.client;
    mintAnswers();
    expect(await getDelegatedToken(ADVISOR)).toBe("held");
    expect(mints).toBe(0);
    expect(tagged("google-token-read")).toEqual([
      expect.stringMatching(/^slate tag=google-token-read msg="token read" tier="holder" scope="calendar" ms=\d+$/),
    ]);
    // The isolate keeps what the holder gave it: the next read never leaves the isolate.
    expect(await getDelegatedToken(ADVISOR)).toBe("held");
    expect(h.reads).toHaveLength(1);
    expect(tagged("google-token-mint")).toEqual([]);
  });

  it("mints on a miss, as before, and puts the new token into the holder after the response", async () => {
    const { getDelegatedToken } = await load();
    const h = fakeHolder();
    live.client = h.client;
    mintAnswers();
    expect(await getDelegatedToken(ADVISOR)).toBe("minted-1");
    expect(h.puts).toEqual([]);
    expect(live.jobs.map((j) => j.label)).toEqual(["google-token-holder-put"]);
    await runJobs();
    expect(h.puts).toEqual([expect.objectContaining({ token: "minted-1" })]);
    expect(h.puts[0].expMs).toBeGreaterThan(Date.now() + HOUR - 5_000);
    expect(tagged("google-token-mint")[0]).toContain('holder="miss"');
    expect(tagged("google-token-read")[0]).toMatch(/tier="mint" scope="calendar" ms=\d+ holder="miss"$/);
  });

  it("shares ONE holder read between concurrent requests for one advisor on one isolate", async () => {
    const { getDelegatedToken, CALENDAR_SCOPE } = await load();
    const h = fakeHolder({ [`${CALENDAR_SCOPE}\n${ADVISOR}`]: { token: "held", expMs: Date.now() + HOUR } });
    live.client = h.client;
    mintAnswers();
    expect(await Promise.all(Array.from({ length: 5 }, () => getDelegatedToken(ADVISOR)))).toEqual(Array(5).fill("held"));
    expect(h.reads).toHaveLength(1);
    expect(mints).toBe(0);
  });

  it("holds the holder read to its own small deadline, and to less when the budget has less", async () => {
    const { getDelegatedToken } = await load();
    const { TOKEN_HOLDER_READ_MS } = await import("./token-holder");
    const { withinCallBudget } = await import("@/lib/call-budget");
    const h = fakeHolder();
    live.client = h.client;
    mintAnswers();
    await getDelegatedToken("one@trypennie.com", undefined, 8_000);
    expect(h.reads[0].waitMs).toBe(TOKEN_HOLDER_READ_MS);
    await withinCallBudget(90, "the booking confirm", () => getDelegatedToken("two@trypennie.com", undefined, 8_000));
    expect(h.reads[1].waitMs).toBeLessThanOrEqual(90);
    expect(h.reads[1].waitMs).toBeGreaterThan(0);
  });
});

describe("a failing holder never fails a token read (#3512)", () => {
  it("mints itself when the holder does not answer within its deadline, and says so", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { makeTokenHolderClient, TOKEN_HOLDER_READ_MS } = await import("./token-holder");
    const { realTimer } = await import("@/lib/read-within-deadline");
    // The REAL client over a binding that never answers.
    live.client = makeTokenHolderClient({
      namespace: { idFromName: (n) => n, get: () => ({ fetch: () => new Promise<Response>(() => {}) }) },
      timer: realTimer,
      now: () => Date.now(),
    });
    mintAnswers();
    const { getDelegatedToken } = await load();
    let settled: unknown = "pending";
    const reading = getDelegatedToken(ADVISOR).then((t) => (settled = t));
    await vi.advanceTimersByTimeAsync(TOKEN_HOLDER_READ_MS - 1);
    expect(settled).toBe("pending");
    expect(mints).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await reading;
    expect(settled).toBe("minted-1");
    expect(tagged("google-token-holder")).toEqual([
      `slate tag=google-token-holder msg="holder did not answer; minting instead" outcome="timeout" waited_ms=${TOKEN_HOLDER_READ_MS}`,
    ]);
    expect(tagged("google-token-mint")[0]).toContain('holder="timeout"');
  });

  it("mints itself when the holder throws, and logs the reason without the address", async () => {
    const { getDelegatedToken } = await load();
    live.client = {
      read: async () => ({ kind: "error", reason: "Durable Object reset because its code was updated." }),
      put: async () => "stored",
    };
    mintAnswers();
    expect(await getDelegatedToken(ADVISOR)).toBe("minted-1");
    const warn = tagged("google-token-holder");
    expect(warn).toEqual([
      'slate tag=google-token-holder msg="holder did not answer; minting instead" outcome="error" reason="Durable Object reset because its code was updated."',
    ]);
    expect(warn[0]).not.toContain("@");
    expect(tagged("google-token-mint")[0]).toContain('holder="error"');
  });

  it("mints itself when the holder hands back a token with no usable time left", async () => {
    const { getDelegatedToken } = await load();
    live.client = { read: async () => ({ kind: "expired" }), put: async () => "stored" };
    mintAnswers();
    expect(await getDelegatedToken(ADVISOR)).toBe("minted-1");
    expect(tagged("google-token-mint")[0]).toContain('holder="expired"');
  });

  it("mints as before where there is no holder at all", async () => {
    const { getDelegatedToken } = await load();
    mintAnswers();
    expect(await getDelegatedToken(ADVISOR)).toBe("minted-1");
    expect(live.jobs).toEqual([]);
    expect(tagged("google-token-mint")[0]).toContain('holder="unbound"');
  });

  it("still answers when the put after a mint fails; the failure is the background job's to report", async () => {
    const { getDelegatedToken } = await load();
    live.client = { read: async () => ({ kind: "miss" }), put: async () => Promise.reject(new Error("holder gone")) };
    mintAnswers();
    expect(await getDelegatedToken(ADVISOR)).toBe("minted-1");
    const [settled] = await runJobs();
    expect(settled.status).toBe("rejected");
  });
});

describe("refreshing ahead of expiry, off the lead's path (#3512)", () => {
  it("serves an ageing token at once and refreshes it after the response when the holder asks", async () => {
    const { getDelegatedToken, CALENDAR_SCOPE } = await load();
    const key = `${CALENDAR_SCOPE}\n${ADVISOR}`;
    const h = fakeHolder({ [key]: { token: "ageing", expMs: Date.now() + 5 * 60_000, refresh: true } });
    live.client = h.client;
    mintAnswers();
    expect(await getDelegatedToken(ADVISOR)).toBe("ageing");
    expect(mints).toBe(0);
    expect(live.jobs.map((j) => j.label)).toEqual(["google-token-refresh"]);
    await runJobs();
    expect(mints).toBe(1);
    expect(tagged("google-token-mint")[0]).toContain('holder="refresh"');
    expect(tagged("google-token-mint")[0]).not.toContain("request=");
    // The refreshed token is put, and this isolate now holds it too.
    expect(live.jobs.map((j) => j.label)).toEqual(["google-token-holder-put"]);
    await runJobs();
    expect(h.puts.map((p) => p.token)).toEqual(["minted-1"]);
    expect(await getDelegatedToken(ADVISOR)).toBe("minted-1");
  });

  it("does not refresh when the holder gave the claim to another reader", async () => {
    const { getDelegatedToken, CALENDAR_SCOPE } = await load();
    live.client = fakeHolder({ [`${CALENDAR_SCOPE}\n${ADVISOR}`]: { token: "ageing", expMs: Date.now() + 5 * 60_000, refresh: false } }).client;
    mintAnswers();
    expect(await getDelegatedToken(ADVISOR)).toBe("ageing");
    expect(live.jobs).toEqual([]);
  });

  it("a refresh that fails costs the lead nothing: the token was served, and the failure is reported", async () => {
    const { getDelegatedToken, CALENDAR_SCOPE } = await load();
    const h = fakeHolder({ [`${CALENDAR_SCOPE}\n${ADVISOR}`]: { token: "ageing", expMs: Date.now() + 5 * 60_000, refresh: true } });
    live.client = h.client;
    mintAnswers(503);
    expect(await getDelegatedToken(ADVISOR)).toBe("ageing");
    const [settled] = await runJobs();
    expect(settled.status).toBe("rejected");
    expect(tagged("google-token-mint")[0]).toMatch(/outcome="error".*status=503/);
    expect(h.puts).toEqual([]);
    // The isolate still serves the token it holds while it is usable.
    expect(await getDelegatedToken(ADVISOR)).toBe("ageing");
  });

  it("an isolate holding an ageing token asks the holder after the response, once a minute at most", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { getDelegatedToken, CALENDAR_SCOPE } = await load();
    const key = `${CALENDAR_SCOPE}\n${ADVISOR}`;
    const h = fakeHolder();
    live.client = h.client;
    mintAnswers();
    expect(await getDelegatedToken(ADVISOR)).toBe("minted-1");
    await runJobs(); // the put
    // 52 minutes on, the isolate's copy has 8 minutes left: still served from the isolate.
    vi.setSystemTime(Date.now() + 52 * 60_000);
    h.held.set(key, { ...h.held.get(key)!, refresh: true });
    expect(await getDelegatedToken(ADVISOR)).toBe("minted-1");
    expect(live.jobs.map((j) => j.label)).toEqual(["google-token-nudge"]);
    expect(await getDelegatedToken(ADVISOR)).toBe("minted-1");
    expect(live.jobs).toHaveLength(1);
    await runJobs();
    expect(mints).toBe(2);
    expect(tagged("google-token-mint")[1]).toContain('holder="nudge"');
    await runJobs(); // the refreshed token's put
    expect(h.puts.map((p) => p.token)).toEqual(["minted-1", "minted-2"]);
    expect(await getDelegatedToken(ADVISOR)).toBe("minted-2");
  });

  it("an isolate adopts a newer token the holder already has instead of minting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { getDelegatedToken, CALENDAR_SCOPE } = await load();
    const key = `${CALENDAR_SCOPE}\n${ADVISOR}`;
    const h = fakeHolder();
    live.client = h.client;
    mintAnswers();
    await getDelegatedToken(ADVISOR);
    await runJobs();
    vi.setSystemTime(Date.now() + 52 * 60_000);
    h.held.set(key, { token: "someone-elses-refresh", expMs: Date.now() + HOUR });
    await getDelegatedToken(ADVISOR);
    await runJobs();
    expect(mints).toBe(1);
    expect(await getDelegatedToken(ADVISOR)).toBe("someone-elses-refresh");
  });
});

describe("what the holder is never asked about (#3512)", () => {
  it("a token Google refused skips the holder, which may still hold it, and the fresh one replaces it", async () => {
    const { getDelegatedToken, CALENDAR_SCOPE } = await load();
    const key = `${CALENDAR_SCOPE}\n${ADVISOR}`;
    const h = fakeHolder({ [key]: { token: "revoked", expMs: Date.now() + HOUR } });
    live.client = h.client;
    mintAnswers();
    expect(await getDelegatedToken(ADVISOR)).toBe("revoked");
    expect(await getDelegatedToken(ADVISOR, undefined, undefined, "revoked")).toBe("minted-1");
    expect(h.reads).toHaveLength(1);
    expect(tagged("google-token-mint")[0]).toContain('holder="refused"');
    await runJobs();
    expect(h.puts.map((p) => p.token)).toEqual(["minted-1"]);
  });

  it("a Gmail or directory token never touches the holder", async () => {
    const { getDelegatedToken, GMAIL_SEND_SCOPE } = await load();
    const h = fakeHolder();
    live.client = h.client;
    mintAnswers();
    await getDelegatedToken("ooo@trypennie.com", GMAIL_SEND_SCOPE);
    await getDelegatedToken("admin@trypennie.com", "https://www.googleapis.com/auth/admin.directory.user.readonly");
    expect(h.reads).toEqual([]);
    expect(live.jobs).toEqual([]);
    expect(tagged("google-token-mint").every((l) => l.includes('holder="not-held"'))).toBe(true);
  });

  it("writes an isolate hit's line only inside a request, so cron lane cache hits stay quiet", async () => {
    const { getDelegatedToken } = await load();
    const { withinCallBudget } = await import("@/lib/call-budget");
    mintAnswers();
    await getDelegatedToken(ADVISOR);
    await getDelegatedToken(ADVISOR);
    expect(tagged("google-token-read").filter((l) => l.includes('tier="isolate"'))).toEqual([]);
    await withinCallBudget(12_000, "the booking confirm", () => getDelegatedToken(ADVISOR, undefined, 8_000));
    expect(tagged("google-token-read").filter((l) => l.includes('tier="isolate"'))).toEqual([
      'slate tag=google-token-read msg="token read" tier="isolate" scope="calendar" ms=0 request="the booking confirm"',
    ]);
  });
});

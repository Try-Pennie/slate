import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3706: the prerender switch, `booking_settings.embed_prerender_enabled`, read for
// `GET /api/embed/config`, which widget.js asks before it builds a booker at page load.
// What it must do: read WHICH column on WHICH row; an absent settings row is a real
// answer (off); a failed or hung read answers OFF and is logged, never thrown, because
// off is how the embed has always run and a host page must never see an error; one
// read per isolate per TTL. And the admin page's read is fresh and null when it fails,
// a third state rather than either answer (L530).
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
type Result = { data: unknown; error: { message: string } | null };
const db = vi.hoisted(() => ({
  results: [] as (Result | "hang" | "throw")[],
  calls: [] as string[],
}));
const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    db.calls.push(`from:${table}`);
    const builder = {
      select: (cols: string) => {
        db.calls.push(`select:${cols}`);
        return builder;
      },
      eq: (col: string, v: unknown) => {
        db.calls.push(`eq:${col}=${String(v)}`);
        return builder;
      },
      maybeSingle: () => {
        const next = db.results.shift() ?? { data: null, error: null };
        if (next === "hang") return new Promise<Result>(() => {});
        if (next === "throw") return Promise.reject(new Error("fetch failed"));
        return Promise.resolve(next);
      },
    };
    return builder;
  }),
);

vi.mock("@/lib/log", () => ({ log }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

/** A fresh module, so each test has its own per isolate cache. */
async function fresh() {
  vi.resetModules();
  return import("./prerender-switch");
}

beforeEach(() => {
  vi.clearAllMocks();
  db.results = [];
  db.calls = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("readEmbedPrerender (the read GET /api/embed/config answers from)", () => {
  it("reads embed_prerender_enabled on settings row 1, and answers what it holds", async () => {
    db.results = [{ data: { embed_prerender_enabled: true }, error: null }];
    const { readEmbedPrerender } = await fresh();
    expect(await readEmbedPrerender()).toBe(true);
    expect(db.calls).toEqual(["from:booking_settings", "select:embed_prerender_enabled", "eq:id=1"]);

    db.results = [{ data: { embed_prerender_enabled: false }, error: null }];
    const second = await fresh();
    expect(await second.readEmbedPrerender()).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("answers off when no settings row exists: nobody has turned it on", async () => {
    db.results = [{ data: null, error: null }];
    const { readEmbedPrerender } = await fresh();
    expect(await readEmbedPrerender()).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("answers off, and logs, when the read is refused, never throwing to the caller", async () => {
    db.results = [{ data: null, error: { message: "permission denied" } }];
    const { readEmbedPrerender } = await fresh();
    await expect(readEmbedPrerender()).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toBe("embed-config");
    expect(log.error.mock.calls[0][2]).toBeInstanceOf(Error);
  });

  it("answers off, and logs, when the read rejects outright", async () => {
    db.results = ["throw"];
    const { readEmbedPrerender } = await fresh();
    await expect(readEmbedPrerender()).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("answers off, and logs, when the read hangs past its deadline", async () => {
    vi.useFakeTimers();
    db.results = ["hang"];
    const { readEmbedPrerender, EMBED_PRERENDER_READ_DEADLINE_MS } = await fresh();
    const answer = readEmbedPrerender();
    await vi.advanceTimersByTimeAsync(EMBED_PRERENDER_READ_DEADLINE_MS);
    await expect(answer).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("a failed read after a good ON answers off, not the last value read", async () => {
    vi.useFakeTimers();
    db.results = [{ data: { embed_prerender_enabled: true }, error: null }, { data: null, error: { message: "boom" } }];
    const { readEmbedPrerender, EMBED_PRERENDER_TTL_MS } = await fresh();
    expect(await readEmbedPrerender()).toBe(true);
    vi.setSystemTime(Date.now() + EMBED_PRERENDER_TTL_MS + 1);
    expect(await readEmbedPrerender()).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("reads the database once per isolate per TTL, however many pages ask", async () => {
    vi.useFakeTimers();
    db.results = [
      { data: { embed_prerender_enabled: true }, error: null },
      { data: { embed_prerender_enabled: false }, error: null },
    ];
    const { readEmbedPrerender, EMBED_PRERENDER_TTL_MS } = await fresh();
    const answers = await Promise.all([readEmbedPrerender(), readEmbedPrerender(), readEmbedPrerender()]);
    expect(answers).toEqual([true, true, true]);
    expect(await readEmbedPrerender()).toBe(true);
    expect(from).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + EMBED_PRERENDER_TTL_MS + 1);
    expect(await readEmbedPrerender()).toBe(false);
    expect(from).toHaveBeenCalledTimes(2);
  });
});

describe("readEmbedPrerenderSetting (the admin page's read)", () => {
  it("reads fresh every time, never the cache", async () => {
    db.results = [
      { data: { embed_prerender_enabled: true }, error: null },
      { data: { embed_prerender_enabled: false }, error: null },
    ];
    const { readEmbedPrerenderSetting } = await fresh();
    expect(await readEmbedPrerenderSetting()).toBe(true);
    expect(await readEmbedPrerenderSetting()).toBe(false);
  });

  it("is null when the read fails, neither answer, and logs it", async () => {
    db.results = [{ data: null, error: { message: "boom" } }];
    const { readEmbedPrerenderSetting } = await fresh();
    expect(await readEmbedPrerenderSetting()).toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

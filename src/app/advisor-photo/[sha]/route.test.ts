// The public photo route (#3027). Every refusal and the served image, with the
// store replaced so no database is touched.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Served = { base64: string; mime: string } | null;
// A plain function over a swappable answer rather than a spy, so a read that
// rejects is handled by the route alone and nothing else observes the rejection.
const store = vi.hoisted(() => ({
  answer: (_sha: string): Promise<Served> => Promise.resolve(null),
  calls: [] as string[],
}));
vi.mock("@/lib/advisor-photos/store", () => ({
  loadServedPhoto: (sha: string) => {
    store.calls.push(sha);
    return store.answer(sha);
  },
}));
vi.mock("@/lib/log", () => ({ log: { error: () => {}, warn: () => {}, info: () => {} } }));

import { GET } from "./route";

const SHA = "a".repeat(64);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const call = (sha: string) => GET(new Request(`https://slate.test/advisor-photo/${sha}`), { params: Promise.resolve({ sha }) });

beforeEach(() => {
  store.calls = [];
  store.answer = () => Promise.resolve(null);
});

describe("GET /advisor-photo/{sha256}", () => {
  it("refuses an address that is not a hash before reading anything", async () => {
    for (const bad of ["abc", "A".repeat(64), "../" + "a".repeat(61), `${SHA}x`]) {
      const res = await call(bad);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(store.calls).toEqual([]);
  });

  it("answers 404 for a hash no live advisor holds, deactivated holders included", async () => {
    // The store's own query requires an active holder, so a deactivated one reads as null.
    const res = await call(SHA);
    expect(res.status).toBe(404);
    expect(store.calls).toEqual([SHA]);
  });

  it("serves the bytes, typed by their signature, cached for good", async () => {
    store.answer = async () => ({ base64: Buffer.from(JPEG).toString("base64"), mime: "image/png" });
    const res = await call(SHA);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...JPEG]);
  });

  it("refuses to serve stored bytes that are not an image", async () => {
    store.answer = async () => ({ base64: Buffer.from("<svg/>").toString("base64"), mime: "image/png" });
    const res = await call(SHA);
    expect(res.status).toBe(503);
  });

  it("answers 503, uncached, when the database read fails", async () => {
    store.answer = async () => {
      throw new Error("read failed");
    };
    const res = await call(SHA);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  describe("the edge cache", () => {
    // A stand in for `caches.default`, keyed exactly as the Workers cache keys: by URL.
    let stored: Map<string, Response>;
    beforeEach(() => {
      stored = new Map();
      (globalThis as { caches?: unknown }).caches = {
        default: {
          match: async (req: Request) => stored.get(req.url)?.clone(),
          put: async (req: Request, res: Response) => void stored.set(req.url, res.clone()),
        },
      };
    });
    afterEach(() => {
      delete (globalThis as { caches?: unknown }).caches;
    });

    it("keys on the path alone, so a query string cannot force a fresh database read", async () => {
      store.answer = async () => ({ base64: Buffer.from(JPEG).toString("base64"), mime: "image/jpeg" });
      for (const q of ["", "?x=1", "?x=2", "?bust=abc"]) {
        await GET(new Request(`https://slate.test/advisor-photo/${SHA}${q}`), { params: Promise.resolve({ sha: SHA }) });
      }
      expect(store.calls).toEqual([SHA]);
      expect([...stored.keys()]).toEqual([`https://slate.test/advisor-photo/${SHA}`]);
    });

    it("holds a photo at the edge for an hour, so a departed advisor stops being served within one", async () => {
      store.answer = async () => ({ base64: Buffer.from(JPEG).toString("base64"), mime: "image/jpeg" });
      const res = await call(SHA);
      expect(stored.get(`https://slate.test/advisor-photo/${SHA}`)!.headers.get("cache-control")).toBe("public, max-age=3600");
      // The browser copy may stay long: the address is the content.
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      const hit = await call(SHA);
      expect(hit.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect([...new Uint8Array(await hit.arrayBuffer())]).toEqual([...JPEG]);
    });

    it("remembers a miss briefly, so random hashes cannot each force a read", async () => {
      await call(SHA);
      const again = await call(SHA);
      expect(again.status).toBe(404);
      expect(again.headers.get("cache-control")).toBe("no-store");
      expect(store.calls).toEqual([SHA]);
      expect(stored.get(`https://slate.test/advisor-photo/${SHA}`)!.headers.get("cache-control")).toBe("public, max-age=60");
    });

    it("never caches a failed read", async () => {
      store.answer = async () => {
        throw new Error("read failed");
      };
      await call(SHA);
      expect(stored.size).toBe(0);
    });
  });
});

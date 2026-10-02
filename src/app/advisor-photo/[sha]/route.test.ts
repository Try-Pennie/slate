// The public photo route (#3027). Every refusal and the served image, with the
// store replaced so no database is touched.
import { describe, it, expect, vi, beforeEach } from "vitest";

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
});

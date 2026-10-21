import { describe, it, expect, vi, beforeEach } from "vitest";

// #3706: GET /api/embed/config, which widget.js asks from the HOST page before it builds
// a booker at page load. The host is another site, so the answer must be readable
// cross origin (Access-Control-Allow-Origin, no credentials), it must be cheap to ask
// on every page view (a short public cache), and it must always be a well formed
// `{ prerender: boolean }` with a 200: any failure answers false, the embed's old
// behaviour, and is logged rather than surfaced to a host page that cannot act on it.
const readEmbedPrerender = vi.hoisted(() => vi.fn(async () => false));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/embed/prerender-switch", async () => {
  const core = await vi.importActual<typeof import("@/lib/embed/prerender-switch-core")>(
    "@/lib/embed/prerender-switch-core",
  );
  return { ...core, readEmbedPrerender };
});
vi.mock("@/lib/log", () => ({ log }));

import { GET } from "./route";
import { EMBED_CONFIG_MAX_AGE_SECONDS } from "@/lib/embed/prerender-switch-core";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/embed/config", () => {
  it("answers { prerender: true } when the switch is on", async () => {
    readEmbedPrerender.mockResolvedValueOnce(true);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prerender: true });
  });

  it("answers { prerender: false } when the switch is off", async () => {
    readEmbedPrerender.mockResolvedValueOnce(false);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prerender: false });
  });

  it("is readable from any host page, without credentials", async () => {
    const res = await GET();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // A wildcard origin may never be paired with credentials; nothing here needs them.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("carries a short public cache, so a lead's page views do not each reach the Worker", async () => {
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe(`public, max-age=${EMBED_CONFIG_MAX_AGE_SECONDS}`);
    expect(EMBED_CONFIG_MAX_AGE_SECONDS).toBeGreaterThan(0);
    expect(EMBED_CONFIG_MAX_AGE_SECONDS).toBeLessThanOrEqual(60);
  });

  it("answers false with a 200, and logs, if the read itself throws", async () => {
    readEmbedPrerender.mockRejectedValueOnce(new Error("unexpected"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prerender: false });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

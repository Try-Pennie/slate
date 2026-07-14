import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Wiring for the #801 logging canary: it must emit an exact, countable number
// of lines per console level so the capture rate read back out of Cloudflare
// observability means something. A canary that emits the wrong count (or emits
// while unauthorized) would produce a confident but wrong answer, which is the
// exact failure #801 exists to correct.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
vi.mock("@/lib/cron", () => cron);

import { GET, CANARY_LEVELS } from "./route";

const req = (query: string) =>
  ({ nextUrl: new URL(`https://slate.test/api/dev/log-canary${query}`) }) as unknown as Parameters<
    typeof GET
  >[0];

const spies = () =>
  Object.fromEntries(
    CANARY_LEVELS.map((l) => [l, vi.spyOn(console, l).mockImplementation(() => {})]),
  ) as Record<(typeof CANARY_LEVELS)[number], ReturnType<typeof vi.spyOn>>;

let console_: ReturnType<typeof spies>;

beforeEach(() => {
  vi.clearAllMocks();
  cron.isAuthorizedCron.mockReturnValue(true);
  console_ = spies();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const linesFor = (level: (typeof CANARY_LEVELS)[number]) =>
  console_[level].mock.calls.map((c) => String(c[0]));

describe("GET /api/dev/log-canary", () => {
  it("returns 401 and emits nothing when the request is unauthorized", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req("?token=abc123"));
    expect(res.status).toBe(401);
    for (const level of CANARY_LEVELS) {
      expect(console_[level]).not.toHaveBeenCalled();
    }
  });

  it("returns 400 and emits nothing when the token is missing or malformed", async () => {
    for (const query of ["", "?token=", "?token=short", "?token=has spaces", "?token=semi;colon"]) {
      const res = await GET(req(query));
      expect(res.status).toBe(400);
    }
    for (const level of CANARY_LEVELS) {
      expect(console_[level]).not.toHaveBeenCalled();
    }
  });

  it("emits exactly `samples` tagged lines at every console level", async () => {
    const res = await GET(req("?token=canary-xyz&samples=3"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      token: "canary-xyz",
      samples: 3,
      levels: [...CANARY_LEVELS],
      emitted: 3 * CANARY_LEVELS.length,
    });

    for (const level of CANARY_LEVELS) {
      expect(linesFor(level)).toEqual([
        `logcanary canary-xyz level=${level} i=1`,
        `logcanary canary-xyz level=${level} i=2`,
        `logcanary canary-xyz level=${level} i=3`,
      ]);
    }
  });

  it("defaults to 10 samples and clamps out-of-range or junk sample counts", async () => {
    for (const [query, expected] of [
      ["?token=canary-xyz", 10],
      ["?token=canary-xyz&samples=999", 50],
      ["?token=canary-xyz&samples=0", 1],
      ["?token=canary-xyz&samples=-5", 1],
      ["?token=canary-xyz&samples=nonsense", 10],
    ] as const) {
      vi.clearAllMocks();
      const body = await (await GET(req(query))).json();
      expect(body.samples).toBe(expected);
      expect(console_.warn).toHaveBeenCalledTimes(expected);
    }
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3141: the hourly cron CPU check the Worker calls in process. What is pinned here is the
// wiring the pure suite cannot see: the token comes from the Worker's environment and goes out
// as a bearer on ONE POST to the analytics endpoint, a measured day stamps the verdict lane and
// nothing else does, an unset token spends no subrequest, a failed stamp fails the request, and
// nothing unauthenticated reaches the API. The decisions are pinned in scripts/test-cron-budget.ts.

const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const verdicts = vi.hoisted(() => ({ recordDetectorVerdict: vi.fn(async () => {}) }));
const throttle = vi.hoisted(() => ({
  refuseCronSecret: vi.fn(async (_headers: Headers, refusal: () => Response) => refusal()),
}));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  sendThrottledInfo: vi.fn(async () => {}),
  resolveAlert: vi.fn(async () => true),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/bearer-failure", () => throttle);
vi.mock("@/lib/monitor/verdict-store", () => verdicts);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";
import { CF_GRAPHQL_URL, CRON_BUDGET_ALERT_KEY, CRON_CPU_NOT_CONFIGURED_KEY } from "@/lib/monitor/cron-budget";

const req = () =>
  ({
    url: "https://slate.trypennie.app/api/cron/cron-budget",
    headers: new Headers(),
  }) as unknown as Parameters<typeof GET>[0];

const day = (worstUs: number) => ({
  data: {
    viewer: {
      accounts: [
        {
          workersInvocationsScheduled: [
            { cron: "* * * * *", cpuTimeUs: worstUs, status: "success" },
            { cron: "*/5 * * * *", cpuTimeUs: 2_000_000, status: "success" },
          ],
        },
      ],
    },
  },
});

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  cron.isAuthorizedCron.mockReturnValue(true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CF_ANALYTICS_TOKEN", "tok-123");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/cron/cron-budget (#3141)", () => {
  it("reads the day with one bearer POST and clears on a measured day under the line", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(day(40_000_000)), { status: 200 }));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "within" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CF_GRAPHQL_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(dispatch.resolveAlert).toHaveBeenCalledWith(CRON_BUDGET_ALERT_KEY, expect.any(String));
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(verdicts.recordDetectorVerdict).toHaveBeenCalledWith("verdict:cron-budget", true);
  });

  it("pages a day past the line, and that is a verdict too", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(day(90_000_000)), { status: 200 }));
    const res = await GET(req());
    expect(await res.json()).toEqual({ status: "over" });
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledWith(CRON_BUDGET_ALERT_KEY, expect.any(Number), expect.stringContaining("90s"));
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    expect(verdicts.recordDetectorVerdict).toHaveBeenCalledWith("verdict:cron-budget", true);
  });

  it("with no token spends no subrequest, whispers once and stamps nothing", async () => {
    vi.stubEnv("CF_ANALYTICS_TOKEN", "");
    const res = await GET(req());
    expect(await res.json()).toEqual({ status: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledInfo).toHaveBeenCalledWith(CRON_CPU_NOT_CONFIGURED_KEY, expect.any(Number), expect.any(String));
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    expect(verdicts.recordDetectorVerdict).toHaveBeenCalledWith("verdict:cron-budget", false);
  });

  it("an answer that is not JSON is unmeasured: no page, no clear, no stamp", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 200 }));
    const res = await GET(req());
    expect(await res.json()).toEqual({ status: "unmeasured" });
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    expect(verdicts.recordDetectorVerdict).toHaveBeenCalledWith("verdict:cron-budget", false);
  });

  it("a fetch that throws is unmeasured, not a crash", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timed out"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unmeasured" });
  });

  it("a failed verdict stamp fails the request rather than reading as recorded", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(day(1_000_000)), { status: 200 }));
    verdicts.recordDetectorVerdict.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(500);
  });

  it("refuses without the cron secret and reads nothing", async () => {
    cron.isAuthorizedCron.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verdicts.recordDetectorVerdict).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// #1035: /api/health surfaces whether the Slack paging layer is configured. It
// is a CONFIG signal, not a liveness one: an unconfigured token must NOT flip
// the endpoint's 200 (the endpoint drives the uptime dead-man's switch), it just
// annotates the body so an uptime check or human can see paging is off. With a
// healthy DB and no stale lanes the status stays "ok"/200 either way.

const slackConfigured = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/notify/slack", () => ({ slackConfigured }));

// Empty heartbeat table by default -> every configured lane has a null age ->
// not stale -> healthy 200 (never alarm on an uninitialized lane). Tests can
// inject rows to exercise the stamp parsing (#1169).
const heartbeatRows = vi.hoisted(() => ({ value: [] as { lane: string; last_ran_at: string }[] }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: async () => ({ data: heartbeatRows.value, error: null }) }),
  }),
}));

// #1228: noodge stamps a heartbeat through this endpoint so a check that was
// deleted, paused or stopped firing goes stale and pages. The stamp is mocked at
// the heartbeat module so the test can see exactly which lane was stamped, and
// can make the write fail.
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async (_lane: string) => {}) }));
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log }));

import { GET } from "./route";

const KEY = "uptime-heartbeat-test-key";
const req = (authorization?: string) =>
  new Request("https://slate.test/api/health", {
    headers: authorization === undefined ? {} : { authorization },
  });

beforeEach(() => {
  vi.clearAllMocks();
  heartbeatRows.value = [];
  process.env.UPTIME_HEARTBEAT_KEY = KEY;
  heartbeat.recordHeartbeat.mockResolvedValue(undefined);
});

describe("/api/health alerting signal (#1035)", () => {
  it("reports alerting 'unconfigured' but stays 200 (paging off is not app-down)", async () => {
    slackConfigured.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerting).toBe("unconfigured");
    expect(body.status).toBe("ok");
  });

  it("reports alerting 'ok' when Slack is configured", async () => {
    slackConfigured.mockReturnValue(true);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerting).toBe("ok");
  });
});

// #1169: a heartbeat row that exists but cannot be parsed used to be skipped,
// which made the lane read as never-stamped (healthy). An unreadable stamp must
// land on the FAILED side of the dead-man's switch: the lane's work cannot be
// proven to be happening.
describe("/api/health on a corrupt heartbeat stamp (#1169)", () => {
  it("fails health (503) when a covered lane's stamp is unparseable", async () => {
    heartbeatRows.value = [{ lane: "sync", last_ran_at: "not-a-timestamp" }];
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("heartbeat_stale");
    expect(body.staleLane).toBe("sync");
  });

  it("stays 200 when the same lane's stamp is fresh and parseable", async () => {
    heartbeatRows.value = [{ lane: "sync", last_ran_at: new Date().toISOString() }];
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

// #1228: the uptime heartbeat. Both directions, because a stamp that anybody can
// write proves nothing about noodge, and a health status that moves with the key
// would turn a key problem into an outage page.
describe("/api/health uptime heartbeat (#1228)", () => {
  it("stamps uptime:api-health when the request carries the heartbeat key", async () => {
    const res = await GET(req(`Bearer ${KEY}`));
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledTimes(1);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("uptime:api-health");
  });

  it("does not stamp without a key, and answers exactly as it would have", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("does not stamp on a wrong key, and still answers normally", async () => {
    const res = await GET(req(`Bearer not-${KEY}`));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("never stamps when the deployment holds no key, whatever the caller sends", async () => {
    process.env.UPTIME_HEARTBEAT_KEY = "";
    for (const auth of [undefined, "Bearer ", `Bearer ${KEY}`]) {
      const res = await GET(req(auth));
      expect(res.status).toBe(200);
    }
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("keeps the degraded status on a keyed request: the stamp does not decide health", async () => {
    heartbeatRows.value = [{ lane: "sync", last_ran_at: "not-a-timestamp" }];
    const res = await GET(req(`Bearer ${KEY}`));
    expect(res.status).toBe(503);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("uptime:api-health");
  });

  it("answers normally when the stamp write fails, and logs the failure", async () => {
    heartbeat.recordHeartbeat.mockRejectedValue(new Error("supabase unreachable"));
    const res = await GET(req(`Bearer ${KEY}`));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
    expect(log.error).toHaveBeenCalled();
    expect(String(log.error.mock.calls[0]?.[0])).toBe("uptime-heartbeat");
  });
});

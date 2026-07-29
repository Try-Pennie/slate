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

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  heartbeatRows.value = [];
});

describe("/api/health alerting signal (#1035)", () => {
  it("reports alerting 'unconfigured' but stays 200 (paging off is not app-down)", async () => {
    slackConfigured.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerting).toBe("unconfigured");
    expect(body.status).toBe("ok");
  });

  it("reports alerting 'ok' when Slack is configured", async () => {
    slackConfigured.mockReturnValue(true);
    const res = await GET();
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
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("heartbeat_stale");
    expect(body.staleLane).toBe("sync");
  });

  it("stays 200 when the same lane's stamp is fresh and parseable", async () => {
    heartbeatRows.value = [{ lane: "sync", last_ran_at: new Date().toISOString() }];
    const res = await GET();
    expect(res.status).toBe(200);
  });
});

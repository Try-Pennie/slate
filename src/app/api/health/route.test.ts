import { describe, it, expect, vi, beforeEach } from "vitest";

// #1035: /api/health surfaces whether the Slack paging layer is configured. It
// is a CONFIG signal, not a liveness one: an unconfigured token must NOT flip
// the endpoint's 200 (the endpoint drives the uptime dead-man's switch), it just
// annotates the body so an uptime check or human can see paging is off. With a
// healthy DB and no stale lanes the status stays "ok"/200 either way.

const slackConfigured = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/notify/slack", () => ({ slackConfigured }));

// Empty heartbeat table -> every configured lane has a null age -> not stale ->
// healthy 200 (never alarm on an uninitialized lane).
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: async () => ({ data: [], error: null }) }),
  }),
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
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

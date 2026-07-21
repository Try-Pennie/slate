import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the Slack interactivity endpoint (#345, behavior from #77/#194):
// every request is signature-verified (401 on a bad signature), a malformed
// payload is a 400, and the Approve/Decline actions run through the SAME
// approveOoo/rejectOoo service the web queue uses. The service authz + side
// effects are covered elsewhere; this exercises only the route's gate + routing.
//
// `after` is overridden so the deferred approve/reject work (which the real
// runtime finishes after the 200 ack) runs and can be awaited in the test.

const deferred = vi.hoisted(() => {
  const cbs: Promise<unknown>[] = [];
  return {
    cbs,
    after: (cb: () => unknown) => {
      cbs.push(Promise.resolve().then(cb));
    },
  };
});
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: deferred.after };
});

vi.mock("@/lib/env", () => ({
  appUrl: () => "https://slate.test",
  slackSigningSecret: () => "sec",
}));

const verify = vi.hoisted(() => ({ verifySlackSignature: vi.fn(() => true) }));
vi.mock("@/lib/slack/verify", () => verify);

const sb = vi.hoisted(() => {
  const cfg: { userRow: unknown; oooRow: unknown } = { userRow: null, oooRow: null };
  const admin = () => ({
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: table === "users" ? cfg.userRow : cfg.oooRow,
          error: null,
        }),
      };
      return chain;
    },
  });
  return { cfg, admin };
});
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: sb.admin }));

const slack = vi.hoisted(() => ({
  getSlackUserEmail: vi.fn(async () => "mgr@x.com"),
  dmSlackUserByEmail: vi.fn(async () => {}),
  openSlackModal: vi.fn(async () => {}),
}));
vi.mock("@/lib/notify/slack", () => slack);

const ooo = vi.hoisted(() => ({
  approveOoo: vi.fn(async () => ({ ok: true })),
  rejectOoo: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/ooo/service", () => ooo);

import { POST } from "./route";
import {
  OOO_APPROVE_ACTION,
  OOO_REJECT_ACTION,
  OOO_REJECT_MODAL,
} from "@/lib/notify/ooo-slack-blocks";

function slackReq(rawBody: string) {
  return { text: async () => rawBody, headers: new Headers() } as unknown as Parameters<
    typeof POST
  >[0];
}

/** Build the `payload=<urlencoded json>` body Slack posts. */
function payloadBody(payload: unknown): string {
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

async function flushDeferred() {
  await Promise.all(deferred.cbs);
}

const MGR = { id: "u-mgr", email: "mgr@x.com", role: "manager" };

beforeEach(() => {
  vi.clearAllMocks();
  deferred.cbs.length = 0;
  verify.verifySlackSignature.mockReturnValue(true);
  slack.getSlackUserEmail.mockResolvedValue("mgr@x.com");
  ooo.approveOoo.mockResolvedValue({ ok: true });
  ooo.rejectOoo.mockResolvedValue({ ok: true });
  sb.cfg.userRow = MGR;
  sb.cfg.oooRow = {
    starts_at: "2026-07-01T15:00:00.000Z",
    ends_at: "2026-07-01T17:00:00.000Z",
    display_tz_id: "America/New_York",
    display_tz_label: "ET",
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
});

describe("POST /api/slack/interactions", () => {
  it("rejects an invalid signature with 401 and does no work (the security gate)", async () => {
    verify.verifySlackSignature.mockReturnValue(false);

    const res = await POST(
      slackReq(
        payloadBody({
          type: "block_actions",
          user: { id: "slack-1" },
          actions: [{ action_id: OOO_APPROVE_ACTION, value: "req-1" }],
        }),
      ),
    );

    expect(res.status).toBe(401);
    await flushDeferred();
    expect(ooo.approveOoo).not.toHaveBeenCalled();
  });

  it("returns 200 (empty ack) when the body carries no payload param", async () => {
    const res = await POST(slackReq(""));
    expect(res.status).toBe(200);
  });

  it("returns 400 when the payload is not valid JSON", async () => {
    const res = await POST(slackReq("payload=not-json"));
    expect(res.status).toBe(400);
  });

  it("acks an Approve click with 200 and runs approveOoo with the resolved actor", async () => {
    const res = await POST(
      slackReq(
        payloadBody({
          type: "block_actions",
          user: { id: "slack-1" },
          response_url: "https://hooks.slack/resp",
          actions: [{ action_id: OOO_APPROVE_ACTION, value: "req-1" }],
        }),
      ),
    );

    expect(res.status).toBe(200);
    await flushDeferred();
    // Runs through the SAME service the web queue uses, with the resolved user.
    expect(ooo.approveOoo).toHaveBeenCalledWith("req-1", MGR);
  });

  it("opens the Decline modal synchronously and acks 200 on a Reject click", async () => {
    const res = await POST(
      slackReq(
        payloadBody({
          type: "block_actions",
          user: { id: "slack-1" },
          trigger_id: "trig-1",
          actions: [{ action_id: OOO_REJECT_ACTION, value: "req-1" }],
        }),
      ),
    );

    expect(res.status).toBe(200);
    // The modal must open before the trigger_id expires, so it is inline (not deferred).
    expect(slack.openSlackModal).toHaveBeenCalledWith("trig-1", expect.anything());
    expect(ooo.rejectOoo).not.toHaveBeenCalled();
  });

  it("runs rejectOoo from the Decline modal submit and acks 200 to close the modal", async () => {
    const res = await POST(
      slackReq(
        payloadBody({
          type: "view_submission",
          user: { id: "slack-1" },
          view: {
            callback_id: OOO_REJECT_MODAL,
            private_metadata: "req-1",
            state: { values: {} },
          },
        }),
      ),
    );

    expect(res.status).toBe(200);
    await flushDeferred();
    expect(ooo.rejectOoo).toHaveBeenCalledWith("req-1", MGR, expect.any(String));
  });

  // Failure path: the clicking Slack user has no matching Slate user. The approval
  // must NOT go through, and the caller is told (best-effort) rather than the click
  // silently looking like it worked.
  it("does not approve when the Slack user maps to no Slate user, and replies instead", async () => {
    sb.cfg.userRow = null;

    const res = await POST(
      slackReq(
        payloadBody({
          type: "block_actions",
          user: { id: "slack-unknown" },
          response_url: "https://hooks.slack/resp",
          actions: [{ action_id: OOO_APPROVE_ACTION, value: "req-1" }],
        }),
      ),
    );

    expect(res.status).toBe(200);
    await flushDeferred();
    expect(ooo.approveOoo).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("https://hooks.slack/resp", expect.anything());
  });
});

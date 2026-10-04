import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3144 (L742): the digest mailer sends on a delegated token cached for most of an
// hour. A token Google refuses must cost a resend, not the digest: failing it
// loses that morning's mail while the next send, minted afresh, succeeds.

const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn(), GMAIL_SEND_SCOPE: "gmail.send" }));
vi.mock("@/lib/google/dwd", () => dwd);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sendGmailEmail } from "./email";

const msg = { from: "ops@x.com", to: ["m@x.com"], subject: "Digest", body: "body" };

describe("sendGmailEmail on a refused token (#3144)", () => {
  beforeEach(() => {
    dwd.getDelegatedToken.mockReset();
    dwd.getDelegatedToken.mockImplementation(async (_e: string, _s?: string, _d?: unknown, rejected?: string) =>
      rejected ? "fresh" : "stale",
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("resends the same message on a fresh token", async () => {
    const sent: { auth: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization");
      sent.push({ auth, body: init.body });
      return auth === "Bearer stale"
        ? new Response("Invalid Credentials", { status: 401 })
        : new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    });
    await expect(sendGmailEmail(msg)).resolves.toBe("msg-1");
    expect(sent.map((s) => s.auth)).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(sent[1].body).toEqual(sent[0].body);
    expect(dwd.getDelegatedToken).toHaveBeenLastCalledWith("ops@x.com", "gmail.send", undefined, "stale");
  });

  it("throws after one resend when the fresh token is refused too", async () => {
    let sends = 0;
    vi.stubGlobal("fetch", async () => {
      sends += 1;
      return new Response("unauthorized", { status: 401 });
    });
    await expect(sendGmailEmail(msg)).rejects.toThrow(/Gmail send failed: 401/);
    expect(sends).toBe(2);
  });
});

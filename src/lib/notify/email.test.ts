import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3144 (L742): the digest mailer sends on a delegated token cached for most of an
// hour. A token Google refuses must cost a resend, not the digest: failing it
// loses that morning's mail while the next send, minted afresh, succeeds.

const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn(), GMAIL_SEND_SCOPE: "gmail.send" }));
vi.mock("@/lib/google/dwd", () => dwd);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sendGmailEmail } from "./email";
import { asEmailSendError, type EmailSendError } from "./email-errors";
import { DeadlineExceededError } from "@/lib/fetch-within-deadline";
import { GoogleHttpError } from "@/lib/google/http-error";
import { shortErrorReason } from "@/lib/notify/error-text";

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

// 2026-10-05: a reminder whose token mint timed out was treated as a send that may
// have reached Gmail, so its claim was kept and the lead was never reminded. The
// mint runs BEFORE the POST, so that send provably delivered nothing. Every failure
// now says which, by the STAGE it happened at rather than by the error's class: a
// deadline during the mint and one during the POST are the same class and opposite
// answers to "could a retry deliver a second copy".
describe("sendGmailEmail says what a failure proves about delivery", () => {
  const rejection = async (p: Promise<unknown>): Promise<EmailSendError> => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    const typed = asEmailSendError(err);
    if (!typed) throw new Error(`expected an EmailSendError, got ${String(err)}`);
    return typed;
  };

  beforeEach(() => {
    dwd.getDelegatedToken.mockReset();
    dwd.getDelegatedToken.mockImplementation(async () => "token");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a mint that misses its deadline is never_sent and transient, and Gmail is never called", async () => {
    dwd.getDelegatedToken.mockRejectedValueOnce(new DeadlineExceededError("google token mint", 8000));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const err = await rejection(sendGmailEmail(msg));
    expect(err.outcome).toBe("never_sent");
    expect(err.stage).toBe("token");
    expect(err.transient).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The deadline stays reachable through the cause, so the short reason a page
    // carries still names it in words.
    expect(shortErrorReason(err)).toBe("google token mint did not answer within 8 seconds");
  });

  it("a first POST answered 401 and then a failed mint is never_sent, after exactly one POST", async () => {
    dwd.getDelegatedToken.mockImplementation(async (_e: string, _s?: string, _d?: unknown, refused?: string) => {
      if (refused) throw new DeadlineExceededError("google token mint", 8000);
      return "stale";
    });
    let posts = 0;
    vi.stubGlobal("fetch", async () => {
      posts += 1;
      return new Response("Invalid Credentials", { status: 401 });
    });
    const err = await rejection(sendGmailEmail(msg));
    expect(err.outcome).toBe("never_sent");
    expect(err.transient).toBe(true);
    expect(posts).toBe(1);
  });

  it("a token endpoint refusal is never_sent, not transient, and names neither the mailbox nor Google's body", async () => {
    dwd.getDelegatedToken.mockRejectedValueOnce(
      new GoogleHttpError(
        'Delegated token failed for ops@x.com: 403 {"error":"unauthorized_client","error_description":"Client is unauthorized"}',
        403,
        "unauthorized_client",
      ),
    );
    vi.stubGlobal("fetch", vi.fn());
    const err = await rejection(sendGmailEmail(msg));
    expect(err.outcome).toBe("never_sent");
    expect(err.transient).toBe(false);
    expect(err.status).toBe(403);
    expect(err.message).not.toContain("ops@x.com");
    expect(err.message).not.toContain("{");
  });

  it("a token endpoint 503 or a network fault reaching it is never_sent and transient", async () => {
    vi.stubGlobal("fetch", vi.fn());
    dwd.getDelegatedToken.mockRejectedValueOnce(new GoogleHttpError("Delegated token failed for ops@x.com: 503 ", 503));
    const unavailable = await rejection(sendGmailEmail(msg));
    expect([unavailable.outcome, unavailable.transient]).toEqual(["never_sent", true]);
    dwd.getDelegatedToken.mockRejectedValueOnce(new TypeError("fetch failed"));
    const network = await rejection(sendGmailEmail(msg));
    expect([network.outcome, network.transient]).toEqual(["never_sent", true]);
  });

  // The mint runs before any POST, so a token failure that is not Google refusing
  // the grant can be tried again without any risk of a second copy. The Workers
  // subrequest ceiling, a token reply whose JSON cannot be read and a signing fault
  // all land here, and each would pass on a fresh invocation.
  it("a token failure that is not a Google 4xx is never_sent and transient, whatever its class", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const cause of [
      new Error("Too many subrequests."),
      new SyntaxError("Unexpected token < in JSON at position 0"),
      new DOMException("Invalid keyData", "DataError"),
    ]) {
      dwd.getDelegatedToken.mockRejectedValueOnce(cause);
      const err = await rejection(sendGmailEmail(msg));
      expect([err.outcome, err.stage, err.transient, err.status]).toEqual(["never_sent", "token", true, null]);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a POST with no answer at all is unknown, because Gmail may have accepted it", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Network connection lost");
    });
    const err = await rejection(sendGmailEmail(msg));
    expect(err.outcome).toBe("unknown");
    expect(err.stage).toBe("post");
  });

  it("a 503 from Gmail is unknown, and keeps the message the digest and the classifier read", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"error":{"errors":[{"reason":"backendError"}]}}', { status: 503 }));
    const err = await rejection(sendGmailEmail(msg));
    expect(err.outcome).toBe("unknown");
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/^Gmail send failed: 503 /);
  });

  it("a 400 is refused and not transient", async () => {
    vi.stubGlobal("fetch", async () => new Response("Invalid To header", { status: 400 }));
    const err = await rejection(sendGmailEmail(msg));
    expect([err.outcome, err.transient, err.status]).toEqual(["refused", false, 400]);
  });

  it("a 429 is refused and transient", async () => {
    vi.stubGlobal("fetch", async () => new Response("rateLimitExceeded", { status: 429 }));
    const err = await rejection(sendGmailEmail(msg));
    expect([err.outcome, err.transient, err.status]).toEqual(["refused", true, 429]);
  });

  // Gmail reports its sending limits as a 403 as well as a 429, told apart from a
  // permission refusal only by the reason in the body (#917). A rate limited send
  // was not delivered and can pass, so it is transient like the 429.
  it("a 403 whose reason is a rate limit is refused and transient, and a permission 403 is not", async () => {
    const body = (reason: string) => JSON.stringify({ error: { code: 403, errors: [{ reason }] } });
    for (const reason of ["userRateLimitExceeded", "rateLimitExceeded", "dailyLimitExceeded"]) {
      vi.stubGlobal("fetch", async () => new Response(body(reason), { status: 403 }));
      const err = await rejection(sendGmailEmail(msg));
      expect([err.outcome, err.transient, err.status, err.reason]).toEqual(["refused", true, 403, reason]);
      expect(err.message).toMatch(/^Gmail send failed: 403 /);
    }
    vi.stubGlobal("fetch", async () => new Response(body("insufficientPermissions"), { status: 403 }));
    const denied = await rejection(sendGmailEmail(msg));
    expect([denied.outcome, denied.transient, denied.reason]).toEqual(["refused", false, "insufficientPermissions"]);
  });

  it("a second 401 is refused, after the one resend", async () => {
    dwd.getDelegatedToken.mockImplementation(async (_e: string, _s?: string, _d?: unknown, refused?: string) =>
      refused ? "fresh" : "stale",
    );
    vi.stubGlobal("fetch", async () => new Response("unauthorized", { status: 401 }));
    const err = await rejection(sendGmailEmail(msg));
    expect([err.outcome, err.transient, err.status]).toEqual(["refused", false, 401]);
  });

  it("a message with nobody to go to is never_sent at compose", async () => {
    const err = await rejection(sendGmailEmail({ ...msg, to: [] }));
    expect([err.outcome, err.stage, err.transient]).toEqual(["never_sent", "compose", false]);
    expect(err.message).toMatch(/no recipients/);
  });

  // Throwing here would report a delivered message as failed, and a caller that
  // retried on it would send the second copy this whole design exists to prevent.
  it("a success whose body cannot be read resolves as sent", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>not json</html>", { status: 200 }));
    await expect(sendGmailEmail(msg)).resolves.toBe("");
  });
});

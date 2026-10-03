import { describe, it, expect, vi, beforeEach } from "vitest";

const limiter = vi.hoisted(() => ({
  allowRequest: vi.fn(async () => true),
  clientIp: vi.fn(() => "203.0.113.7"),
  CSP_REPORT_RATE_RULES: [{ prefix: "csp:m", windowSeconds: 60, max: 20 }],
}));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
}));
const settings = vi.hoisted(() => ({
  loadMonitorCooldowns: vi.fn(async (_tag: string) => ({ csp_violation: 60 * 60_000 }) as Record<string, number>),
}));

vi.mock("@/lib/rate-limit", () => limiter);
vi.mock("@/lib/log", () => ({ log: logged }));
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/monitor/settings", () => settings);

import { POST } from "./route";

function req(body: unknown, contentType = "application/csp-report") {
  return new Request("https://slate.trypennie.app/api/csp-report", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const LEGACY = {
  "csp-report": {
    "document-uri": "https://slate.trypennie.app/book?xbc=411",
    "violated-directive": "script-src",
    "blocked-uri": "https://evil.test/x.js",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  limiter.allowRequest.mockResolvedValue(true);
  dispatch.sendThrottledAlert.mockResolvedValue(undefined);
  settings.loadMonitorCooldowns.mockResolvedValue({ csp_violation: 60 * 60_000 });
});

describe("POST /api/csp-report (#2565)", () => {
  it("records the violation with the directive and what was blocked", async () => {
    const res = await POST(req(LEGACY));

    expect(res.status).toBe(204);
    expect(logged.warn).toHaveBeenCalledWith(
      "csp-report",
      expect.objectContaining({ directive: "script-src", blocked: "https://evil.test/x.js" }),
    );
  });

  it("never logs a booking manage token out of a reported URL", async () => {
    // The manage page's URL IS a credential. #2564 took it out of the warehouse;
    // an endpoint the whole internet can post to must not put it in the logs.
    await POST(
      req({
        "csp-report": {
          "document-uri": "https://slate.trypennie.app/booking/manage/tok-secret",
          referrer: "https://slate.trypennie.app/booking/manage/tok-secret",
          "violated-directive": "img-src",
        },
      }),
    );

    expect(JSON.stringify(logged.warn.mock.calls)).not.toContain("tok-secret");
    expect(JSON.stringify(logged.warn.mock.calls)).toContain("[redacted]");
  });

  it("reads the modern Reporting API shape as well as the legacy one", async () => {
    // A browser family that reports in a shape this cannot read is a browser
    // family reporting nothing, which looks exactly like one with nothing to
    // report.
    await POST(
      req([{ type: "csp-violation", body: { documentURL: "https://slate.trypennie.app/book", effectiveDirective: "style-src", blockedURL: "inline" } }]),
    );

    expect(logged.warn).toHaveBeenCalledWith(
      "csp-report",
      expect.objectContaining({ directive: "style-src" }),
    );
  });

  it("returns 204 and records NOTHING when the rate limiter refuses", async () => {
    limiter.allowRequest.mockResolvedValue(false);

    const res = await POST(req(LEGACY));

    expect(res.status).toBe(204);
    expect(logged.warn).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the rate limiter itself throws", async () => {
    // This is a public path anyone can post to. A limiter that cannot vouch for
    // the caller means the report is dropped, because an unmetered public path
    // that writes costs more than one lost report.
    limiter.allowRequest.mockRejectedValue(new Error("limiter unreachable"));

    const res = await POST(req(LEGACY));

    expect(res.status).toBe(204);
    expect(logged.warn).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("returns 204 for a body that is not JSON, and records nothing", async () => {
    const res = await POST(req("not json at all"));

    expect(res.status).toBe(204);
    expect(logged.warn).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("answers 204 with no body on EVERY path, so it is no oracle for what is accepted", async () => {
    const bodies: unknown[] = [LEGACY, "garbage", null, { nonsense: true }];
    for (const b of bodies) {
      const res = await POST(req(b));
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    }
  });
});

/**
 * #2575, Dan 2026-10-02: enforced, a violation means something was refused for a
 * real person, so it sends a THROTTLED PAGE on the alert channel.
 */
describe("the page an enforced violation sends (#2575)", () => {
  const ENFORCED = {
    "csp-report": {
      "document-uri":
        "https://slate.trypennie.app/booking/manage/tok-secret?name=Dana%20Lee&email=dana%40example.com&phone=2155550100",
      referrer: "https://www.trypennie.com/my-offers/result?lead=00Q123&email=dana%40example.com",
      "violated-directive": "script-src-elem",
      "blocked-uri": "https://evil.example/steal.js?email=dana%40example.com",
      disposition: "enforce",
    },
  };

  it("pages on the alert channel, keyed on the directive, on the tunable cooldown", async () => {
    const res = await POST(req(ENFORCED));

    expect(res.status).toBe(204);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldownMs, text] = dispatch.sendThrottledAlert.mock.calls[0];
    expect(key).toBe("csp_violation:script-src");
    expect(cooldownMs).toBe(60 * 60_000);
    expect(text).toContain("https://evil.example");
    expect(text).toContain("/booking");
  });

  it("is THROTTLED: a burst of the same refusal shares one key, so the cooldown collapses it to one page", async () => {
    // The throttle lives in sendThrottledAlert, keyed on the key it is given. What
    // this route owns is handing every report of one refusal the SAME key and a
    // real cooldown, never a key per report, which would page once per lead.
    for (let i = 0; i < 5; i++) await POST(req(ENFORCED));

    const keys = new Set(dispatch.sendThrottledAlert.mock.calls.map((c) => c[0]));
    expect([...keys]).toEqual(["csp_violation:script-src"]);
    for (const [, cooldownMs] of dispatch.sendThrottledAlert.mock.calls) expect(cooldownMs).toBeGreaterThan(0);
  });

  it("gives a different directive its own key, so an image refusal never silences a script one", async () => {
    await POST(req({ "csp-report": { ...ENFORCED["csp-report"], "violated-directive": "img-src" } }));
    await POST(req(ENFORCED));

    expect(dispatch.sendThrottledAlert.mock.calls.map((c) => c[0])).toEqual([
      "csp_violation:img-src",
      "csp_violation:script-src",
    ]);
  });

  it("carries no lead data, no query string and no manage token into Slack", async () => {
    await POST(req(ENFORCED));

    const text = dispatch.sendThrottledAlert.mock.calls[0][2];
    for (const leak of ["tok-secret", "Dana", "dana", "example.com", "2155550100", "00Q123", "?", "steal.js", "trypennie.com/my-offers"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("never keys on text a caller invented", async () => {
    await POST(req({ "csp-report": { ...ENFORCED["csp-report"], "violated-directive": "<!channel> wake up" } }));

    expect(dispatch.sendThrottledAlert.mock.calls[0][0]).toBe("csp_violation:other");
    expect(dispatch.sendThrottledAlert.mock.calls[0][2]).not.toContain("<!channel>");
  });

  it("does NOT page a report only report, and still logs it", async () => {
    await POST(req({ "csp-report": { ...ENFORCED["csp-report"], disposition: "report" } }));

    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(logged.warn).toHaveBeenCalledWith("csp-report", expect.objectContaining({ disposition: "report" }));
  });

  it("does NOT page a browser extension's own refusal, and still logs it", async () => {
    await POST(req({ "csp-report": { ...ENFORCED["csp-report"], "blocked-uri": "chrome-extension://abc/x.js" } }));

    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(logged.warn).toHaveBeenCalledWith("csp-report", expect.objectContaining({ paged: false }));
  });

  it("still answers 204 and SAYS so when the page cannot be sent", async () => {
    // A failed page must not turn into a 500 a browser retries, and must not be
    // silent either: the log line is the only trace a refusal paged nobody.
    dispatch.sendThrottledAlert.mockRejectedValue(new Error("slack down"));

    const res = await POST(req(ENFORCED));

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(logged.error).toHaveBeenCalledWith("csp-report", expect.objectContaining({ msg: expect.stringContaining("page") }), expect.any(Error));
  });

  it("says so, rather than dropping the page silently, when the cooldown cannot be read", async () => {
    // loadMonitorCooldowns itself falls back to the last known or coded cooldowns;
    // a throw that escapes it anyway must not drop the page on the floor in silence.
    settings.loadMonitorCooldowns.mockRejectedValue(new Error("db down"));

    const res = await POST(req(ENFORCED));

    expect(res.status).toBe(204);
    expect(logged.error).toHaveBeenCalledWith("csp-report", expect.objectContaining({ msg: expect.stringContaining("page") }), expect.any(Error));
  });
});

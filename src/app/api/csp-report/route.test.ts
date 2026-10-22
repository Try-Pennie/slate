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

  it("logs the script that tried the refused thing, in both report shapes", async () => {
    // 2026-10-04: an eval refusal on the manage page could only be traced by joining
    // the report against the Worker's invocation records by hand, because nothing
    // here said which script had tried it. The report carries it, so the log does.
    await POST(
      req({
        "csp-report": {
          "document-uri": "https://slate.trypennie.app/booking/manage/tok-secret",
          "violated-directive": "script-src",
          "blocked-uri": "eval",
          "source-file": "https://slate.trypennie.app/booking/manage/tok-secret?x=1",
          "line-number": 3,
          "column-number": 19,
          disposition: "enforce",
        },
      }),
    );
    await POST(
      req(
        [
          {
            type: "csp-violation",
            body: {
              documentURL: "https://slate.trypennie.app/book",
              effectiveDirective: "script-src",
              blockedURL: "eval",
              sourceFile: "https://slate.trypennie.app/_next/static/chunks/abc.js",
              lineNumber: 1,
              columnNumber: 2345,
              disposition: "enforce",
            },
          },
        ],
        "application/reports+json",
      ),
    );

    const sources = logged.warn.mock.calls.map((c) => (c[1] as { source?: string }).source);
    expect(sources).toEqual([
      "https://slate.trypennie.app/booking/manage/[redacted]:3:19",
      "https://slate.trypennie.app/_next/static/chunks/abc.js:1:2345",
    ]);
  });

  it("says so when the report names no script, rather than leaving the field out", async () => {
    await POST(req(LEGACY));

    expect(logged.warn).toHaveBeenCalledWith("csp-report", expect.objectContaining({ source: "(none)" }));
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
    // A SLATE-OWN-ORIGIN image refusal (a real gap in our own loading) pages under the
    // img-src key; the script refusal pages under the script-src key. Different keys, so
    // neither silences the other for the cooldown. (A THIRD-PARTY image refusal is the
    // injected-passive class and is logged, not paged, covered below.)
    await POST(req({ "csp-report": { ...ENFORCED["csp-report"], "violated-directive": "img-src", "blocked-uri": "https://slate.trypennie.app/logo.png" } }));
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

  it("says code was STOPPED FROM RUNNING for a refused eval, never that part of the page did not load", async () => {
    // An eval refusal stops a script that is already running from building more
    // code; nothing failed to load. On 2026-10-04 the page said it had, about a
    // refusal measured to come from code Slate does not ship.
    await POST(
      req({
        "csp-report": {
          ...ENFORCED["csp-report"],
          "violated-directive": "script-src",
          "blocked-uri": "eval",
          "source-file": "https://slate.trypennie.app/_next/static/chunks/abc.js",
        },
      }),
    );

    const text = dispatch.sendThrottledAlert.mock.calls[0][2];
    expect(text).toContain("stopped from running");
    expect(text).not.toContain("did not load");
    expect(text).toContain("source=");
    // The pointer, never the reported URL itself: the body is a stranger's text.
    expect(text).not.toContain("abc.js");
  });

  it("points at source= only when the report named a script", async () => {
    await POST(req({ "csp-report": { ...ENFORCED["csp-report"], "violated-directive": "script-src", "blocked-uri": "eval" } }));

    const text = dispatch.sendThrottledAlert.mock.calls[0][2];
    expect(text).toContain("stopped from running");
    expect(text).not.toContain("source=");
  });

  it("never says code was stopped for an inline STYLE refusal, where no code ran", async () => {
    await POST(
      req({
        "csp-report": {
          ...ENFORCED["csp-report"],
          "violated-directive": "style-src-attr",
          "blocked-uri": "inline",
          "source-file": "https://slate.trypennie.app/book",
        },
      }),
    );

    const text = dispatch.sendThrottledAlert.mock.calls[0][2];
    expect(text).not.toContain("stopped from running");
    expect(text).not.toContain("did not load");
    expect(text).toContain("styling");
    expect(text).not.toContain("inline code");
    // Its own sentence, not one opening on "So" after a full stop.
    expect(text).not.toMatch(/\. So /);
    // The source of a style refusal is the page, not a script.
    expect(text).toContain("source=");
    expect(text).not.toContain("script that tried it");
  });

  it("never says code was stopped for a Trusted Types refusal", async () => {
    for (const blocked of ["trusted-types-policy", "trusted-types-sink"]) {
      dispatch.sendThrottledAlert.mockClear();
      await POST(req({ "csp-report": { ...ENFORCED["csp-report"], "violated-directive": "script-src", "blocked-uri": blocked } }));

      const text = dispatch.sendThrottledAlert.mock.calls[0][2];
      expect(text).not.toContain("stopped from running");
      expect(text).not.toContain("did not load");
    }
  });

  it("says only that one resource was blocked when what was refused is a file, never that the page did not load (#3699)", async () => {
    // A report says the browser refused one resource. It never measured whether the
    // page looked or worked any differently, so the page must not claim it did (L11).
    await POST(req(ENFORCED));

    const text = dispatch.sendThrottledAlert.mock.calls[0][2];
    expect(text).toContain("The browser blocked that one resource");
    expect(text).not.toContain("did not load");
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

// #3417: a passive FONT refusal from a third-party host no Slate page requests, with no
// source, is almost always an extension and blocked nothing a lead needed, so it is
// LOGGED and never pages. One person's extension no longer pages production, and a
// widespread real gap still shows in the logs by host. (img/style/media keep paging as
// exfil channels; covered in csp.test.ts.)
describe("#3417 injected passive third-party refusal", () => {
  const INJECTED = {
    "csp-report": {
      "document-uri": "https://slate.trypennie.app/book?xbc=411",
      "violated-directive": "font-src",
      "blocked-uri": "https://fonts.gstatic.com/s/mulish/x.woff2",
      disposition: "enforce",
    },
  };

  it("logs the violation but does NOT page", async () => {
    const res = await POST(req(INJECTED));
    expect(res.status).toBe(204);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(logged.warn).toHaveBeenCalledWith(
      "csp-report",
      expect.objectContaining({ paged: false, not_paged: "injected-passive" }),
    );
  });

  it("still pages a passive refusal of Slate's OWN origin (a real gap in our loading)", async () => {
    await POST(req({ "csp-report": { ...INJECTED["csp-report"], "blocked-uri": "https://slate.trypennie.app/fonts/own.woff2" } }));
    expect(dispatch.sendThrottledAlert.mock.calls.map((c) => c[0])).toEqual(["csp_violation:font-src"]);
  });
});

// #3699: the Google Voice logo a browser add-on draws beside a phone number paged
// production four times in a week, the last at 2026-10-21T02:08:27Z on /book. It is the
// one refused image logged rather than paged: host exactly fonts.gstatic.com, path under
// /s/i/productlogos/, no named source (or a Slate page script, #4063, below). Every other
// refused image still pages.
describe("#3699 the Google product logo refused under img-src", () => {
  const VOICE_LOGO =
    "https://fonts.gstatic.com/s/i/productlogos/voice_2020q4/v7/web-24dp/logo_voice_2020q4_color_2x_web_24dp.png";
  const LOGO_REPORT = {
    "csp-report": {
      "document-uri": "https://slate.trypennie.app/book",
      referrer: "https://trypennie.com/",
      "violated-directive": "img-src",
      "blocked-uri": VOICE_LOGO,
      disposition: "enforce",
    },
  };

  it("logs the Voice logo with not_paged=injected-passive and does NOT page", async () => {
    const res = await POST(req(LOGO_REPORT));
    expect(res.status).toBe(204);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(logged.warn).toHaveBeenCalledWith(
      "csp-report",
      expect.objectContaining({
        directive: "img-src",
        blocked: VOICE_LOGO,
        source: "(none)",
        paged: false,
        not_paged: "injected-passive",
      }),
    );
  });

  it("still pages an image from the same host under another path", async () => {
    await POST(req({ "csp-report": { ...LOGO_REPORT["csp-report"], "blocked-uri": "https://fonts.gstatic.com/s/i/other/logo.png" } }));
    expect(dispatch.sendThrottledAlert.mock.calls.map((c) => c[0])).toEqual(["csp_violation:img-src"]);
    expect(logged.warn).toHaveBeenCalledWith("csp-report", expect.objectContaining({ paged: true }));
  });

  it("still pages the product logo path on another host", async () => {
    await POST(req({ "csp-report": { ...LOGO_REPORT["csp-report"], "blocked-uri": "https://evil.example/s/i/productlogos/logo.png" } }));
    expect(dispatch.sendThrottledAlert.mock.calls.map((c) => c[0])).toEqual(["csp_violation:img-src"]);
  });

  it("still pages the Voice logo when the report names a source on another origin", async () => {
    await POST(req({ "csp-report": { ...LOGO_REPORT["csp-report"], "source-file": "https://evil.example/_next/static/chunks/a.js" } }));
    expect(dispatch.sendThrottledAlert.mock.calls.map((c) => c[0])).toEqual(["csp_violation:img-src"]);
  });
});

// #4063: at 2026-10-22T02:47Z the same logo paged with Slate's own chunk named as the
// source, because Chrome credits a load to whatever script is on the stack when it fires
// (the embed's ResizeObserver forcing a layout), not to the code that added the image.
// A Slate page script (the page's origin, under /_next/static/) no longer makes it page.
describe("#4063 the Google product logo credited to a Slate page script", () => {
  const VOICE_LOGO =
    "https://fonts.gstatic.com/s/i/productlogos/voice_2020q4/v7/web-24dp/logo_voice_2020q4_color_2x_web_24dp.png";
  const chromeReport = (over: Record<string, unknown> = {}) => [
    {
      type: "csp-violation",
      body: {
        documentURL: "https://slate.trypennie.app/book",
        referrer: "https://trypennie.com/",
        effectiveDirective: "img-src",
        blockedURL: VOICE_LOGO,
        sourceFile: "https://slate.trypennie.app/_next/static/chunks/1oy04_4tbw26c.js",
        lineNumber: 1,
        columnNumber: 15104,
        disposition: "enforce",
        ...over,
      },
    },
  ];

  it("logs the report of 2026-10-22 with not_paged=injected-passive, its source kept, and does NOT page", async () => {
    const res = await POST(req(chromeReport(), "application/reports+json"));
    expect(res.status).toBe(204);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(logged.warn).toHaveBeenCalledWith(
      "csp-report",
      expect.objectContaining({
        directive: "img-src",
        blocked: VOICE_LOGO,
        source: "https://slate.trypennie.app/_next/static/chunks/1oy04_4tbw26c.js:1:15104",
        paged: false,
        not_paged: "injected-passive",
      }),
    );
  });

  it("still pages the logo when the source is a Slate script outside /_next/static/", async () => {
    await POST(req(chromeReport({ sourceFile: "https://slate.trypennie.app/book" }), "application/reports+json"));
    expect(dispatch.sendThrottledAlert.mock.calls.map((c) => c[0])).toEqual(["csp_violation:img-src"]);
  });

  it("still pages another gstatic image whose source is a Slate chunk", async () => {
    await POST(req(chromeReport({ blockedURL: "https://fonts.gstatic.com/s/i/other/logo.png" }), "application/reports+json"));
    expect(dispatch.sendThrottledAlert.mock.calls.map((c) => c[0])).toEqual(["csp_violation:img-src"]);
  });
});

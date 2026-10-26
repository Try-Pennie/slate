import { describe, it, expect } from "vitest";
import {
  buildContentSecurityPolicy,
  CSP_REPORT_PATH,
  cspNonce,
  redactReportUri,
  summariseViolation,
} from "./csp";

const NONCE = "dGVzdC1ub25jZQ==";

/** Directives as a map, so a test names the directive it means. */
function directives(policy: string): Record<string, string> {
  return Object.fromEntries(
    policy
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...rest] = d.split(/\s+/);
        return [name, rest.join(" ")];
      }),
  );
}

describe("buildContentSecurityPolicy (#2565)", () => {
  it("allows the page's own scripts by nonce and nothing inline without one", () => {
    const d = directives(buildContentSecurityPolicy({ nonce: NONCE, frameable: false }));
    expect(d["script-src"]).toContain(`'nonce-${NONCE}'`);
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
    expect(d["default-src"]).toBe("'self'");
  });

  it("carries strict-dynamic, so the bundles the nonced bootstrap loads are allowed", () => {
    // Measured on production 2026-09-18: the booker serves 4 inline scripts and 13
    // external ones, every external one same-origin and loaded by the bootstrap.
    // strict-dynamic is what lets those through without listing each chunk.
    const d = directives(buildContentSecurityPolicy({ nonce: NONCE, frameable: false }));
    expect(d["script-src"]).toContain("'strict-dynamic'");
  });

  it("allows wasm, because the confirmation mark's player compiles it (#2560)", () => {
    const d = directives(buildContentSecurityPolicy({ nonce: NONCE, frameable: false }));
    expect(d["script-src"]).toContain("'wasm-unsafe-eval'");
    expect(d["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("forbids framing on a staff page", () => {
    const d = directives(buildContentSecurityPolicy({ nonce: NONCE, frameable: false }));
    expect(d["frame-ancestors"]).toBe("'none'");
  });

  it("says NOTHING about framing on the booker, which must stay embeddable", () => {
    // The whole product is an embed on partner pages. A frame-ancestors here would
    // be reported in this phase and would black out the booker the day it is
    // enforced, which is a failure nothing on our side can see (the host page is
    // the only place the error appears).
    const d = directives(buildContentSecurityPolicy({ nonce: NONCE, frameable: true }));
    expect(d["frame-ancestors"]).toBeUndefined();
  });

  it("points reports at Slate's own endpoint, by both the old and the new directive", () => {
    // report-uri is deprecated and is what Safari and older Chrome still send to;
    // report-to is the replacement. Shipping one of the two means a whole browser
    // family reports nothing, and silence reads exactly like a clean policy.
    const policy = buildContentSecurityPolicy({ nonce: NONCE, frameable: true });
    expect(policy).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(policy).toContain("report-to csp");
  });

  it("locks down the directives an injection would reach for", () => {
    const d = directives(buildContentSecurityPolicy({ nonce: NONCE, frameable: true }));
    expect(d["object-src"]).toBe("'none'");
    expect(d["base-uri"]).toBe("'self'");
    expect(d["form-action"]).toBe("'self'");
  });

  it("is one line, because a header carrying newlines is not a header", () => {
    const policy = buildContentSecurityPolicy({ nonce: NONCE, frameable: true });
    expect(policy).not.toMatch(/[\r\n]/);
    expect(policy).not.toMatch(/\s{2,}/);
  });
});

describe("cspNonce", () => {
  it("is different every time, since a guessable nonce allows the injection it exists to stop", () => {
    const seen = new Set(Array.from({ length: 200 }, () => cspNonce()));
    expect(seen.size).toBe(200);
  });

  it("is base64 and long enough to be unguessable", () => {
    const n = cspNonce();
    expect(n).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(n.length).toBeGreaterThanOrEqual(22);
  });
});

describe("redactReportUri", () => {
  it("removes a booking manage token from a reported URL", () => {
    // A violation report carries document-uri, referrer and blocked-uri, and the
    // manage page's URL IS the credential: whoever holds the token can cancel or
    // reschedule that booking. #2564 took it out of the warehouse; it must not
    // arrive in the logs by this door instead.
    expect(redactReportUri("https://slate.trypennie.app/booking/manage/abc123XYZ-token")).toBe(
      "https://slate.trypennie.app/booking/manage/[redacted]",
    );
  });

  it("redacts it inside a longer URL with a query string", () => {
    expect(
      redactReportUri("https://slate.trypennie.app/booking/manage/tok_secret?from=email"),
    ).toBe("https://slate.trypennie.app/booking/manage/[redacted]");
  });

  // #3046: a browser keeps the query string in `document-uri` and `referrer`, and
  // on /book that query carries the lead's name, email and phone, percent encoded
  // so no contact shape matches. The query and fragment are dropped whole.
  it("drops the query string and fragment that carry a lead's details", () => {
    const out = redactReportUri(
      "https://slate.trypennie.app/book?name=Dana%20Lee&email=dana%40example.com&phone=%28215%29%20555-0100#confirm",
    );
    expect(out).toBe("https://slate.trypennie.app/book");
  });

  it("CONTROL: leaves a URL with no query string alone", () => {
    expect(redactReportUri("https://slate.trypennie.app/book")).toBe("https://slate.trypennie.app/book");
    expect(redactReportUri("inline")).toBe("inline");
  });

  it("returns a fixed marker for something that is not a string", () => {
    expect(redactReportUri(undefined)).toBe("(none)");
    expect(redactReportUri(42 as unknown as string)).toBe("(unreadable)");
  });

  it("truncates a very long value rather than logging it whole", () => {
    const out = redactReportUri("https://example.test/" + "a".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(300);
  });
});

describe("summariseViolation", () => {
  it("reads both the modern and the legacy report shapes", () => {
    const modern = summariseViolation({
      body: { documentURL: "https://slate.trypennie.app/book", effectiveDirective: "script-src", blockedURL: "https://evil.test/x.js" },
    });
    const legacy = summariseViolation({
      "csp-report": { "document-uri": "https://slate.trypennie.app/book", "violated-directive": "script-src", "blocked-uri": "https://evil.test/x.js" },
    });

    expect(modern.directive).toBe("script-src");
    expect(legacy.directive).toBe("script-src");
    expect(modern.blocked).toBe("https://evil.test/x.js");
    expect(legacy.blocked).toBe("https://evil.test/x.js");
  });

  it("redacts the manage token out of every URL field it reports", () => {
    const s = summariseViolation({
      "csp-report": {
        "document-uri": "https://slate.trypennie.app/booking/manage/tok-secret",
        referrer: "https://slate.trypennie.app/booking/manage/tok-secret",
        "blocked-uri": "https://slate.trypennie.app/booking/manage/tok-secret",
        "violated-directive": "img-src",
      },
    });

    expect(JSON.stringify(s)).not.toContain("tok-secret");
    expect(s.document).toContain("[redacted]");
  });

  it("says whether the report named where the refusal came from, so no caller compares the sentinel", () => {
    const named = summariseViolation({
      "csp-report": { "violated-directive": "script-src", "blocked-uri": "eval", "source-file": "https://slate.trypennie.app/x.js" },
    });
    const unnamed = summariseViolation({ "csp-report": { "violated-directive": "script-src", "blocked-uri": "eval" } });
    const empty = summariseViolation({ "csp-report": { "violated-directive": "script-src", "blocked-uri": "eval", "source-file": "" } });

    expect(named.sourceNamed).toBe(true);
    expect(unnamed.sourceNamed).toBe(false);
    expect(empty.sourceNamed).toBe(false);
    expect(summariseViolation(null).sourceNamed).toBe(false);
  });

  it("says the directive is unknown rather than inventing one, for an unreadable body", () => {
    // A report that cannot be read must not be counted as a violation of something
    // in particular: that would send somebody to fix a directive nothing reported.
    expect(summariseViolation(null).directive).toBe("(unreadable)");
    expect(summariseViolation({ nonsense: true }).directive).toBe("(unreadable)");
  });
});

describe("our own inline theme scripts (#2565)", () => {
  it("enumerates every script the boot rule can emit, from its own vocabulary", async () => {
    const { themeBootScriptTexts } = await import("./csp");
    const texts = themeBootScriptTexts();
    // cookie, plus each preference with and without remember. Derived from the
    // vocabulary rather than listed, so a fourth preference cannot ship a script
    // the policy has never heard of.
    expect(texts.length).toBe(7);
    expect(new Set(texts).size).toBe(texts.length);
    for (const t of texts) expect(t.length).toBeGreaterThan(20);
  });

  it("covers the exact text each component renders", async () => {
    const { themeBootScriptTexts } = await import("./csp");
    const { themeBootScript } = await import("@/lib/theme/boot");
    const texts = new Set(themeBootScriptTexts());

    // The four live call sites, written the way the components write them. A hash
    // list that did not cover one of these would report our own script on every
    // page, which is the noise this exists to prevent.
    expect(texts.has(themeBootScript({ kind: "cookie" }))).toBe(true);
    expect(texts.has(themeBootScript({ kind: "preference", preference: "light" }))).toBe(true);
    expect(texts.has(themeBootScript({ kind: "preference", preference: "dark" }))).toBe(true);
    expect(texts.has(themeBootScript({ kind: "preference", preference: "system", remember: true }))).toBe(true);
  });

  it("hashes them as sha256 sources the policy can carry", async () => {
    const { themeScriptHashes } = await import("./csp");
    const hashes = await themeScriptHashes();
    expect(hashes.length).toBe(7);
    for (const h of hashes) expect(h).toMatch(/^'sha256-[A-Za-z0-9+/]+={0,2}'$/);
  });

  it("puts them in script-src, so our own boot scripts are allowed without a nonce", async () => {
    const { buildContentSecurityPolicy, themeScriptHashes } = await import("./csp");
    const hashes = await themeScriptHashes();
    const policy = buildContentSecurityPolicy({ nonce: NONCE, frameable: true, scriptHashes: hashes });
    for (const h of hashes) expect(policy).toContain(h);
  });
});

/**
 * #2575: what enforcement needs from the policy, every rule taken from the
 * violations production actually reported rather than from the policy looking
 * right. Over the seven days to 2026-10-03 the Worker logged 450 reports and every
 * one was the same thing: `img-src` refusing an advisor's Google sign in photo
 * (`https://lh3.googleusercontent.com/a/...`) on the manage page.
 */
describe("the enforced policy (#2575)", () => {
  it("allows the sign in photo host Google serves advisor faces from", async () => {
    // Enforced without this, a lead's manage page draws a broken image where the
    // advisor's face should be, for every advisor the directory run has not
    // reached yet (the resolver's never-read and unreadable states).
    const { SIGN_IN_PHOTO_ORIGIN } = await import("./csp");
    const d = directives(buildContentSecurityPolicy({ nonce: NONCE, frameable: true }));
    expect(SIGN_IN_PHOTO_ORIGIN).toBe("https://lh3.googleusercontent.com");
    expect(d["img-src"].split(" ")).toContain(SIGN_IN_PHOTO_ORIGIN);
  });

  it("CONTROL: allows that host for images ONLY, never for scripts or connections", async () => {
    const { SIGN_IN_PHOTO_ORIGIN } = await import("./csp");
    const d = directives(buildContentSecurityPolicy({ nonce: NONCE, frameable: true }));
    expect(d["script-src"]).not.toContain(SIGN_IN_PHOTO_ORIGIN);
    expect(d["connect-src"]).toBe("'self'");
    expect(d["default-src"]).toBe("'self'");
  });

  it("adds a connect source only where one is passed", () => {
    // The staff sign in page builds a Supabase browser client, which talks to the
    // project's own origin. The booker has no such client and gets none.
    const staff = directives(
      buildContentSecurityPolicy({ nonce: NONCE, frameable: false, connectSources: ["https://project.supabase.co"] }),
    );
    expect(staff["connect-src"]).toBe("'self' https://project.supabase.co");
  });
});

describe("cspAlertDirective (#2575)", () => {
  it("maps a reported directive onto the policy's own directive list", async () => {
    const { cspAlertDirective } = await import("./csp");
    expect(cspAlertDirective("script-src")).toBe("script-src");
    // Browsers report the element and attribute variants; they page as the
    // directive the policy actually declares.
    expect(cspAlertDirective("script-src-elem")).toBe("script-src");
    expect(cspAlertDirective("style-src-attr")).toBe("style-src");
    // Older browsers put the whole directive, values included.
    expect(cspAlertDirective("img-src 'self' data: blob:")).toBe("img-src");
    expect(cspAlertDirective("frame-ancestors")).toBe("frame-ancestors");
  });

  it("maps anything else to other, so a caller can never mint a key", async () => {
    const { cspAlertDirective } = await import("./csp");
    expect(cspAlertDirective("totally-made-up")).toBe("other");
    expect(cspAlertDirective("report-uri")).toBe("other");
    expect(cspAlertDirective("(unreadable)")).toBe("other");
    expect(cspAlertDirective("<!channel>")).toBe("other");
  });

  it("derives the list from the policy itself, so a new directive is covered by construction", async () => {
    const { CSP_ALERT_DIRECTIVES } = await import("./csp");
    const declared = Object.keys(directives(buildContentSecurityPolicy({ nonce: NONCE, frameable: false })))
      .filter((d) => !d.startsWith("report-"));
    expect([...CSP_ALERT_DIRECTIVES].sort()).toEqual([...declared, "other"].sort());
  });
});

describe("cspViolationPage (#2575)", () => {
  const enforced = (over: Record<string, unknown> = {}) => ({
    "csp-report": {
      "document-uri": "https://slate.trypennie.app/book?xbc=411&email=dana%40example.com",
      "violated-directive": "script-src-elem",
      "blocked-uri": "https://evil.example/x.js?lead=dana",
      disposition: "enforce",
      ...over,
    },
  });

  it("pages an enforced refusal, keyed on the directive", async () => {
    const { cspViolationPage } = await import("./csp");
    const d = cspViolationPage(summariseViolation(enforced()));
    expect(d).toEqual({
      page: true,
      key: "csp_violation:script-src",
      directive: "script-src",
      surface: "book",
      blocked: { kind: "origin", origin: "https://evil.example" },
    });
  });

  it("pages a report that does not say its disposition, since the only policy now enforces", async () => {
    // Safari's legacy reports omit it. Reading a missing field as report only
    // would silence a whole browser family on the one surface this pages about.
    const { cspViolationPage } = await import("./csp");
    const body = enforced();
    delete (body["csp-report"] as Record<string, unknown>).disposition;
    expect(cspViolationPage(summariseViolation(body)).page).toBe(true);
  });

  it("does not page a report only report, which blocked nothing", async () => {
    const { cspViolationPage } = await import("./csp");
    expect(cspViolationPage(summariseViolation(enforced({ disposition: "report" })))).toEqual({
      page: false,
      why: "report-only",
    });
  });

  it("does not page a browser extension's own refusal, which is not Slate's page", async () => {
    const { cspViolationPage } = await import("./csp");
    expect(
      cspViolationPage(summariseViolation(enforced({ "blocked-uri": "chrome-extension://abcdef/inject.js" }))),
    ).toEqual({ page: false, why: "extension" });
    expect(
      cspViolationPage(summariseViolation(enforced({ "blocked-uri": "inline", "source-file": "moz-extension://x/c.js" }))),
    ).toEqual({ page: false, why: "extension" });
  });

  it("does not page when Chrome strips the extension id to the bare scheme word (#3634)", async () => {
    // Chrome removes the extension id from CSP reports for privacy, so an
    // extension-injected inline handler arrives with source-file as the bare word
    // "chrome-extension": no "://id" and no colon. Measured in production
    // 2026-10-12 on /book (directive script-src-attr, blocked inline), this paged
    // although it is the extension's own code, not Slate's page failing a lead.
    const { cspViolationPage } = await import("./csp");
    expect(
      cspViolationPage(
        summariseViolation(
          enforced({ "violated-directive": "script-src-attr", "blocked-uri": "inline", "source-file": "chrome-extension" }),
        ),
      ),
    ).toEqual({ page: false, why: "extension" });
    // The same bare word in blocked-uri, which is the other field a report can name it in.
    expect(
      cspViolationPage(summariseViolation(enforced({ "violated-directive": "script-src-elem", "blocked-uri": "chrome-extension" }))),
    ).toEqual({ page: false, why: "extension" });
  });

  it("still pages a value that only starts with the scheme word, or names it in a host", async () => {
    // The bare word is matched only as a whole scheme segment: followed by the end, a
    // colon or a slash. A value that merely begins with it is somebody else's, and a URL
    // whose HOST contains it is an ordinary origin, so both still page.
    const { cspViolationPage } = await import("./csp");
    for (const source of ["chrome-extension.example.com/x.js", "chrome-extensions", "https://chrome-extension.example.com/x.js"]) {
      expect(
        cspViolationPage(summariseViolation(enforced({ "blocked-uri": "inline", "source-file": source }))).page,
        source,
      ).toBe(true);
    }
  });

  it("reads the modern report's disposition too", async () => {
    const { cspViolationPage } = await import("./csp");
    const modern = (disposition: string) =>
      summariseViolation([
        {
          type: "csp-violation",
          body: { documentURL: "https://slate.trypennie.app/admin", effectiveDirective: "style-src-elem", blockedURL: "inline", disposition },
        },
      ]);
    expect(cspViolationPage(modern("report"))).toEqual({ page: false, why: "report-only" });
    expect(cspViolationPage(modern("enforce"))).toMatchObject({
      page: true,
      key: "csp_violation:style-src",
      surface: "admin",
      blocked: { kind: "keyword", keyword: "inline" },
    });
  });

  it("describes what was blocked without any of the reported URL beyond its origin", async () => {
    const { cspViolationPage } = await import("./csp");
    const page = (blocked: string) => cspViolationPage(summariseViolation(enforced({ "blocked-uri": blocked })));
    expect(page("eval")).toMatchObject({ blocked: { kind: "keyword", keyword: "eval" } });
    expect(page("data")).toMatchObject({ blocked: { kind: "scheme", scheme: "data" } });
    expect(page("blob:https://slate.trypennie.app/1234")).toMatchObject({ blocked: { kind: "scheme", scheme: "blob" } });
    expect(page("javascript:alert(1)")).toMatchObject({ blocked: { kind: "unreadable" } });
    expect(page("<!channel> look here")).toMatchObject({ blocked: { kind: "unreadable" } });
  });

  it("maps the page onto Slate's surface list, never the reported path", async () => {
    const { cspViolationPage } = await import("./csp");
    const on = (doc: string) => cspViolationPage(summariseViolation(enforced({ "document-uri": doc })));
    expect(on("https://slate.trypennie.app/booking/manage/tok-secret")).toMatchObject({ surface: "booking" });
    expect(on("https://slate.trypennie.app/")).toMatchObject({ surface: "root" });
    expect(on("https://slate.trypennie.app/wp-admin/x")).toMatchObject({ surface: "other" });
    expect(on("not a url")).toMatchObject({ surface: "other" });
  });
});

describe("the injected passive third-party class (#3417)", () => {
  // A FONT refused from a third-party host no Slate page requests, with no named source,
  // is almost always an extension and blocked nothing a lead needed, so it is logged and
  // does NOT page. Only font-src is suppressed: a named source (unless it is a Slate page
  // script under /_next/static/ on the page's own origin, #4063, below), a Slate-own-origin
  // refusal, an ACTIVE directive (script/connect/frame), and the other passive exfil
  // channels (img/style/media) all still page at once.
  const report = (over: Record<string, unknown> = {}) => ({
    "csp-report": {
      "document-uri": "https://slate.trypennie.app/book?xbc=411",
      "violated-directive": "font-src",
      "blocked-uri": "https://fonts.gstatic.com/s/mulish/x.woff2",
      disposition: "enforce",
      ...over,
    },
  });

  it("logs, rather than pages, a passive third-party refusal with no source", async () => {
    const { cspViolationPage } = await import("./csp");
    expect(cspViolationPage(summariseViolation(report()))).toEqual({ page: false, why: "injected-passive" });
  });

  it("does NOT log-only img-src, style-src or media-src: they are data-exfil channels and keep paging", async () => {
    // An injected `<img src=attacker/?d=...>` beacon or a CSS exfil is refused on these,
    // so a third-party refusal there may signal an injection attempt worth a page. Only
    // font-src is suppressed, plus the one Google product logo path under img-src (#3699,
    // below); this font path on the same host is not it.
    const { cspViolationPage } = await import("./csp");
    for (const directive of ["img-src", "style-src", "media-src"]) {
      const d = cspViolationPage(summariseViolation(report({ "violated-directive": directive })));
      expect(d.page).toBe(true);
    }
  });

  it("still pages an ACTIVE directive's third-party refusal at once (a blocked script is worth a page)", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const directive of ["script-src", "connect-src", "frame-src"]) {
      const d = cspViolationPage(summariseViolation(report({ "violated-directive": directive, "blocked-uri": "https://evil.example/x" })));
      expect(d.page).toBe(true);
    }
  });

  it("still pages a passive refusal that NAMES a script source", async () => {
    const { cspViolationPage } = await import("./csp");
    const d = cspViolationPage(summariseViolation(report({ "source-file": "https://slate.trypennie.app/app.js" })));
    expect(d.page).toBe(true);
  });

  it("still pages a passive refusal of Slate's OWN origin (a real gap in our loading)", async () => {
    const { cspViolationPage } = await import("./csp");
    const d = cspViolationPage(summariseViolation(report({ "blocked-uri": "https://slate.trypennie.app/fonts/own.woff2" })));
    expect(d.page).toBe(true);
  });

  it("still pages a passive refusal whose blocked value is not a concrete origin (data:, a keyword)", async () => {
    const { cspViolationPage } = await import("./csp");
    expect(cspViolationPage(summariseViolation(report({ "blocked-uri": "data" }))).page).toBe(true);
    expect(cspViolationPage(summariseViolation(report({ "blocked-uri": "inline" }))).page).toBe(true);
  });

  it("pages (never suppresses) when the document host cannot be read, so third-party cannot be proven", async () => {
    const { cspViolationPage } = await import("./csp");
    const d = cspViolationPage(summariseViolation(report({ "document-uri": "not a url" })));
    expect(d.page).toBe(true);
  });
});

describe("the Google product logo an add-on injects, refused under img-src (#3699)", () => {
  // A browser add-on draws Google Voice's "click to call" logo beside a phone number, and
  // the enforced policy refuses it under img-src. Slate never loads it. It is logged, not
  // paged, ONLY for that exact host AND the product logo path, with no named source (or
  // a Slate page script as the source, #4063, below): an
  // image request to Google's own host carries nothing an attacker can collect. Every
  // other refused image keeps paging, because a third-party image can be an injected
  // exfiltration beacon (<img src=https://attacker/?d=...>).
  const VOICE_LOGO =
    "https://fonts.gstatic.com/s/i/productlogos/voice_2020q4/v7/web-24dp/logo_voice_2020q4_color_2x_web_24dp.png";
  const report = (over: Record<string, unknown> = {}) => ({
    "csp-report": {
      "document-uri": "https://slate.trypennie.app/book?xbc=411",
      referrer: "https://trypennie.com/",
      "violated-directive": "img-src",
      "blocked-uri": VOICE_LOGO,
      disposition: "enforce",
      ...over,
    },
  });

  it("logs, rather than pages, the Google Voice logo refused with no source", async () => {
    const { cspViolationPage } = await import("./csp");
    expect(cspViolationPage(summariseViolation(report()))).toEqual({ page: false, why: "injected-passive" });
  });

  it("logs it on the manage page too, where the token is redacted out of the document", async () => {
    const { cspViolationPage } = await import("./csp");
    const d = cspViolationPage(summariseViolation(report({ "document-uri": "https://slate.trypennie.app/booking/manage/tok-secret" })));
    expect(d).toEqual({ page: false, why: "injected-passive" });
  });

  it("logs it when an older browser reports the directive with its values", async () => {
    const { cspViolationPage } = await import("./csp");
    const d = cspViolationPage(summariseViolation(report({ "violated-directive": "img-src 'self' data:" })));
    expect(d).toEqual({ page: false, why: "injected-passive" });
  });

  it("still pages an image from the same host under any other path", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const blocked of [
      "https://fonts.gstatic.com/s/mulish/x.woff2",
      "https://fonts.gstatic.com/s/i/other/logo.png",
      "https://fonts.gstatic.com/s/i/productlogosX/logo.png",
      "https://fonts.gstatic.com/x/s/i/productlogos/logo.png",
      "https://fonts.gstatic.com/",
      "https://fonts.gstatic.com/s/i/productlogos/../../../beacon.png",
    ]) {
      expect(cspViolationPage(summariseViolation(report({ "blocked-uri": blocked }))).page, blocked).toBe(true);
    }
  });

  it("still pages the product logo path on any other host, a look alike or a port included", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const blocked of [
      "https://evil.example/s/i/productlogos/voice_2020q4/v7/web-24dp/logo.png",
      "https://fonts.gstatic.com.evil.example/s/i/productlogos/logo.png",
      "https://evilfonts.gstatic.com/s/i/productlogos/logo.png",
      "https://www.gstatic.com/s/i/productlogos/logo.png",
      "https://fonts.gstatic.com:8443/s/i/productlogos/logo.png",
      "http://fonts.gstatic.com/s/i/productlogos/logo.png",
      "https://lh4.googleusercontent.com/s/i/productlogos/logo.png",
    ]) {
      expect(cspViolationPage(summariseViolation(report({ "blocked-uri": blocked }))).page, blocked).toBe(true);
    }
  });

  it("still pages the Voice logo when the report names a source on another origin (#4063 narrows, never drops, this)", async () => {
    const { cspViolationPage } = await import("./csp");
    const d = cspViolationPage(summariseViolation(report({ "source-file": "https://evil.example/_next/static/chunks/a.js" })));
    expect(d.page).toBe(true);
  });

  it("still pages the Voice logo URL under any directive but img-src", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const directive of ["style-src", "media-src", "connect-src", "script-src", "frame-src"]) {
      expect(cspViolationPage(summariseViolation(report({ "violated-directive": directive }))).page, directive).toBe(true);
    }
  });

  it("CONTROL: another refused image from that host pages under the img-src key", async () => {
    const { cspViolationPage } = await import("./csp");
    const d = cspViolationPage(summariseViolation(report({ "blocked-uri": "https://fonts.gstatic.com/s/i/other/logo.png" })));
    expect(d).toMatchObject({ page: true, key: "csp_violation:img-src", directive: "img-src" });
  });
});

describe("the Google product logo credited to a Slate page script (#4063)", () => {
  // 2026-10-22 02:47Z: the Voice logo paged again on /book, this time with a named
  // source, Slate's own chunk at the column where the embed's ResizeObserver reads
  // scrollHeight. That read forces a layout, the add-on's injected image starts loading
  // during it, and Chrome credits the load to whatever script is on the stack (L799). So
  // a Slate page script as the source says only that Slate code was running, not that
  // Slate asked for the image. The logo is logged also when the source is a script under
  // /_next/static/ on the page's own origin; every other named source still pages.
  const VOICE_LOGO =
    "https://fonts.gstatic.com/s/i/productlogos/voice_2020q4/v7/web-24dp/logo_voice_2020q4_color_2x_web_24dp.png";
  const CHUNK = "https://slate.trypennie.app/_next/static/chunks/1oy04_4tbw26c.js";
  // The report as Chrome posted it, through the Reporting API.
  const modern = (over: Record<string, unknown> = {}) => [
    {
      type: "csp-violation",
      body: {
        documentURL: "https://slate.trypennie.app/book",
        referrer: "https://trypennie.com/",
        effectiveDirective: "img-src",
        blockedURL: VOICE_LOGO,
        sourceFile: CHUNK,
        lineNumber: 1,
        columnNumber: 15104,
        disposition: "enforce",
        ...over,
      },
    },
  ];
  const legacy = (over: Record<string, unknown> = {}) => ({
    "csp-report": {
      "document-uri": "https://slate.trypennie.app/book?xbc=411",
      referrer: "https://trypennie.com/",
      "violated-directive": "img-src",
      "blocked-uri": VOICE_LOGO,
      "source-file": CHUNK,
      "line-number": 1,
      "column-number": 15104,
      disposition: "enforce",
      ...over,
    },
  });

  it("logs, rather than pages, the exact report of 2026-10-22, in both report shapes", async () => {
    const { cspViolationPage } = await import("./csp");
    expect(cspViolationPage(summariseViolation(modern()))).toEqual({ page: false, why: "injected-passive" });
    expect(cspViolationPage(summariseViolation(legacy()))).toEqual({ page: false, why: "injected-passive" });
  });

  it("logs it whatever page of Slate's it was on, the manage page with its token included", async () => {
    const { cspViolationPage } = await import("./csp");
    const d = cspViolationPage(
      summariseViolation(
        legacy({
          "document-uri": "https://slate.trypennie.app/booking/manage/tok-secret",
          "source-file": "https://slate.trypennie.app/_next/static/chunks/app/booking/manage/page-abc.js?v=1",
        }),
      ),
    );
    expect(d).toEqual({ page: false, why: "injected-passive" });
  });

  it("still pages the logo when the source is on any origin but the page's own", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const sourceFile of [
      "https://evil.example/_next/static/chunks/a.js",
      "https://trypennie.com/_next/static/chunks/a.js", // the host page that embeds Slate
      "https://slate.trypennie.app.evil.example/_next/static/chunks/a.js",
      "https://evilslate.trypennie.app/_next/static/chunks/a.js",
      "https://slate.trypennie.app:8443/_next/static/chunks/a.js",
      "http://slate.trypennie.app/_next/static/chunks/a.js",
      "blob:https://slate.trypennie.app/_next/static/chunks/a.js",
    ]) {
      expect(cspViolationPage(summariseViolation(modern({ sourceFile }))).page, sourceFile).toBe(true);
    }
  });

  it("still pages the logo when a Slate source is outside /_next/static/, an inline or eval source included", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const sourceFile of [
      "https://slate.trypennie.app/book", // an inline script, credited to the document
      "https://slate.trypennie.app/app.js",
      "https://slate.trypennie.app/widget.js",
      "https://slate.trypennie.app/_next/staticX/chunks/a.js",
      "https://slate.trypennie.app/_next/static",
      "https://slate.trypennie.app/x/_next/static/chunks/a.js",
      "https://slate.trypennie.app/_next/image?url=/_next/static/a.js",
      "https://slate.trypennie.app/_next/static/../../api/x.js",
      "https://slate.trypennie.app/_next/static/%2e%2e/%2e%2e/api/x.js",
      "inline",
      "eval",
      "wasm-eval",
      "data:text/javascript,1",
      "chunks/a.js",
      "/_next/static/chunks/a.js",
    ]) {
      expect(cspViolationPage(summariseViolation(modern({ sourceFile }))).page, sourceFile).toBe(true);
    }
  });

  it("still pages any image but the logo with a Slate chunk as its source", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const blockedURL of [
      "https://fonts.gstatic.com/s/i/other/logo.png",
      "https://fonts.gstatic.com/s/mulish/x.png",
      "https://fonts.gstatic.com/s/i/productlogos/../../../beacon.png",
      "https://evil.example/s/i/productlogos/logo.png",
      "https://evil.example/?d=secret",
      "https://slate.trypennie.app/s/i/productlogos/logo.png",
    ]) {
      const d = cspViolationPage(summariseViolation(modern({ blockedURL })));
      expect(d, blockedURL).toMatchObject({ page: true, key: "csp_violation:img-src" });
    }
  });

  it("still pages the logo URL under any directive but img-src with a Slate chunk source", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const effectiveDirective of ["style-src", "media-src", "connect-src", "script-src", "frame-src"]) {
      expect(cspViolationPage(summariseViolation(modern({ effectiveDirective }))).page, effectiveDirective).toBe(true);
    }
  });

  it("pages when the document cannot be read, so the source cannot be proven the page's own", async () => {
    const { cspViolationPage } = await import("./csp");
    expect(cspViolationPage(summariseViolation(modern({ documentURL: "not a url" }))).page).toBe(true);
    expect(cspViolationPage(summariseViolation(modern({ documentURL: undefined }))).page).toBe(true);
  });
});

describe("a third-party font credited to a Slate page script (the #4063 rule, extended to font-src)", () => {
  // 2026-10-24 19:37Z (3:37 PM ET): an add-on's Mulish font paged font-src on /book,
  // embedded from trypennie.com. #3417 already logs a third-party font with no source; this
  // report named Slate's own chunk at the column where the embed's ResizeObserver reads
  // scrollHeight, the same forced layout #4063 found crediting the Voice logo to Slate
  // (L799). Until 2026-10-26 a test here held that a named Slate chunk still paged a font
  // ("#4063 is the logo only"); Dan reversed that on 2026-10-26, so the one rule is now:
  // a passive refusal credited to a Slate page script reads as one that named no source.
  const MULISH = "https://fonts.gstatic.com/s/mulish/v18/1Ptvg83HX_SGhgqk0AotYKNnBcif.woff2";
  const CHUNK = "https://slate.trypennie.app/_next/static/chunks/2xlik_6mb5atx.js";
  // The report as logged, field for field (the log carries no query string; none is added).
  const modern = (over: Record<string, unknown> = {}) => [
    {
      type: "csp-violation",
      body: {
        documentURL: "https://slate.trypennie.app/book",
        referrer: "https://trypennie.com/",
        effectiveDirective: "font-src",
        blockedURL: MULISH,
        sourceFile: CHUNK,
        lineNumber: 1,
        columnNumber: 14435,
        disposition: "enforce",
        ...over,
      },
    },
  ];
  const legacy = (over: Record<string, unknown> = {}) => ({
    "csp-report": {
      "document-uri": "https://slate.trypennie.app/book",
      referrer: "https://trypennie.com/",
      "violated-directive": "font-src",
      "blocked-uri": MULISH,
      "source-file": CHUNK,
      "line-number": 1,
      "column-number": 14435,
      disposition: "enforce",
      ...over,
    },
  });

  it("logs, rather than pages, the exact report of 2026-10-24, in both report shapes", async () => {
    const { cspViolationPage } = await import("./csp");
    expect(cspViolationPage(summariseViolation(modern()))).toEqual({ page: false, why: "injected-passive" });
    expect(cspViolationPage(summariseViolation(legacy()))).toEqual({ page: false, why: "injected-passive" });
  });

  it("still pages a refused font from Slate's OWN origin with a Slate chunk as its source (Slate self hosts PP Mori)", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const blockedURL of [
      "https://slate.trypennie.app/fonts/PPMori-Regular.woff2",
      "https://slate.trypennie.app/_next/static/media/pp-mori.woff2",
    ]) {
      const d = cspViolationPage(summariseViolation(modern({ blockedURL })));
      expect(d, blockedURL).toMatchObject({ page: true, key: "csp_violation:font-src" });
    }
  });

  it("still pages the third-party font when the source is on any origin but the page's own", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const sourceFile of [
      "https://evil.example/_next/static/chunks/a.js",
      "https://trypennie.com/_next/static/chunks/a.js", // the host page that embeds Slate
      "https://slate.trypennie.app.evil.example/_next/static/chunks/a.js",
      "https://slate.trypennie.app:8443/_next/static/chunks/a.js",
      "http://slate.trypennie.app/_next/static/chunks/a.js",
      "https://fonts.gstatic.com/_next/static/chunks/a.js",
    ]) {
      const d = cspViolationPage(summariseViolation(modern({ sourceFile })));
      expect(d, sourceFile).toMatchObject({ page: true, key: "csp_violation:font-src" });
    }
  });

  it("still pages the third-party font when the source is inline, eval, or a Slate URL outside /_next/static/", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const sourceFile of [
      "inline",
      "eval",
      "wasm-eval",
      "https://slate.trypennie.app/book", // an inline script, credited to the document
      "https://slate.trypennie.app/widget.js",
      "https://slate.trypennie.app/_next/static/../../api/x.js",
      "/_next/static/chunks/a.js",
    ]) {
      const d = cspViolationPage(summariseViolation(modern({ sourceFile })));
      expect(d, sourceFile).toMatchObject({ page: true, key: "csp_violation:font-src" });
    }
  });

  it("keeps paging a stylesheet, media or script from that host with a Slate chunk source: fonts and the logo only", async () => {
    const { cspViolationPage } = await import("./csp");
    for (const effectiveDirective of ["style-src", "media-src", "script-src", "connect-src", "img-src"]) {
      expect(cspViolationPage(summariseViolation(modern({ effectiveDirective }))).page, effectiveDirective).toBe(true);
    }
  });
});

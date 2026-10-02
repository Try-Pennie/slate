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

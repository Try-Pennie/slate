import { describe, it, expect } from "vitest";
import { httpsRedirect } from "./https-redirect";

/**
 * #1024: the public booker collects lead name, email and phone, so a first-time
 * visitor arriving on an http:// link must be bounced to https:// before the
 * browser sends anything.
 *
 * This lives in the Worker entry rather than in Cloudflare config because
 * slate.trypennie.app is attached to the Worker as a Custom Domain
 * (`custom_domain: true`, wrangler.jsonc), which makes the Worker the ORIGIN: a
 * zone Redirect Rule is never consulted for it. That was established the
 * expensive way, by deploying a correct, valid rule and watching plaintext
 * requests sail past it.
 */

/** A request as the Worker receives it, with optional Cloudflare scheme header. */
function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

describe("httpsRedirect", () => {
  it("redirects a plaintext request to the same URL over https", () => {
    const res = httpsRedirect(req("http://slate.trypennie.app/book/411"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(308);
    expect(res!.headers.get("location")).toBe("https://slate.trypennie.app/book/411");
  });

  it("uses 308 so a POST keeps its method and body", () => {
    // A 301/302 lets clients rewrite POST to GET and drop the body, which would
    // silently turn an integrator's booking call into an empty page request.
    const res = httpsRedirect(req("http://slate.trypennie.app/api/bookings"));
    expect(res!.status).toBe(308);
  });

  it("carries the path and the full query string across", () => {
    const res = httpsRedirect(
      req("http://slate.trypennie.app/book/411?name=Ada%20L&email=a%40b.com&xbc=411"),
    );
    expect(res!.headers.get("location")).toBe(
      "https://slate.trypennie.app/book/411?name=Ada%20L&email=a%40b.com&xbc=411",
    );
  });

  it("preserves the hostname rather than hardcoding one", () => {
    // Production answers on one hostname now (#1052 closed the workers.dev origin),
    // so this is no longer about a second live origin. It is about the redirect
    // deriving its target from the request rather than from a constant: a hardcoded
    // target sends a request that arrived on any other host to the wrong place, which
    // is what a local or a future host would be.
    const res = httpsRedirect(req("http://slate-other.example/api/health"));
    expect(res!.headers.get("location")).toBe("https://slate-other.example/api/health");
  });

  it("passes an already-secure request straight through", () => {
    expect(httpsRedirect(req("https://slate.trypennie.app/book/411"))).toBeNull();
  });

  it("trusts CF-Visitor over the URL when it reports http", () => {
    // If Cloudflare normalizes request.url to https but reports the real client
    // scheme in CF-Visitor, the URL alone would say "already secure" and the
    // guard would never fire. CF-Visitor is the authoritative signal.
    const res = httpsRedirect(
      req("https://slate.trypennie.app/book/411", { "cf-visitor": '{"scheme":"http"}' }),
    );
    expect(res).not.toBeNull();
    expect(res!.headers.get("location")).toBe("https://slate.trypennie.app/book/411");
  });

  it("passes through when CF-Visitor reports https, whatever the URL says", () => {
    expect(
      httpsRedirect(
        req("http://slate.trypennie.app/book/411", { "cf-visitor": '{"scheme":"https"}' }),
      ),
    ).toBeNull();
  });

  it("passes through on an unparseable CF-Visitor rather than guessing", () => {
    // Fail-safe direction (the one decision that matters here): an unreadable
    // signal must NOT redirect. Redirecting a request that is already secure
    // loops the browser forever, which is far worse than the status quo. So an
    // unknown scheme degrades to today's behavior, and the smoke canary keeps
    // warning that the redirect is not live.
    expect(
      httpsRedirect(req("https://slate.trypennie.app/", { "cf-visitor": "not-json" })),
    ).toBeNull();
    expect(
      httpsRedirect(req("https://slate.trypennie.app/", { "cf-visitor": "{}" })),
    ).toBeNull();
  });

  it("never redirects a request it cannot read at all", () => {
    // Same fail-safe, reached from the other side: no CF-Visitor and an https
    // URL is the overwhelmingly common healthy case and must be untouched.
    expect(httpsRedirect(req("https://slate.trypennie.app/api/cron/sync"))).toBeNull();
  });
});

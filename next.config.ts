import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { buildCommitFrom, deploymentIdFor } from "./src/lib/deployment-id";

// NEXT_PUBLIC_APP_URL is INLINED at build time into every booking webhook's
// manage_url / slateBookingLink and the Google invite manage link (env.ts
// appUrl()). It is not read at runtime, so a wrangler var can't rescue it — if a
// production build (CI or a manual `pnpm cf:deploy`) lacks it, the localhost
// fallback gets baked in and poisons every outbound link. Fail loudly instead.
// CI sets it in the build env and local dev supplies it via .env.local, so this
// only trips a bare deploy that forgot it.
if (process.env.NODE_ENV === "production") {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl || /localhost|127\.0\.0\.1/.test(appUrl)) {
    throw new Error(
      `NEXT_PUBLIC_APP_URL must be set to the public URL for a production build ` +
        `(got ${appUrl ? `"${appUrl}"` : "undefined"}). It is inlined into ` +
        `webhook + invite manage links; the localhost fallback would poison them.`,
    );
  }
}

// #1994: the build identity Next stamps into every page and every server action.
// Derived from the commit the deploy job has already stamped into
// `src/lib/build-info.ts`, read as TEXT so this config does not depend on module
// resolution into `src/` at build time, and HASHED because the value is sent to
// the browser and the commit is deliberately not public.
//
// AN UNSTAMPED BUILD IS NOT REFUSED HERE, and the first version of this did
// refuse one. The signal it used for "this is a real deploy" was a production
// build pointing at a non-localhost URL, which is also every local `pnpm
// cf:build`, because `.env.local` points at production too. It broke the
// pre-push gate on the first run.
//
// The risk it was reaching for is real (a deploy that skipped the stamp gives
// every build the SAME id, so nothing can tell a stale page from a current one
// while the setting reads as present) but it belongs where the deploy is
// defined, not here: `scripts/test-deploy-stamp-order.ts` asserts the deploy job
// stamps before it builds. A local build gets a stable local id, which is
// correct, because there is only one of them at a time.
const buildCommit = buildCommitFrom(
  readFileSync(join(import.meta.dirname, "src", "lib", "build-info.ts"), "utf8"),
);
const nextConfig: NextConfig = {
  // Changes on every deploy, so a page loaded from an earlier one is recognised
  // rather than failing with an unexplained 404 on its next save (#1994).
  deploymentId: deploymentIdFor(buildCommit),
  // Pin the project as the Turbopack root so an unrelated lockfile in a parent
  // directory isn't mistaken for the workspace root.
  turbopack: {
    root: import.meta.dirname,
  },
  // Baseline hardening on EVERY response. None of these restrict framing, so
  // serving them site-wide is safe for the embeddable booker (unlike the framing
  // headers, which stay middleware-only on /admin, /me, /login):
  //   - HSTS (#1024): the public booker collects name / email / phone, so a
  //     returning visitor's browser must auto-upgrade http->https before it sends
  //     anything. No `preload`, so this stays reversible. The first-visit
  //     http->https redirect is served by the Worker itself (worker/index.ts via
  //     src/lib/http/https-redirect.ts), NOT by Cloudflare config: the hostname is
  //     a Workers Custom Domain, which leaves zone Redirect Rules out of the path.
  //   - nosniff + Referrer-Policy (#1030): the booker, the manage-by-token pages,
  //     and every /api response used to carry none of the standard hardening
  //     headers (they were middleware-only on the staff surfaces). Serving them
  //     globally covers the PII-bearing public surfaces too.
  //
  // "Every response" means every response the Worker handles. A static file under
  // public/ reaches these headers only because wrangler.jsonc routes it through
  // the Worker first (`assets.run_worker_first`, #1203/#1204); an asset left off
  // that list is served by Cloudflare directly and ships bare.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          //   - noindex (#1756): nothing Slate serves belongs in a search index.
          //     It is an internal booking tool plus an embeddable widget, and the
          //     public booker at /book?xbc=<code> can create a REAL booking against
          //     a real agent: a real calendar invite and a real Regal webhook, on a
          //     three digit code that is trivial to guess once the host is known.
          //     Measured 2026-09-13: production answered 200 on /book?xbc=111 with
          //     no X-Robots-Tag and no noindex in the markup, and the robots.txt the
          //     domain serves (Cloudflare's injected content signals file, since this
          //     repo ships none) carries no Disallow at all. Nothing links to the
          //     host before the embed swap (#65), but a Workers Custom Domain is in
          //     the public certificate transparency logs, so "nothing links to it" is
          //     not the same as "nobody can find it".
          //
          //     `nofollow` is here as well as `noindex` so a crawler that does reach
          //     one page is not led from it into other bucket codes.
          //
          //     DO NOT pair this with a `Disallow` in robots.txt. A disallowed URL is
          //     never FETCHED, so the crawler never sees this header, and the URL can
          //     still be indexed from a link elsewhere. Allowing the crawl and serving
          //     noindex is what actually keeps a page out of search.
          //     `scripts/test-global-headers.ts` asserts both halves.
          //
          //     This does NOT close #1756, which asks for a database backed switch
          //     that refuses the public booking path outright and doubles as the
          //     cutover kill switch. It closes the one discovery path that does not
          //     require somebody deliberately going looking.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;

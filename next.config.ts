import type { NextConfig } from "next";

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

const nextConfig: NextConfig = {
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
        ],
      },
    ];
  },
};

export default nextConfig;

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
  // HSTS on EVERY response (#1024). The public booker collects name / email /
  // phone, so a returning visitor's browser must auto-upgrade http->https before
  // it sends anything. HSTS is transport-only and does not restrict framing, so
  // serving it site-wide is safe for the embeddable booker (unlike the framing
  // headers, which stay middleware-only on /admin, /me, /login). The first-visit
  // http->https redirect is a Cloudflare "Always Use HTTPS" zone setting, out of
  // code. No `preload`, so this stays reversible.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

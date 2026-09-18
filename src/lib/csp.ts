/**
 * The script Content Security Policy, shipped in REPORT ONLY mode first (#2565).
 *
 * Slate's only policy was `frame-ancestors 'none'` on the staff paths. There was
 * no `script-src` or `default-src` anywhere, including on the booker, which is the
 * surface that renders attendee supplied data. React escapes what it renders and
 * the inline scripts are our own theme boot, so there is no known injection today.
 * A script policy is the layer that still holds if one ever appears.
 *
 * Three things were MEASURED before any of this was written, because the previous
 * comment in `security-headers.ts` deferred the work on assumptions:
 *
 *   1. What the deployed booker actually serves (2026-09-18, live production):
 *      4 inline `<script>` tags, 13 external ones and EVERY external one
 *      same-origin. No inline styles and no inline event handlers. So the only
 *      thing standing between Slate and `script-src 'self'` is those 4 inline
 *      tags, which is what the nonce is for.
 *   2. Whether Next applies a nonce under a REPORT ONLY header. The Next docs
 *      describe the nonce being read from `Content-Security-Policy` and say
 *      nothing about the report only variant, which would have made this rollout
 *      pointless: every inline script would be reported on every page and the
 *      noise would bury any real finding. `next/dist/server/app-render/app-render.js`
 *      actually reads
 *      `headers['content-security-policy'] || headers['content-security-policy-report-only']`,
 *      so it does. That is why the middleware sets the report only header on the
 *      REQUEST as well as the response.
 *   3. That a nonce needs DYNAMIC rendering, since Next applies it while serving
 *      a request. Every route this covers is already dynamic.
 *
 * Enforcement is deliberately a later change, gated on reading real violations.
 * See the issue that follows #2565.
 */

import { THEME_PREFERENCES, themeBootScript } from "@/lib/theme/boot";

/** Where a violating browser posts its report. */
export const CSP_REPORT_PATH = "/api/csp-report";

/** The `report-to` group name, defined by the Reporting-Endpoints header. */
export const CSP_REPORT_GROUP = "csp";

export interface CspOptions {
  /** This request's nonce. Next applies it to its own inline scripts. */
  nonce: string;
  /**
   * `'sha256-...'` sources for the inline scripts Next does NOT nonce: Slate's
   * own theme boot scripts, written with `dangerouslySetInnerHTML` in the root
   * layout, the app header and the standalone theme.
   *
   * Hashes rather than a nonce, and the choice is load bearing. A nonce would
   * mean reading the request inside the layout, which forces DYNAMIC rendering
   * on every page the layout serves, for a script whose text never varies.
   * Measured on the dev server 2026-09-18: with the nonce alone, 9 of 11 inline
   * scripts on the booker carried it and these were the two that did not, so
   * they would be reported on every page and the noise would bury any real
   * finding.
   */
  scriptHashes?: string[];
  /**
   * True for surfaces that MUST stay embeddable on a partner page. Those get no
   * `frame-ancestors` at all: the whole product is an embed, and a policy that
   * refused framing would black the booker out on somebody else's site, where the
   * only error is in a console we never see.
   */
  frameable: boolean;
}

export function buildContentSecurityPolicy({ nonce, frameable, scriptHashes = [] }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    // 'strict-dynamic' lets the nonced bootstrap load the page's own chunks
    // without naming each one, which is what the 13 same-origin scripts measured
    // above need. 'wasm-unsafe-eval' is for the confirmation mark's player
    // (#2560), which compiles WebAssembly; it permits wasm and nothing else, and
    // is NOT 'unsafe-eval', which would permit arbitrary string evaluation.
    ["script-src 'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'", ...scriptHashes].join(" "),
    // Inline styles stay allowed: the measurement found none in the markup, but
    // React and the design system set style attributes at runtime, and a style
    // violation is not the attack this policy is about. Tightening it is its own
    // change with its own evidence.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(frameable ? [] : ["frame-ancestors 'none'"]),
    // BOTH report directives on purpose. `report-uri` is deprecated and is still
    // the only one Safari and older Chrome send to; `report-to` is its
    // replacement. Shipping one of them means a whole browser family reports
    // nothing, and a browser that reports nothing looks exactly like a browser
    // with nothing to report.
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ];
  return directives.join("; ");
}

/** The companion header that gives `report-to` its destination. */
export function reportingEndpointsHeader(): string {
  return `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;
}

/**
 * A fresh, unguessable nonce. Uses the Web Crypto API, which the Edge runtime the
 * middleware runs on provides.
 */
export function cspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** How much of a reported URL is worth keeping in a log line. */
const MAX_URI = 300;

/**
 * Strip a booking manage token out of a reported URL.
 *
 * A violation report carries `document-uri`, `referrer` and `blocked-uri`, and on
 * the manage page the URL IS the credential: whoever holds that token can cancel
 * or reschedule the booking with no other authentication. #2564 took it out of the
 * warehouse; it must not walk into the Worker logs through this door instead.
 */
export function redactReportUri(value: string | undefined | null): string {
  if (value === undefined || value === null) return "(none)";
  if (typeof value !== "string") return "(unreadable)";
  const redacted = value.replace(/(\/booking\/manage\/)[^/?#\s]+/g, "$1[redacted]");
  return redacted.length > MAX_URI ? `${redacted.slice(0, MAX_URI - 3)}...` : redacted;
}

export interface ViolationSummary {
  directive: string;
  document: string;
  blocked: string;
  referrer: string;
}

/** What a report says, in one shape, with nothing sensitive left in it. */
export function summariseViolation(payload: unknown): ViolationSummary {
  const body = readReportBody(payload);
  if (!body) {
    // Never guess a directive for a body we could not read: a made up one sends
    // somebody to fix something no browser reported.
    return {
      directive: "(unreadable)",
      document: "(none)",
      blocked: "(none)",
      referrer: "(none)",
    };
  }
  return {
    directive: body.directive ?? "(unreadable)",
    document: redactReportUri(body.document),
    blocked: redactReportUri(body.blocked),
    referrer: redactReportUri(body.referrer),
  };
}

interface RawReport {
  directive?: string;
  document?: string;
  blocked?: string;
  referrer?: string;
}

/**
 * Read either report shape. The legacy `report-uri` body is
 * `{"csp-report": {"document-uri": ..., "violated-directive": ...}}`; the modern
 * Reporting API body is `{"body": {"documentURL": ..., "effectiveDirective": ...}}`,
 * and a browser may post an ARRAY of those. Reading one shape only would drop
 * every report from half the browsers while looking like a working endpoint.
 */
function readReportBody(payload: unknown): RawReport | null {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!first || typeof first !== "object") return null;
  const obj = first as Record<string, unknown>;

  const legacy = obj["csp-report"];
  if (legacy && typeof legacy === "object") {
    const l = legacy as Record<string, unknown>;
    return {
      directive: str(l["violated-directive"]) ?? str(l["effective-directive"]),
      document: str(l["document-uri"]),
      blocked: str(l["blocked-uri"]),
      referrer: str(l["referrer"]),
    };
  }

  const modern = obj.body;
  if (modern && typeof modern === "object") {
    const m = modern as Record<string, unknown>;
    return {
      directive: str(m.effectiveDirective) ?? str(m.violatedDirective),
      document: str(m.documentURL),
      blocked: str(m.blockedURL),
      referrer: str(m.referrer),
    };
  }
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}


/**
 * Every inline script text Slate's own theme boot rule can emit.
 *
 * DERIVED from the preference vocabulary rather than listed, so a fourth
 * preference cannot ship a script the policy has never heard of (L41, L96). The
 * four live call sites are the root layout (`kind: "cookie"`), the standalone
 * theme (light and dark) and the app header (the signed in preference, with
 * `remember`), and `scripts/test-...` plus the vitest suite hold this set against
 * what those components actually render.
 */
export function themeBootScriptTexts(): string[] {
  const texts = [themeBootScript({ kind: "cookie" })];
  for (const preference of THEME_PREFERENCES) {
    for (const remember of [false, true]) {
      texts.push(themeBootScript({ kind: "preference", preference, remember }));
    }
  }
  return [...new Set(texts)];
}

let hashCache: Promise<string[]> | null = null;

/**
 * The `'sha256-...'` sources for those scripts.
 *
 * Computed once per isolate: the set is fixed at build time, and hashing seven
 * short strings on every request would be paid on the booker's hot path for an
 * answer that never changes. `crypto.subtle` is what the Edge runtime the
 * middleware runs on provides.
 */
export function themeScriptHashes(): Promise<string[]> {
  hashCache ??= Promise.all(
    themeBootScriptTexts().map(async (text) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      let binary = "";
      for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
      return `'sha256-${btoa(binary)}'`;
    }),
  );
  return hashCache;
}

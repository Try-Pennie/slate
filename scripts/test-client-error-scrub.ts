// Pure logic for the client error beacon (#1368): scrubbing a lead's contact
// details out of a browser error before it leaves the page, and bounding what a
// public endpoint will accept. Run:
//   node --experimental-strip-types scripts/test-client-error-scrub.ts
//
// This is the module that decides whether a monitoring feature becomes a PII
// leak. The booker form holds a name, an email and a phone number, and any of
// them can end up inside a thrown message or a stack frame. What survives this
// function goes to Slack and sits in Cloudflare's logs for 7 days.
//
// The honest limit, stated here because it must not be discovered later: this
// catches SHAPES (an address, a phone, a long digit run). A person's NAME has no
// shape, so it cannot be caught this way. See the module header for what that
// means and why the field caps matter as a second line.
import {
  scrubContactData,
  stripUrlQueries,
  withoutUrlQuery,
  isHarmlessBrowserMessage,
  isOpaqueScriptError,
  whereClientErrorCameFrom,
  normalizeClientError,
  clientErrorSignature,
  clientErrorSurface,
  CLIENT_ERROR_SURFACES,
  FIELD_LIMITS,
} from "../src/lib/api/client-error-scrub.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanPageSurfaces } from "./lib/scan-page-surfaces.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- scrubContactData: email ---
{
  eq(
    scrubContactData("Cannot submit for jane.doe+lead@example.co.uk"),
    "Cannot submit for [email]",
    "a plain email address is replaced",
  );
  eq(
    scrubContactData("emails: a@b.com and c.d@e.org failed"),
    "emails: [email] and [email] failed",
    "every address in the string is replaced, not just the first",
  );
  eq(
    scrubContactData("at Object.submit (app.js:12:9)"),
    "at Object.submit (app.js:12:9)",
    "an ordinary stack frame is left alone",
  );
}

// --- scrubContactData: phone numbers, in the shapes a US lead actually types ---
{
  for (const [raw, why] of [
    ["(555) 123-4567", "a bracketed US number"],
    ["555-123-4567", "a dashed US number"],
    ["555.123.4567", "a dotted US number"],
    ["5551234567", "a bare 10 digit number"],
    ["+1 555 123 4567", "an international format"],
    ["+15551234567", "an E.164 number"],
  ] as const) {
    const out = scrubContactData(`phone ${raw} is invalid`);
    assert(!out.includes("1234567"), `${why} is scrubbed (${raw} -> ${out})`);
    assert(out.includes("[phone]"), `${why} leaves a marker so the reader knows something was removed`);
  }
}
{
  // Stack frames are full of small numbers. Scrubbing those would destroy the
  // only diagnostic value the beacon has.
  const frame = "at t (/_next/static/chunks/main-4f2a.js:1:20345)";
  eq(scrubContactData(frame), frame, "line and column numbers in a stack survive");
  eq(
    scrubContactData("HTTP 429 after 3 retries in 1200ms"),
    "HTTP 429 after 3 retries in 1200ms",
    "ordinary short numbers in a message survive",
  );
}
// --- the shape a BOOKING error is actually made of ---------------------------
{
  // Every error the booker can throw mentions a slot time, so a filter that eats
  // dates strips the diagnosis out of exactly the messages this exists to catch.
  // A date is not contact data and must survive intact.
  for (const [text, why] of [
    ["Booking failed for 2026-08-11T14:30:00.000Z in America/New_York", "an ISO timestamp in a message"],
    ["GET /api/availability/2026-08-11T14:00:00.000Z 500", "an ISO timestamp in a URL path"],
    ["no slot at 2026-08-11 14:30", "a plain date and time"],
    ["window 2026-08-11 to 2026-08-15 empty", "a date range"],
  ] as const) {
    eq(scrubContactData(text), text, `${why} survives untouched`);
  }
}
// --- #3046: a query string is removed whole, path kept ------------------------
{
  // On /book the page's query string carries the lead's name, email and phone,
  // PERCENT ENCODED, so neither the email nor the phone shape can match it, and a
  // name never could. The browser puts that address into `ErrorEvent.filename` and
  // every stack frame. Until #3046 a query string survived this function, and one
  // reached Slack. A query in a URL is now dropped whole (this reverses the old
  // "an ISO timestamp in a URL survives" case, which kept a query intact).
  const url =
    "https://slate.trypennie.app/book?name=Dana%20Lee&email=dana%40example.com&phone=%28215%29%20555-0100";
  eq(stripUrlQueries(url), "https://slate.trypennie.app/book", "an encoded query string is dropped, the path kept");
  eq(
    scrubContactData(`    at submit (${url}:12:3)`),
    "    at submit (https://slate.trypennie.app/book:12:3)",
    "a stack frame keeps its line and column when its query is dropped",
  );
  eq(
    scrubContactData(`failed at ${url}#confirm and again at /book/411?email=dana%40example.com`),
    "failed at https://slate.trypennie.app/book and again at /book/411",
    "every URL in the text loses its query and fragment, absolute or a path",
  );
  eq(
    scrubContactData("GET /api/availability?bucket=411&from=2026-08-11T14:00:00.000Z 500"),
    "GET /api/availability 500",
    "a query string is dropped even when it holds nothing identifying",
  );
  // CONTROLS: a `?` or `#` that is not part of a URL is ordinary text.
  eq(scrubContactData("Unexpected token '#'"), "Unexpected token '#'", "a bare # in a message survives");
  eq(scrubContactData("is this valid? no"), "is this valid? no", "a question mark in a sentence survives");
  // A field that IS one address is cut at the first `?` or `#`, so a DECODED
  // query holding a space cannot leave half a name behind.
  eq(withoutUrlQuery("/book?name=Dana Lee"), "/book", "a decoded query with a space is cut whole");
  eq(withoutUrlQuery("/book"), "/book", "an address with no query is unchanged");
  const report = normalizeClientError({
    kind: "error",
    message: "boom",
    page: "/book?name=Dana Lee&email=dana%40example.com",
    source: `${url}#confirm`,
  });
  eq(report?.page, "/book", "the server cuts the query from the page");
  eq(report?.source, "https://slate.trypennie.app/book", "the server cuts the query from the source");
}
// --- #3046: the harmless browser warnings are matched exactly -----------------
{
  assert(
    isHarmlessBrowserMessage("ResizeObserver loop completed with undelivered notifications."),
    "the ResizeObserver loop warning is known harmless",
  );
  assert(isHarmlessBrowserMessage("ResizeObserver loop limit exceeded"), "the older wording is known harmless");
  assert(
    !isHarmlessBrowserMessage("ResizeObserver loop limit exceeded while saving"),
    "a message that merely mentions it is not",
  );
  assert(!isHarmlessBrowserMessage("Cannot read properties of undefined"), "an ordinary error is not");
}
{
  // A minified stack is the other half of the diagnosis. It is dense with
  // numbers, dots and dashes, which is exactly what a loose phone pattern eats.
  const stack =
    "TypeError: Cannot read properties of undefined (reading 'slots')\n" +
    "    at u (https://slate.trypennie.app/_next/static/chunks/main-app-9f3c21.js:1:203458)\n" +
    "    at Object.rF (https://slate.trypennie.app/_next/static/chunks/4bd1b696-c1a2f9.js:1:87234)";
  eq(scrubContactData(stack), stack, "a real minified stack trace survives untouched");
}

{
  // Anything long and numeric is treated as identifying whether or not we can
  // name it: a card number, an SSN, an account number.
  const out = scrubContactData("value 4111111111111111 rejected");
  assert(!out.includes("4111111111111111"), "a long digit run is removed even though it is not a phone");
}
{
  eq(scrubContactData(""), "", "an empty string scrubs to an empty string");
}

// --- normalizeClientError: a public endpoint accepts nothing unbounded --------
{
  const out = normalizeClientError({
    kind: "error",
    message: "x".repeat(5000),
    stack: "y".repeat(50_000),
    source: "z".repeat(5000),
    page: "p".repeat(5000),
    bucketCode: "4".repeat(500),
  });
  assert(out !== null, "an oversized but well formed report is accepted, not rejected");
  assert(
    (out?.message.length ?? 0) <= FIELD_LIMITS.message,
    "the message is capped rather than passed through at any length",
  );
  assert((out?.stack?.length ?? 0) <= FIELD_LIMITS.stack, "the stack is capped");
  assert((out?.source?.length ?? 0) <= FIELD_LIMITS.source, "the source is capped");
  assert((out?.page.length ?? 0) <= FIELD_LIMITS.page, "the page is capped");
  assert((out?.bucketCode?.length ?? 0) <= FIELD_LIMITS.bucketCode, "the bucket code is capped");
}
{
  const out = normalizeClientError({
    kind: "unhandledrejection",
    message: "Failed for jane@example.com on 555-123-4567",
    stack: "at submit (app.js:1:1) with jane@example.com",
    page: "/book/411",
  });
  assert(!out?.message.includes("jane@example.com"), "the message is scrubbed on the way in as well");
  assert(!out?.stack?.includes("jane@example.com"), "the stack is scrubbed too, not just the message");
}
{
  eq(normalizeClientError(null), null, "a null body is refused");
  eq(normalizeClientError({ kind: "error" }), null, "a report with no message is refused");
  eq(normalizeClientError({ kind: "error", message: "   " }), null, "a blank message is refused");
  eq(
    normalizeClientError({ kind: "nonsense", message: "boom", page: "/book" }),
    null,
    "an unknown kind is refused rather than recorded as an unknown category",
  );
  eq(normalizeClientError({ kind: "error", message: "boom" }), null, "a report with no page is refused");
}
{
  const out = normalizeClientError({
    kind: "error",
    message: "boom",
    page: "/book/411",
    line: "12",
    col: 9.5,
  });
  eq(out?.line, null, "a non numeric line is dropped rather than coerced into a lie");
  eq(out?.col, null, "a fractional column is dropped");
}
{
  const out = normalizeClientError({ kind: "error", message: "boom", page: "/book/411", line: 12, col: 9 });
  eq(out?.line, 12, "a real line number survives");
  eq(out?.col, 9, "a real column survives");
}

// --- clientErrorSignature: what the ALERT is keyed on -----------------------
{
  // The key has to be BOUNDED. Keying on the raw message would let anyone with a
  // browser mint unlimited alert_state rows, and would defeat the throttle that
  // stops one broken deploy becoming thousands of messages.
  const a = clientErrorSignature({ page: "/book/411" });
  const b = clientErrorSignature({ page: "/book/412" });
  eq(a, b, "the key does not vary per bucket, so a broken bundle is ONE alert and not sixty");
  eq(a, "client_error:book", "a real route keeps its own key");
  assert(a.startsWith("client_error:"), "the key is namespaced, so it cannot collide with a server context");
  const admin = clientErrorSignature({ page: "/admin/bookings" });
  assert(admin !== a, "genuinely different surfaces stay distinguishable");
  eq(clientErrorSignature({ page: "/" }), "client_error:root", "the landing page is its own surface");
  assert(
    clientErrorSignature({ page: "/../../etc/passwd\n " }).length < 60,
    "a hostile page value cannot produce an unbounded or newline carrying key",
  );
}

// --- #2755: the suffix is drawn from the app's own routes, never the caller ---
{
  // The page path is text anybody can post. A suffix that is merely sanitised and
  // capped is still a new alert key, a new throttle bucket and a new alert_state
  // row per invented path, so the per key cooldown bounds nothing in total.
  eq(clientErrorSignature({ page: "/wp-login.php" }), "client_error:other", "a path outside the route list lands in other");
  eq(
    clientErrorSignature({ page: "/aaaa" }),
    clientErrorSignature({ page: "/bbbb/cccc" }),
    "two invented paths share one key",
  );
  eq(
    clientErrorSignature({ page: "/nope", kind: "boundary" }),
    "boundary_error:other",
    "a boundary catch on an invented path lands in the boundary family's other",
  );
  eq(
    clientErrorSignature({ page: "/admin/tiers", kind: "boundary" }),
    "boundary_error:admin",
    "a boundary catch on a real route keeps its own key",
  );
  // Next matches segments case sensitively, so /BOOK is a 404 and not the booker.
  eq(clientErrorSignature({ page: "/BOOK/411" }), "client_error:other", "a near miss spelling is not the route");
  // A query string or fragment is not part of the segment.
  eq(clientErrorSignature({ page: "/book?bucket=411" }), "client_error:book", "a query string does not change the surface");
  eq(clientErrorSignature({ page: "/me#time-off" }), "client_error:me", "a fragment does not change the surface");
  // The pages report a path; anything else is somebody else's text.
  eq(
    clientErrorSignature({ page: "https://slate.trypennie.app/admin/tiers" }),
    "client_error:other",
    "an absolute URL is not a path and is not guessed at",
  );

  // The whole key space is finite and known: every surface, plus other, per family.
  const keys = new Set<string>();
  for (let i = 0; i < 500; i++) {
    for (const kind of ["error", "boundary"] as const) {
      keys.add(clientErrorSignature({ page: `/${i.toString(36)}x/${i}`, kind }));
    }
  }
  eq([...keys].sort(), ["boundary_error:other", "client_error:other"], "five hundred invented paths mint exactly two keys");
  assert(
    CLIENT_ERROR_SURFACES.every((s) => /^[a-z0-9_-]+$/.test(s)),
    "every surface is a plain segment, so a key can never carry caller text",
  );
  assert(
    !(CLIENT_ERROR_SURFACES as readonly string[]).includes("other"),
    "no real surface is called other, so the bucket is unambiguous",
  );
  eq(clientErrorSurface("/book/411"), "book", "the surface is readable on its own for a real route");
  eq(clientErrorSurface("/zz"), "other", "the surface is readable on its own for an invented one");
}

// --- #2755: the list is held against the REAL route tree, both directions ----
{
  const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app");
  const scan = scanPageSurfaces(appDir);
  eq(scan.refusals, [], "the route tree has no dynamic top level segment the fixed list cannot express");
  assert(scan.surfaces.length > 0, "the walk found pages at all, so an empty match cannot read as agreement");
  eq(
    [...CLIENT_ERROR_SURFACES].sort(),
    scan.surfaces,
    "CLIENT_ERROR_SURFACES names exactly the top level segments src/app serves a page under",
  );
}
{
  // Positive control on a fixture tree: the walk must SEE a new page, look
  // through a route group, skip a private folder, an api only tree and a test
  // file, and refuse a dynamic top level segment. Without this a walk that
  // listed nothing new would agree with a stale constant for ever (L1).
  const root = mkdtempSync(join(tmpdir(), "slate-2755-"));
  const put = (rel: string) => {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), "export default function P() { return null; }\n");
  };
  put("page.tsx");
  put("book/page.tsx");
  put("reports/deep/[id]/page.tsx");
  put("(marketing)/pricing/page.tsx");
  put("_internal/page.tsx");
  put("api/thing/route.ts");
  put("fonts/x.woff2");
  put("drafts/page.test.tsx");
  const found = scanPageSurfaces(root);
  eq(
    found.surfaces,
    ["book", "pricing", "reports", "root"],
    "the walk sees new pages, looks through groups, skips private, api and tests",
  );
  eq(found.refusals, [], "a fixture with no dynamic top level segment is not refused");
  put("[slug]/page.tsx");
  eq(scanPageSurfaces(root).refusals.length, 1, "a dynamic top level segment is refused rather than listed");
  rmSync(root, { recursive: true, force: true });
}

// --- whereClientErrorCameFrom: judged by the locations a report names ---
// A browser extension's script runs inside Slate's page, so its uncaught errors
// reach the beacon as if they were Slate's (L477). Measured 2026-10-29 12:14 ET:
// "Failed to connect to MetaMask" paged from /book with one stack frame, in
// MetaMask's own `chrome-extension://` script. The judgement reads WHERE the
// error came from (the source and every stack frame), never the message, so the
// next extension needs no new string. Fixtures go through `normalizeClientError`,
// which is what the route holds.
{
  const report = (over: Record<string, unknown> = {}) =>
    normalizeClientError({ kind: "unhandledrejection", message: "Failed to connect to MetaMask", page: "/book", ...over })!;
  const METAMASK_STACK =
    "i: Failed to connect to MetaMask\n" +
    "    at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:12:4822)";
  const SLATE_FRAME = "    at submit (https://slate.trypennie.app/_next/static/chunks/0booker.js:1:20345)";

  eq(
    whereClientErrorCameFrom(report({ stack: METAMASK_STACK })),
    { from: "extension", scheme: "chrome-extension" },
    "the measured MetaMask report: its only frame is the extension's own script",
  );
  eq(
    whereClientErrorCameFrom(
      report({ kind: "error", message: "boom", source: "moz-extension://4f1c2b/content.js", line: 3, col: 9 }),
    ),
    { from: "extension", scheme: "moz-extension" },
    "a window error whose file is a Firefox extension's",
  );
  eq(
    whereClientErrorCameFrom(report({ stack: "connect@safari-web-extension://ABCD-EF/inpage.js:1:2\nr@safari-web-extension://ABCD-EF/inpage.js:3:4" })),
    { from: "extension", scheme: "safari-web-extension" },
    "Safari's frame shape (fn@url:line:col), every frame an extension's",
  );
  eq(
    whereClientErrorCameFrom(
      report({ stack: `${METAMASK_STACK}\n    at new Promise (<anonymous>)\n    at Array.forEach (native)` }),
    ),
    { from: "extension", scheme: "chrome-extension" },
    "an engine's own frames (<anonymous>, native) name no script, so they neither excuse nor accuse",
  );

  // CONTROLS: one frame anywhere but an extension, and the report is not excused.
  eq(
    whereClientErrorCameFrom(report({ stack: `${METAMASK_STACK}\n${SLATE_FRAME}` })),
    { from: "other_location" },
    "an extension frame AND a Slate bundle frame: Slate's code is on the stack, so it is not the extension's alone",
  );
  eq(
    whereClientErrorCameFrom(report({ stack: `TypeError: x is undefined\n${SLATE_FRAME}` })),
    { from: "other_location" },
    "a Slate bundle frame alone",
  );
  eq(
    whereClientErrorCameFrom(report({ stack: "at submit (main.js:1:20)" })),
    { from: "other_location" },
    "a frame with no scheme at all is still a location, and not an extension's",
  );
  eq(
    whereClientErrorCameFrom(
      report({ kind: "error", source: "chrome-extension://abc/x.js", stack: `Error: x\n${SLATE_FRAME}` }),
    ),
    { from: "other_location" },
    "an extension file but a Slate frame in the stack",
  );
  eq(
    whereClientErrorCameFrom(report({ stack: "Error: x\n    at f (https://chrome-extension.example.com/x.js:1:2)" })),
    { from: "other_location" },
    "an ordinary site whose HOST merely contains the word is not an extension",
  );
  eq(
    whereClientErrorCameFrom(report({ kind: "error", source: "https://slate.trypennie.app/book", line: 1, col: 2 })),
    { from: "other_location" },
    "a Slate page as the file",
  );

  // Nothing named at all: no file and no frame. Not excused as an extension's,
  // because nothing says it was; the route decides what that costs.
  eq(whereClientErrorCameFrom(report()), { from: "no_location" }, "no stack and no file names nowhere");
  eq(
    whereClientErrorCameFrom(report({ message: "Failed to fetch", stack: "TypeError: Failed to fetch" })),
    { from: "no_location" },
    "a stack that is only its message line names nowhere",
  );
  eq(
    whereClientErrorCameFrom(report({ message: "chrome-extension://abc/x.js failed" })),
    { from: "no_location" },
    "the MESSAGE is never read for a location: free text could claim anything",
  );
}

// --- isOpaqueScriptError (#3323) ---
// The browser's sanitised report of an error thrown by a script from another
// origin: the fixed text "Script error.", no file, line and column 0, no error
// object. Judged on the NORMALISED report, which is what the route holds, so the
// fixtures go through `normalizeClientError` exactly as a posted body does.
{
  const opaque = (over: Record<string, unknown> = {}) =>
    normalizeClientError({ kind: "error", message: "Script error.", page: "/book", line: 0, col: 0, ...over })!;

  assert(isOpaqueScriptError(opaque()), "the exact sanitised report, line and column 0, is opaque");
  assert(
    isOpaqueScriptError(opaque({ line: undefined, col: undefined })),
    "an opaque report with no position at all is opaque",
  );
  assert(
    isOpaqueScriptError(opaque({ source: "", stack: null })),
    "an empty file name (what the browser sends) is no source",
  );
  assert(isOpaqueScriptError(opaque({ message: "  Script error.  " })), "surrounding whitespace is not detail");
  assert(isOpaqueScriptError(opaque({ message: "Script error" })), "the wording without a full stop is opaque too");

  // CONTROLS: any real detail means somebody can act on it, so it is NOT opaque.
  assert(
    !isOpaqueScriptError(opaque({ stack: "Error: Script error.\n    at x (https://slate.trypennie.app/a.js:1:2)" })),
    "Script error. WITH a stack is not opaque",
  );
  assert(
    !isOpaqueScriptError(opaque({ source: "https://slate.trypennie.app/_next/static/chunks/a.js" })),
    "Script error. WITH a source is not opaque",
  );
  assert(!isOpaqueScriptError(opaque({ line: 12 })), "Script error. with a real line is not opaque");
  assert(!isOpaqueScriptError(opaque({ col: 3 })), "Script error. with a real column is not opaque");
  assert(
    !isOpaqueScriptError(opaque({ message: "Script error. while saving" })),
    "a message that merely starts with the phrase is not opaque",
  );
  assert(!isOpaqueScriptError(opaque({ message: "script error." })), "matched exactly, case included");
  assert(
    !isOpaqueScriptError(opaque({ kind: "unhandledrejection" })),
    "only a window error event is sanitised this way, so a rejection is not opaque",
  );
  assert(!isOpaqueScriptError(opaque({ kind: "boundary" })), "a boundary catch is never opaque");
  assert(
    !isOpaqueScriptError(opaque({ message: "Cannot read properties of undefined" })),
    "an ordinary error is not opaque",
  );
}

finish();

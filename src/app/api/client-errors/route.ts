import { NextResponse, type NextRequest } from "next/server";
import { reportInternalError } from "@/lib/api/errors";
import { log } from "@/lib/log";
import { sendThrottledAlert, sendThrottledInfo } from "@/lib/notify/dispatch";
import {
  boundaryCatchAlert,
  embedOriginMismatchAlert,
  opaqueScriptErrorBurstAlert,
  testBucketClientErrorInfo,
  unattributedRejectionBurstAlert,
  unrecognisedPageReports,
} from "@/lib/notify/misc-alert-copy";
import { parseOriginMismatchMessage } from "@/lib/embed/parent-origin";
import { resolveTestTraffic } from "@/lib/monitor/test-traffic";
import { shortErrorReason } from "@/lib/notify/error-text";
import {
  countBoundaryCatch,
  countOpaqueScriptError,
  countUnattributedRejection,
  countUnrecognisedPageReport,
  BOUNDARY_WINDOW_MS,
  OPAQUE_BURST_THRESHOLD,
  OPAQUE_BURST_WINDOW_MS,
  UNATTRIBUTED_REJECTION_BURST_THRESHOLD,
  UNATTRIBUTED_REJECTION_WINDOW_MS,
} from "@/lib/api/boundary-count";

/**
 * How long one page stays quiet after its boundary has been reported (#1974).
 *
 * Long enough that a page broken for everybody pages ONCE rather than once per
 * person who opens it. Short enough that a second, different break the next hour
 * is not swallowed by the first.
 *
 * The cooldown answers "how OFTEN does one page speak". It cannot answer "is
 * this worth speaking about at all", because the first catch always passes it:
 * that is what `countBoundaryCatch` decides, and the two are deliberately equal
 * in length so a break lasting past the window pages again on the same cadence.
 */
const BOUNDARY_ERROR_COOLDOWN_MS = BOUNDARY_WINDOW_MS;

/**
 * How often a misconfigured embedding host is mentioned in Slack (#2641). Every
 * lead on that host reports it, so once a day is the whole signal; every report is
 * still logged with its pair.
 */
const ORIGIN_MISMATCH_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * How often a TEST bucket's client errors are mentioned in Slack (#2660). A
 * partner's staging page is the population most likely to throw, and its errors
 * are theirs to fix, so once a day is the whole signal; every report is still
 * logged in full.
 */
const TEST_BUCKET_ERROR_COOLDOWN_MS = 24 * 60 * 60_000;
import { allowRequest, clientIp, CLIENT_ERROR_RATE_RULES } from "@/lib/rate-limit";
import { CLIENT_ERROR_ADDRESS_POLICY } from "@/lib/rate-limit-core";
import {
  normalizeClientError,
  clientErrorSignature,
  clientErrorSurface,
  isHarmlessBrowserMessage,
  isOpaqueScriptError,
  whereClientErrorCameFrom,
} from "@/lib/api/client-error-scrub";
import { readJsonCapped, PUBLIC_JSON_MAX_BYTES } from "@/lib/http/read-json-capped";
import { loggedUserAgent } from "@/lib/http/user-agent";

export const dynamic = "force-dynamic";

/**
 * The client error beacon (#1368).
 *
 * A broken client bundle loses bookings SILENTLY. Every other detector Slate has
 * is downstream of a request the browser managed to send: the booking failure
 * rate (#1313) counts attempts that REACHED the server, so a bundle that throws
 * before submit produces no attempt at all and the share it measures stays
 * perfectly healthy while nobody can book. The smoke canary exercises the
 * booking API, not the bundle. This is the one failure that removes all the
 * evidence of itself, which is why it needs its own channel.
 *
 * WHO CAN CALL THIS: anyone. It is reachable by whoever can load the booker,
 * which is the whole internet, and there is no honest way around that (a page
 * that is failing to run its own JavaScript cannot be relied on to authenticate).
 * WHAT DATA IT CAN TOUCH: nothing. It performs no read and no write of any
 * customer, agent or org record. Its entire effect is a log line and a throttled
 * alert.
 *
 * Given that, three deliberate refusals:
 *
 *  - It FAILS CLOSED on the rate limiter, unlike the booking paths which fail
 *    open. There, a limiter hiccup blocking a real booking is the worse outcome.
 *    Here it is the reverse: dropping a beacon report costs a log line, while
 *    letting an unmetered public path to Slack stay open costs the pager.
 *  - It returns 204 with NO BODY, ever, on every path including refusal. A
 *    response that varied would make it an oracle for what the server accepts.
 *  - It accepts nothing unbounded and re-scrubs contact data server side, since
 *    the page having scrubbed already says nothing about what a forged or stale
 *    client sends.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // 204 on every path: refusal and success are indistinguishable from outside.
  const done = () => new NextResponse(null, { status: 204 });

  // Fail CLOSED: a limiter that cannot vouch for this caller means the report is
  // dropped, not forwarded. Everything below this line can cause a Slack message.
  // #1557: and fails closed on a caller it cannot IDENTIFY for the same reason. The policy
  // says so once, next to the ceiling, rather than being re-decided here.
  const allowed = await allowRequest(
    { kind: "address", ip: clientIp(req.headers), policy: CLIENT_ERROR_ADDRESS_POLICY },
    CLIENT_ERROR_RATE_RULES,
  ).catch(() => false);
  if (!allowed) return done();

  // #3135: read under a byte cap. An oversized report is dropped like any other
  // unreadable one, on the same 204, so refusal and success still look alike.
  const read = await readJsonCapped(req, PUBLIC_JSON_MAX_BYTES);
  if (read.tooLarge) return done();
  const body = read.value;
  const report = normalizeClientError(body);
  if (!report) return done();

  // #2641: not an error, and never worded as one (L11). The pair is REBUILT from
  // what parses as two origins, and anything else is dropped, because this endpoint
  // is public and whatever it forwards reaches Slack. One fixed key, so a stranger
  // cannot mint a throttle row per forged pair.
  if (report.kind === "origin_mismatch") {
    const pair = parseOriginMismatchMessage(report.message);
    if (!pair) {
      // Said, never silent: a report the parser refuses is either forged or a
      // format this route no longer reads, and the second is a Slate fault. The
      // posted text is never logged, because anybody can post it.
      log.warn("client-errors", { msg: "unreadable origin mismatch report", page: report.page });
      return done();
    }
    log.warn("client-errors", {
      msg: "embed origin mismatch",
      declared: pair.declared,
      framed_by: pair.framedBy,
      page: report.page,
    });
    // alert-key: embed_origin_mismatch
    await sendThrottledInfo(
      "embed_origin_mismatch",
      ORIGIN_MISMATCH_COOLDOWN_MS,
      embedOriginMismatchAlert(pair.declared, pair.framedBy),
    ).catch((alertErr: unknown) => {
      log.error("client-errors", { msg: "origin mismatch info failed" }, alertErr);
    });
    return done();
  }

  // #3046: a known harmless browser warning (the ResizeObserver loop ones) is
  // logged at info and never pages. Nothing failed for the lead, and a page about
  // it teaches the reader to skip the channel (L36). Matched exactly, so an error
  // that merely mentions one still takes the path below.
  if (isHarmlessBrowserMessage(report.message)) {
    log.info("client-errors", {
      msg: "harmless browser warning",
      kind: report.kind,
      page: report.page,
      warning: report.message,
      source: report.source,
    });
    return done();
  }

  // The alert carries a short, bounded reason; the full report goes to the log,
  // which Cloudflare keeps complete (#1133: the alert is read on a phone, the
  // detail belongs where there is room for it).
  const where = [report.source, report.line, report.col].filter((p) => p !== null).join(":");
  const err = new Error(
    `${report.kind} on ${report.page}: ${report.message}${where ? ` (${where})` : ""}`,
  );
  err.stack = report.stack ?? undefined;

  // #2660: an error on a TEST bucket is a partner's staging page throwing, which
  // is theirs to fix and never a customer who could not book. Resolved the way
  // the outcome tally resolves it, off `buckets.is_test` on the server (a caller
  // settable marker would let anybody mute a real wave), and a marker that
  // cannot be read counts as REAL, so the pager is never muted by a failed read.
  // The full report still goes to the log; Slack gets one whisper a day.
  if (report.bucketCode && (await resolveTestTraffic({ by: "bucket", code: report.bucketCode }))) {
    log.warn("client-errors", { msg: "client error on a test bucket", page: report.page, bucket: report.bucketCode }, err);
    // alert-key: client_error_test_bucket
    await sendThrottledInfo(
      "client_error_test_bucket",
      TEST_BUCKET_ERROR_COOLDOWN_MS,
      testBucketClientErrorInfo(report.page, report.bucketCode),
    ).catch((alertErr: unknown) => {
      log.error("client-errors", { msg: "test bucket info failed" }, alertErr);
    });
    return done();
  }

  // #3323: an OPAQUE cross origin script error ("Script error." with no source, no
  // position and no stack) is the browser hiding an error from a script another site
  // put on the page. One of them cannot be acted on, so it is logged and counted and
  // never pages; only a burst across several addresses does, because that can mean
  // the page is failing for a whole group of leads.
  //
  // Classified HERE rather than in the beacon: a forged report, or a lead still on an
  // older bundle, reaches this route whatever the page does, so the route is the one
  // place that sees every report. The beacon keeps sending these, because the burst
  // can only be counted if they arrive. Judged after the test bucket check, so a
  // partner's staging page never counts toward a page.
  if (isOpaqueScriptError(report)) {
    const signature = clientErrorSignature(report);
    const seen = await countOpaqueScriptError(signature, clientIp(req.headers));
    // The line every opaque report leaves, paging or not. The user agent is what
    // says WHICH browsers a burst came from, which is the first thing to know; the
    // address is a counter key only and never logged.
    log.warn("client-errors", {
      msg: "opaque cross origin script error",
      page: report.page,
      addresses: seen.addresses,
      new_address: seen.newAddress,
      burst: seen.burst,
      measured: seen.measured,
      user_agent: loggedUserAgent(req.headers),
    });
    if (!seen.burst) return done();
    // alert-key: opaque_script_errors:*
    await sendThrottledAlert(
      `opaque_script_errors:${clientErrorSurface(report.page)}`,
      OPAQUE_BURST_WINDOW_MS,
      opaqueScriptErrorBurstAlert({
        surface: clientErrorSurface(report.page),
        addresses: seen.addresses,
        threshold: OPAQUE_BURST_THRESHOLD,
        windowMinutes: Math.round(OPAQUE_BURST_WINDOW_MS / 60_000),
      }),
    ).catch((alertErr: unknown) => {
      log.error("client-errors", { msg: "opaque script error alert failed", page: report.page }, alertErr);
    });
    return done();
  }

  // L477: a window error or an unhandled rejection is judged by WHERE it came from,
  // its file and stack frames, never its message. A browser extension's script runs
  // inside the page, so its uncaught errors arrive here exactly as Slate's do (on
  // 2026-10-29, "Failed to connect to MetaMask" from MetaMask's injected provider
  // paged from /book). A boundary catch is React's own report from Slate's tree, so
  // it is never judged this way. Classified HERE, as the opaque errors are, because
  // the route sees every report whatever bundle the page is on.
  if (report.kind === "error" || report.kind === "unhandledrejection") {
    const origin = whereClientErrorCameFrom(report);

    // Every location it names is an extension's: nothing Slate ships is on the stack,
    // so nobody here can act on it. Logged below error, with the reason, and never
    // paged. One frame anywhere else, Slate's bundle included, and it pages below.
    if (origin.from === "extension") {
      log.warn("client-errors", {
        msg: "browser extension error",
        reason: "every file and stack frame it names is a browser extension's, so Slate's code is not on it",
        kind: report.kind,
        page: report.page,
        scheme: origin.scheme,
        message: report.message,
        source: report.source,
        user_agent: loggedUserAgent(req.headers),
      });
      return done();
    }

    // A rejection naming nowhere at all cannot be attributed: an extension rejecting
    // with a plain value sends this, and so would a Slate fault with no stack. One is
    // logged and counted and never pages; a burst across several browsers pages,
    // because a fault in the page's own code fails for every lead who opens it.
    if (report.kind === "unhandledrejection" && origin.from === "no_location") {
      const signature = clientErrorSignature(report);
      const seen = await countUnattributedRejection(signature, clientIp(req.headers));
      log.warn("client-errors", {
        msg: "unattributed unhandled rejection",
        reason: "it names no file and no stack frame, so it cannot be told from an extension's",
        page: report.page,
        message: report.message,
        addresses: seen.addresses,
        new_address: seen.newAddress,
        burst: seen.burst,
        measured: seen.measured,
        user_agent: loggedUserAgent(req.headers),
      });
      if (!seen.burst) return done();
      // alert-key: unattributed_rejections:*
      await sendThrottledAlert(
        `unattributed_rejections:${clientErrorSurface(report.page)}`,
        UNATTRIBUTED_REJECTION_WINDOW_MS,
        unattributedRejectionBurstAlert({
          surface: clientErrorSurface(report.page),
          addresses: seen.addresses,
          threshold: UNATTRIBUTED_REJECTION_BURST_THRESHOLD,
          windowMinutes: Math.round(UNATTRIBUTED_REJECTION_WINDOW_MS / 60_000),
        }),
      ).catch((alertErr: unknown) => {
        log.error("client-errors", { msg: "unattributed rejection alert failed", page: report.page }, alertErr);
      });
      return done();
    }
  }

  // #1974: a BOUNDARY catch is a different event from an unexpected 500 and gets
  // its own sentence. `reportInternalError`'s copy ends "the caller got a
  // generic 500", which is untrue here: nothing returned a 500, a person was
  // shown a screen (L11). The log line is the same either way, because the
  // forensic trail is the same.
  if (report.kind === "boundary") {
    const signature = clientErrorSignature(report);
    // The LOG line is written for every catch, including the ones that do not
    // page. It is the forensic trail and the record the count is read against,
    // so a single stray fault stays findable by `tag=client-errors` even though
    // nobody is woken for it.
    log.error("client-errors", { msg: "page boundary caught", page: report.page }, err);

    // #1974: ONE catch is not a signal. A stale bundle after a deploy, a chunk
    // that failed to load, one person's extension: each is exactly one catch on
    // one load, and paging on it teaches the reader to ignore the channel (L36).
    // A SECOND catch on the same surface inside the window is the page rather
    // than the person. The counter fails OPEN, so a counter that cannot answer
    // pages and says the scope is unknown.
    const seen = await countBoundaryCatch(signature);
    if (!seen.repeated) return done();

    // alert-key: boundary_error:*
    await sendThrottledAlert(
      signature,
      BOUNDARY_ERROR_COOLDOWN_MS,
      boundaryCatchAlert(report.page, shortErrorReason(err, { maxChars: 240 }), {
        count: seen.count,
        measured: seen.measured,
        windowMinutes: Math.round(BOUNDARY_WINDOW_MS / 60_000),
      }),
    ).catch((alertErr: unknown) => {
      log.error("client-errors", { msg: "boundary alert failed", page: report.page }, alertErr);
    });
    return done();
  }

  // #2755: every page Slate does not serve shares the one `other` key, so a storm
  // of invented paths is one alert per cooldown rather than one per path. That
  // alert leads with how many there have been, or forty forged reports would read
  // exactly like one stray one. (A boundary catch is already counted per key.)
  const signature = clientErrorSignature(report);
  if (clientErrorSurface(report.page) === "other") {
    const seen = await countUnrecognisedPageReport(signature);
    err.message = `${unrecognisedPageReports({
      ...seen,
      windowMinutes: Math.round(BOUNDARY_WINDOW_MS / 60_000),
    })} ${err.message}`;
  }
  // #2788: the chokepoint reads the `client_error:` key and sends the browser
  // report's own sentence, never the server fault's "generic 500" one.
  await reportInternalError(err, signature);
  return done();
}

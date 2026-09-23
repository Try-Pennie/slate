import { NextResponse, type NextRequest } from "next/server";
import { reportInternalError } from "@/lib/api/errors";
import { log } from "@/lib/log";
import { sendThrottledAlert, sendThrottledInfo } from "@/lib/notify/dispatch";
import { boundaryCatchAlert, embedOriginMismatchAlert } from "@/lib/notify/misc-alert-copy";
import { parseOriginMismatchMessage } from "@/lib/embed/parent-origin";
import { shortErrorReason } from "@/lib/notify/error-text";
import { countBoundaryCatch, BOUNDARY_WINDOW_MS } from "@/lib/api/boundary-count";

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
import { allowRequest, clientIp, CLIENT_ERROR_RATE_RULES } from "@/lib/rate-limit";
import { CLIENT_ERROR_ADDRESS_POLICY } from "@/lib/rate-limit-core";
import {
  normalizeClientError,
  clientErrorSignature,
} from "@/lib/api/client-error-scrub";

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

  const body = await req.json().catch(() => null);
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

  // The alert carries a short, bounded reason; the full report goes to the log,
  // which Cloudflare keeps complete (#1133: the alert is read on a phone, the
  // detail belongs where there is room for it).
  const where = [report.source, report.line, report.col].filter((p) => p !== null).join(":");
  const err = new Error(
    `${report.kind} on ${report.page}: ${report.message}${where ? ` (${where})` : ""}`,
  );
  err.stack = report.stack ?? undefined;

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

  await reportInternalError(err, clientErrorSignature(report));
  return done();
}

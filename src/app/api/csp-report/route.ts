import { NextResponse, type NextRequest } from "next/server";
import { log } from "@/lib/log";
import { allowRequest, clientIp, CSP_REPORT_RATE_RULES } from "@/lib/rate-limit";
import { CSP_REPORT_ADDRESS_POLICY } from "@/lib/rate-limit-core";
import { cspViolationPage, summariseViolation } from "@/lib/csp";
import { loadMonitorCooldowns } from "@/lib/monitor/settings";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { cspViolationAlert } from "@/lib/notify/misc-alert-copy";
import { readJsonCapped, CSP_REPORT_MAX_BYTES } from "@/lib/http/read-json-capped";

export const dynamic = "force-dynamic";

/**
 * Where a browser posts a Content Security Policy violation (#2565).
 *
 * The policy is ENFORCED since #2575, so a violation is no longer information
 * about what a policy WOULD break: a resource was refused for a real person. Dan
 * decided on 2026-10-02 that this sends a THROTTLED PAGE on the alert channel, unless
 * `cspViolationPage` names a reason it does not, keyed on the violated directive mapped onto
 * the policy's own directive list (`cspViolationPage`), so a burst of one refusal
 * is one page per cooldown and no caller can mint a key.
 *
 * WHO CAN CALL THIS: anyone. A browser posts a report with no credentials and no
 * way to add any, so there is no honest alternative.
 * WHAT DATA IT CAN TOUCH: nothing. No read and no write of any customer, agent or
 * org record. Its effect is a log line and, for an enforced refusal, a throttled
 * page whose copy carries only a directive, a surface and an origin.
 *
 * Four deliberate refusals, the first two taken straight from the client error
 * beacon (#1368), which is the same shape of public unauthenticated beacon that
 * can page:
 *
 *  - It FAILS CLOSED on the rate limiter. Everything below that line can cause a
 *    Slack message, so a limiter that cannot vouch for the caller drops the report.
 *  - It returns 204 with NO BODY on every path, refusal included, so the response
 *    cannot be used as an oracle for what the server accepts.
 *  - It REDACTS before it logs. A report carries `document-uri`, `referrer` and
 *    `blocked-uri`, and on the manage page the URL is the booking's credential.
 *    #2564 took that token out of the warehouse; an endpoint the whole internet
 *    can post to must not walk it into the logs instead.
 *  - It does not page a report only report, a browser extension's own refusal, or a
 *    passive third-party font refusal (#3417, `injected-passive`), or the Google
 *    product logo an add-on injects under `img-src` (#3699), also when Chrome credits
 *    it to a Slate page script that happened to be running (#4063), none of which is
 *    Slate's page failing somebody. All are still logged.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // 204 on every path: refusal and success are indistinguishable from outside.
  const done = () => new NextResponse(null, { status: 204 });

  const allowed = await allowRequest(
    { kind: "address", ip: clientIp(req.headers), policy: CSP_REPORT_ADDRESS_POLICY },
    CSP_REPORT_RATE_RULES,
  ).catch(() => false);
  if (!allowed) return done();

  // #3135: read under a byte cap. An oversized report is dropped on the same 204.
  const read = await readJsonCapped(req, CSP_REPORT_MAX_BYTES);
  if (read.tooLarge) return done();
  const body = read.value;
  const violation = summariseViolation(body);
  // A body we could not read is not a violation of anything in particular, and
  // recording it as one would send somebody to fix a directive no browser named.
  if (violation.directive === "(unreadable)") return done();

  const decision = cspViolationPage(violation);
  const logBase = {
    msg: "policy violation",
    directive: violation.directive,
    blocked: violation.blocked,
    document: violation.document,
    referrer: violation.referrer,
    source: violation.source,
    disposition: violation.disposition,
  };

  // Three refusals are logged and dropped (#3417 added the third): a report-only report
  // blocked nothing, an extension's own resource is the person's browser, and a passive
  // third-party resource no Slate page requests ("injected-passive") is almost always an
  // extension and blocked nothing a lead needed, so one person's extension no longer
  // pages production.
  if (decision.page === false) {
    log.warn("csp-report", { ...logBase, paged: false, not_paged: decision.why });
    return done();
  }

  log.warn("csp-report", { ...logBase, paged: true });
  try {
    const cooldowns = await loadMonitorCooldowns("csp-report");
    // alert-key: csp_violation:*
    await sendThrottledAlert(
      decision.key,
      cooldowns.csp_violation,
      cspViolationAlert({
        directive: decision.directive,
        surface: decision.surface,
        blocked: decision.blocked,
        sourceNamed: violation.sourceNamed,
      }),
    );
  } catch (err) {
    // Said, never silent: the log line above is then the only trace that a
    // refusal reached a real person and paged nobody.
    log.error("csp-report", { msg: "violation page could not be sent", key: decision.key }, err);
  }
  return done();
}

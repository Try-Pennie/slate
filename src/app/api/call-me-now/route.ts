import { NextResponse, type NextRequest } from "next/server";
import { callMeNowAllowed, clientIp } from "@/lib/rate-limit";
import { readJsonCapped, PUBLIC_JSON_MAX_BYTES } from "@/lib/http/read-json-capped";
import { forgetCallMeNowLogin, liveCallMeNowDeps } from "@/lib/salesforce/call-me-now-live";
import {
  checkCallMeNow,
  formatCallMeNowFailedAlert,
  requestCallMeNow,
  retryCanHelp,
  type CallMeNowFailedStage,
  type CallMeNowInput,
} from "@/lib/salesforce/call-me-now";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { isSfAuthFailure } from "@/lib/salesforce/rest";
import { isSubmissionId } from "@/lib/salesforce/lead-xbc";
import { afterResponse } from "@/lib/after-response";
import { log } from "@/lib/log";
import { readTextingLine } from "@/lib/automations/texting-line";
import { automationsApiUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * One page per window per key: a run of failures is one Salesforce outage, and each
 * lead's id is in its own log line, which the press page points at.
 */
export const CALL_ME_NOW_ALERT_COOLDOWN_MS = 10 * 60_000;

/**
 * Page about a failed check or press, after the response so the lead never waits on
 * Slack. Two keys, so a hidden button never silences the page about a lead who pressed;
 * within one key a run of failures is one outage, and the press page says where in the
 * logs every lead in its quiet window is.
 */
const FAILURE_KEY = { check: "call_me_now_hidden", press: "call_me_now_failed" } as const;

function pageFailure(failure: { stage: CallMeNowFailedStage; error: unknown }, leadId: string, when: "check" | "press"): void {
  // Only a refused login is fixed by logging in afresh. Dropping it on any failure would
  // log in again on every card load for the length of a Salesforce outage.
  if (isSfAuthFailure(failure.error)) forgetCallMeNowLogin();
  const page = formatCallMeNowFailedAlert({ stage: failure.stage, leadId, error: failure.error, when });
  // alert-key: call_me_now_hidden
  // alert-key: call_me_now_failed
  // alert-text-ok: the builder reduces the error to shortErrorReason's one line, which
  // scripts/test-call-me-now.ts pins; the full text is in the caller's log line.
  afterResponse("call-me-now-alert", () => sendThrottledAlert(FAILURE_KEY[when], CALL_ME_NOW_ALERT_COOLDOWN_MS, page));
}

const submissionIdOf = (v: unknown): string | null => {
  const id = text(v);
  return id && isSubmissionId(id) ? id : null;
};

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/**
 * Call me now for the inline booker (#3718). POST `{ action, leadId, email, phone }`:
 *
 *  - `check` answers `{ offered }`: whether the card shows the button. Writes nothing.
 *    A failed check hides the button rather than erroring the card, since booking a
 *    time still works.
 *  - `request` marks the Lead for a call and answers `{ outcome }`: `requested`,
 *    `already-requested` (a call is pending), `refused` (no retry), or `failed` (503,
 *    with retry, and a page after the response).
 *
 * No auth: the caller is the booker a lead has open. What stops a stranger sending an
 * advisor to call somebody is the contact check in `call-me-now.ts`, and the answer
 * never says WHY a press was refused, so a guessed id cannot tell a missing lead from a
 * contact that did not match. Throttled per address before Salesforce is asked.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  if (!(await callMeNowAllowed(ip))) {
    return NextResponse.json({ error: "Too many requests. Please try again in a moment." }, { status: 429 });
  }

  const read = await readJsonCapped(req, PUBLIC_JSON_MAX_BYTES);
  if (read.tooLarge) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  const body = (read.value ?? {}) as Record<string, unknown>;
  const action = body.action;
  const leadId = text(body.leadId);
  if ((action !== "check" && action !== "request") || !leadId) {
    return NextResponse.json({ error: "action (check or request) and leadId are required" }, { status: 400 });
  }
  const input: CallMeNowInput = { leadId, email: text(body.email), phone: text(body.phone) };
  const deps = liveCallMeNowDeps();

  if (action === "check") {
    const out = await checkCallMeNow(input, deps);
    if (out.kind === "failed") {
      log.warn("call-me-now", { msg: "check failed, button hidden", lead_id: leadId, stage: out.stage }, out.error);
      // A Salesforce outage hides the button for every lead, and then nobody can press it
      // to cause the press page, so the check pages on its own.
      pageFailure(out, leadId, "check");
    } else if (out.kind === "refused") {
      log.info("call-me-now", { msg: "check refused", lead_id: leadId, reason: out.reason });
    }
    return NextResponse.json({ offered: out.kind === "offered" });
  }

  const out = await requestCallMeNow(input, deps);
  if (out.kind === "failed") {
    log.error("call-me-now", { msg: "press failed", lead_id: leadId, stage: out.stage }, out.error);
    pageFailure(out, leadId, "press");
    return NextResponse.json({ outcome: "failed", retry: retryCanHelp(out) }, { status: 503 });
  }
  if (out.kind === "refused") {
    log.info("call-me-now", { msg: "press refused", lead_id: leadId, reason: out.reason });
    return NextResponse.json({ outcome: "refused", retry: retryCanHelp(out) });
  }
  log.info("call-me-now", { msg: "press answered", lead_id: leadId, outcome: out.kind });
  // The line the lead can text, for the confirmation's Text us. Null when the service
  // is not configured or does not answer usefully, and the card then shows no Text us.
  const textLine = await readTextingLine(
    // The submission id only when it is shaped like one: the contact check proves
    // nothing about it, so a malformed value is never handed to the service.
    { phone: out.leadPhone, submissionId: submissionIdOf(body.submissionId) },
    {
      baseUrl: automationsApiUrl(),
      fetchImpl: fetch,
      onUnread: (err) => log.warn("call-me-now", { msg: "texting line unread, no Text us", lead_id: leadId }, err),
    },
  );
  return NextResponse.json({ outcome: out.kind, textLine });
}

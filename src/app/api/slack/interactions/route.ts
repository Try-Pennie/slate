import { NextResponse, after, type NextRequest } from "next/server";
import { log } from "@/lib/log";
import { appUrl, slackSigningSecret } from "@/lib/env";
import { verifySlackSignature } from "@/lib/slack/verify";
import { gateSessionRow } from "@/lib/auth/active-session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  dmSlackUserByEmail,
  getSlackUserEmail,
  openSlackModal,
  replyToSlackResponseUrl,
} from "@/lib/notify/slack";
import { approveOoo, rejectOoo } from "@/lib/ooo/service";
import { formatWhenLine } from "@/lib/ooo/core";
import {
  OOO_APPROVE_ACTION,
  OOO_REJECT_ACTION,
  OOO_REJECT_MODAL,
  noteFromViewState,
  rejectionModalView,
} from "@/lib/notify/ooo-slack-blocks";
import type { OooRequest, User } from "@/lib/db/types";

export const dynamic = "force-dynamic";

/**
 * Slack interactivity endpoint (#77): Approve / Decline buttons on the manager
 * OOO notification, and the Decline note modal. Every request is signature-
 * verified; the work runs through the SAME approveOoo/rejectOoo service the web
 * queue uses, so authz (canModerate) and side effects stay identical.
 *
 * Slack expects a response within ~3s. Button clicks ack immediately and finish
 * the (slower) approve/reject in the background; the Decline button must open
 * its modal synchronously, since the trigger_id expires in 3s.
 */

/**
 * Resolve the clicking Slack user to a Slate user via their workspace email.
 * Returns the email too (when Slack gave us one) so callers can DM feedback
 * even when no Slate user matches.
 *
 * #2378: the row goes through `gateSessionRow`, the same judge the signed in
 * session uses, so somebody who has LEFT stops being an actor here too. Their
 * Slack account outlives their Slate row by however long offboarding takes, and
 * the button sits in a message already delivered to their phone: before this, a
 * departed manager's Approve press ran `approveOoo` with whatever role their row
 * still carried, and `canModerate` said yes.
 *
 * All three refusals resolve to `user: null`, which the two callers already
 * handle by telling the clicker the press did not land, so a departed manager
 * gets the same honest reply an unmatched account gets rather than silence.
 */
async function resolveActor(
  slackUserId: string,
): Promise<{ user: User | null; email: string | null }> {
  const email = await getSlackUserEmail(slackUserId);
  if (!email) return { user: null, email: null };
  const { data, error } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  const gate = gateSessionRow(data as User | null, error);
  if (gate.admit) return { user: gate.user, email };
  if (gate.reason !== "no-row") {
    log.warn("slack", { msg: `refused an actor: ${gate.reason}` }, error);
  }
  return { user: null, email };
}

/** Slack mrkdwn hyperlink to the request in the admin queue. */
function requestLink(requestId: string): string {
  return `<${appUrl()}/admin/ooo?request=${requestId}|Open it in Slate>`;
}

async function runApprove(
  requestId: string,
  slackUserId: string,
  responseUrl: string,
): Promise<void> {
  const { user } = await resolveActor(slackUserId);
  if (!user) {
    await replyToSlackResponseUrl(
      responseUrl,
      `Couldn't match your Slack account to a Slate user, so the approval didn't go through. ${requestLink(requestId)} to decide.`,
    );
    return;
  }
  const res = await approveOoo(requestId, user);
  if (!res.ok) await replyToSlackResponseUrl(responseUrl, res.error);
}

async function runReject(
  requestId: string,
  slackUserId: string,
  note: string,
): Promise<void> {
  // The Decline modal submit has no response_url, so failures are reported by
  // DMing the manager who clicked — otherwise the modal just closes and a failed
  // rejection (unmatched account, not authorized, error) looks like it worked.
  const { user, email } = await resolveActor(slackUserId);
  if (!user) {
    if (email) {
      await dmSlackUserByEmail(
        email,
        `Couldn't match your Slack account to a Slate user, so the decline didn't go through. ${requestLink(requestId)} to decide.`,
      );
    }
    return;
  }
  const res = await rejectOoo(requestId, user, note);
  if (!res.ok && email) {
    await dmSlackUserByEmail(email, `Couldn't decline that request: ${res.error}`);
  }
}

export async function POST(req: NextRequest) {
  // body-cap-ok: Slack signs the raw form body, so it has to be read whole before the
  // signature can be checked, and the size of an interaction payload is Slack's to set (#3135).
  const raw = await req.text();
  if (
    !verifySlackSignature({
      signingSecret: slackSigningSecret(),
      timestamp: req.headers.get("x-slack-request-timestamp"),
      signature: req.headers.get("x-slack-signature"),
      rawBody: raw,
      nowMs: Date.now(),
    })
  ) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  const encoded = new URLSearchParams(raw).get("payload");
  if (!encoded) return new NextResponse(null, { status: 200 });
  let payload: {
    type?: string;
    user?: { id?: string };
    trigger_id?: string;
    response_url?: string;
    actions?: { action_id?: string; value?: string }[];
    view?: { callback_id?: string; private_metadata?: string };
  };
  try {
    payload = JSON.parse(encoded);
  } catch {
    return new NextResponse("bad payload", { status: 400 });
  }

  const slackUserId = payload.user?.id ?? "";

  // A manager submitted the Decline note modal.
  if (payload.type === "view_submission") {
    if (payload.view?.callback_id === OOO_REJECT_MODAL) {
      const requestId = payload.view.private_metadata ?? "";
      const note = noteFromViewState(payload.view);
      if (requestId && slackUserId) {
        // after() keeps the Worker alive until the reject finishes — a plain
        // fire-and-forget promise is killed once the response is sent on the
        // Cloudflare runtime, so the rejection never lands (#191).
        after(() =>
          runReject(requestId, slackUserId, note).catch((err) =>
            // The requester was already told the modal closed, so a silent
            // failure here means a rejection that never happened and nobody knows.
            log.error("slack", { msg: "OOO reject failed", request_id: requestId }, err),
          ),
        );
      }
    }
    // Empty 200 closes the modal.
    return new NextResponse(null, { status: 200 });
  }

  // A button on the notification.
  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    const requestId = action?.value ?? "";
    const responseUrl = payload.response_url ?? "";

    if (action?.action_id === OOO_APPROVE_ACTION && requestId && slackUserId) {
      // Ack now; the approval (Google + Slack writes) finishes after the
      // response via after(), which keeps the Worker alive — a bare
      // fire-and-forget promise is cut off on the Cloudflare runtime (#191).
      after(() =>
        runApprove(requestId, slackUserId, responseUrl).catch((err) =>
          // Same as reject: an approval that silently never landed leaves the
          // agent still bookable over time off they were told was approved.
          log.error("slack", { msg: "OOO approve failed", request_id: requestId }, err),
        ),
      );
      return new NextResponse(null, { status: 200 });
    }

    if (action?.action_id === OOO_REJECT_ACTION && requestId) {
      // The modal must open before the trigger_id expires (~3s), so do it inline.
      // error-ok: this read only DECORATES the modal with the dates. An empty
      // result falls back to "this request", the modal still opens inside the
      // 3s window and the rejection it collects is unaffected, so nothing
      // downstream reads the emptiness as a fact about the request.
      const { data } = await supabaseAdmin()
        .from("ooo_requests")
        .select("starts_at, ends_at, display_tz_id, display_tz_label")
        .eq("id", requestId)
        .maybeSingle();
      const r = data as Pick<
        OooRequest,
        "starts_at" | "ends_at" | "display_tz_id" | "display_tz_label"
      > | null;
      const whenLine = r
        ? formatWhenLine(r.starts_at, r.ends_at, r.display_tz_id, r.display_tz_label)
        : "this request";
      if (payload.trigger_id) {
        await openSlackModal(
          payload.trigger_id,
          rejectionModalView(requestId, whenLine),
        );
      }
      return new NextResponse(null, { status: 200 });
    }
  }

  return new NextResponse(null, { status: 200 });
}

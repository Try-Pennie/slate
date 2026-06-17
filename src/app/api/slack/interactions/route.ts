import { NextResponse, after, type NextRequest } from "next/server";
import { slackSigningSecret } from "@/lib/env";
import { verifySlackSignature } from "@/lib/slack/verify";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getSlackUserEmail, openSlackModal } from "@/lib/notify/slack";
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

/** Resolve the clicking Slack user to a Slate user via their workspace email. */
async function resolveActor(slackUserId: string): Promise<User | null> {
  const email = await getSlackUserEmail(slackUserId);
  if (!email) return null;
  const { data } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  return (data as User | null) ?? null;
}

/** Post an ephemeral note back to the interaction's response_url (best-effort). */
async function replyEphemeral(responseUrl: string, text: string): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
  } catch {
    /* best-effort */
  }
}

async function runApprove(
  requestId: string,
  slackUserId: string,
  responseUrl: string,
): Promise<void> {
  const actor = await resolveActor(slackUserId);
  if (!actor) {
    await replyEphemeral(
      responseUrl,
      "Couldn't match your Slack account to a Slate user, so the approval didn't go through. Use the link to decide in Slate.",
    );
    return;
  }
  const res = await approveOoo(requestId, actor);
  if (!res.ok) await replyEphemeral(responseUrl, res.error);
}

async function runReject(
  requestId: string,
  slackUserId: string,
  note: string,
): Promise<void> {
  const actor = await resolveActor(slackUserId);
  if (!actor) return;
  await rejectOoo(requestId, actor, note);
}

export async function POST(req: NextRequest) {
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
        after(() => runReject(requestId, slackUserId, note).catch(() => {}));
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
      after(() => runApprove(requestId, slackUserId, responseUrl).catch(() => {}));
      return new NextResponse(null, { status: 200 });
    }

    if (action?.action_id === OOO_REJECT_ACTION && requestId) {
      // The modal must open before the trigger_id expires (~3s), so do it inline.
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

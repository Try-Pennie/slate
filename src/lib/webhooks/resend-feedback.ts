/**
 * What the admin is told after pressing Resend on a webhook delivery (#1076).
 *
 * The resend already refused correctly: it will not re-fire a delivery whose
 * payload was blanked for PII retention (#1073), nor a suppressed test delivery,
 * and the send itself can fail. All of that was logged server side and NOTHING
 * appeared on screen, so an admin pressed a button and watched the log re-render
 * unchanged. A refusal that looks identical to a success is the standing defect
 * this closes.
 *
 * Two rules the copy holds, and both matter to whether the admin presses again:
 *
 *  - a refusal and a success are different screens;
 *  - each refusal says its OWN reason, because two of these can never succeed
 *    however many times the button is pressed, and one of them already worked.
 *    "Could not resend" for all of them leaves an admin with no way to tell
 *    "try later" from "stop trying" (L11).
 *
 * Pure, so scripts/test-webhook-resend-feedback.ts drives every outcome.
 */
import type { ResendResult } from "@/lib/webhooks/emit";

export type { ResendResult };

/**
 * Every outcome the resend can return, as a list.
 *
 * The copy below is checked against THIS rather than against a hand written set,
 * so an outcome added to `ResendResult` and not to the copy fails the build rather
 * than rendering nothing, which would be the same silence one level along (L96).
 */
export const RESEND_RESULTS: ResendResult[] = [
  "sent",
  "not-found",
  "suppressed",
  "payload-erased",
  "retired-event",
  "deduped",
];

export interface ResendFeedback {
  /** `ok` renders as a success; `error` as something that did not happen. */
  tone: "ok" | "error";
  message: string;
}

/**
 * The line to show for a resend outcome. Never null: an unrecognised value still
 * says something, and errs toward reporting a problem, because the alternative is
 * a button that visibly does nothing, which is what this exists to remove.
 */
export function resendFeedback(result: ResendResult): ResendFeedback {
  switch (result) {
    case "sent":
      return { tone: "ok", message: "Delivery re-sent. The receiver should have it now." };

    case "deduped":
      // Not a refusal in any sense that matters to the admin: it went. Saying
      // "could not resend" here would have somebody chasing a delivery that landed.
      return {
        tone: "error",
        message:
          "This delivery has already been re-sent very recently, so it was not sent again. The receiver has it.",
      };

    case "payload-erased":
      // Permanent, and the admin has to know that. The payload is gone under the
      // PII retention window and no amount of pressing brings it back.
      return {
        tone: "error",
        message:
          "This delivery cannot be re-sent: its contents were deleted under the data retention window, so there is nothing left to send.",
      };

    case "retired-event":
      // Permanent: Slate no longer sends this kind of event at all (#2915).
      return {
        tone: "error",
        message:
          "This kind of event is no longer sent, so this delivery cannot be re-sent.",
      };

    case "suppressed":
      // Also permanent. Test traffic is deliberately never delivered.
      return {
        tone: "error",
        message:
          "This is a test delivery, which is never sent to a real receiver, so it was not re-sent.",
      };

    case "not-found":
      return {
        tone: "error",
        message:
          "This delivery could not be found. It may have been cleaned up since the log was loaded; reload the page.",
      };

    default:
      // An outcome the copy has not been taught. Reported rather than swallowed,
      // so the button never looks like it did nothing.
      return {
        tone: "error",
        message: "The resend did not go through. Check the webhook logs for the reason.",
      };
  }
}

/**
 * What the admin is told after pressing Replay failed deliveries (#2384).
 *
 * The batch control never said anything at all. Success revalidated the Overview
 * and returned void, and a second press inside the five minute dedupe window
 * `return`ed in silence, so the one thing that re-fires a receiver's whole
 * backlog after an outage was indistinguishable from a broken button on exactly
 * the press somebody makes when they are not sure the first one worked. That is
 * the fault #1076 closed for the Resend button beside it, left open here.
 *
 * The value it takes is either a COUNT or the word `deduped`, so the three things
 * a reader can meet are three different sentences: none found, some queued, and
 * this window was already replayed.
 *
 * Zero is not a failure and does not read as one. An outage with nothing dead
 * lettered in the chosen window is the ordinary healthy answer, and the reader's
 * next move is to widen the window, which the sentence says.
 */
export function replayFeedback(raw: string | undefined | null): ResendFeedback | null {
  if (!raw) return null;
  if (raw === "deduped") {
    return {
      tone: "error",
      message:
        "These deliveries were replayed in the last few minutes, so nothing was sent again. Wait five minutes before replaying the same window.",
    };
  }
  const queued = Number(raw);
  // A value that is not a count is not silently rounded into one: something other
  // than this action put it in the address bar, and inventing a number for it
  // would confirm a replay nobody ran (L11).
  if (!Number.isInteger(queued) || queued < 0) return null;
  if (queued === 0) {
    return {
      tone: "ok",
      message:
        "No failed deliveries were found in that window, so nothing was sent. Try a longer window if you are looking for an older failure.",
    };
  }
  return {
    tone: "ok",
    message:
      queued === 1
        ? "1 failed delivery was queued to send again. The log below shows how it goes."
        : `${queued} failed deliveries were queued to send again. The log below shows how they go.`,
  };
}

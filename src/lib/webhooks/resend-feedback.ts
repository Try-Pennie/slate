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

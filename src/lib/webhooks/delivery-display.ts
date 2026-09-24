import type { PillVariant } from "@/components/ui/Pill";
import type { DeliveryStatus, WebhookEvent } from "@/lib/db/types";
import { webhookEventFamily, type WebhookEventFamily } from "@/lib/webhooks/events";

/**
 * Why a suppressed delivery was not sent, per event family (#2085). Keyed on the
 * family so a third family cannot ship borrowing another's reason (L113): a test
 * bucket's booking and a test agent's bookable trait are suppressed by the same
 * rule for different things, and naming the wrong one sends the reader looking
 * for something that is not there.
 */
const SUPPRESSED_HINT: Record<WebhookEventFamily, string> = {
  booking: "Test bucket booking: recorded, but deliberately not sent to any downstream system.",
  agent: "Test agent: recorded, but deliberately not sent to any downstream system.",
};

/**
 * How one webhook delivery reads in the admin log (#777).
 *
 * A suppressed delivery (an is_test bucket's booking, #459, or an is_test agent's
 * bookable trait, #2085) is recorded but never POSTed, and it is stored with a
 * TERMINAL `success` status so the retry sweep can never pick it up. Rendering that
 * status verbatim told the admin a smoke test had been delivered to Regal when
 * nothing left the building, which misleads exactly the person debugging a
 * delivery problem.
 *
 * Resend is off for the same reason: `resendDelivery` already refuses a suppressed
 * row server-side, so an enabled button is a no-op dressed up as an action.
 */
export function deliveryDisplay(d: {
  event: WebhookEvent;
  status: DeliveryStatus;
  suppressed?: boolean | null;
}): { label: string; variant: PillVariant; resendable: boolean; hint: string | null } {
  if (d.suppressed) {
    return {
      label: "not sent",
      variant: "outline",
      resendable: false,
      hint: SUPPRESSED_HINT[webhookEventFamily(d.event)],
    };
  }

  return {
    label: d.status,
    variant:
      d.status === "success"
        ? "status-ok"
        : d.status === "failed"
          ? "status-error"
          : "status-pending",
    resendable: true,
    hint: null,
  };
}

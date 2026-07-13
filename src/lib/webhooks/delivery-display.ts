import type { PillVariant } from "@/components/ui/Pill";
import type { DeliveryStatus } from "@/lib/db/types";

/**
 * How one webhook delivery reads in the admin log (#777).
 *
 * A suppressed delivery (an is_test bucket's booking, #459) is recorded but never
 * POSTed, and it is stored with a TERMINAL `success` status so the retry sweep can
 * never pick it up. Rendering that status verbatim told the admin a smoke-test
 * booking had been delivered to Regal when nothing left the building, which misleads
 * exactly the person debugging a delivery problem.
 *
 * Resend is off for the same reason: `resendDelivery` already refuses a suppressed
 * row server-side, so an enabled button is a no-op dressed up as an action.
 */
export function deliveryDisplay(d: {
  status: DeliveryStatus;
  suppressed?: boolean | null;
}): { label: string; variant: PillVariant; resendable: boolean; hint: string | null } {
  if (d.suppressed) {
    return {
      label: "not sent",
      variant: "outline",
      resendable: false,
      hint: "Test bucket booking: recorded, but deliberately not sent to any downstream system.",
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

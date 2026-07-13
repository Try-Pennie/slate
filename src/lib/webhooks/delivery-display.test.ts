import { describe, it, expect } from "vitest";
import { deliveryDisplay } from "./delivery-display";

// #777: a suppressed delivery (an is_test bucket's booking, #459) is RECORDED but
// deliberately never POSTed. To stop the retry sweep ever picking it up it is stored
// with a TERMINAL `success` status, so the admin webhook log was showing smoke-test
// bookings as delivered to Regal when nothing was sent. That misleads exactly the
// person debugging a delivery problem, which is the one job this log has.

describe("deliveryDisplay", () => {
  it("shows a suppressed delivery as not sent, never as success", () => {
    const d = deliveryDisplay({ status: "success", suppressed: true });

    expect(d.label).toBe("not sent");
    // Must not borrow the success/ok treatment: the whole bug is that a suppressed
    // row reads as delivered.
    expect(d.variant).not.toBe("status-ok");
    expect(d.variant).toBe("outline");
  });

  it("does not offer Resend on a suppressed delivery", () => {
    // resendDelivery() already refuses these server-side, so an enabled button is a
    // no-op dressed up as an action: the admin clicks it and nothing happens, with
    // no explanation.
    expect(deliveryDisplay({ status: "success", suppressed: true }).resendable).toBe(false);
  });

  it("explains why it was not sent, so the log is self-describing", () => {
    expect(deliveryDisplay({ status: "success", suppressed: true }).hint).toMatch(/test bucket/i);
  });

  it("leaves a real delivery exactly as it was", () => {
    expect(deliveryDisplay({ status: "success", suppressed: false })).toMatchObject({
      label: "success",
      variant: "status-ok",
      resendable: true,
    });
    expect(deliveryDisplay({ status: "failed", suppressed: false })).toMatchObject({
      label: "failed",
      variant: "status-error",
      resendable: true,
    });
    expect(deliveryDisplay({ status: "pending", suppressed: false })).toMatchObject({
      label: "pending",
      variant: "status-pending",
      resendable: true,
    });
  });

  it("treats a legacy row with no suppressed flag as a real delivery", () => {
    // Rows written before migration 0066 have no `suppressed` column value in an
    // older cached payload; absent must mean "was really sent", not "suppressed".
    expect(
      deliveryDisplay({ status: "success", suppressed: undefined }),
    ).toMatchObject({ label: "success", resendable: true });
  });
});

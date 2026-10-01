// @vitest-environment jsdom
//
// #2162: the pure caret arithmetic is pinned in scripts/test-phone-caret.ts. This
// file asks the other half of the question, which that one cannot: is it WIRED,
// on BOTH surfaces that take a phone number (L3).
//
// Both were broken by the same shared formatter, so both are driven here rather
// than one being taken as evidence for the other.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";
import ManageBooking from "@/components/ManageBooking";
import { PHONE_COPY } from "@/lib/booking/manage-copy";
import { bookerSlotIso } from "@/components/booker-test-slot";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";

// A fixed daytime hour in the booker's zone (#2310): see booker-test-slot.ts.
const slotIso = bookerSlotIso(3);
const availability = {
  bucket: { code: "411" },
  orgName: "Pennie",
  eventType: { name: "Advisor Call", description: null, durationMin: 30 },
  slots: [slotIso],
};
const baseProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
};

const manageProps = {
  token: "tok_1",
  rebookHref: "/book?xbc=411",
  rescheduleTimesFrom: "pool" as const,
  startsAt: slotIso,
  timezone: "America/New_York",
  bucketCode: "411",
  eventName: "Advisor Call",
  status: "confirmed" as const,
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  theme: "light" as const,
  durationMin: 20,
  attendeePhone: "(215) 555-0100",
  callingNumber: null,
  attendeeEmail: "dana@example.com",
  advisorName: "Aisha Bello",
  advisorRole: "Senior Loan Advisor",
};

/** The value with a bar where the caret is, which is what the lead sees. */
function shown(el: HTMLInputElement): string {
  const at = el.selectionStart ?? el.value.length;
  return `${el.value.slice(0, at)}|${el.value.slice(at)}`;
}

async function reachThePhoneField() {
  render(<Booker {...baseProps} />);
  await userEvent.click(
    await screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }),
  );
  await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
  return (await screen.findByLabelText("Phone")) as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => availability,
  })) as unknown as typeof fetch;
});

describe("phone field caret (#2162)", () => {
  it("puts a digit typed in the middle where the cursor was, on the booker", async () => {
    const input = await reachThePhoneField();

    await userEvent.type(input, "5555678987");
    expect(input.value).toBe("(555) 567-8987");

    // Dan's report: the cursor between the 6 and the 7.
    input.setSelectionRange(8, 8);
    await userEvent.type(input, "1", { initialSelectionStart: 8, initialSelectionEnd: 8 });

    await waitFor(() => expect(input.value).toBe("(555) 561-7898"));
    expect(shown(input)).toBe("(555) 561|-7898");
  });

  it("leaves the cursor at the deletion when a digit in the middle is removed", async () => {
    const input = await reachThePhoneField();
    await userEvent.type(input, "5555678987");

    input.setSelectionRange(9, 9);
    await userEvent.type(input, "{Backspace}", {
      initialSelectionStart: 9,
      initialSelectionEnd: 9,
    });

    await waitFor(() => expect(input.value).toBe("(555) 568-987"));
    expect(shown(input)).toBe("(555) 56|8-987");
  });

  it("still lands at the end when typing at the end, so ordinary entry is unchanged", async () => {
    const input = await reachThePhoneField();
    await userEvent.type(input, "203561");
    expect(shown(input)).toBe("(203) 561|");
  });

  it("puts a digit typed in the middle where the cursor was, on the manage page too", async () => {
    // Driven, not inferred. Both surfaces shared the formatter, so both shared the
    // defect, and one passing is no evidence about the other.
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ slots: [] }),
    })) as unknown as typeof fetch;

    render(<ManageBooking {...manageProps} />);
    await userEvent.click(screen.getByRole("button", { name: PHONE_COPY.trigger }));

    const input = (await screen.findByLabelText(PHONE_COPY.heading)) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "5555678987");
    expect(input.value).toBe("(555) 567-8987");

    input.setSelectionRange(8, 8);
    await userEvent.type(input, "1", { initialSelectionStart: 8, initialSelectionEnd: 8 });

    await waitFor(() => expect(input.value).toBe("(555) 561-7898"));
    expect(shown(input)).toBe("(555) 561|-7898");
  });
});

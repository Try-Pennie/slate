import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";

// #625: the confirm POST must not freeze the button in "Booking your call…" if
// the request rejects at the network layer (flaky mobile). It surfaces an error
// and re-enables so the lead can retry.

const slotIso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

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
};

async function fillAndConfirm() {
  const slot = await screen.findByRole("button", { name: /:\d{2}/ });
  await userEvent.click(slot);
  await userEvent.type(screen.getByLabelText("Name"), "Dana Lead");
  await userEvent.type(screen.getByLabelText("Email"), "dana@example.com");
  await userEvent.type(screen.getByLabelText("Phone"), "(203) 561-5295");
  await userEvent.click(screen.getByRole("button", { name: /confirm booking/i }));
}

beforeEach(() => vi.clearAllMocks());

describe("Booker confirm", () => {
  it("surfaces an error and re-enables Confirm when the booking POST rejects at the network layer", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      // POST /booking
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: /confirm booking/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(screen.queryByText("You're all set")).toBeNull();
  });

  it("enters the confirmed state on a successful booking", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    expect(await screen.findByText("You're all set")).toBeTruthy();
  });
});

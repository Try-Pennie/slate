// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

// The coordinator booking page's component (#4205), against the settled design
// (docs/design/coordinator-booking.html). The rules live in a pure reducer driven by
// scripts/test-coordinator-booking-page.ts; this pins what only the component does: it
// calls the server when it should (find on paste, Requirement 7.3), moves focus, keeps the
// dialog modal (Requirement 7.17), and draws the refused button grey (7.15). Every value
// is invented.

const actions = vi.hoisted(() => ({ lookupCoordinatorCustomer: vi.fn(), placeCoordinatorCall: vi.fn(), checkCoordinatorTransfer: vi.fn() }));
vi.mock("@/app/coordinator/actions", () => actions);

import { CoordinatorBooking } from "./CoordinatorBooking";
import { initialPageState, reducePage, type LookupAnswer, type PageEvent, type PageState } from "@/lib/coordinator/booking-page";
import { offeredDays } from "@/lib/coordinator/bookable-hours";
import type { BusinessHoursRules } from "@/lib/availability/compute";

const NOW = Date.parse("2026-11-16T17:40:00Z");
const HOURS: BusinessHoursRules = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 19 * 60 + 30 })),
  exceptions: [],
};
const REASONS = [
  { code: "schedule_conflict", label: "Schedule conflict" },
  { code: "other", label: "Other" },
];
const ID = "00Q5e00000XyZ12EAC";
const customer = {
  salesforceLeadId: ID,
  name: "Jordan Rivera",
  firstName: "Jordan",
  email: null,
  phone: "+1 (555) 010 2477",
  zone: "America/Phoenix",
  zoneFrom: "zip" as const,
  bucketCode: "412",
  bucketSource: "salesforce" as const,
  bucketIsTest: false,
  durationMin: 30,
};
const days = { ok: true as const, days: offeredDays({ hours: HOURS, zone: "America/Phoenix", durationMin: 0, nowMs: NOW, horizonDays: 4 }) };
const call = { bookingId: "bk-old", startsAt: "2026-11-17T18:00:00.000Z", timezone: "America/Phoenix", advisorName: "Ada Example", onPlaceholder: false };
const jordan: LookupAnswer = { ok: true, customer, existingCall: { kind: "found", happens: "moves-when-confirmed", call }, days };
const newCustomer: LookupAnswer = { ok: true, customer, existingCall: { kind: "none" }, days };
const serverAnswer = { ok: true, customer, existingCall: { kind: "none" }, hours: { ok: true, date: "2026-11-16", windows: [] }, days };

const stateOf = (answer: LookupAnswer, more: PageEvent[] = []): PageState =>
  [{ type: "leadEdited", value: ID, at: NOW } as PageEvent, { type: "lookupAnswered", seq: 1, answer } as PageEvent, ...more].reduce(reducePage, initialPageState());
const ready = (answer: LookupAnswer) =>
  stateOf(answer, [
    { type: "toldChanged", checked: true },
    { type: "dayChosen", date: "2026-11-19" },
    { type: "timeChosen", start: "2026-11-19T14:00:00.000-07:00" },
    { type: "reasonChosen", code: "schedule_conflict" },
  ]);

const draw = (initial: PageState) => render(<CoordinatorBooking initial={initial} reasons={REASONS} fixedNowMs={NOW} />);

beforeEach(() => {
  actions.lookupCoordinatorCustomer.mockReset();
  actions.placeCoordinatorCall.mockReset();
  actions.checkCoordinatorTransfer.mockReset();
  actions.checkCoordinatorTransfer.mockResolvedValue({ kind: "busy" });
});
afterEach(cleanup);

describe("Requirement 7.3: find on paste (D22)", () => {
  it("looks the customer up as soon as the field holds a whole Lead ID, with no press", async () => {
    actions.lookupCoordinatorCustomer.mockResolvedValue(serverAnswer);
    draw(initialPageState());
    fireEvent.change(screen.getByLabelText("Salesforce Lead"), { target: { value: ID } });
    await waitFor(() => expect(actions.lookupCoordinatorCustomer).toHaveBeenCalledWith({ reference: ID }));
    expect(await screen.findByText("Jordan Rivera")).toBeTruthy();
    expect(actions.lookupCoordinatorCustomer).toHaveBeenCalledTimes(1);
  });

  it("does not look up a part of an ID, and Find refuses it under the field in plain words", () => {
    draw(initialPageState());
    fireEvent.change(screen.getByLabelText("Salesforce Lead"), { target: { value: "00Q5e00000" } });
    expect(actions.lookupCoordinatorCustomer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Find customer" }));
    expect(screen.getByRole("alert").textContent).toMatch(/^This is not a Salesforce Lead link or ID\./);
    expect(actions.lookupCoordinatorCustomer).not.toHaveBeenCalled();
  });

  it("says the server's refusal under the field, never a blank page", async () => {
    actions.lookupCoordinatorCustomer.mockResolvedValue({ ok: false, refusal: "salesforce-unreadable", sentence: "We could not reach Salesforce just now." });
    draw(initialPageState());
    fireEvent.change(screen.getByLabelText("Salesforce Lead"), { target: { value: ID } });
    expect((await screen.findByRole("alert")).textContent).toBe("We could not reach Salesforce just now.");
  });

  it("shows it is working while the lookup runs", async () => {
    actions.lookupCoordinatorCustomer.mockReturnValue(new Promise(() => {}));
    draw(initialPageState());
    fireEvent.change(screen.getByLabelText("Salesforce Lead"), { target: { value: ID } });
    expect(await screen.findByText("Looking up the customer")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Looking up the customer/ }).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("Requirement 7.8 and 7.9: the checkbox gates the card (D10, D11)", () => {
  it("puts the pointer over the locked card on a press, and pressing it moves focus to the checkbox", () => {
    draw(stateOf(jordan));
    expect(screen.queryByRole("button", { name: "Check the box above first" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^You cannot book yet\./ }));
    fireEvent.click(screen.getByRole("button", { name: "Check the box above first" }));
    expect(document.activeElement).toBe(screen.getByLabelText("I told Jordan their Tuesday call will move"));
  });

  it("takes a key on the locked card as an attempt too, and says why in a polite live region", () => {
    const { container } = draw(stateOf(jordan));
    fireEvent.keyDown(screen.getByRole("button", { name: /^You cannot book yet\./ }), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Check the box above first" })).toBeTruthy();
    expect(container.querySelector("[aria-live=polite]")?.textContent).toMatch(/^You cannot book yet\./);
  });

  it("unlocks the card when the box is checked", () => {
    draw(stateOf(jordan));
    fireEvent.click(screen.getByLabelText("I told Jordan their Tuesday call will move"));
    expect(screen.queryByRole("button", { name: /^You cannot book yet\./ })).toBeNull();
    expect((screen.getByRole("button", { name: "Thursday, November 19" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Requirement 7.15: a refused main button is grey, never Sky (D19)", () => {
  it("marks the confirm refused, so the shared Button draws it in --bg-alt", () => {
    draw(stateOf(newCustomer));
    const confirm = screen.getByRole("button", { name: "Book the call" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.hasAttribute("data-refused")).toBe(true);
    expect(confirm.className).toContain("pn-btn--primary");
  });

  it("drops the mark once everything is done", () => {
    draw(ready(jordan));
    const confirm = screen.getByRole("button", { name: "Move the call to Thursday, November 19 at 2:00pm" }) as HTMLButtonElement;
    expect([confirm.disabled, confirm.hasAttribute("data-refused")]).toEqual([false, false]);
  });
});

describe("Requirement 7.16 and 7.17: the confirmation dialog (D23 to D26)", () => {
  it("opens on the confirm with focus on Go back, and Escape or Go back close it with focus back on the confirm", () => {
    vi.useFakeTimers();
    try {
      draw(ready(jordan));
      const confirm = screen.getByRole("button", { name: /^Move the call to/ });
      fireEvent.click(confirm);
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("Thursday, November 19 at 2:00pm, Arizona time (Phoenix)");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Go back" }));
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(screen.queryByRole("alertdialog")).toBeNull();
      act(() => {
        vi.runAllTimers();
      });
      expect(document.activeElement).toBe(confirm);
      fireEvent.click(confirm);
      fireEvent.click(screen.getByRole("button", { name: "Go back" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(actions.placeCoordinatorCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("places once: a second press and Escape while placing are ignored, and it shows the working state", async () => {
    let answer: (v: unknown) => void = () => {};
    actions.placeCoordinatorCall.mockReturnValue(new Promise((r) => (answer = r)));
    draw(ready(jordan));
    fireEvent.click(screen.getByRole("button", { name: /^Move the call to/ }));
    const go = screen.getByRole("button", { name: "Move the call" });
    fireEvent.click(go);
    fireEvent.click(go);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Moving the call")).toBeTruthy();
    await waitFor(() => expect(actions.placeCoordinatorCall).toHaveBeenCalledTimes(1));
    const sent = actions.placeCoordinatorCall.mock.calls[0]![0];
    expect(sent).toMatchObject({ reference: ID, startIso: "2026-11-19T14:00:00.000-07:00", move: { bookingId: "bk-old", reasonCode: "schedule_conflict" } });
    expect(sent.submissionId).toMatch(/^[0-9a-f-]{36}$/);
    await act(async () => {
      answer({ kind: "moved", on: "advisor", advisorName: "Ada Example", startsAt: "2026-11-19T21:00:00.000Z", zone: "America/Phoenix", manageUrl: "", submissionId: sent.submissionId, sentence: "" });
    });
    expect(screen.getByRole("heading", { name: "Moved" })).toBeTruthy();
    expect(screen.queryByLabelText("Salesforce Lead")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Book another call" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Salesforce Lead")));
  });

  it("says a refusal on the page, in the server's words, and keeps what was chosen", async () => {
    actions.placeCoordinatorCall.mockResolvedValue({ kind: "refused", reason: "start-in-past", retryable: false, submissionId: "x", sentence: "That time has already passed. Pick a later one." });
    draw(ready(jordan));
    fireEvent.click(screen.getByRole("button", { name: /^Move the call to/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move the call" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That time has already passed. Pick a later one.");
    expect(screen.getByRole("button", { name: /^Move the call to Thursday/ })).toBeTruthy();
  });
});

describe("#4331: the customer's current call time (settled 2026-10-28, Greyed, label shown)", () => {
  it("draws the call's own time greyed, unclickable and labelled, with Current call shown in the button", () => {
    draw(stateOf(jordan, [{ type: "toldChanged", checked: true }, { type: "dayChosen", date: "2026-11-17" }]));
    const current = screen.getByRole("button", { name: "11:00am, Current call" }) as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    expect(current.textContent).toBe("11:00amCurrent call");
    expect(current.querySelector("[data-marked-label-mark]")).toBeNull();
    const other = screen.getByRole("button", { name: "11:15am" }) as HTMLButtonElement;
    expect(other.disabled).toBe(false);
    expect(screen.queryAllByText("Current call")).toHaveLength(1);
  });
});

describe("#4380: the live transfer offer (docs/design/coordinator-call-me-now.html)", () => {
  const OFFER = { kind: "offer", line: "786-504-0671" };
  const find = async () => {
    actions.lookupCoordinatorCustomer.mockResolvedValue(serverAnswer);
    draw(initialPageState());
    fireEvent.change(screen.getByLabelText("Salesforce Lead"), { target: { value: ID } });
    expect(await screen.findByText("Jordan Rivera")).toBeTruthy();
  };

  it("asks once the customer is found, and draws the card between the customer and the booking card (D1 to D3)", async () => {
    actions.checkCoordinatorTransfer.mockResolvedValue(OFFER);
    await find();
    const heading = await screen.findByRole("heading", { name: "Advisors are free now" });
    expect(actions.checkCoordinatorTransfer).toHaveBeenCalledTimes(1);
    const card = heading.closest("section")!;
    expect(card.textContent).toContain("Transfer Jordan to an advisor while they're on the line.");
    expect(card.textContent).toContain("If it doesn't connect, book a time below.");
    expect(screen.getAllByText("786-504-0671")).toHaveLength(1);
    const customerCard = screen.getByRole("heading", { name: "Customer" }).closest("section")!;
    const booking = document.getElementById("co-booking")!;
    expect(customerCard.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(booking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("asks again on Transfer now, and says so plainly when advisors are no longer free, leaving booking as it was", async () => {
    actions.checkCoordinatorTransfer.mockResolvedValueOnce(OFFER);
    await find();
    const press = await screen.findByRole("button", { name: "Transfer now" });
    let answer: (v: unknown) => void = () => {};
    actions.checkCoordinatorTransfer.mockReturnValueOnce(new Promise((r) => (answer = r)));
    fireEvent.click(press);
    expect(actions.checkCoordinatorTransfer).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Checking advisors")).toBeTruthy();
    fireEvent.click(screen.getByText("Checking advisors").closest("button")!);
    expect(actions.checkCoordinatorTransfer).toHaveBeenCalledTimes(2);
    await act(async () => answer({ kind: "busy" }));
    expect(screen.getByText("Not enough advisors are free now. Book a time below.", { selector: "p" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Advisors are free now" })).toBeNull();
    expect(document.getElementById("co-booking")).toBeTruthy();
  });

  it("says to transfer now when the re-check still finds enough free", async () => {
    actions.checkCoordinatorTransfer.mockResolvedValueOnce(OFFER).mockResolvedValueOnce(OFFER);
    await find();
    fireEvent.click(await screen.findByRole("button", { name: "Transfer now" }));
    expect(await screen.findByText("Advisors are still free. Transfer Jordan now.", { selector: "p" })).toBeTruthy();
  });

  it("draws nothing when too few are free", async () => {
    await find();
    await waitFor(() => expect(actions.checkCoordinatorTransfer).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByRole("heading", { name: "Advisors are free now" })).toBeNull();
    expect(screen.queryByText(/Live transfer/)).toBeNull();
  });

  it.each([
    ["an unreadable count", () => actions.checkCoordinatorTransfer.mockResolvedValue({ kind: "unreadable", why: "count" })],
    ["a refusal", () => actions.checkCoordinatorTransfer.mockResolvedValue({ kind: "refused", refusal: "rate-limited" })],
    ["a thrown action", () => actions.checkCoordinatorTransfer.mockRejectedValue(new Error("network"))],
  ])("draws the plain line, never the card, on %s", async (_label, arrange) => {
    arrange();
    await find();
    expect(await screen.findByText("Live transfer can't be checked right now. Book a time below.", { selector: "p" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Transfer now" })).toBeNull();
  });

  it("never asks for a state it was handed already checking, so a design frame calls nothing", async () => {
    draw(stateOf(newCustomer));
    await act(async () => {});
    expect(actions.checkCoordinatorTransfer).not.toHaveBeenCalled();
  });
});

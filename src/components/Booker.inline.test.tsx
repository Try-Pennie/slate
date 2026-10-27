// @vitest-environment jsdom
//
// #3718: the inline card, the booker drawn inside a landing page by cal.com's
// `Cal("inline")` (widget.js asks for `layout=inline`). The settled design is
// docs/design/inline-booker.html. What this pins:
//  - the card's own title and panel label, from the copy file, and none of the
//    full booker's side panel (the event name, the Pennie mark);
//  - the first bookable day is chosen for the lead, so times show at once;
//  - six times, then View more times;
//  - the ordinary booker is untouched when no layout is asked for.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Booker from "@/components/Booker";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import { bookerSlotIso } from "@/components/booker-test-slot";
import { CALL_ME_NOW_COPY, INLINE_CARD_COPY, PICKER_COPY } from "@/lib/booking/booker-copy";
import { deviceTimeZone, resolveZone, zoneLabel } from "@/lib/booking/timezones";

const firstDay = Array.from({ length: 9 }, (_, i) => bookerSlotIso(3, 9 + i));
const secondDay = [bookerSlotIso(4, 10), bookerSlotIso(4, 11)];

const baseProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
  embedded: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      bucket: { code: "411" },
      orgName: "Pennie",
      eventType: { name: "Advisor Call", description: null, durationMin: 30 },
      slots: [...firstDay, ...secondDay],
    }),
  })) as unknown as typeof fetch;
});

const timeButtons = () =>
  screen.queryAllByRole("button").filter((b) => /^\d{1,2}:\d{2}\s?(am|pm)$/i.test((b.textContent ?? "").trim()));

describe("the inline card (#3718)", () => {
  it("draws the card's title and panel label, and none of the full booker's side panel", async () => {
    render(<Booker {...baseProps} layout="inline" />);
    expect(await screen.findByText(INLINE_CARD_COPY.title)).toBeTruthy();
    expect(screen.getByText(INLINE_CARD_COPY.chooseTime)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Advisor Call" })).toBeNull();
    expect(document.querySelector("[data-org-mark]")).toBeNull();
  });

  it("opens on the first bookable day, showing six of its times and a way to the rest", async () => {
    render(<Booker {...baseProps} layout="inline" />);
    await screen.findByRole("button", { name: PICKER_COPY.viewMore });
    expect(timeButtons()).toHaveLength(6);
    // The chosen day chip already names the day, so no "Times on" line repeats it (L605).
    expect(screen.queryByText(/^Times on /)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: PICKER_COPY.viewMore }));
    expect(timeButtons()).toHaveLength(9);
  });

  it("names the time zone the times are in, in the booker's own words (Dan, 2026-10-14)", async () => {
    render(<Booker {...baseProps} layout="inline" />);
    await screen.findByRole("button", { name: PICKER_COPY.viewMore });
    expect(screen.getByText(INLINE_CARD_COPY.timesIn(zoneLabel(resolveZone(deviceTimeZone()))))).toBeTruthy();
  });

  it("says nothing about a zone when there are no times to describe", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    render(<Booker {...baseProps} layout="inline" />);
    await screen.findByText(INLINE_CARD_COPY.title);
    await screen.findByRole("alert");
    expect(screen.queryByText(/^Times in /)).toBeNull();
  });

  it("opens on the first day with a time the lead can book, skipping a day whose times all fall outside their calling hours", async () => {
    // Day one's times are all after 8pm on the lead's clock, so none can be offered
    // (#2310); opening on it would show a card with no times at all.
    const late = [bookerSlotIso(3, 21), bookerSlotIso(3, 22)];
    const bookable = [bookerSlotIso(4, 10), bookerSlotIso(4, 11)];
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        bucket: { code: "411" },
        orgName: "Pennie",
        eventType: { name: "Advisor Call", description: null, durationMin: 30 },
        slots: [...late, ...bookable],
      }),
    })) as unknown as typeof fetch;
    render(<Booker {...baseProps} layout="inline" />);
    await waitFor(() => expect(timeButtons()).toHaveLength(2));
  });

  it("opens on the first day, which then says why, when no time at all fits the lead's calling hours", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        bucket: { code: "411" },
        orgName: "Pennie",
        eventType: { name: "Advisor Call", description: null, durationMin: 30 },
        slots: [bookerSlotIso(3, 21), bookerSlotIso(4, 22)],
      }),
    })) as unknown as typeof fetch;
    render(<Booker {...baseProps} layout="inline" />);
    // Not a blank card and not the "pick a day" prompt: the first day, chosen, saying
    // its times fall outside the lead's calling hours.
    expect(await screen.findByText(/calling hours|8:00am|8:00pm/i, { selector: "span.block" })).toBeTruthy();
    expect(timeButtons()).toHaveLength(0);
    expect(screen.queryByText(PICKER_COPY.pickADay, { selector: "span.block" })).toBeNull();
  });

  it("leaves the ordinary booker as it was when no layout is asked for", async () => {
    render(<Booker {...baseProps} />);
    expect(await screen.findByRole("heading", { name: "Advisor Call" })).toBeTruthy();
    expect(screen.queryByText(INLINE_CARD_COPY.title)).toBeNull();
    // No day is chosen for the lead on the ordinary booker.
    expect(await screen.findByText(PICKER_COPY.pickADay, { selector: "span.block" })).toBeTruthy();
  });
});

// #3718 step 3: the Call me now row on the card, settled in design rounds 1 to 3.
describe("the inline card's Call me now row (#3718)", () => {
  const CMN = {
    position: "above" as const,
    leadId: "00QUi000010889ZMAQ",
    email: "maria@example.com",
    phone: "2197588170",
    submissionId: "a0XUi000001",
    firstName: "Maria",
  };
  type Answer = { status: number; body: unknown };
  const sent: Record<string, unknown>[] = [];
  function serve(check: Answer, press: Answer | (() => Promise<Answer>)) {
    sent.length = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/call-me-now")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push(body);
        const a = body.action === "check" ? check : typeof press === "function" ? await press() : press;
        return { ok: a.status < 400, status: a.status, json: async () => a.body };
      }
      return {
        ok: true,
        json: async () => ({
          bucket: { code: "411" },
          orgName: "Pennie",
          eventType: { name: "Advisor Call", description: null, durationMin: 30 },
          slots: [...firstDay, ...secondDay],
        }),
      };
    }) as unknown as typeof fetch;
  }
  const OFFERED = { status: 200, body: { offered: true } };
  const callButton = () => screen.findByRole("button", { name: CALL_ME_NOW_COPY.button });

  it("shows the row above the times once the check says the button is offered", async () => {
    serve(OFFERED, { status: 200, body: { outcome: "requested", textLine: null } });
    render(<Booker {...baseProps} layout="inline" callMeNow={CMN} />);
    const button = await callButton();
    const label = screen.getByText(INLINE_CARD_COPY.chooseTime);
    expect(button.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(CALL_ME_NOW_COPY.ready)).toBeTruthy();
    expect(sent[0]).toEqual({ action: "check", leadId: CMN.leadId, email: CMN.email, phone: CMN.phone, submissionId: CMN.submissionId });
  });

  it("paints a host's card colour, with its text colour on the title and on the way back to the times (#3718)", async () => {
    serve(OFFERED, { status: 200, body: { outcome: "requested", textLine: null } });
    const surface = { background: "#1D212F", ink: "var(--pennie-beige)" };
    const { container } = render(<Booker {...baseProps} layout="inline" callMeNow={CMN} cardSurface={surface} />);
    const title = await screen.findByText(INLINE_CARD_COPY.title);
    expect((container.firstElementChild as HTMLElement).style.backgroundColor).toBe("rgb(29, 33, 47)");
    expect(title.style.color).toBe("var(--pennie-beige)");
    fireEvent.click(await callButton());
    const back = await screen.findByText(CALL_ME_NOW_COPY.instead, { exact: false });
    expect(back.style.color).toBe("var(--pennie-beige)");
  });

  it("puts the row below the times when the page asks for below", async () => {
    serve(OFFERED, { status: 200, body: { outcome: "requested", textLine: null } });
    render(<Booker {...baseProps} layout="inline" callMeNow={{ ...CMN, position: "below" }} />);
    const button = await callButton();
    const label = screen.getByText(INLINE_CARD_COPY.chooseTime);
    expect(button.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("shows no row when the check says the button is not offered", async () => {
    serve({ status: 200, body: { offered: false } }, { status: 200, body: {} });
    render(<Booker {...baseProps} layout="inline" callMeNow={CMN} />);
    await screen.findByRole("button", { name: PICKER_COPY.viewMore });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.queryByRole("button", { name: CALL_ME_NOW_COPY.button })).toBeNull();
  });

  it("confirms the call with trypennie's words, the lead's name, a way to text, and a way back to the times", async () => {
    serve(OFFERED, { status: 200, body: { outcome: "requested", textLine: "+12125550188" } });
    render(<Booker {...baseProps} layout="inline" callMeNow={CMN} />);
    fireEvent.click(await callButton());
    expect(await screen.findByText("Thanks, Maria!")).toBeTruthy();
    expect(sent[1]).toEqual({ action: "request", leadId: CMN.leadId, email: CMN.email, phone: CMN.phone, submissionId: CMN.submissionId });
    expect(screen.getByText(CALL_ME_NOW_COPY.momentarily)).toBeTruthy();
    for (const step of CALL_ME_NOW_COPY.steps) expect(screen.getByText(step.title)).toBeTruthy();
    const text = screen.getByRole("link", { name: CALL_ME_NOW_COPY.textButton });
    expect(text.getAttribute("href")).toBe(`sms:+12125550188?&body=${encodeURIComponent(CALL_ME_NOW_COPY.textMessage)}`);
    expect(screen.queryByText(INLINE_CARD_COPY.chooseTime)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: CALL_ME_NOW_COPY.insteadLink }));
    expect(await screen.findByText(INLINE_CARD_COPY.chooseTime)).toBeTruthy();
    expect(screen.queryByRole("button", { name: CALL_ME_NOW_COPY.button })).toBeNull();
  });

  it("offers no Text us when no texting line came back", async () => {
    serve(OFFERED, { status: 200, body: { outcome: "already-requested", textLine: null } });
    render(<Booker {...baseProps} layout="inline" callMeNow={CMN} />);
    fireEvent.click(await callButton());
    await screen.findByText(CALL_ME_NOW_COPY.momentarily);
    expect(screen.queryByRole("link", { name: CALL_ME_NOW_COPY.textButton })).toBeNull();
  });

  it("thanks a lead whose name the page did not send without inventing one", async () => {
    serve(OFFERED, { status: 200, body: { outcome: "requested", textLine: null } });
    render(<Booker {...baseProps} layout="inline" callMeNow={{ ...CMN, firstName: null }} />);
    fireEvent.click(await callButton());
    expect(await screen.findByText("Thanks!")).toBeTruthy();
  });

  it("says the call was not requested, offers Try again, and keeps the times, when Salesforce failed", async () => {
    serve(OFFERED, { status: 503, body: { outcome: "failed", retry: true } });
    render(<Booker {...baseProps} layout="inline" callMeNow={CMN} />);
    fireEvent.click(await callButton());
    expect(await screen.findByText(CALL_ME_NOW_COPY.failedHeading)).toBeTruthy();
    expect(screen.getByText(INLINE_CARD_COPY.chooseTime)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: CALL_ME_NOW_COPY.tryAgain }));
    await waitFor(() => expect(sent.filter((b) => b.action === "request")).toHaveLength(2));
  });

  it("points the lead the right way to the times, whichever side of them the row sits", async () => {
    serve(OFFERED, { status: 503, body: { outcome: "failed", retry: true } });
    const { unmount } = render(<Booker {...baseProps} layout="inline" callMeNow={CMN} />);
    fireEvent.click(await callButton());
    expect(await screen.findByText(CALL_ME_NOW_COPY.failedBody("above"))).toBeTruthy();
    unmount();
    serve(OFFERED, { status: 503, body: { outcome: "failed", retry: true } });
    render(<Booker {...baseProps} layout="inline" callMeNow={{ ...CMN, position: "below" }} />);
    fireEvent.click(await callButton());
    expect(await screen.findByText(CALL_ME_NOW_COPY.failedBody("below"))).toBeTruthy();
    expect(CALL_ME_NOW_COPY.failedBody("below")).toMatch(/above/);
    expect(CALL_ME_NOW_COPY.failedBody("above")).toMatch(/below/);
  });

  it("offers Try again when the press was turned away for coming too often, since that clears", async () => {
    serve(OFFERED, { status: 429, body: { error: "Too many requests. Please try again in a moment." } });
    render(<Booker {...baseProps} layout="inline" callMeNow={CMN} />);
    fireEvent.click(await callButton());
    expect(await screen.findByText(CALL_ME_NOW_COPY.failedHeading)).toBeTruthy();
    expect(screen.getByRole("button", { name: CALL_ME_NOW_COPY.tryAgain })).toBeTruthy();
  });

  it("offers no Try again for a refusal, since retrying cannot change it", async () => {
    serve(OFFERED, { status: 200, body: { outcome: "refused", retry: false } });
    render(<Booker {...baseProps} layout="inline" callMeNow={CMN} />);
    fireEvent.click(await callButton());
    expect(await screen.findByText(CALL_ME_NOW_COPY.failedHeading)).toBeTruthy();
    expect(screen.queryByRole("button", { name: CALL_ME_NOW_COPY.tryAgain })).toBeNull();
    expect(screen.getByText(INLINE_CARD_COPY.chooseTime)).toBeTruthy();
  });

  it("keeps a time the lead picked while the press was in flight, behind Choose a time instead", async () => {
    let answer: (a: Answer) => void = () => {};
    serve(OFFERED, () => new Promise<Answer>((r) => (answer = r)));
    render(<Booker {...baseProps} layout="inline" callMeNow={CMN} />);
    fireEvent.click(await callButton());
    await screen.findByRole("button", { name: new RegExp(CALL_ME_NOW_COPY.pressing) });
    // The lead picks a time while the call is being requested.
    fireEvent.click(timeButtons()[0]!);
    const chosen = await screen.findByRole("textbox", { name: /email/i });
    expect(chosen).toBeTruthy();
    answer({ status: 200, body: { outcome: "requested", textLine: null } });
    // The call is coming, so that is what the card says...
    expect(await screen.findByText(CALL_ME_NOW_COPY.momentarily)).toBeTruthy();
    // ...and the time they picked is still there behind the way back.
    fireEvent.click(screen.getByRole("button", { name: CALL_ME_NOW_COPY.insteadLink }));
    expect(await screen.findByRole("textbox", { name: /email/i })).toBeTruthy();
  });

  it("shows that it is working while the press is in flight", async () => {
    let answer: (a: Answer) => void = () => {};
    serve(OFFERED, () => new Promise<Answer>((r) => (answer = r)));
    render(<Booker {...baseProps} layout="inline" callMeNow={CMN} />);
    fireEvent.click(await callButton());
    const busy = await screen.findByRole("button", { name: new RegExp(CALL_ME_NOW_COPY.pressing) });
    expect(busy.hasAttribute("disabled")).toBe(true);
    answer({ status: 200, body: { outcome: "requested", textLine: null } });
    expect(await screen.findByText(CALL_ME_NOW_COPY.momentarily)).toBeTruthy();
  });
});

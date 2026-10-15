// @vitest-environment jsdom
//
// #3718, Geoff 2026-10-15: the inline card split into two pieces a page places
// separately, and the pop up booker each one opens. What this pins:
//  - the times piece is the times tile only; a picked time and View more times ask
//    the host for the pop up rather than changing the tile;
//  - the Call me now piece is the row only, a press asks for the pop up, and a lead
//    it is not offered to sees nothing at all;
//  - the Call me now pop up makes the request on arrival and shows its confirmation;
//  - the pop up a time opens lands on the details step for that time, or on its day
//    saying the time has gone, and View more times lands on its day.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Booker from "@/components/Booker";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import { bookerSlotIso } from "@/components/booker-test-slot";
import { CALL_ME_NOW_COPY, INLINE_CARD_COPY, PICKER_COPY } from "@/lib/booking/booker-copy";
import { EMBED_MESSAGE, PIECE_MESSAGE } from "@/lib/embed/lifecycle-events";

const firstDay = Array.from({ length: 9 }, (_, i) => bookerSlotIso(3, 9 + i));
const secondDay = [bookerSlotIso(4, 10), bookerSlotIso(4, 11)];
const HOST = "https://host.example";

const baseProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
  embedded: true,
  parentOrigin: HOST,
};
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
function serve(check: Answer = { status: 200, body: { offered: true } }, press: Answer = { status: 200, body: { outcome: "requested", textLine: "+12125550188" } }) {
  sent.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/call-me-now")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      const a = body.action === "check" ? check : press;
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

let posted: unknown[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  serve();
  posted = [];
  vi.spyOn(window.parent, "postMessage").mockImplementation((m: unknown) => {
    posted.push(m);
  });
});
afterEach(() => vi.restoreAllMocks());

const asked = () =>
  posted.filter((m): m is { type: string; data: unknown } => (m as { type?: string })?.type === PIECE_MESSAGE.openBooker);
const timeButtons = () =>
  screen.queryAllByRole("button").filter((b) => /^\d{1,2}:\d{2}\s?(am|pm)$/i.test((b.textContent ?? "").trim()));

describe("the times piece (#3718)", () => {
  it("is the times tile only: no card title and no Call me now row", async () => {
    render(<Booker {...baseProps} layout="inline" piece="times" callMeNow={CMN} />);
    // The file's first render also pays the cold module load, so it gets more than
    // the default second to settle; it still ends the moment the button is there.
    await screen.findByRole("button", { name: PICKER_COPY.viewMore }, { timeout: 5000 });
    expect(screen.getByText(INLINE_CARD_COPY.chooseTime)).toBeTruthy();
    expect(screen.queryByText(INLINE_CARD_COPY.title)).toBeNull();
    expect(screen.queryByRole("button", { name: CALL_ME_NOW_COPY.button })).toBeNull();
    expect(timeButtons()).toHaveLength(6);
    // The Call me now piece beside it asks Salesforce; this one never shows the row,
    // so it asks nothing (one check per visitor, not two).
    expect(sent).toHaveLength(0);
  });

  it("asks the page for the pop up on a picked time, and stays on the times", async () => {
    render(<Booker {...baseProps} layout="inline" piece="times" />);
    await screen.findByRole("button", { name: PICKER_COPY.viewMore });
    fireEvent.click(timeButtons()[1]!);
    expect(asked()).toEqual([{ type: PIECE_MESSAGE.openBooker, data: { slot: firstDay[1] } }]);
    expect(screen.queryByRole("textbox", { name: /email/i })).toBeNull();
    expect(timeButtons()).toHaveLength(6);
  });

  it("asks the page for the pop up on the day for View more times, and does not grow", async () => {
    render(<Booker {...baseProps} layout="inline" piece="times" />);
    fireEvent.click(await screen.findByRole("button", { name: PICKER_COPY.viewMore }));
    const req = asked()[0]?.data as { day: string };
    expect(req.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(timeButtons()).toHaveLength(6);
  });
});

describe("the Call me now piece (#3718)", () => {
  it("is the row only, and a press asks the page for the pop up rather than calling", async () => {
    render(<Booker {...baseProps} layout="inline" piece="callMeNow" callMeNow={CMN} />);
    fireEvent.click(await screen.findByRole("button", { name: CALL_ME_NOW_COPY.button }));
    expect(asked()).toEqual([{ type: PIECE_MESSAGE.openBooker, data: { callMeNow: "press" } }]);
    // Only the check was asked; the request is the pop up's to make.
    expect(sent.map((b) => b.action)).toEqual(["check"]);
    expect(screen.queryByText(INLINE_CARD_COPY.title)).toBeNull();
    expect(screen.queryByText(INLINE_CARD_COPY.chooseTime)).toBeNull();
  });

  it("draws nothing for a lead it is not offered to", async () => {
    serve({ status: 200, body: { offered: false } });
    const { container } = render(<Booker {...baseProps} layout="inline" piece="callMeNow" callMeNow={CMN} />);
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(container.textContent?.trim() ?? "").toBe(""));
  });
});

describe("the Call me now pop up (#3718)", () => {
  it("makes the request on arrival, without asking again whether it is offered, and confirms it", async () => {
    render(<Booker {...baseProps} layout="inline" callMeNow={CMN} pressCallMeNow />);
    expect(await screen.findByText(CALL_ME_NOW_COPY.momentarily)).toBeTruthy();
    expect(sent.map((b) => b.action)).toEqual(["request"]);
    expect(screen.getByRole("link", { name: CALL_ME_NOW_COPY.textButton })).toBeTruthy();
  });
});

describe("the pop up a time opens (#3718)", () => {
  it("lands on the details step for the picked time", async () => {
    render(<Booker {...baseProps} initialSlot={firstDay[4]!} />);
    expect(await screen.findByRole("textbox", { name: /email/i })).toBeTruthy();
  });

  it("lands on that time's day, and says the time has gone, when it is no longer offered", async () => {
    const gone = bookerSlotIso(3, 8);
    render(<Booker {...baseProps} initialSlot={gone} />);
    expect(await screen.findByText(PICKER_COPY.pickedTimeGone)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /email/i })).toBeNull();
    await waitFor(() => expect(timeButtons().length).toBe(9));
  });

  it("lands on the day View more times asked for, with all its times", async () => {
    const day = secondDay[0]!.slice(0, 10);
    render(<Booker {...baseProps} initialDay={day} />);
    await waitFor(() => expect(timeButtons()).toHaveLength(2));
  });
});

// Dan, 2026-10-15: GA4 counts a booker view once per visit, so of a page's frames
// only the times piece announces the booker's stages. The Call me now piece and the
// pop ups stay quiet; a booking is still announced from wherever it is made.
describe("which frame announces the booker's stages (#3718)", () => {
  const stages = () =>
    posted
      .map((m) => (m as { type?: string })?.type)
      .filter((t) => t === EMBED_MESSAGE.bookerViewed || t === EMBED_MESSAGE.bookerReady);

  it("the times piece announces viewed and ready", async () => {
    render(<Booker {...baseProps} layout="inline" piece="times" />);
    await screen.findByRole("button", { name: PICKER_COPY.viewMore });
    await waitFor(() => expect(stages()).toEqual([EMBED_MESSAGE.bookerViewed, EMBED_MESSAGE.bookerReady]));
  });

  it("the Call me now piece, and each pop up, announce nothing", async () => {
    render(<Booker {...baseProps} layout="inline" piece="callMeNow" callMeNow={CMN} />);
    await screen.findByRole("button", { name: CALL_ME_NOW_COPY.button });
    render(<Booker {...baseProps} initialSlot={firstDay[4]!} />);
    await screen.findByRole("textbox", { name: /email/i });
    render(<Booker {...baseProps} layout="inline" callMeNow={CMN} pressCallMeNow />);
    await screen.findByText(CALL_ME_NOW_COPY.momentarily);
    expect(stages()).toEqual([]);
  });
});


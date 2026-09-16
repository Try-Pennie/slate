import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #2412: Google reports a per calendar failure INSIDE a 200 response, as
// `calendars.<key>.errors[]` with reasons like `internalError`, `notFound` and
// `tooManyCalendarsRequested`. The single agent reader used to read only `busy`,
// so an errored calendar arrived as an empty busy list and `isFree` answered
// FREE. That is the permissive answer on the LAST check before `createEvent`:
// the bulk wave refuses to trust the calendar and hands the agent to this
// "accurate fallback", which asked the same calendar, met the same error, and
// said yes.
//
// Both readers now parse through the one tested parser
// (`busyByCalendarFromResponse`), and this reader reports `null` for
// "unreadable" rather than an empty list. `getDelegatedToken` and global fetch
// are stubbed, so nothing here reaches Google.

const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn() }));
vi.mock("@/lib/google/dwd", () => dwd);

import { freeBusy, isFree } from "./calendar";
import { FREEBUSY_MAX_ITEMS } from "@/lib/booking/core";

const START = "2026-06-01T15:00:00.000Z";
const END = "2026-06-01T15:30:00.000Z";

/** Every freeBusy POST body this run saw, so chunking can be measured. */
function captureFetch(reply: (items: { id: string }[]) => unknown) {
  const bodies: { id: string }[][] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { items: { id: string }[] };
    bodies.push(body.items);
    return new Response(JSON.stringify(reply(body.items)), { status: 200 });
  });
  return bodies;
}

describe("freeBusy reads Google's per calendar errors (#2412)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  it("reports unreadable when the only calendar carries an internalError", async () => {
    captureFetch(() => ({
      calendars: { "a@b.com": { errors: [{ domain: "global", reason: "internalError" }] } },
    }));

    expect(await freeBusy("a@b.com", START, END, ["a@b.com"])).toBeNull();
    expect(await isFree("a@b.com", START, END, ["a@b.com"])).toBeNull();
  });

  it("reports unreadable when the calendar carries a notFound error", async () => {
    captureFetch(() => ({
      calendars: { "a@b.com": { errors: [{ domain: "global", reason: "notFound" }], busy: [] } },
    }));

    expect(await freeBusy("a@b.com", START, END, ["a@b.com"])).toBeNull();
    expect(await isFree("a@b.com", START, END, ["a@b.com"])).toBeNull();
  });

  it("reports unreadable when a requested calendar is absent from the response", async () => {
    // A calendar the response never mentions was not measured. That is the same
    // state as an error, and the shape a `tooManyCalendarsRequested` reply takes
    // for the calendars Google dropped.
    captureFetch(() => ({ calendars: {} }));

    expect(await freeBusy("a@b.com", START, END, ["a@b.com"])).toBeNull();
    expect(await isFree("a@b.com", START, END, ["a@b.com"])).toBeNull();
  });

  it("reports unreadable when the response carries no calendars key at all", async () => {
    captureFetch(() => ({}));

    expect(await freeBusy("a@b.com", START, END, ["a@b.com"])).toBeNull();
  });

  it("reports unreadable when ONE of several calendars errored", async () => {
    captureFetch(() => ({
      calendars: {
        "a@b.com": { busy: [] },
        "team@b.com": { errors: [{ reason: "notFound" }] },
      },
    }));

    expect(await freeBusy("a@b.com", START, END, ["a@b.com", "team@b.com"])).toBeNull();
  });

  // The control that stops an over broad fix making every agent unbookable.
  it("still answers FREE for a calendar that is present, clean and empty", async () => {
    captureFetch(() => ({ calendars: { "a@b.com": { busy: [] } } }));

    expect(await freeBusy("a@b.com", START, END, ["a@b.com"])).toEqual([]);
    expect(await isFree("a@b.com", START, END, ["a@b.com"])).toBe(true);
  });

  it("still answers BUSY for a real overlapping busy period", async () => {
    captureFetch(() => ({
      calendars: {
        "a@b.com": {
          busy: [{ start: "2026-06-01T15:10:00.000Z", end: "2026-06-01T15:40:00.000Z" }],
        },
      },
    }));

    expect(await freeBusy("a@b.com", START, END, ["a@b.com"])).toEqual([
      { start: "2026-06-01T15:10:00.000Z", end: "2026-06-01T15:40:00.000Z" },
    ]);
    expect(await isFree("a@b.com", START, END, ["a@b.com"])).toBe(false);
  });

  it("still answers FREE for a real busy period that does not overlap", async () => {
    captureFetch(() => ({
      calendars: {
        "a@b.com": {
          busy: [{ start: "2026-06-01T17:00:00.000Z", end: "2026-06-01T18:00:00.000Z" }],
        },
      },
    }));

    expect(await isFree("a@b.com", START, END, ["a@b.com"])).toBe(true);
  });

  it("reports unreadable for a busy entry whose bounds cannot be read", async () => {
    captureFetch(() => ({
      calendars: { "a@b.com": { busy: [{ start: "not-a-date", end: "also-not" }] } },
    }));

    expect(await freeBusy("a@b.com", START, END, ["a@b.com"])).toBeNull();
    expect(await isFree("a@b.com", START, END, ["a@b.com"])).toBeNull();
  });

  it("asks for nothing and answers free when there are no calendars to read", async () => {
    const bodies = captureFetch(() => ({ calendars: {} }));

    expect(await freeBusy("a@b.com", START, END, [])).toEqual([]);
    expect(bodies).toHaveLength(0);
  });
});

describe("freeBusy chunks at Google's calendar cap (#2412)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  const many = Array.from({ length: FREEBUSY_MAX_ITEMS + 5 }, (_, i) => `cal-${i}@b.com`);

  it("never asks for more than FREEBUSY_MAX_ITEMS calendars in one call", async () => {
    const bodies = captureFetch((items) => ({
      calendars: Object.fromEntries(items.map((i) => [i.id, { busy: [] }])),
    }));

    const busy = await freeBusy("a@b.com", START, END, many);

    expect(busy).toEqual([]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveLength(FREEBUSY_MAX_ITEMS);
    expect(bodies[1]).toHaveLength(5);
    // Every requested calendar was asked about exactly once.
    expect(bodies.flat().map((i) => i.id).sort()).toEqual([...many].sort());
  });

  it("aggregates busy periods across chunks", async () => {
    captureFetch((items) => ({
      calendars: Object.fromEntries(
        items.map((i) => [
          i.id,
          i.id === many[many.length - 1]
            ? { busy: [{ start: "2026-06-01T15:10:00.000Z", end: "2026-06-01T15:20:00.000Z" }] }
            : { busy: [] },
        ]),
      ),
    }));

    // The conflict lives in the SECOND chunk; an answer built from the first
    // chunk alone would report this agent free.
    expect(await isFree("a@b.com", START, END, many)).toBe(false);
  });

  it("reports unreadable when an error lands in the LAST chunk", async () => {
    captureFetch((items) => ({
      calendars: Object.fromEntries(
        items.map((i) => [
          i.id,
          i.id === many[many.length - 1] ? { errors: [{ reason: "internalError" }] } : { busy: [] },
        ]),
      ),
    }));

    expect(await freeBusy("a@b.com", START, END, many)).toBeNull();
    expect(await isFree("a@b.com", START, END, many)).toBeNull();
  });

  it("reports unreadable when an error lands in the FIRST chunk", async () => {
    captureFetch((items) => ({
      calendars: Object.fromEntries(
        items.map((i) => [
          i.id,
          i.id === many[0] ? { errors: [{ reason: "notFound" }] } : { busy: [] },
        ]),
      ),
    }));

    expect(await freeBusy("a@b.com", START, END, many)).toBeNull();
  });
});

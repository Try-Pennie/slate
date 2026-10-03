import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #598: an unexpected fault must return a generic body to the client while the
// real detail (table names, Google error text) stays in the server log only.
// #802: it must also TELL someone. The log has 7-day retention and nothing
// watching it, so a silent 500 is only ever found by someone going to look.

const dispatch = vi.hoisted(() => ({ sendThrottledAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/dispatch", () => dispatch);

import { internalErrorResponse, reportInternalError, INTERNAL_ERROR_COOLDOWN_MS } from "@/lib/api/errors";

beforeEach(() => {
  vi.clearAllMocks();
  dispatch.sendThrottledAlert.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("internalErrorResponse", () => {
  it("returns a generic 500 body that does NOT leak the error message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await internalErrorResponse(
      new Error('relation "bookings" does not exist'),
      "cancel",
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toMatch(/bookings|does not exist/);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("logs the real error with its context so detail is retained server-side", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("Google 503 backend error");
    await internalErrorResponse(err, "reschedule");
    expect(spy).toHaveBeenCalled();
    // The context label and the real error both reach the log.
    const logged = spy.mock.calls[0];
    expect(JSON.stringify(logged)).toContain("reschedule");
    expect(logged).toContain(err);
  });

  it("handles a non-Error throw without leaking its stringification", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await internalErrorResponse("raw string blow up", "booking");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("blow up");
  });
});

describe("internalErrorResponse alerting (#802)", () => {
  it("fires a throttled alert carrying the route context and the real detail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await internalErrorResponse(new Error("Google 503 backend error"), "admin/bookings/[id]/cancel");

    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, text] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [
      string,
      number,
      string,
    ];
    // Keyed PER CONTEXT: a persistently-broken route must not throttle away the
    // first alert from a different route that breaks at the same time.
    expect(key).toContain("admin/bookings/[id]/cancel");
    expect(cooldown).toBe(INTERNAL_ERROR_COOLDOWN_MS);
    // Slack is internal, so the alert (unlike the client body) SHOULD name the fault.
    expect(text).toContain("admin/bookings/[id]/cancel");
    expect(text).toContain("Google 503 backend error");
  });

  it("uses a different throttle key per route so one noisy route cannot mask another", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await internalErrorResponse(new Error("boom"), "booking");
    await internalErrorResponse(new Error("boom"), "bookings/reassign");

    const calls = dispatch.sendThrottledAlert.mock.calls as unknown as [string, number, string][];
    const keys = calls.map((c) => c[0]);
    expect(new Set(keys).size).toBe(2);
  });

  // The failure path is the whole point of the fail-loud rule: the alert writes to
  // alert_state, so whatever broke the route can break the alert too. A monitoring
  // outage must never turn a 500 into a crash (or into a 200).
  it("still returns the generic 500 when the alert itself throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack is down"));

    const res = await internalErrorResponse(new Error("db exploded"), "booking");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("db exploded");
    expect(body.error).not.toContain("slack");
    // The alert's own failure is itself logged, never swallowed into silence.
    // #808: the Error is passed THROUGH as the second argument (so Cloudflare
    // serializes its stack) rather than being flattened into the message, so assert
    // on the argument itself, not on a stringified copy of the call.
    const loggedErrors = errSpy.mock.calls.map((c) => c[1]);
    expect(loggedErrors.some((e) => e instanceof Error && e.message === "slack is down")).toBe(true);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("tag=api"))).toBe(true);
  });

  it("reportInternalError alerts without producing a response (for non-response 500 paths)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError(new Error("bot api blew up"), "bookings-api/book");

    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [
      string,
      number,
      string,
    ];
    expect(key).toContain("bookings-api/book");
    expect(text).toContain("bot api blew up");
  });

  // #1135: this is the chokepoint for EVERY unexpected fault, so whatever a
  // library decides to throw ends up in Slack here. It used to hard-slice the
  // message at a fixed width, which is how the 2026-07-28 sync page became eight
  // lines of JSON cut off mid-word at `"mess`. A page is read on a phone during an
  // incident: it has to be one readable sentence, with the full text left in the
  // Worker log, which Cloudflare stores complete.
  describe("the alert body stays readable whatever was thrown (#1135)", () => {
    const alertText = () =>
      (dispatch.sendThrottledAlert.mock.calls[0] as unknown as [string, number, string])[2];

    it("collapses a multi-line error to a single line", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await reportInternalError(
        new Error('SQL compilation error:\nsyntax error line 3 at position 8\nunexpected CURRENT'),
        "snowflake",
      );

      const body = alertText();
      expect(body.split("\n")).toHaveLength(1);
      expect(body).toContain("SQL compilation error");
    });

    it("never cuts a word in half when the message is too long", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      // Long enough to force truncation, with a distinctive final word that must
      // not survive as a fragment.
      await reportInternalError(new Error(`${"diagnosis ".repeat(40)}supercalifragilistic`), "book");

      const body = alertText();
      expect(body).not.toMatch(/supercalifragil(?!istic)/);
      expect(body.length).toBeLessThan(600);
    });

    // This alert is the on-call reader's FIRST diagnostic for a fault nobody
    // predicted, so it gets a wider budget than a routine page whose cause is
    // already named in its copy. Wider, not unbounded, and still whole words and
    // one line: readable and useful are not in tension here.
    it("carries more detail than a routine alert, still one line and whole words", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await reportInternalError(new Error(`${"diagnosis ".repeat(40)}supercalifragilistic`), "book");

      const body = alertText();
      expect(body.length).toBeGreaterThan(250);
      expect(body).not.toMatch(/supercalifragil(?!istic)/);
      expect(body.split("\n")).toHaveLength(1);
    });

    // #3143: a library error can quote the row or request it failed on, and this
    // detail goes to Slack. The client error beacon already scrubbed its own text;
    // this chokepoint carried every OTHER fault's message through untouched.
    it("scrubs contact data out of the detail before it reaches Slack", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await reportInternalError(
        new Error(
          'duplicate key value violates unique constraint: Key (attendee_email)=(jane.doe@example.com) ' +
            "phone (203) 561-5295 from /book?bucket=411&name=Jane%20Doe&email=jane%40example.com",
        ),
        "book",
      );

      const body = alertText();
      expect(body).not.toContain("jane.doe@example.com");
      expect(body).not.toContain("561-5295");
      expect(body).not.toContain("Jane%20Doe");
      expect(body).not.toContain("jane%40example.com");
      // The diagnosis survives around the markers.
      expect(body).toContain("duplicate key value");
      expect(body).toContain("[email]");
      expect(body).toContain("[phone]");
      expect(body).toContain("/book");
    });

    it("keeps the full, unscrubbed error in the log, where the diagnosis is read from", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const err = new Error("insert failed for jane.doe@example.com");
      await reportInternalError(err, "book");
      expect(alertText()).not.toContain("jane.doe@example.com");
      const args = logged.mock.calls.flat();
      expect(args.some((a) => a === err || String(a).includes("jane.doe@example.com"))).toBe(true);
    });

    it("keeps a raw JSON body out of the page entirely", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await reportInternalError(
        new Error('events.list failed: 503 {\n  "error": {\n    "reason": "backendError"\n  }\n}'),
        "sync",
      );

      const body = alertText();
      // The useful half (status plus Google's machine reason) survives; the braces
      // and quoting do not.
      expect(body).toContain("503 backendError");
      expect(body).not.toMatch(/[{}]/);
    });
  });
});

// #2788: the browser error beacon raises its alerts through this same chokepoint,
// keyed `client_error:<surface>`, and nothing returned a 500 there: the beacon
// answers 204 and the page was whatever the browser showed. A sentence claiming a
// 500 sends the reader hunting a server fault that did not happen (L11).
describe("a browser error report is not a server fault (#2788)", () => {
  const alertText = () =>
    (dispatch.sendThrottledAlert.mock.calls[0] as unknown as [string, number, string])[2];

  it("a client_error alert never says 500 and names the page it came from", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError(new Error("error on /book/411: TypeError: x is undefined"), "client_error:book");

    const body = alertText();
    expect(body).not.toMatch(/500/);
    expect(body).not.toMatch(/server error/i);
    expect(body).toMatch(/browser reported an error/i);
    expect(body).toContain("/book");
    expect(body).toContain("TypeError: x is undefined");
  });

  it("the home page surface reads as a page, not as a key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError(new Error("error on /: boom"), "client_error:root");

    const body = alertText();
    expect(body).not.toMatch(/500/);
    expect(body).not.toContain("client_error");
    expect(body).not.toMatch(/\broot\b/);
  });

  it("the `other` alert still LEADS with its count sentence (#2755) and never says 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError(
      new Error("40 reports from pages Slate does not serve in the last 30 minutes; latest: error on /wp-login.php: boom"),
      "client_error:other",
    );

    const body = alertText();
    expect(body.startsWith("40 reports from pages Slate does not serve")).toBe(true);
    expect(body).not.toMatch(/500/);
    expect(body).not.toContain("client_error");
  });

  it("a real server fault still says the caller got a 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError(new Error("db exploded"), "POST /api/bookings");

    expect(alertText()).toMatch(/generic 500/);
  });

  it("keeps the throttle key unchanged, so the catalog entry and cooldown still apply", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError(new Error("error on /book: boom"), "client_error:book");

    const [key, cooldown] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [string, number, string];
    expect(key).toBe("internal_error:client_error:book");
    expect(cooldown).toBe(INTERNAL_ERROR_COOLDOWN_MS);
  });
});

// A plain object throw (a supabase-js PostgrestError is `{ message, code,
// details, hint }`, not an Error) reached Slack as "[object Object]" through
// `String(err)`, which threw away the one fact the page exists to carry.
describe("the alert detail reads whatever shape was thrown", () => {
  const alertText = () =>
    (dispatch.sendThrottledAlert.mock.calls[0] as unknown as [string, number, string])[2];

  it("an Error renders its message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError(new Error("connection reset"), "book");
    expect(alertText()).toContain("connection reset");
  });

  it("a PostgrestError shaped object renders its message and code, scrubbed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError(
      {
        message: "duplicate key value violates unique constraint for jane.doe@example.com",
        code: "23505",
        details: "Key (attendee_email)=(jane.doe@example.com) already exists.",
        hint: null,
      },
      "book",
    );
    const body = alertText();
    expect(body).not.toContain("[object Object]");
    expect(body).toContain("duplicate key value violates unique constraint");
    expect(body).toContain("23505");
    expect(body).not.toContain("jane.doe@example.com");
  });

  it("a string renders as itself", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError("raw string blow up", "book");
    expect(alertText()).toContain("raw string blow up");
  });

  it("an object with no message never renders as [object Object]", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError({ status: 418 }, "book");
    const body = alertText();
    expect(body).not.toContain("[object Object]");
    expect(body).toContain("418");
  });

  it("undefined says there was no detail rather than printing undefined", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError(undefined, "book");
    const body = alertText();
    expect(body).not.toContain("undefined");
    expect(body).toContain("no detail");
  });
});

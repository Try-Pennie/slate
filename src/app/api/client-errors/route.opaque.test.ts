import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRateLimits, type FakeRateLimits } from "../../../../scripts/lib/fake-rate-limits";

// #3323: opaque cross origin script errors from the booker.
//
// "Script error." with no file, line and column 0 and no stack is the browser's
// sanitised report of an error thrown by a script from ANOTHER origin (an
// extension, a translator, an in app browser's injection). Slate serves its own
// bundles same origin, so nothing in one of these can be acted on, and each one
// used to page. These tests drive the real route and the real counter end to end,
// over a fake of the `rate_limit_hit` RPC with the SQL's own semantics, so the
// threshold is tested where it is decided rather than asserted of a mock.
//
// Kept apart from route.test.ts because that file mocks the counter module whole,
// and the point here is that the counter is NOT mocked.

const reportInternalError = vi.hoisted(() => vi.fn(async (_err: unknown, _context: string) => {}));
vi.mock("@/lib/api/errors", () => ({ reportInternalError }));
const sendThrottledAlert = vi.hoisted(() => vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}));
const sendThrottledInfo = vi.hoisted(() => vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, sendThrottledInfo }));
// Each report's address, so one lead's browser and many leads' browsers can be told apart.
const clientIp = vi.hoisted(() => vi.fn(() => "203.0.113.1"));
vi.mock("@/lib/rate-limit", () => ({
  allowRequest: vi.fn(async () => true),
  clientIp,
  CLIENT_ERROR_RATE_RULES: [{ prefix: "clienterr:h", windowSeconds: 3600, max: 60 }],
}));
const resolveTestTraffic = vi.hoisted(() => vi.fn(async (): Promise<boolean> => false));
vi.mock("@/lib/monitor/test-traffic", () => ({ resolveTestTraffic }));

let db: FakeRateLimits;
const override = vi.hoisted(() => ({ rpc: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    rpc: (name: string, args: Record<string, unknown>) => (override.rpc ? override.rpc() : db.rpc(name, args)),
    from: (table: string) => db.from(table),
  }),
}));

import { POST } from "./route";
import { log } from "@/lib/log";
import { PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
import { OPAQUE_BURST_THRESHOLD, OPAQUE_BURST_WINDOW_MS } from "@/lib/api/boundary-count";

const post = (body: unknown, ip = "203.0.113.1") => {
  clientIp.mockReturnValue(ip);
  return POST(
    new Request("https://slate.test/api/client-errors", {
      method: "POST",
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
  );
};

/** Exactly what the beacon sends for a cross origin error: the browser gives it
 *  no file (an empty `filename`), line and column 0, and no error object. */
const OPAQUE = { kind: "error", message: "Script error.", page: "/book", source: "", line: 0, col: 0, stack: null };

const address = (n: number) => `203.0.113.${n}`;

/** The two dash characters the copy rules forbid, named by code point so this
 *  file holds neither. */
const FORBIDDEN_DASHES = [0x2014, 0x2013].map((cp) => String.fromCodePoint(cp));

beforeEach(() => {
  vi.clearAllMocks();
  db = fakeRateLimits();
  override.rpc = null;
  resolveTestTraffic.mockResolvedValue(false);
});

describe("an opaque cross origin script error (#3323)", () => {
  it("a single opaque report sends no alert but is logged and counted", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const res = await post(OPAQUE);
    expect(res.status).toBe(204);
    expect(reportInternalError).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(sendThrottledInfo).not.toHaveBeenCalled();
    // Logged under the beacon's own tag, with the count it now stands at.
    expect(warn).toHaveBeenCalledWith(
      "client-errors",
      expect.objectContaining({ msg: "opaque cross origin script error", page: "/book", addresses: 1 }),
    );
    // Counted: the burst counter for the booker now holds one address.
    expect(db.rows.get("opaque_script_error_count:client_error:book")?.count).toBe(1);
    // The address is a counter key, never a log field (a line names no lead).
    expect(JSON.stringify(warn.mock.calls)).not.toContain("203.0.113.1");
    warn.mockRestore();
  });

  it("one lead's browser reloading and retrying never pages, however often", async () => {
    for (let i = 0; i < 30; i++) await post(OPAQUE, address(1));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it("one address short of the threshold does not page", async () => {
    for (let n = 1; n < OPAQUE_BURST_THRESHOLD; n++) await post(OPAQUE, address(n));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it("a burst at the threshold pages once, on its own key, with copy that carries no raw error", async () => {
    for (let n = 1; n <= OPAQUE_BURST_THRESHOLD; n++) await post(OPAQUE, address(n));
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, text] = sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe("opaque_script_errors:book");
    // The cooldown is the window, so a burst that goes on pages once per window.
    expect(cooldown).toBe(OPAQUE_BURST_WINDOW_MS);
    expect(text).toContain(`${OPAQUE_BURST_THRESHOLD} different`);
    expect(text).toContain("/book");
    expect(text).not.toContain("Script error.");
    expect(text).not.toMatch(/^Slate/);
    for (const dash of FORBIDDEN_DASHES) expect(text).not.toContain(dash);
    // It is not a server fault, so it never rides the 500 chokepoint.
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it("a counter that cannot answer logs it and does not page", async () => {
    override.rpc = async () => ({ data: null, error: { message: "rpc down" } });
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    await post(OPAQUE);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(reportInternalError).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  // CONTROLS: anything carrying real detail is somebody's to act on, and pages
  // exactly as it did before, whatever its message says.
  it("CONTROL: a same origin error with a source and position still pages", async () => {
    await post({
      kind: "error",
      message: "TypeError: slots.map is not a function",
      page: "/book",
      source: "https://slate.trypennie.app/_next/static/chunks/booker.js",
      line: 1,
      col: 4821,
    });
    expect(reportInternalError).toHaveBeenCalledOnce();
    expect(reportInternalError.mock.calls[0]![1]).toBe("client_error:book");
    expect(db.rows.size).toBe(0);
  });

  it("CONTROL: a same origin error with a stack still pages", async () => {
    await post({ kind: "error", message: "Cannot read properties of undefined", page: "/book", stack: "at submit (main.js:1:20)" });
    expect(reportInternalError).toHaveBeenCalledOnce();
  });

  it("Script error. WITH a stack still pages", async () => {
    await post({ ...OPAQUE, stack: "Error: Script error.\n    at x (https://slate.trypennie.app/a.js:1:2)" });
    expect(reportInternalError).toHaveBeenCalledOnce();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("Script error. WITH a source still pages", async () => {
    await post({ ...OPAQUE, source: "https://slate.trypennie.app/_next/static/chunks/a.js", line: 3, col: 9 });
    expect(reportInternalError).toHaveBeenCalledOnce();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("an opaque report on a test bucket takes the test bucket path and is not counted", async () => {
    resolveTestTraffic.mockResolvedValue(true);
    await post({ ...OPAQUE, bucketCode: PUBLIC_TEST_BUCKET_CODES[0] });
    expect(sendThrottledInfo).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(db.rows.size).toBe(0);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRateLimits, type FakeRateLimits } from "../../../../scripts/lib/fake-rate-limits";

// Browser errors that did not come from Slate's own code (L477).
//
// A browser extension's script runs inside the booker, so its uncaught errors reach
// the beacon exactly as Slate's do. On 2026-10-29 at 12:14 ET this paged as
// "unhandledrejection on /book: Failed to connect to MetaMask", and the logged report's
// only stack frame was MetaMask's own `chrome-extension://` script. Slate has no wallet
// code, so nobody could act on it.
//
// These drive the real route and the real counter over a fake of the `rate_limit_hit`
// RPC, the way route.opaque.test.ts does, so the count is tested where it is decided.

const reportInternalError = vi.hoisted(() => vi.fn(async (_err: unknown, _context: string) => {}));
vi.mock("@/lib/api/errors", () => ({ reportInternalError }));
const sendThrottledAlert = vi.hoisted(() => vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}));
const sendThrottledInfo = vi.hoisted(() => vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, sendThrottledInfo }));
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
import { UNATTRIBUTED_REJECTION_BURST_THRESHOLD, UNATTRIBUTED_REJECTION_WINDOW_MS } from "@/lib/api/boundary-count";

const post = (body: unknown, ip = "203.0.113.1") => {
  clientIp.mockReturnValue(ip);
  return POST(
    new Request("https://slate.test/api/client-errors", {
      method: "POST",
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
  );
};

/** The report that paged on 2026-10-29, as the beacon sends it: the rejection's
 *  message and its stack, whose one frame is MetaMask's injected provider. */
const METAMASK = {
  kind: "unhandledrejection",
  message: "Failed to connect to MetaMask",
  page: "/book",
  stack:
    "i: Failed to connect to MetaMask\n" +
    "    at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:12:4822)",
};

const SLATE_FRAME = "    at submit (https://slate.trypennie.app/_next/static/chunks/0booker.js:1:20345)";

/** A rejection naming no file and no frame at all: what a provider rejecting with a
 *  plain value sends, and also what a Slate fault without a stack would look like. */
const UNLOCATED = { kind: "unhandledrejection", message: "[object Object]", page: "/book", stack: null };

const address = (n: number) => `203.0.113.${n}`;

const FORBIDDEN_DASHES = [0x2014, 0x2013].map((cp) => String.fromCodePoint(cp));

beforeEach(() => {
  vi.clearAllMocks();
  db = fakeRateLimits();
  override.rpc = null;
  resolveTestTraffic.mockResolvedValue(false);
});

describe("an error whose every location is a browser extension's", () => {
  it("the measured MetaMask report never pages, and is logged below error with the reason", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const res = await post(METAMASK);
    expect(res.status).toBe(204);
    expect(reportInternalError).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(sendThrottledInfo).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "client-errors",
      expect.objectContaining({
        msg: "browser extension error",
        page: "/book",
        kind: "unhandledrejection",
        scheme: "chrome-extension",
        message: "Failed to connect to MetaMask",
        reason: expect.stringContaining("extension"),
      }),
    );
    // Nothing counted: the attribution is definite, so there is no burst to watch for.
    expect(db.rows.size).toBe(0);
    warn.mockRestore();
    error.mockRestore();
  });

  it("a window error whose file is an extension's never pages", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await post({ kind: "error", message: "boom", page: "/book", source: "moz-extension://4f1c2b/content.js", line: 3, col: 9 });
    expect(reportInternalError).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("client-errors", expect.objectContaining({ msg: "browser extension error", scheme: "moz-extension" }));
    warn.mockRestore();
  });

  // CONTROLS: Slate's own code on the stack means Slate's fault is possible, so it
  // pages exactly as before, whatever else is on the stack and whatever it says.
  it("CONTROL: the same message with a Slate bundle frame still pages", async () => {
    await post({ ...METAMASK, stack: `TypeError: Failed to connect to MetaMask\n${SLATE_FRAME}` });
    expect(reportInternalError).toHaveBeenCalledOnce();
    expect(reportInternalError.mock.calls[0]![1]).toBe("client_error:book");
  });

  it("CONTROL: an extension frame AND a Slate frame still pages", async () => {
    await post({ ...METAMASK, stack: `${METAMASK.stack}\n${SLATE_FRAME}` });
    expect(reportInternalError).toHaveBeenCalledOnce();
  });

  it("CONTROL: a window error with a Slate file still pages", async () => {
    await post({
      kind: "error",
      message: "TypeError: slots.map is not a function",
      page: "/book",
      source: "https://slate.trypennie.app/_next/static/chunks/booker.js",
      line: 1,
      col: 4821,
    });
    expect(reportInternalError).toHaveBeenCalledOnce();
  });

  it("a boundary catch is never excused by this rule: React reports it from Slate's own tree", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    await post({ ...METAMASK, kind: "boundary" });
    expect(errorLog).toHaveBeenCalledWith("client-errors", expect.objectContaining({ msg: "page boundary caught" }), expect.anything());
    errorLog.mockRestore();
  });
});

describe("an unhandled rejection that names no location at all", () => {
  it("one report never pages, but is logged with its message and counted", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await post(UNLOCATED);
    expect(reportInternalError).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "client-errors",
      expect.objectContaining({ msg: "unattributed unhandled rejection", page: "/book", message: "[object Object]", addresses: 1 }),
    );
    expect(db.rows.get("unattributed_rejection_count:client_error:book")?.count).toBe(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("203.0.113.1");
    warn.mockRestore();
  });

  it("one lead's browser reloading never pages, however often", async () => {
    for (let i = 0; i < 30; i++) await post(UNLOCATED, address(1));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it("one address short of the threshold does not page", async () => {
    for (let n = 1; n < UNATTRIBUTED_REJECTION_BURST_THRESHOLD; n++) await post(UNLOCATED, address(n));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  // The failure path this rule must not hide: a Slate fault that rejects with no
  // stack on every load breaks the booker for everybody, and still pages.
  it("a burst across addresses pages once, on its own key, with copy carrying no raw error", async () => {
    for (let n = 1; n <= UNATTRIBUTED_REJECTION_BURST_THRESHOLD; n++) await post(UNLOCATED, address(n));
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, text] = sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe("unattributed_rejections:book");
    expect(cooldown).toBe(UNATTRIBUTED_REJECTION_WINDOW_MS);
    expect(text).toContain(`${UNATTRIBUTED_REJECTION_BURST_THRESHOLD} different`);
    expect(text).toContain("/book");
    expect(text).not.toContain("[object Object]");
    expect(text).not.toMatch(/^Slate/);
    for (const dash of FORBIDDEN_DASHES) expect(text).not.toContain(dash);
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it("is counted apart from opaque script errors, so neither population fills the other's burst", async () => {
    for (let n = 1; n < UNATTRIBUTED_REJECTION_BURST_THRESHOLD; n++) await post(UNLOCATED, address(n));
    await post({ kind: "error", message: "Script error.", page: "/book", source: "", line: 0, col: 0, stack: null }, address(99));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(db.rows.get("opaque_script_error_count:client_error:book")?.count).toBe(1);
  });

  it("a counter that cannot answer logs it at error and does not page", async () => {
    override.rpc = async () => ({ data: null, error: { message: "rpc down" } });
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    await post(UNLOCATED);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(reportInternalError).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("CONTROL: a window error with no location and a real message still pages as before", async () => {
    await post({ kind: "error", message: "Cannot read properties of undefined", page: "/book" });
    expect(reportInternalError).toHaveBeenCalledOnce();
  });

  it("an extension or unlocated report on a test bucket takes the test bucket path", async () => {
    resolveTestTraffic.mockResolvedValue(true);
    await post({ ...UNLOCATED, bucketCode: PUBLIC_TEST_BUCKET_CODES[0] });
    await post({ ...METAMASK, bucketCode: PUBLIC_TEST_BUCKET_CODES[0] });
    expect(sendThrottledInfo).toHaveBeenCalledTimes(2);
    expect(db.rows.size).toBe(0);
  });
});

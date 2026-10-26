import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseSlateLine } from "@/lib/log-shipping/parse-line";

// #4237 (L809): the line this public beacon really writes, through the real `log`,
// for a report a stranger built to forge fields. `route.test.ts` mocks the logger
// to assert on fields; this file keeps it real so it sees the rendered line.

const limiter = vi.hoisted(() => ({
  allowRequest: vi.fn(async () => true),
  clientIp: vi.fn(() => "203.0.113.7"),
  CSP_REPORT_RATE_RULES: [{ prefix: "csp:m", windowSeconds: 60, max: 20 }],
}));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
}));
const settings = vi.hoisted(() => ({
  loadMonitorCooldowns: vi.fn(async (_tag: string) => ({ csp_violation: 60 * 60_000 }) as Record<string, number>),
}));
vi.mock("@/lib/rate-limit", () => limiter);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/monitor/settings", () => settings);

import { POST } from "./route";

const BACKSLASH = "\u005c";
const LF = "\u000a";
const CR = "\u000d";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

/** A report-only report, which the route logs with `paged=false` and never pages. */
function forgedReport(fields: { document: string; blocked: string }, userAgent: string) {
  return new Request("https://slate.trypennie.app/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report", "user-agent": userAgent },
    body: JSON.stringify({
      "csp-report": {
        "document-uri": fields.document,
        "violated-directive": "script-src",
        "blocked-uri": fields.blocked,
        disposition: "report",
      },
    }),
  }) as unknown as Parameters<typeof POST>[0];
}

/** The keys of a line, read as any reader of `key="value"` reads them: a backslash
 *  escapes the next character and a quote ends the value. */
function keysOf(line: string): string[] {
  const field = / ([A-Za-z_][A-Za-z0-9_]*)=("(?:\\.|[^"\\])*"|[^\s"]\S*)/g;
  return [...line.matchAll(field)].map((m) => m[1]!);
}

describe("the csp-report log line for a forged report (#4237)", () => {
  it("keeps every stranger's value in its own field on one line, and paged stays false", async () => {
    const blocked = `x${BACKSLASH}" paged=true`;
    const document = `https://slate.trypennie.app/book${LF}slate tag=csp-report paged=true${CR}${LF}`;
    const userAgent = `Mozilla/5.0 ${BACKSLASH}" not_paged=forged`;

    const res = await POST(forgedReport({ document, blocked }, userAgent));
    expect(res.status).toBe(204);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).not.toMatch(/[\r\n]/);

    const keys = keysOf(line);
    expect(keys.filter((k) => k === "paged")).toEqual(["paged"]);
    expect(keys.filter((k) => k === "not_paged")).toEqual(["not_paged"]);
    expect(keys.filter((k) => k === "tag")).toEqual(["tag"]);

    const fields = parseSlateLine(line);
    expect(fields?.paged).toBe(false);
    expect(fields?.not_paged).toBe("report-only");
    expect(fields?.blocked).toBe(blocked);
    expect(fields?.document).toBe(document);
    expect(fields?.user_agent).toBe(userAgent);
  });
});

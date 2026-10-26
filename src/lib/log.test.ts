import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, formatLine } from "./log";

// #808: log lines used to be hand-rolled at each call site, each picking its own
// method, prefix and format. That inconsistency is how #801 happened: six
// operational lines had drifted onto console.log, the one method Cloudflare
// stores with NO level, making them invisible to every level-filtered query.
//
// So this helper owns two things that must never again be decided per call site:
// the LEVEL (never console.log) and a searchable TAG.

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("formatLine", () => {
  it("stamps the service and the tag so a query can filter by subsystem", () => {
    expect(formatLine("recompute", { msg: "refreshed" })).toBe(
      'slate tag=recompute msg="refreshed"',
    );
  });

  it("renders scalar fields as key=value, in the order given", () => {
    expect(formatLine("recompute", { msg: "refreshed", util: 42, drained: true })).toBe(
      'slate tag=recompute msg="refreshed" util=42 drained=true',
    );
  });

  it("quotes strings (so a value with spaces stays one field) but never numbers or booleans", () => {
    const line = formatLine("booking-api", { msg: "authenticated request", key: "primary", n: 0 });
    expect(line).toBe('slate tag=booking-api msg="authenticated request" key="primary" n=0');
  });

  it("escapes a quote inside a value rather than breaking the field apart", () => {
    expect(formatLine("t", { msg: 'he said "hi"' })).toBe('slate tag=t msg="he said \\"hi\\""');
  });

  it("omits null and undefined fields instead of printing them as text", () => {
    expect(formatLine("t", { msg: "x", a: null, b: undefined, c: 1 })).toBe(
      'slate tag=t msg="x" c=1',
    );
  });

  it("works with no fields at all", () => {
    expect(formatLine("t", {})).toBe("slate tag=t");
  });
});

// #4237 (L809): the public beacons log strings a stranger controls. A value has to
// stay ONE field on ONE line however it is spelled, or a forged report can append
// `paged=true` to a csp-report line, or a whole fake line, and mislead whoever
// reads the logs during an incident.
describe("formatLine with a value a stranger wrote (#4237)", () => {
  /** The keys a line holds, read the way any reader of `key="value"` reads it: a
   *  backslash escapes the next character, and a quote ends the value. */
  function keysOf(line: string): string[] {
    const keys: string[] = [];
    const field = / ([A-Za-z_][A-Za-z0-9_]*)=("(?:\\.|[^"\\])*"|[^\s"]\S*)/g;
    for (const m of line.matchAll(field)) keys.push(m[1]!);
    return keys;
  }

  const BACKSLASH = "\u005c";
  const LF = "\u000a";
  const CR = "\u000d";

  it("keeps a backslash then a quote inside the value, so no forged field appears", () => {
    const forged = `x${BACKSLASH}" paged=true`;
    const line = formatLine("csp-report", { blocked: forged, paged: false });
    expect(keysOf(line)).toEqual(["tag", "blocked", "paged"]);
    expect(line).toBe('slate tag=csp-report blocked="x\\\\\\" paged=true" paged=false');
  });

  it("keeps a value that ends in a backslash from swallowing the next field", () => {
    const line = formatLine("t", { a: `ends${BACKSLASH}`, b: 1 });
    expect(keysOf(line)).toEqual(["tag", "a", "b"]);
  });

  it("never lets a line feed or a carriage return start a second line", () => {
    const forged = `x${LF}slate tag=csp-report paged=true${CR}${LF}more`;
    const line = formatLine("csp-report", { document: forged, paged: false });
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.split(LF)).toHaveLength(1);
    expect(keysOf(line)).toEqual(["tag", "document", "paged"]);
    expect(line).toBe('slate tag=csp-report document="x\\nslate tag=csp-report paged=true\\r\\nmore" paged=false');
  });

  it("writes a tab and every other control character as an escape, never raw", () => {
    const line = formatLine("t", { v: `a\u0009b\u0000c\u001bd\u007fe\u2028f` });
    expect(line).toBe('slate tag=t v="a\\tb\\u0000c\\u001bd\\u007fe\\u2028f"');
    expect(line).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/);
  });

  it("renders ordinary values exactly as before, so no existing log query changes", () => {
    expect(formatLine("t", { msg: "lane timings", url: "https://slate.trypennie.app/book?xbc=411#x" })).toBe(
      'slate tag=t msg="lane timings" url="https://slate.trypennie.app/book?xbc=411#x"',
    );
    expect(formatLine("t", { msg: 'he said "hi"' })).toBe('slate tag=t msg="he said \\"hi\\""');
    expect(formatLine("t", { msg: "caf\u00e9 \u2192 ok", n: 3, ok: true })).toBe(
      'slate tag=t msg="caf\u00e9 \u2192 ok" n=3 ok=true',
    );
  });
});

describe("log", () => {
  it("routes info to console.info (never console.log, which Cloudflare stores with no level)", () => {
    log.info("recompute", { msg: "refreshed", util: 42 });
    expect(info).toHaveBeenCalledWith('slate tag=recompute msg="refreshed" util=42');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("routes warn to console.warn", () => {
    log.warn("lane-watchdog", { msg: "stale lane", lane: "outbox" });
    expect(warn).toHaveBeenCalledWith('slate tag=lane-watchdog msg="stale lane" lane="outbox"');
  });

  it("routes error to console.error", () => {
    log.error("sync", { msg: "sync failed" });
    expect(error).toHaveBeenCalledWith('slate tag=sync msg="sync failed"');
  });

  // #708 verified Cloudflare serializes a passed Error object. That is how the
  // stack survives to the logs, so the helper must pass the Error THROUGH as a
  // second argument rather than flattening it into the string.
  it("passes an Error object through to console.error so its stack is serialized", () => {
    const err = new Error("db exploded");
    log.error("booking", { msg: "insert failed" }, err);
    expect(error).toHaveBeenCalledWith('slate tag=booking msg="insert failed"', err);
  });

  it("omits the second argument entirely when there is no Error", () => {
    log.error("booking", { msg: "insert failed" });
    expect(error.mock.calls[0]).toHaveLength(1);
  });

  // #1188: warn is the correct severity for a failure with a documented backstop,
  // which is most best-effort work. Without a third parameter those sites had to
  // flatten the error to one line, which keeps it searchable but discards the
  // stack, the part that says WHERE it broke. Promoting them to error instead
  // would overstate severity on paths that genuinely self-heal and would pollute
  // error-level queries, so warn carries the Error the same way.
  it("passes an Error object through to console.warn so its stack is serialized", () => {
    const err = new Error("google 503");
    log.warn("sync", { msg: "channel stop failed" }, err);
    expect(warn).toHaveBeenCalledWith('slate tag=sync msg="channel stop failed"', err);
  });

  it("omits warn's second argument entirely when there is no Error", () => {
    log.warn("sync", { msg: "stale lane" });
    expect(warn.mock.calls[0]).toHaveLength(1);
  });

  // The same for info, so the three levels have one signature between them and a
  // call site does not have to remember which of them can carry an error.
  it("passes an Error object through to console.info too, for symmetry", () => {
    const err = new Error("partial");
    log.info("recompute", { msg: "skipped a bucket" }, err);
    expect(info).toHaveBeenCalledWith('slate tag=recompute msg="skipped a bucket"', err);
  });

  it("omits info's second argument entirely when there is no Error", () => {
    log.info("recompute", { msg: "cycle" });
    expect(info.mock.calls[0]).toHaveLength(1);
  });
});

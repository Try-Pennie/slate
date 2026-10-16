import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3325: the shared confirm line's switch wired to the real database and the deployment's
// vars. The caching and the failure policy are driven in scripts/test-shared-line-switch.ts;
// this is the wiring: WHICH column it reads, that an absent settings row is a real answer
// (off), that a failed read takes the deployment default named by SHARED_CONFIRM_LINE_DEFAULT,
// that a bad default is reported in words naming the setting, and that the admin page's
// read is fresh and null when it fails rather than either answer (L530).
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
type Result = { data: unknown; error: { message: string } | null };
const db = vi.hoisted(() => ({
  result: { data: null, error: null } as Result,
  /** #3339: each audit_log read answers the next of these, in order. */
  audit: [] as Result[],
  calls: [] as string[],
}));
const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    db.calls.push(`from:${table}`);
    const builder = {
      select: (cols: string) => {
        db.calls.push(`select:${cols}`);
        return builder;
      },
      eq: (col: string, v: unknown) => {
        db.calls.push(`eq:${col}=${String(v)}`);
        return builder;
      },
      gt: (col: string, v: unknown) => {
        db.calls.push(`gt:${col}=${String(v)}`);
        return builder;
      },
      order: (col: string, o: { ascending: boolean }) => {
        db.calls.push(`order:${col}:${o.ascending ? "asc" : "desc"}`);
        return builder;
      },
      limit: async (n: number) => {
        db.calls.push(`limit:${n}`);
        return db.audit.shift() ?? { data: [], error: null };
      },
      maybeSingle: async () => db.result,
    };
    return builder;
  }),
);
// #3339: a sustained run of failed reads pages, only on the Workers runtime.
const runtime = vi.hoisted(() => ({ onWorkers: true }));
const sendThrottledAlert = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/lib/log", () => ({ log }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/platform/runtime", () => ({ isWorkersRuntime: () => runtime.onWorkers }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert }));
vi.mock("@/lib/after-response", () => ({ afterResponse: (_c: string, work: () => Promise<unknown>) => void work() }));

const ENV = "SHARED_CONFIRM_LINE_DEFAULT";
let saved: string | undefined;

/** A fresh module, so each test has its own per isolate cache. */
async function fresh() {
  vi.resetModules();
  return import("./shared-line-switch");
}

beforeEach(() => {
  vi.clearAllMocks();
  db.result = { data: null, error: null };
  db.audit = [];
  db.calls = [];
  runtime.onWorkers = true;
  saved = process.env[ENV];
  process.env[ENV] = "off";
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

describe("readSharedConfirmLine", () => {
  it("reads booking_settings.shared_confirm_line for id 1", async () => {
    db.result = { data: { shared_confirm_line: true }, error: null };
    const { readSharedConfirmLine } = await fresh();
    expect(await readSharedConfirmLine()).toEqual({ on: true, source: "read" });
    expect(db.calls).toEqual(["from:booking_settings", "select:shared_confirm_line", "eq:id=1"]);
  });

  it("answers off, from a read, when no settings row exists: nobody ever turned it on", async () => {
    db.result = { data: null, error: null };
    const { readSharedConfirmLine } = await fresh();
    expect(await readSharedConfirmLine()).toEqual({ on: false, source: "read" });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("answers the deployment default when the read fails, and reports the failure", async () => {
    process.env[ENV] = "on";
    db.result = { data: null, error: { message: "permission denied" } };
    const { readSharedConfirmLine } = await fresh();
    expect(await readSharedConfirmLine()).toEqual({ on: true, source: "default" });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [tag, fields, err] = log.warn.mock.calls[0] as [string, { msg: string }, unknown];
    expect(tag).toBe("shared-line");
    expect(fields.msg).toMatch(/unreadable/);
    expect(err).toBeInstanceOf(Error);
  });

  it("reports a missing default once, naming the setting and what it means", async () => {
    delete process.env[ENV];
    db.result = { data: null, error: { message: "timeout" } };
    const { readSharedConfirmLine } = await fresh();
    expect(await readSharedConfirmLine()).toEqual({ on: false, source: "default" });
    const problems = log.warn.mock.calls.filter(([, f]) => String((f as { msg: string }).msg).includes(ENV));
    expect(problems).toHaveLength(1);
    expect((problems[0]![1] as { msg: string }).msg).toMatch(/not set/);
    expect((problems[0]![1] as { msg: string }).msg).toMatch(/off/);
  });

  it("reports a default that is neither on nor off, quoting what it holds", async () => {
    process.env[ENV] = "yes";
    db.result = { data: { shared_confirm_line: false }, error: null };
    const { readSharedConfirmLine } = await fresh();
    expect(await readSharedConfirmLine()).toEqual({ on: false, source: "read" });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [, fields] = log.warn.mock.calls[0] as [string, { msg: string; value?: string }];
    expect(fields.msg).toContain(ENV);
    expect(fields.value).toBe("yes");
  });
});

describe("readSharedConfirmLineSetting", () => {
  it("reads fresh on every call, for the admin page", async () => {
    const { readSharedConfirmLineSetting } = await fresh();
    db.result = { data: { shared_confirm_line: true }, error: null };
    expect(await readSharedConfirmLineSetting()).toBe(true);
    db.result = { data: { shared_confirm_line: false }, error: null };
    expect(await readSharedConfirmLineSetting()).toBe(false);
  });

  it("is null when the read fails, never either answer", async () => {
    db.result = { data: null, error: { message: "column does not exist" } };
    const { readSharedConfirmLineSetting } = await fresh();
    expect(await readSharedConfirmLineSetting()).toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe("failed switch reads are counted, not only logged (#3339)", () => {
  /** A fresh reader whose clock the test moves, so the retry spacing can be crossed. */
  async function withClock() {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const mod = await fresh();
    return { mod, advance: (ms: number) => (now += ms) };
  }
  afterEach(() => vi.restoreAllMocks());

  it("pages once a run of failed reads crosses the threshold on one server, naming the default", async () => {
    db.result = { data: null, error: { message: "statement timeout" } };
    const { mod, advance } = await withClock();
    for (let i = 0; i < mod.SWITCH_READ_PAGE_AFTER; i++) {
      await mod.readSharedConfirmLine();
      advance(mod.SHARED_LINE_SWITCH_RETRY_MS);
    }
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, text] = sendThrottledAlert.mock.calls[0] as unknown as [string, number, string];
    expect(key).toBe("shared_line_switch_unreadable");
    expect(cooldown).toBe(mod.SWITCH_READ_ALERT_COOLDOWN_MS);
    expect(text).toMatch(/deployment default, which is off/);
    expect(text).not.toMatch(/statement timeout/);
  });

  it("never pages one failed read, and never pages off the Workers runtime", async () => {
    db.result = { data: null, error: { message: "statement timeout" } };
    const one = await withClock();
    await one.mod.readSharedConfirmLine();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();

    runtime.onWorkers = false;
    const dev = await withClock();
    for (let i = 0; i < 10; i++) {
      await dev.mod.readSharedConfirmLine();
      dev.advance(dev.mod.SHARED_LINE_SWITCH_RETRY_MS);
    }
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });
});

describe("readSharedLineSwitchHistory (#3339)", () => {
  it("reads only the switch while it is on: nothing to time", async () => {
    db.result = { data: { shared_confirm_line: true }, error: null };
    const { readSharedLineSwitchHistory } = await fresh();
    expect(await readSharedLineSwitchHistory()).toEqual({ on: true, lastOnAtMs: null, offSinceMs: null });
    expect(db.calls.filter((c) => c === "from:audit_log")).toHaveLength(0);
  });

  it("is never activated when no audit entry ever turned it on", async () => {
    db.result = { data: { shared_confirm_line: false }, error: null };
    db.audit = [{ data: [], error: null }];
    const { readSharedLineSwitchHistory } = await fresh();
    expect(await readSharedLineSwitchHistory()).toEqual({ on: false, lastOnAtMs: null, offSinceMs: null });
    expect(db.calls).toEqual(
      expect.arrayContaining([
        "from:audit_log",
        "eq:action=booking.settings",
        "eq:details->>shared_confirm_line=true",
        "order:chain_seq:desc",
        "limit:1",
      ]),
    );
  });

  it("times the off from the FIRST off after the newest on, so pressing off twice cannot restart it", async () => {
    db.result = { data: { shared_confirm_line: false }, error: null };
    db.audit = [
      { data: [{ chain_seq: 40, created_at: "2026-10-10T12:00:00.000Z" }], error: null },
      { data: [{ chain_seq: 41, created_at: "2026-10-11T09:30:00.000Z" }], error: null },
    ];
    const { readSharedLineSwitchHistory } = await fresh();
    expect(await readSharedLineSwitchHistory()).toEqual({
      on: false,
      lastOnAtMs: Date.parse("2026-10-10T12:00:00.000Z"),
      offSinceMs: Date.parse("2026-10-11T09:30:00.000Z"),
    });
    expect(db.calls).toEqual(expect.arrayContaining(["eq:details->>shared_confirm_line=false", "gt:chain_seq=40", "order:chain_seq:asc"]));
  });

  it("has no off time when nothing recorded the off", async () => {
    db.result = { data: { shared_confirm_line: false }, error: null };
    db.audit = [{ data: [{ chain_seq: 40, created_at: "2026-10-10T12:00:00.000Z" }], error: null }, { data: [], error: null }];
    const { readSharedLineSwitchHistory } = await fresh();
    expect(await readSharedLineSwitchHistory()).toEqual({ on: false, lastOnAtMs: Date.parse("2026-10-10T12:00:00.000Z"), offSinceMs: null });
  });

  it("THROWS on a failed read, never answering never activated", async () => {
    db.result = { data: { shared_confirm_line: false }, error: null };
    db.audit = [{ data: null, error: { message: "permission denied" } }];
    const { readSharedLineSwitchHistory } = await fresh();
    await expect(readSharedLineSwitchHistory()).rejects.toThrow();
  });

  it("THROWS when the switch itself cannot be read", async () => {
    db.result = { data: null, error: { message: "timeout" } };
    const { readSharedLineSwitchHistory } = await fresh();
    await expect(readSharedLineSwitchHistory()).rejects.toThrow();
  });
});

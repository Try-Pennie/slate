import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3325: the shared confirm line's switch wired to the real database and the deployment's
// vars. The caching and the failure policy are driven in scripts/test-shared-line-switch.ts;
// this is the wiring: WHICH column it reads, that an absent settings row is a real answer
// (off), that a failed read takes the deployment default named by SHARED_CONFIRM_LINE_DEFAULT,
// that a bad default is reported in words naming the setting, and that the admin page's
// read is fresh and null when it fails rather than either answer (L530).
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const db = vi.hoisted(() => ({
  result: { data: null, error: null } as { data: unknown; error: { message: string } | null },
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
      maybeSingle: async () => db.result,
    };
    return builder;
  }),
);

vi.mock("@/lib/log", () => ({ log }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

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
  db.calls = [];
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

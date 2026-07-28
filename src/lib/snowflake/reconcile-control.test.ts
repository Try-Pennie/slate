import { afterEach, describe, expect, it, vi } from "vitest";

// #1102: the reconciliation's positive control must apply the SAME
// redacted-row skip predicate the count read uses.
//
// The failure it prevents: a booking erased before its first export exists in
// Supabase and never in Snowflake. The control picks the OLDEST booking, so if such
// a row is ever the oldest, the control fails on every tick, `mirrorReadyForDeletion`
// is never ready again, and all three retention lanes freeze permanently and
// silently. That is the #1118 class the count read was already patched for; the
// control was missed.
const sf = vi.hoisted(() => ({ executeStatement: vi.fn() }));
const db = vi.hoisted(() => {
  const state = { filtersByTable: {} as Record<string, string[]>, current: "" };
  const make = (table: string) => {
    const chain: Record<string, unknown> = {};
    const note = (f: string) => {
      (state.filtersByTable[table] ??= []).push(f);
      return chain;
    };
    chain.select = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.is = (col: string) => note(`is:${col}`);
    chain.eq = (col: string) => note(`eq:${col}`);
    chain.maybeSingle = () => Promise.resolve({ data: { id: "oldest-booking" }, error: null });
    chain.then = (onF: (v: unknown) => unknown) => Promise.resolve({ count: 1, data: null, error: null }).then(onF);
    return chain;
  };
  return { state, from: vi.fn((table: string) => make(table)) };
});

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: db.from }) }));
vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  executeStatement: sf.executeStatement,
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { reconcileSnowflakeMirror } from "./reconcile";
import { readSnowflakeConfig } from "./config";

afterEach(() => {
  vi.resetAllMocks();
  db.state.filtersByTable = {};
});

describe("reconcile positive control (#1102)", () => {
  it("skips redacted rows when choosing the known-present control row", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue({
      account: "a",
      user: "u",
      privateKeyPem: "k",
      database: "SLATE",
      schema: "PUBLIC",
      warehouse: "SLATE_WH",
      role: "SLATE_ROLE",
    });
    sf.executeStatement.mockResolvedValue({ data: [["1"]] });

    await reconcileSnowflakeMirror();

    // The bookings chain is used twice: once for the count, once for the control.
    // BOTH must carry the redaction skip, or the control can pick a row that is
    // legitimately absent from the warehouse and freeze retention forever.
    const bookingFilters = db.state.filtersByTable["bookings"] ?? [];
    const skips = bookingFilters.filter((f) => f === "is:pii_redacted_at");
    expect(skips.length).toBeGreaterThanOrEqual(2);
  });
});

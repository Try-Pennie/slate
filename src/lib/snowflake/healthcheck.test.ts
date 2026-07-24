import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("./client", () => ({ executeStatement: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { runSnowflakeHealthcheck } from "./healthcheck";
import { readSnowflakeConfig } from "./config";
import { executeStatement } from "./client";
import { log } from "@/lib/log";

const cfg = {
  account: "vrkfjso-rwc54963",
  user: "SLATE_SERVICE",
  privateKeyPem: "k",
  database: "SLATE",
  schema: "PUBLIC",
  warehouse: "SLATE_WH",
  role: "SLATE_ROLE",
};

afterEach(() => vi.clearAllMocks());

describe("runSnowflakeHealthcheck", () => {
  it("reports not-configured and does not call Snowflake when the key is unset", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.configured).toBe(false);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it("returns ok with the role and warehouse the login resolves to", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockResolvedValue({ data: [["SLATE_ROLE", "SLATE_WH"]] });
    const r = await runSnowflakeHealthcheck();
    expect(r).toMatchObject({ ok: true, configured: true, role: "SLATE_ROLE", warehouse: "SLATE_WH" });
    expect(executeStatement).toHaveBeenCalledOnce();
  });

  it("fails loud (returns not-ok + logs) instead of throwing when the login errors", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockRejectedValue(new Error("JWT token is invalid"));
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.configured).toBe(true);
    expect(r.error).toMatch(/JWT token is invalid/);
    expect(log.error).toHaveBeenCalled();
  });
});

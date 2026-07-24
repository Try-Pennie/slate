import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/lib/db/types";

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/snowflake/healthcheck", () => ({ runSnowflakeHealthcheck: vi.fn() }));

import { GET } from "./route";
import { requireAdmin } from "@/lib/auth";
import { runSnowflakeHealthcheck } from "@/lib/snowflake/healthcheck";

const admin = { id: "a1", role: "admin", org_id: "o1" } as User;

afterEach(() => vi.clearAllMocks());

describe("GET /api/admin/snowflake-check", () => {
  it("403s a non-admin and never runs the check", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Not authorized"));
    const res = await GET();
    expect(res.status).toBe(403);
    expect(runSnowflakeHealthcheck).not.toHaveBeenCalled();
  });

  it("returns 200 and the result to an admin when the login is healthy", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(admin);
    vi.mocked(runSnowflakeHealthcheck).mockResolvedValue({
      ok: true,
      configured: true,
      role: "SLATE_ROLE",
      warehouse: "SLATE_WH",
    });
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, role: "SLATE_ROLE" });
  });

  it("returns 503 to an admin when the login fails (fail-loud, not a 200)", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(admin);
    vi.mocked(runSnowflakeHealthcheck).mockResolvedValue({
      ok: false,
      configured: true,
      error: "JWT token is invalid",
    });
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "JWT token is invalid" });
  });
});

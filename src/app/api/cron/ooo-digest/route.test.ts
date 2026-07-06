import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial guard for the OOO manager-digest cron (#676): an unauthenticated caller
// must be rejected with 401 before the time gate is read or any DB row is
// queried. The digest content/timing logic is covered elsewhere.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const from = vi.hoisted(() => vi.fn());

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/ooo-digest", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });
});

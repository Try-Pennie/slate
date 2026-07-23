import { describe, it, expect, vi, beforeEach } from "vitest";

// #1015: the direct-booking default-bucket accessor. Reads the single-row
// booking_settings config (id=1) and returns the configured bucket code, or null
// when no default is set. Fail-loud: a real read error THROWS (via unwrap) rather
// than degrading to a false "no default", which downstream would misread as an
// intentional NO_DEFAULT_BUCKET. Only the DB client is mocked.
const maybeSingle = vi.hoisted(() =>
  vi.fn(async () => ({ data: null as unknown, error: null as { message: string } | null })),
);
const admin = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle })),
      })),
    })),
  })),
}));
vi.mock("@/lib/supabase/admin", () => admin);

import { getDefaultBucketCode } from "./settings";

describe("getDefaultBucketCode", () => {
  beforeEach(() => {
    maybeSingle.mockReset();
    maybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it("returns the configured default bucket code", async () => {
    maybeSingle.mockResolvedValue({ data: { default_bucket_code: "123" }, error: null });
    expect(await getDefaultBucketCode()).toBe("123");
  });

  it("returns null when no config row exists (maybeSingle -> null)", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getDefaultBucketCode()).toBeNull();
  });

  it("returns null when the stored code is blank/whitespace", async () => {
    maybeSingle.mockResolvedValue({ data: { default_bucket_code: "   " }, error: null });
    expect(await getDefaultBucketCode()).toBeNull();
  });

  it("throws (fail-loud) on a real read error rather than returning null", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    await expect(getDefaultBucketCode()).rejects.toThrow(/relation does not exist/);
  });
});

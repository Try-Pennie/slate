import { describe, it, expect, vi } from "vitest";
import { sweepMirrorCredentials } from "./credential-sweep";
import { MIRROR_CREDENTIALS } from "./mirror-credentials";

const config = { account: "a", user: "u", role: "r", warehouse: "w", database: "d", schema: "s", privateKey: "k" } as never;

/** A Snowflake answer shaped the way the REST statement API returns one. */
function answer(...cells: (string | null)[]) {
  return { data: [cells] } as never;
}

describe("sweepMirrorCredentials (#2564)", () => {
  it("blanks every declared credential and reports what each one cleared", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(answer("2392"))
      .mockResolvedValueOnce(answer("6522"))
      .mockResolvedValueOnce(answer("0", "0"));

    const result = await sweepMirrorCredentials(config, execute);

    expect(execute).toHaveBeenCalledTimes(MIRROR_CREDENTIALS.length + 1);
    expect(result.cleared["bookings.manage_token"]).toBe(2392);
    expect(result.cleared["webhook_deliveries.payload:manage_url"]).toBe(6522);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("is a no-op on a settled warehouse and still reports a measured zero", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(answer("0"))
      .mockResolvedValueOnce(answer("0"))
      .mockResolvedValueOnce(answer("0", "0"));

    const result = await sweepMirrorCredentials(config, execute);

    expect(result.ok).toBe(true);
    expect(Object.values(result.cleared).every((n) => n === 0)).toBe(true);
  });

  it("REFUSES when a residual survives the blanking, naming the field that held it", async () => {
    // The state worth paging on: the update ran and the credential is still there,
    // so the cleanup cannot do its job and the warehouse holds booking control.
    const execute = vi.fn()
      .mockResolvedValueOnce(answer("0"))
      .mockResolvedValueOnce(answer("0"))
      .mockResolvedValueOnce(answer("0", "17"));

    const result = await sweepMirrorCredentials(config, execute);

    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("webhook_deliveries");
    expect(result.reasons.join(" ")).toContain("17 rows");
  });

  it("says one row rather than 1 row(s), because a reader on a phone reads the sentence", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(answer("0"))
      .mockResolvedValueOnce(answer("0"))
      .mockResolvedValueOnce(answer("1", "0"));

    const result = await sweepMirrorCredentials(config, execute);

    expect(result.reasons.join(" ")).toContain("1 row still holds the credential");
    expect(result.reasons.join(" ")).not.toContain("row(s)");
  });

  it("REFUSES rather than reporting zero when a row count cannot be read", async () => {
    // A blanking reported as having changed no rows and one whose count could not
    // be read are opposite facts, and only one of them means the warehouse is
    // clean. Number(null) is NaN, which compares false against every threshold and
    // would land on the healthy side having measured nothing.
    const execute = vi.fn()
      .mockResolvedValueOnce(answer(null))
      .mockResolvedValueOnce(answer("0"))
      .mockResolvedValueOnce(answer("0", "0"));

    const result = await sweepMirrorCredentials(config, execute);

    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("bookings");
  });

  it("REFUSES when the residual count itself cannot be read", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(answer("0"))
      .mockResolvedValueOnce(answer("0"))
      .mockResolvedValueOnce(answer("0", null));

    const result = await sweepMirrorCredentials(config, execute);

    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("could not");
  });

  it("does not swallow a statement error into a clean verdict", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("SQL compilation error"));

    await expect(sweepMirrorCredentials(config, execute)).rejects.toThrow("SQL compilation error");
  });
});

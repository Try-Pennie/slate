import { describe, it, expect, vi, beforeEach } from "vitest";

// The lead's active bookings, read for the person check and for the lookup API.
//
// #3476: both now read in ONE request, `find_active_bookings_for_person` (migration
// 0175), where they made one per signal: a crowd's confirms are limited by how many
// requests each sends (#3492). Which rows that function returns, signal by signal, is
// proved against the old reads in a real Postgres (scripts/verify-person-bookings-sql.ts).
// What is pinned here is what the live dependency SENDS and how it reads the answer:
//
//  - every signal goes as a parameter, never as filter text, each strong id once
//    (#2663: the function reads it against both id columns), the email trimmed and
//    LIKE escaped (#620), the phone as E.164;
//  - the world is named (#2660): real or test for the person check, both for the
//    lookup API, which reports each row's world;
//  - a failed read THROWS (#1641). Empty here is the specific answer "this lead has no
//    call booked", the one that lets a second booking be made for somebody who has one.

interface FakeRpc {
  data: unknown;
  error: { message: string; code?: string } | null;
}

const calls: { fn: string; args: Record<string, unknown> }[] = [];
let answer: FakeRpc = { data: [], error: null };
const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc }) }));

import { findActiveBookingsForPerson, findActiveBookingsByStrongIds } from "@/lib/booking/service";

function row(id: string, isTest = false): Record<string, unknown> {
  return { id, status: "confirmed", starts_at: "2026-09-01T14:00:00+00:00", manage_token: `tok-${id}`, is_test: isTest };
}

beforeEach(() => {
  calls.length = 0;
  answer = { data: [], error: null };
  rpc.mockReset();
  rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return answer;
  });
});

describe("findActiveBookingsForPerson (the person check's read)", () => {
  it("asks once, whatever the number of signals (#3476)", async () => {
    await findActiveBookingsForPerson(
      { externalId: "ext-1", salesforceId: "sf-1", email: "lead@example.com", phone: "215 555 0100" },
      { isTest: false },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("find_active_bookings_for_person");
  });

  it("sends each strong id once, the escaped email and the E.164 phone, as parameters", async () => {
    await findActiveBookingsForPerson(
      { externalId: "ext-1", salesforceId: "sf-1", email: "  John_Doe%@Example.com ", phone: "215 555 0100" },
      { isTest: false },
    );
    expect(calls[0]!.args).toEqual({
      p_ids: ["ext-1", "sf-1"],
      // Trimmed, case kept (the match is case insensitive), `_` and `%` escaped (#620).
      p_email_like: "John\\_Doe\\%@Example.com",
      p_phone: "+12155550100",
      p_world: "real",
    });
  });

  it("sends one id given in both fields once (the function reads it against both columns)", async () => {
    await findActiveBookingsForPerson({ externalId: "00Q-lead", salesforceId: " 00Q-lead ", email: null, phone: null }, { isTest: false });
    expect(calls[0]!.args.p_ids).toEqual(["00Q-lead"]);
    expect(calls[0]!.args.p_email_like).toBeNull();
    expect(calls[0]!.args.p_phone).toBeNull();
  });

  // #2660: a test booking and a real booking are never one person's calls. Both directions.
  it("asks only for the TEST world when landing on a test bucket", async () => {
    await findActiveBookingsForPerson({ externalId: "ext-1", salesforceId: null, email: null, phone: null }, { isTest: true });
    expect(calls[0]!.args.p_world).toBe("test");
  });

  it("asks only for the REAL world when landing on a real bucket", async () => {
    await findActiveBookingsForPerson({ externalId: "ext-1", salesforceId: null, email: null, phone: null }, { isTest: false });
    expect(calls[0]!.args.p_world).toBe("real");
  });

  it("hands back plain booking rows, without the world riding along", async () => {
    answer = { data: [row("bk-1", true), row("bk-2", true)], error: null };
    const rows = await findActiveBookingsForPerson({ externalId: "ext-1", salesforceId: null, email: null, phone: null }, { isTest: true });
    expect(rows.map((b) => b.id)).toEqual(["bk-1", "bk-2"]);
    expect(rows[0]).not.toHaveProperty("is_test");
    expect(rows[0]).not.toHaveProperty("isTest");
    expect(rows[0]!.manage_token).toBe("tok-bk-1");
  });

  it("throws when the read fails, rather than reading as no existing call (#1641)", async () => {
    answer = { data: null, error: { message: "statement timeout", code: "57014" } };
    await expect(
      findActiveBookingsForPerson({ externalId: "ext-1", salesforceId: null, email: null, phone: null }, { isTest: false }),
    ).rejects.toThrow(/person booking lookup.*statement timeout|statement timeout/);
  });

  it("throws on an answer it cannot read, rather than reading it as none", async () => {
    answer = { data: { rows: [] }, error: null };
    await expect(
      findActiveBookingsForPerson({ externalId: "ext-1", salesforceId: null, email: null, phone: null }, { isTest: false }),
    ).rejects.toThrow(/not a list/);
  });

  it("control: a genuinely empty answer is no bookings, so a lead with no call can book", async () => {
    answer = { data: [], error: null };
    expect(await findActiveBookingsForPerson({ externalId: "ext-1", salesforceId: null, email: null, phone: null }, { isTest: false })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("asks nothing when the identity carries no signal", async () => {
    expect(await findActiveBookingsForPerson({ externalId: null, salesforceId: null, email: "  ", phone: null }, { isTest: false })).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});

// #2657: the lookup API's own fetch, by strong id only and in both worlds, since a key
// holder reading its own test booking is the point. Each row says which world it is in.
describe("findActiveBookingsByStrongIds (the lookup API's fetch)", () => {
  it("asks once for every id, in both worlds, with no email or phone", async () => {
    await findActiveBookingsByStrongIds(["00Q-lead", "sf-other"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ p_ids: ["00Q-lead", "sf-other"], p_email_like: null, p_phone: null, p_world: "both" });
  });

  it("returns each booking with its world", async () => {
    answer = { data: [row("bk-api"), row("bk-test", true)], error: null };
    const rows = await findActiveBookingsByStrongIds(["00Q-lead"]);
    expect(rows.map((b) => [b.id, b.isTest])).toEqual([["bk-api", false], ["bk-test", true]]);
    expect(rows[0]).not.toHaveProperty("is_test");
  });

  it("throws when the read fails, rather than reading as no call", async () => {
    answer = { data: null, error: { message: "statement timeout", code: "57014" } };
    await expect(findActiveBookingsByStrongIds(["00Q-lead"])).rejects.toThrow(/statement timeout/);
  });

  it("asks nothing for an empty id set", async () => {
    expect(await findActiveBookingsByStrongIds([])).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});

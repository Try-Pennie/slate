import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #4389: the server side of the program lead token, the half that reads the environment,
// the clock and the store. The pure rules are in scripts/test-program-lead.ts; this proves
// the wiring the routes (#4390, #4391) and the two pages will call.

const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  programLeadMoveTokenFor,
  programLeadTokenForLanding,
  verifyProgramLeadToken,
} from "./program-lead-gate";
import { mintProgramLeadToken, PROGRAM_LEAD_TOKEN_TTL_MS } from "./program-lead-token";
import { log } from "@/lib/log";

const SECRET = "q".repeat(64);
const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);
const LEAD = "00Q5f00000AbCdEFGH";
const OTHER_LEAD = "00Q5f00000ZzZzZzZz";
const BOOKING = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_BOOKING = "11111111-2222-4333-8444-555555555555";

/** The `program_leads` read, recording what it was asked. */
function programLeadsDb(answer: { data: unknown; error: { message: string } | null }, asked: string[]) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, value: string) => {
      asked.push(`${col}=${value}`);
      return builder;
    },
    maybeSingle: async () => answer,
  };
  return {
    from: (table: string) => {
      asked.push(table);
      return builder;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("PROGRAM_LEAD_TOKEN_SECRET", SECRET);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("verifyProgramLeadToken (#4389)", () => {
  const fresh = (bookingId: string | null = null) =>
    mintProgramLeadToken({ salesforceId: LEAD, bookingId, secret: SECRET, nowMs: NOW }).value;

  it("reads a valid new booking token back as its facts", () => {
    expect(verifyProgramLeadToken(fresh(), { salesforceId: LEAD })).toEqual({
      leadKey: LEAD.slice(0, 15),
      purpose: "new",
      bookingId: null,
      expiresAtMs: NOW + PROGRAM_LEAD_TOKEN_TTL_MS,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reads a valid move token back for its booking", () => {
    expect(verifyProgramLeadToken(fresh(BOOKING), { salesforceId: LEAD, bookingId: BOOKING })).toMatchObject({
      purpose: "move",
      bookingId: BOOKING,
    });
  });

  it("treats an expired token as not a program lead", () => {
    const token = fresh();
    vi.setSystemTime(NOW + PROGRAM_LEAD_TOKEN_TTL_MS);
    expect(verifyProgramLeadToken(token, { salesforceId: LEAD })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith("program-lead", expect.objectContaining({ reason: "expired" }));
  });

  it("treats a tampered token as not a program lead, never as an error", () => {
    const [lead, scope, exp, sig] = fresh().split(".");
    expect(verifyProgramLeadToken(`${lead}.${scope}.${Number(exp) + 3_600_000}.${sig}`, { salesforceId: LEAD })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith("program-lead", expect.objectContaining({ reason: "forged" }));
  });

  it("refuses a token issued for another lead", () => {
    expect(verifyProgramLeadToken(fresh(), { salesforceId: OTHER_LEAD })).toBeNull();
  });

  it("refuses a move token issued for another booking, and a new booking's token for a move", () => {
    expect(verifyProgramLeadToken(fresh(BOOKING), { salesforceId: LEAD, bookingId: OTHER_BOOKING })).toBeNull();
    expect(verifyProgramLeadToken(fresh(), { salesforceId: LEAD, bookingId: BOOKING })).toBeNull();
  });

  it("answers no token with null and logs nothing: an ordinary lead is not a refusal", () => {
    expect(verifyProgramLeadToken(null, { salesforceId: LEAD })).toBeNull();
    expect(verifyProgramLeadToken("", { salesforceId: LEAD })).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("never logs the token itself", () => {
    const token = fresh();
    verifyProgramLeadToken(token, { salesforceId: OTHER_LEAD });
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(token);
  });
});

describe("programLeadTokenForLanding (#4389)", () => {
  it("mints a token for a lead with a live registration, capped at the registration's expiry", async () => {
    const asked: string[] = [];
    const expires = NOW + 30 * 60_000;
    admin.supabaseAdmin.mockReturnValue(
      programLeadsDb({ data: { expires_at: new Date(expires).toISOString() }, error: null }, asked),
    );
    const token = await programLeadTokenForLanding(LEAD);
    expect(asked).toEqual(["program_leads", `lead_key=${LEAD.slice(0, 15)}`]);
    expect(verifyProgramLeadToken(token, { salesforceId: LEAD })).toMatchObject({ purpose: "new", expiresAtMs: expires });
  });

  it("mints nothing for a lapsed registration or none", async () => {
    admin.supabaseAdmin.mockReturnValue(
      programLeadsDb({ data: { expires_at: new Date(NOW - 1).toISOString() }, error: null }, []),
    );
    expect(await programLeadTokenForLanding(LEAD)).toBeNull();
    admin.supabaseAdmin.mockReturnValue(programLeadsDb({ data: null, error: null }, []));
    expect(await programLeadTokenForLanding(LEAD)).toBeNull();
  });

  it("reads nothing for an empty lookup id (the throttle said no) or an id that is not a Lead", async () => {
    expect(await programLeadTokenForLanding("")).toBeNull();
    expect(await programLeadTokenForLanding("001AAAAAAAAAAAAAAA")).toBeNull();
    expect(admin.supabaseAdmin).not.toHaveBeenCalled();
  });

  it("treats a failed read as not a program lead, and logs it", async () => {
    admin.supabaseAdmin.mockReturnValue(programLeadsDb({ data: null, error: { message: "boom" } }, []));
    expect(await programLeadTokenForLanding(LEAD)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "program-lead",
      expect.objectContaining({ msg: expect.stringContaining("registration read failed") }),
      expect.any(Error),
    );
  });

  it("with no secret recognises nobody, and a registered lead turned away for it is logged by name of the setting", async () => {
    vi.stubEnv("PROGRAM_LEAD_TOKEN_SECRET", "");
    admin.supabaseAdmin.mockReturnValue(
      programLeadsDb({ data: { expires_at: new Date(NOW + 60_000).toISOString() }, error: null }, []),
    );
    expect(await programLeadTokenForLanding(LEAD)).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "program-lead",
      expect.objectContaining({ msg: expect.stringContaining("PROGRAM_LEAD_TOKEN_SECRET") }),
    );
  });

  it("with no secret says nothing about a lead who is not registered", async () => {
    vi.stubEnv("PROGRAM_LEAD_TOKEN_SECRET", "");
    admin.supabaseAdmin.mockReturnValue(programLeadsDb({ data: null, error: null }, []));
    expect(await programLeadTokenForLanding(LEAD)).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("programLeadMoveTokenFor (#4389)", () => {
  it("mints a move token for a program booking, good for that booking only", () => {
    const token = programLeadMoveTokenFor({ id: BOOKING, program_lead: true, salesforce_id: LEAD });
    expect(verifyProgramLeadToken(token, { salesforceId: LEAD, bookingId: BOOKING })).toMatchObject({ purpose: "move" });
    expect(verifyProgramLeadToken(token, { salesforceId: LEAD })).toBeNull();
  });

  it("mints nothing for an ordinary booking", () => {
    expect(programLeadMoveTokenFor({ id: BOOKING, program_lead: false, salesforce_id: LEAD })).toBeNull();
  });

  it("mints nothing, and logs, for a program booking carrying no Lead id", () => {
    expect(programLeadMoveTokenFor({ id: BOOKING, program_lead: true, salesforce_id: null })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith("program-lead", expect.objectContaining({ booking_id: BOOKING }));
  });

  it("with no secret mints nothing", () => {
    vi.stubEnv("PROGRAM_LEAD_TOKEN_SECRET", "");
    expect(programLeadMoveTokenFor({ id: BOOKING, program_lead: true, salesforce_id: LEAD })).toBeNull();
  });
});

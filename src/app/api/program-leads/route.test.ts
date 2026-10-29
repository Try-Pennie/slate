import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #4388: POST /api/program-leads, where Bidspoke registers an accepted lead's Salesforce
// Lead id so its texted booking link is recognised as a program lead's (#4255).
//
// Seams, every one named (L284). Mocked: the database client (the register call), the
// failed credential limiter (IO), the internal error reporter (it alerts) and the log.
// Left REAL on purpose: the env module (each key is set as the deployment would set it,
// so a booking API key really is configured beside Bidspoke's and really is refused),
// the constant time bearer check, the Lead id validation and the store module, since
// those are what the route is.
const db = vi.hoisted(() => ({ rpc: vi.fn() }));
const rateLimit = vi.hoisted(() => ({
  bearerFailureWithinLimit: vi.fn(async (_ip: string) => true),
  clientIp: (headers: Headers) => headers.get("cf-connecting-ip")?.trim() ?? "unknown",
}));
const errors = vi.hoisted(() => ({ reportInternalError: vi.fn(async () => {}) }));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => db }));
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/api/errors", () => errors);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { POST } = await import("./route");

const BIDSPOKE = "bidspoke-secret-value";
const BIDSPOKE_NEXT = "bidspoke-rotated-value";
const REGAL = "regal-booking-secret";
const MARCIA = "marcia-cancel-secret";

// Salesforce's checksum for this id is EAV (scripts/test-lead-id-spellings.ts).
const LEAD_15 = "00Q5f00000AbCdE";
const LEAD_18 = "00Q5f00000AbCdEEAV";
const EXPIRES = "2026-11-28T15:00:00+00:00";
const LATER = "2026-11-29T09:30:00+00:00";

const request = (body: unknown, auth: string | null = `Bearer ${BIDSPOKE}`, raw = false) =>
  new Request("https://slate.test/api/program-leads", {
    method: "POST",
    headers: auth ? { authorization: auth, "content-type": "application/json" } : { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BOOKING_API_KEY_BIDSPOKE", BIDSPOKE);
  vi.stubEnv("BOOKING_API_KEY_BIDSPOKE_2", "");
  vi.stubEnv("BOOKING_API_KEY_REGAL", REGAL);
  vi.stubEnv("BOOKING_API_KEY_MARCIA", MARCIA);
  rateLimit.bearerFailureWithinLimit.mockResolvedValue(true);
  db.rpc.mockResolvedValue({ data: EXPIRES, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a registration", () => {
  it("answers 200 with when the mark lapses, registering the 15 character key as Bidspoke", async () => {
    const res = await POST(request({ salesforceLeadId: LEAD_18 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registered: true, expiresAt: EXPIRES });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith("register_program_lead", { p_lead_key: LEAD_15, p_caller: "bidspoke" });
  });

  it("accepts the 15 character spelling, keyed the same as the 18", async () => {
    const res = await POST(request({ salesforceLeadId: LEAD_15 }));
    expect(res.status).toBe(200);
    expect(db.rpc).toHaveBeenCalledWith("register_program_lead", { p_lead_key: LEAD_15, p_caller: "bidspoke" });
  });

  it("reads past surrounding whitespace", async () => {
    const res = await POST(request({ salesforceLeadId: `  ${LEAD_18}\n` }));
    expect(res.status).toBe(200);
    expect(db.rpc).toHaveBeenCalledWith("register_program_lead", { p_lead_key: LEAD_15, p_caller: "bidspoke" });
  });

  it("answers 200 again on a re-register, under the same key, with the extended lapse the store returns", async () => {
    await POST(request({ salesforceLeadId: LEAD_18 }));
    db.rpc.mockResolvedValue({ data: LATER, error: null });
    const res = await POST(request({ salesforceLeadId: LEAD_15 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registered: true, expiresAt: LATER });
    expect(db.rpc.mock.calls.map((c) => c[1])).toEqual([
      { p_lead_key: LEAD_15, p_caller: "bidspoke" },
      { p_lead_key: LEAD_15, p_caller: "bidspoke" },
    ]);
  });

  it("accepts Bidspoke's rotation slot beside its primary", async () => {
    vi.stubEnv("BOOKING_API_KEY_BIDSPOKE_2", BIDSPOKE_NEXT);
    const res = await POST(request({ salesforceLeadId: LEAD_18 }, `Bearer ${BIDSPOKE_NEXT}`));
    expect(res.status).toBe(200);
  });
});

describe("a bad body or id is 400, and nothing is written", () => {
  const cases: Array<[string, unknown, string, boolean?]> = [
    ["a body that is not JSON", "{not json", "VALIDATION", true],
    ["no salesforceLeadId", { leadId: LEAD_18 }, "VALIDATION"],
    ["a salesforceLeadId that is not a string", { salesforceLeadId: 12345 }, "VALIDATION"],
    ["a blank salesforceLeadId", { salesforceLeadId: "   " }, "VALIDATION"],
    ["a Contact id (wrong prefix)", { salesforceLeadId: "003D000000IqhSLIAZ" }, "NOT_A_LEAD_ID"],
    ["a 16 character id (wrong length)", { salesforceLeadId: `${LEAD_15}E` }, "NOT_A_LEAD_ID"],
    ["a 14 character id (wrong length)", { salesforceLeadId: LEAD_15.slice(0, 14) }, "NOT_A_LEAD_ID"],
    ["an id with a character Salesforce never uses", { salesforceLeadId: "00Q5f00000AbC-E" }, "NOT_A_LEAD_ID"],
    ["an 18 character id lowercased after its suffix was computed", { salesforceLeadId: "00Q5f00000abcdeEAV" }, "LEAD_ID_CASE_MISMATCH"],
    ["an 18 character id with a wrong suffix", { salesforceLeadId: "00Q5f00000AbCdEEAW" }, "LEAD_ID_CASE_MISMATCH"],
  ];
  for (const [label, body, code, raw] of cases) {
    it(label, async () => {
      const res = await POST(request(body, `Bearer ${BIDSPOKE}`, raw));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code });
      expect(db.rpc).not.toHaveBeenCalled();
    });
  }
});

describe("only Bidspoke's key opens it", () => {
  it("answers 401 with no Authorization header, through the failed credential limiter", async () => {
    const res = await POST(request({ salesforceLeadId: LEAD_18 }, null));
    expect(res.status).toBe(401);
    expect(rateLimit.bearerFailureWithinLimit).toHaveBeenCalledTimes(1);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("answers 401 on a wrong key", async () => {
    const res = await POST(request({ salesforceLeadId: LEAD_18 }, "Bearer not-the-key"));
    expect(res.status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("refuses a booking API key, configured and valid on the booking routes", async () => {
    const res = await POST(request({ salesforceLeadId: LEAD_18 }, `Bearer ${REGAL}`));
    expect(res.status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("refuses the cancel only key", async () => {
    const res = await POST(request({ salesforceLeadId: LEAD_18 }, `Bearer ${MARCIA}`));
    expect(res.status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("answers 429 once one address has failed too often, so a key cannot be guessed", async () => {
    rateLimit.bearerFailureWithinLimit.mockResolvedValue(false);
    const res = await POST(request({ salesforceLeadId: LEAD_18 }, "Bearer guess"));
    expect(res.status).toBe(429);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("never spends the limiter on a good key", async () => {
    await POST(request({ salesforceLeadId: LEAD_18 }));
    expect(rateLimit.bearerFailureWithinLimit).not.toHaveBeenCalled();
  });

  it("answers 503 NOT_CONFIGURED when Bidspoke's key is unset, and never reads the body", async () => {
    vi.stubEnv("BOOKING_API_KEY_BIDSPOKE", "");
    const res = await POST(request({ salesforceLeadId: LEAD_18 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "NOT_CONFIGURED" });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("does not let an unset primary turn the rotation slot alone into a key", async () => {
    vi.stubEnv("BOOKING_API_KEY_BIDSPOKE", "");
    vi.stubEnv("BOOKING_API_KEY_BIDSPOKE_2", BIDSPOKE_NEXT);
    const res = await POST(request({ salesforceLeadId: LEAD_18 }, `Bearer ${BIDSPOKE_NEXT}`));
    expect(res.status).toBe(503);
  });
});

describe("a store failure is 503, never a fake success", () => {
  it("when the register call answers an error", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    const res = await POST(request({ salesforceLeadId: LEAD_18 }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code: "STORE_UNAVAILABLE" });
    expect(body.registered).toBeUndefined();
    expect(errors.reportInternalError).toHaveBeenCalledTimes(1);
  });

  it("when the register call throws", async () => {
    db.rpc.mockRejectedValue(new Error("fetch failed"));
    const res = await POST(request({ salesforceLeadId: LEAD_18 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "STORE_UNAVAILABLE" });
  });

  it("when the register call answers no error and no lapse time", async () => {
    db.rpc.mockResolvedValue({ data: null, error: null });
    const res = await POST(request({ salesforceLeadId: LEAD_18 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "STORE_UNAVAILABLE" });
  });

  it("still answers 503 when the alert itself fails", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    errors.reportInternalError.mockRejectedValueOnce(new Error("alert store down"));
    const res = await POST(request({ salesforceLeadId: LEAD_18 }));
    expect(res.status).toBe(503);
  });
});

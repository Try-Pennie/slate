import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #4389: the texted booking link `/booking/{sfId}` recognises a program lead on the server
// and hands the Booker a short lived token. These assertions are about the WIRING no
// component test can see: that `program_leads` is read only for the id the throttled per
// person lookup allowed (#3106, #3173), that the token reaches the Booker only for a live
// registration, and that a failed read is the ordinary booker plus a log line, never an
// error page.

const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => admin);
const landingIdentityAllowed = vi.hoisted(() => vi.fn(async (_ip: string) => true));
vi.mock("@/lib/rate-limit", async () => {
  const core = await import("@/lib/rate-limit-core");
  return { clientIp: core.clientIp, landingIdentityAllowed };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/Booker", () => ({ default: () => null }));
vi.mock("@/components/StandaloneBookerShell", () => ({
  default: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 14) }));
vi.mock("@/lib/booking/reason-options", () => ({
  loadReasonOptions: vi.fn(async () => ({ reschedule: { active: [] }, cancel: { active: [] } })),
}));
vi.mock("@/lib/routing/landing-code", () => ({
  resolveLandingCode: vi.fn(async (code: string) => ({ code: code || "411" })),
}));
vi.mock("@/lib/booking/landing-bucket", () => ({ loadLandingBucketIsTest: vi.fn(async () => false) }));
vi.mock("@/lib/booking/service", () => ({
  existingCallForLanding: vi.fn(async () => null),
  landingAttendee: vi.fn(async (_identity: unknown, link: unknown) => link),
}));

import BookingPage from "./page";
import Booker from "@/components/Booker";
import { verifyProgramLeadToken } from "@/lib/booking/program-lead-gate";
import { log } from "@/lib/log";
import { PARTNER_BUCKET_CODE } from "@/lib/embed/public-test-bucket";

const SECRET = "r".repeat(64);
const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);
const LEAD = "00Q5f00000AbCdEFGH";

function findByType(node: unknown, type: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } & Record<string, unknown> };
  if (el.type === type) return el.props ?? {};
  return findByType(el.props?.children, type);
}

/** The `program_leads` read, recording each table and key asked. */
function db(answer: { data: unknown; error: { message: string } | null }, asked: string[]) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (_col: string, value: string) => {
      asked.push(value);
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

async function bookerProps(id = LEAD) {
  const tree = await BookingPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ xbc: "411" }) });
  const props = findByType(tree, Booker as unknown);
  if (!props) throw new Error("the page rendered no Booker");
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("PROGRAM_LEAD_TOKEN_SECRET", SECRET);
  landingIdentityAllowed.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("/booking/{sfId} recognises a program lead (#4389)", () => {
  it("hands the Booker a token for a lead with a live registration", async () => {
    const asked: string[] = [];
    admin.supabaseAdmin.mockReturnValue(db({ data: { expires_at: new Date(NOW + 86_400_000).toISOString() }, error: null }, asked));
    const props = await bookerProps();
    expect(asked).toEqual(["program_leads", LEAD.slice(0, 15)]);
    expect(typeof props.programLeadToken).toBe("string");
    expect(verifyProgramLeadToken(props.programLeadToken as string, { salesforceId: LEAD })).toMatchObject({ purpose: "new" });
  });

  it("hands no token for a lapsed registration", async () => {
    admin.supabaseAdmin.mockReturnValue(db({ data: { expires_at: new Date(NOW - 1).toISOString() }, error: null }, []));
    expect((await bookerProps()).programLeadToken).toBeNull();
  });

  it("hands no token for a lead with no registration", async () => {
    admin.supabaseAdmin.mockReturnValue(db({ data: null, error: null }, []));
    expect((await bookerProps()).programLeadToken).toBeNull();
  });

  it("reads nothing over the per address ceiling: the throttle governs this read too", async () => {
    landingIdentityAllowed.mockResolvedValue(false);
    const props = await bookerProps();
    expect(admin.supabaseAdmin).not.toHaveBeenCalled();
    expect(props.programLeadToken).toBeNull();
  });

  it("reads nothing for a path id that is not a Lead id", async () => {
    await bookerProps("003AAAAAAAAAAAA");
    expect(admin.supabaseAdmin).not.toHaveBeenCalled();
  });

  it("shows the ordinary booker when the registration read fails, and logs it, never an error page", async () => {
    admin.supabaseAdmin.mockReturnValue(db({ data: null, error: { message: "connection reset" } }, []));
    const props = await bookerProps();
    expect(props.programLeadToken).toBeNull();
    expect(props.bucketCode).toBe("411");
    expect(log.warn).toHaveBeenCalledWith("program-lead", expect.objectContaining({ msg: expect.any(String) }), expect.any(Error));
  });
});

// #4393: the public test bucket opens only from approved partner pages (`/book`'s origin
// gate). A registered program lead's texted link may open it too, so the program path can
// be drilled on the test bucket; registering needs Bidspoke's key, so a stranger cannot.
describe("/booking/{sfId} on the public test bucket (#4393)", () => {
  async function propsFor(xbc: string) {
    const tree = await BookingPage({ params: Promise.resolve({ id: LEAD }), searchParams: Promise.resolve({ xbc }) });
    const props = findByType(tree, Booker as unknown);
    if (!props) throw new Error("the page rendered no Booker");
    return props;
  }

  beforeEach(() => {
    vi.stubEnv("EMBED_TEST_PASS_SECRET", "t".repeat(64));
  });

  it("hands a registered program lead the test pass on the public test bucket", async () => {
    admin.supabaseAdmin.mockReturnValue(db({ data: { expires_at: new Date(NOW + 86_400_000).toISOString() }, error: null }, []));
    const props = await propsFor(PARTNER_BUCKET_CODE);
    expect(typeof props.programLeadToken).toBe("string");
    expect(typeof props.testPass).toBe("string");
  });

  it("hands anyone else on the public test bucket no test pass", async () => {
    admin.supabaseAdmin.mockReturnValue(db({ data: null, error: null }, []));
    expect((await propsFor(PARTNER_BUCKET_CODE)).testPass ?? null).toBeNull();
  });

  it("hands a program lead on a real bucket no test pass", async () => {
    admin.supabaseAdmin.mockReturnValue(db({ data: { expires_at: new Date(NOW + 86_400_000).toISOString() }, error: null }, []));
    expect((await propsFor("411")).testPass ?? null).toBeNull();
  });
});

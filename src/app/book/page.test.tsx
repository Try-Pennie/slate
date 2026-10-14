// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEMO_BUCKET_CODE, PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
import { CATCHALL_CODE } from "@/lib/routing/catchall";

// #2660: `/book?xbc=<public test code>` renders the Booker AGAINST THE TEST
// BUCKET, in test mode.
//
// This is the page level fact the route tests cannot see. The code is not an
// XBC, so before the resolver learned it the catch-all rewrote it to the Low pool
// before the bucket row was ever read: a partner opening the embed with the test
// code was shown the live Low booker and booked a real advisor, which is the
// harm the whole feature exists to prevent (red team finding 1). What matters is
// therefore WHICH code the Booker is handed, and whether it is told the booking
// is a test one, so the mode is drawn on every screen it reaches (L319, L678).
//
// The old "This booking link is not available" refusal is gone with the branch
// that drew it: after the resolver change no reachable code produces a hidden
// test bucket here (a non XBC code is rescued, an XBC code is a real bucket), so
// the branch was dead code guarded by a fixture production never produces (L29,
// L84). The confirm still refuses a hidden bucket (#2667).

const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
// #2638: the Salesforce read behind a link with no routable code. Only the live
// reader is replaced; `isLeadId` and the decoding stay real.
const leadXbc = vi.hoisted(() => ({
  readLeadXbcLive: vi.fn(async (_id: string): Promise<string | null | undefined> => undefined),
  // #3246: the submission's Lead, read when the link carried no code and no lead id.
  readSubmissionLeadIdLive: vi.fn(async (_id: string): Promise<string | null | undefined> => undefined),
}));
vi.mock("@/lib/salesforce/lead-xbc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/salesforce/lead-xbc")>()),
  readLeadXbcLive: leadXbc.readLeadXbcLive,
  readSubmissionLeadIdLive: leadXbc.readSubmissionLeadIdLive,
}));

vi.mock("@/lib/supabase/admin", () => admin);
// #3106 / #3173: the per address landing throttle, under the ceiling unless a case says
// otherwise. The address derivation stays real.
const landingIdentityAllowed = vi.hoisted(() => vi.fn(async (_ip: string) => true));
vi.mock("@/lib/rate-limit", async () => {
  const core = await import("@/lib/rate-limit-core");
  return { clientIp: core.clientIp, landingIdentityAllowed };
});
// #2666: the Referer of the iframe's own document request, which is how `/book`
// learns which website framed it.
const requestHeaders = vi.hoisted(() => ({ referer: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(requestHeaders.referer ? { referer: requestHeaders.referer } : {}),
}));
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/Booker", () => ({ default: () => null }));
vi.mock("@/components/StandaloneBookerShell", () => ({
  default: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("@/components/ClientErrorBeacon", () => ({ ClientErrorBeacon: () => null }));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 14) }));
vi.mock("@/lib/booking/reason-options", () => ({
  loadReasonOptions: vi.fn(async () => ({
    reschedule: { active: [] },
    cancel: { active: [] },
  })),
}));
vi.mock("@/lib/booking/service", () => ({
  existingCallForLanding: vi.fn(async () => null),
  landingAttendee: vi.fn(async (_identity: unknown, link: unknown) => link),
}));

import BookEntry from "./page";
import Booker from "@/components/Booker";
import { PARTNER_KEYS, partnerKeysFrom } from "@/lib/booking/partner-keys";
import { TestAccessRefused } from "@/components/TestAccessRefused";
import { TEST_ACCESS_COPY } from "@/lib/booking/booker-copy";
import { verifyTestPass } from "@/lib/embed/test-pass";
import { log } from "@/lib/log";

const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];
const SECRET = "p".repeat(64);
const APPROVED = "https://dev.approved.example";

/** The Booker element in the tree the page returned, found by its (mocked) type.
 *  The page hands back elements rather than rendering, so the props are read off
 *  the element itself. */
function bookerElement(node: unknown): Record<string, unknown> {
  const found = findByType(node, Booker as unknown);
  if (!found) throw new Error("the page rendered no Booker");
  return found;
}
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

/** The `buckets` read, answering per code, and recording which code was asked. */
function dbByCode(rows: Record<string, { org_id: string; is_test: boolean }>, asked: string[]) {
  let code = "";
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (_col: string, value: string) => {
      code = value;
      asked.push(value);
      return builder;
    },
    maybeSingle: async () => ({ data: rows[code] ?? null, error: null }),
  };
  return { from: () => builder };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMBED_TEST_PASS_SECRET", SECRET);
  vi.stubEnv("EMBED_TEST_ORIGINS", `${APPROVED},https://approved.example`);
  // An approved host by default, so the #2660 cases below still draw a booker.
  requestHeaders.referer = `${APPROVED}/`;
});

describe("/book on the public test bucket (#2660)", () => {
  it("hands the Booker the test code itself, not the Low pool, in test mode", async () => {
    const asked: string[] = [];
    admin.supabaseAdmin.mockReturnValue(
      dbByCode({ [PUBLIC_TEST]: { org_id: "o1", is_test: true } }, asked),
    );

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: PUBLIC_TEST }) });

    expect(asked).toEqual([PUBLIC_TEST]);
    expect(bookerElement(el)).toMatchObject({
      bucketCode: PUBLIC_TEST,
      requestedCode: PUBLIC_TEST,
      isTest: true,
    });
  });

  it("CONTROL: a real code renders the ordinary booker, not in test mode", async () => {
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "111": { org_id: "o1", is_test: false } }, []));

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "111" }) });

    expect(bookerElement(el)).toMatchObject({ bucketCode: "111", isTest: false });
  });

  it("CONTROL: a hidden test code is still rescued to the Low pool and drawn as a real booker", async () => {
    // The row read is for the RESOLVED code, so the hidden bucket's row is never
    // even asked for: to this page the canary's code is a typo like any other.
    const asked: string[] = [];
    admin.supabaseAdmin.mockReturnValue(
      dbByCode(
        { SMOKE: { org_id: "o1", is_test: true }, [CATCHALL_CODE]: { org_id: "o1", is_test: false } },
        asked,
      ),
    );

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "SMOKE" }) });

    expect(asked).toEqual([CATCHALL_CODE]);
    expect(bookerElement(el)).toMatchObject({ bucketCode: CATCHALL_CODE, requestedCode: "SMOKE", isTest: false });
  });

  it("renders the booker, not in test mode, when the resolved code has no row yet", async () => {
    // Before the seed has run the test code resolves to no row. The page still
    // draws the booker (the availability read then answers 404 and the booker
    // says it could not load), rather than refusing with a sentence about a
    // link: nothing here is the tester's to fix.
    admin.supabaseAdmin.mockReturnValue(dbByCode({}, []));

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: PUBLIC_TEST }) });

    expect(bookerElement(el)).toMatchObject({ bucketCode: PUBLIC_TEST, isTest: false });
  });
});

// #2659: trypennie puts `submissionId=<submission.Id>` on the `/book` URL (its
// `SlateCalendar.tsx`), and a page may add `regalProfileId`. The page keeps
// every query param in `prefill`, so the keys ride into the booking, the
// webhooks and the warehouse under the spelling the URL used. This pins that
// the two names survive EXACTLY, because every reader downstream looks them up
// by that spelling through one constant, and a page that started filtering
// prefill to the fields it knows would drop them with nothing else failing.
// #2666: the public test bucket opens only for a page on an approved website, and
// the page says in the tester's words why it did not.
describe("/book gates the public test bucket on the host's origin (#2666)", () => {
  function refusal(node: unknown): Record<string, unknown> | null {
    return findByType(node, TestAccessRefused as unknown);
  }
  const testRows = () =>
    admin.supabaseAdmin.mockReturnValue(dbByCode({ [PUBLIC_TEST]: { org_id: "o1", is_test: true } }, []));

  it("hands an approved page a pass bound to the public code", async () => {
    testRows();
    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: PUBLIC_TEST }) });
    const pass = bookerElement(el).testPass;
    expect(typeof pass).toBe("string");
    expect(verifyTestPass({ pass: pass as string, code: PUBLIC_TEST, secret: SECRET, nowMs: Date.now() })).toEqual({ ok: true });
    expect(refusal(el)).toBeNull();
  });

  it("refuses a page with no referer, naming the cause", async () => {
    requestHeaders.referer = null;
    testRows();
    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: PUBLIC_TEST }) });
    expect(findByType(el, Booker as unknown)).toBeNull();
    expect(refusal(el)).toMatchObject({ sentence: TEST_ACCESS_COPY.noReferer });
    expect(log.warn).toHaveBeenCalledWith("embed-test", expect.objectContaining({ reason: "no-referer" }));
    // Nothing about any lead is read for a page that is not going to be drawn.
    expect(admin.supabaseAdmin).not.toHaveBeenCalled();
  });

  // #3424: the demo bucket opens from Slate's own /demo page only. Through /book it
  // is refused even from an approved website, in its own words, and before anything
  // about any lead is read.
  it("refuses the demo bucket from an approved website, pointing back at the demo link", async () => {
    testRows();
    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: DEMO_BUCKET_CODE }) });
    expect(findByType(el, Booker as unknown)).toBeNull();
    expect(refusal(el)).toMatchObject({ sentence: TEST_ACCESS_COPY.demoPageOnly });
    expect(log.warn).toHaveBeenCalledWith("embed-test", expect.objectContaining({ reason: "demo-page-only" }));
    expect(admin.supabaseAdmin).not.toHaveBeenCalled();
  });

  it("refuses an unlisted website and names it", async () => {
    requestHeaders.referer = "https://elsewhere.example/landing?x=1";
    testRows();
    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: PUBLIC_TEST }) });
    expect(findByType(el, Booker as unknown)).toBeNull();
    expect(refusal(el)).toMatchObject({
      sentence: TEST_ACCESS_COPY.unlistedOrigin("https://elsewhere.example"),
    });
    expect(log.warn).toHaveBeenCalledWith(
      "embed-test",
      expect.objectContaining({ reason: "unlisted-origin", origin: "https://elsewhere.example" }),
    );
  });

  it("is switched off, in its own words, with no secret", async () => {
    vi.stubEnv("EMBED_TEST_PASS_SECRET", "");
    testRows();
    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: PUBLIC_TEST }) });
    expect(refusal(el)).toMatchObject({ sentence: TEST_ACCESS_COPY.secretUnset });
  });

  it("is switched off, in its own words, with an empty origin list", async () => {
    vi.stubEnv("EMBED_TEST_ORIGINS", "");
    testRows();
    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: PUBLIC_TEST }) });
    expect(refusal(el)).toMatchObject({ sentence: TEST_ACCESS_COPY.listEmpty });
  });

  it("CONTROL: a real code with no referer draws the ordinary booker and hands it no pass", async () => {
    requestHeaders.referer = null;
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "111": { org_id: "o1", is_test: false } }, []));
    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "111" }) });
    expect(bookerElement(el)).toMatchObject({ bucketCode: "111", testPass: null });
    expect(refusal(el)).toBeNull();
    expect(log.warn).not.toHaveBeenCalledWith("embed-test", expect.anything());
  });
});

describe("/book keeps the partner join keys in prefill (#2659)", () => {
  it("hands the Booker submissionId and regalProfileId under their exact spelling", async () => {
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "111": { org_id: "o1", is_test: false } }, []));

    const el = await BookEntry({
      searchParams: Promise.resolve({
        xbc: "111",
        [PARTNER_KEYS.submissionId]: "a0G5x00000AbCdEQAU",
        [PARTNER_KEYS.regalProfileId]: "rp_01HZY3",
      }),
    });

    const prefill = bookerElement(el).prefill as Record<string, string>;
    expect(prefill[PARTNER_KEYS.submissionId]).toBe("a0G5x00000AbCdEQAU");
    expect(prefill[PARTNER_KEYS.regalProfileId]).toBe("rp_01HZY3");
    // And the one reader every consumer goes through gets them back out.
    expect(partnerKeysFrom(prefill)).toEqual({
      submissionId: "a0G5x00000AbCdEQAU",
      regalProfileId: "rp_01HZY3",
    });
  });

  it("CONTROL: a page with neither key hands the Booker a prefill both read as null", async () => {
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "111": { org_id: "o1", is_test: false } }, []));

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "111", utm_source: "google" }) });

    const prefill = bookerElement(el).prefill as Record<string, string>;
    expect(partnerKeysFrom(prefill)).toEqual({ submissionId: null, regalProfileId: null });
  });
});

// #2638: a link with no routable code that names the lead is routed on the lead's
// Salesforce XBC, and the PAGE shows that pool's times, so the times shown and
// the pool the confirm books agree.
describe("/book with no code on the link and a Lead id (#2638)", () => {
  const LEAD = "00Q5e00000AbCdEEAU";

  it("shows the pool the lead's Salesforce XBC names", async () => {
    leadXbc.readLeadXbcLive.mockResolvedValueOnce("512");
    const asked: string[] = [];
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "512": { org_id: "o1", is_test: false } }, asked));

    const el = await BookEntry({ searchParams: Promise.resolve({ external_id: LEAD }) });

    expect(leadXbc.readLeadXbcLive).toHaveBeenCalledWith(LEAD);
    expect(asked).toEqual(["512"]);
    expect(bookerElement(el)).toMatchObject({ bucketCode: "512", isTest: false });
  });

  it("takes the catch-all when Salesforce holds no code", async () => {
    leadXbc.readLeadXbcLive.mockResolvedValueOnce(null);
    admin.supabaseAdmin.mockReturnValue(dbByCode({ [CATCHALL_CODE]: { org_id: "o1", is_test: false } }, []));

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "", external_id: LEAD }) });

    expect(bookerElement(el)).toMatchObject({ bucketCode: CATCHALL_CODE });
  });

  it("throws to the error boundary when the Salesforce read fails, never showing the catch-all", async () => {
    leadXbc.readLeadXbcLive.mockRejectedValueOnce(new Error("SF query failed: 503"));
    admin.supabaseAdmin.mockReturnValue(dbByCode({ [CATCHALL_CODE]: { org_id: "o1", is_test: false } }, []));

    await expect(BookEntry({ searchParams: Promise.resolve({ external_id: LEAD }) })).rejects.toThrow(
      /temporary issue/,
    );
  });

  // #3508 reverses the old rule here, at the LANDING only: four trypennie pages put
  // the Lead's stale XBC__c on the link, so a routable code is no longer taken on
  // trust when the link names the lead. The confirm still never asks (it books the
  // team this page showed), which test-routing-lead-code.ts holds.
  it("#3508: a routable but stale link code shows the team of the lead's current score", async () => {
    leadXbc.readLeadXbcLive.mockResolvedValueOnce("312");
    const asked: string[] = [];
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "312": { org_id: "o1", is_test: false } }, asked));

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "112", external_id: LEAD }) });

    expect(leadXbc.readLeadXbcLive).toHaveBeenCalledWith(LEAD);
    expect(asked).toEqual(["312"]);
    // The Booker shows 312 and still posts what the link carried, so the confirm can record both.
    expect(bookerElement(el)).toMatchObject({ bucketCode: "312", requestedCode: "112" });
  });

  it("CONTROL: an agreeing score leaves the link's code", async () => {
    leadXbc.readLeadXbcLive.mockResolvedValueOnce("111");
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "111": { org_id: "o1", is_test: false } }, []));

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "111", external_id: LEAD }) });

    expect(bookerElement(el)).toMatchObject({ bucketCode: "111", requestedCode: "111" });
  });

  it("#3508: a failed score read keeps the link's code and logs it, never refusing the page", async () => {
    leadXbc.readLeadXbcLive.mockRejectedValueOnce(new Error("SF query failed: 503"));
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "112": { org_id: "o1", is_test: false } }, []));

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "112", external_id: LEAD }) });

    expect(bookerElement(el)).toMatchObject({ bucketCode: "112" });
    expect(log.warn).toHaveBeenCalledWith("landing", expect.objectContaining({ code: "112" }), expect.any(Error));
  });

  it("#3508: over the landing ceiling, a routable link code is shown as sent and nothing is read", async () => {
    landingIdentityAllowed.mockResolvedValueOnce(false);
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "112": { org_id: "o1", is_test: false } }, []));

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "112", external_id: LEAD }) });

    expect(leadXbc.readLeadXbcLive).not.toHaveBeenCalled();
    expect(bookerElement(el)).toMatchObject({ bucketCode: "112" });
  });

  // #3173: the routing read sits behind the same per address throttle as the identity
  // reads, so a blank code flood of guessed ids costs no Salesforce read once over it.
  it("over the landing ceiling, shows the default route without asking Salesforce", async () => {
    landingIdentityAllowed.mockResolvedValueOnce(false);
    const asked: string[] = [];
    admin.supabaseAdmin.mockReturnValue(dbByCode({ [CATCHALL_CODE]: { org_id: "o1", is_test: false } }, asked));

    const el = await BookEntry({ searchParams: Promise.resolve({ external_id: LEAD }) });

    expect(landingIdentityAllowed).toHaveBeenCalledTimes(1);
    expect(leadXbc.readLeadXbcLive).not.toHaveBeenCalled();
    expect(asked).toEqual([CATCHALL_CODE]);
    // The id still reaches the confirm, which routes on the lead's own code.
    expect(bookerElement(el)).toMatchObject({ bucketCode: CATCHALL_CODE, salesforceId: LEAD });
  });

  it("CONTROL: under the ceiling, one page spends one count for both reads", async () => {
    leadXbc.readLeadXbcLive.mockResolvedValueOnce("512");
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "512": { org_id: "o1", is_test: false } }, []));

    await BookEntry({ searchParams: Promise.resolve({ external_id: LEAD }) });

    expect(landingIdentityAllowed).toHaveBeenCalledTimes(1);
    expect(leadXbc.readLeadXbcLive).toHaveBeenCalledWith(LEAD);
  });
});

// #3246: on iPhone Safari the widget could build the booker before the page's query
// was forwarded, so the link carried only the submission id. The page finds the lead
// through the submission and shows that lead's pool, as the confirm books it.
describe("/book with no code and no Lead id, but a submission id (#3246)", () => {
  const SUB = "a04Ui00000NNZ7uIAH";
  const LEAD = "00QUi000010Sab8MAC";

  it("shows the pool of the lead the submission names", async () => {
    leadXbc.readSubmissionLeadIdLive.mockResolvedValueOnce(LEAD);
    leadXbc.readLeadXbcLive.mockResolvedValueOnce("512");
    const asked: string[] = [];
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "512": { org_id: "o1", is_test: false } }, asked));

    const el = await BookEntry({ searchParams: Promise.resolve({ form: "f", submissionId: SUB, embed: "1" }) });

    expect(leadXbc.readSubmissionLeadIdLive).toHaveBeenCalledWith(SUB);
    expect(leadXbc.readLeadXbcLive).toHaveBeenCalledWith(LEAD);
    expect(asked).toEqual(["512"]);
    expect(bookerElement(el)).toMatchObject({ bucketCode: "512" });
  });

  it("CONTROL: a routable code never reads the submission and spends nothing", async () => {
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "111": { org_id: "o1", is_test: false } }, []));

    await BookEntry({ searchParams: Promise.resolve({ xbc: "111", submissionId: SUB }) });

    expect(leadXbc.readSubmissionLeadIdLive).not.toHaveBeenCalled();
    expect(landingIdentityAllowed).not.toHaveBeenCalled();
  });

  it("CONTROL: a lead id on the link wins and the submission is never read", async () => {
    leadXbc.readLeadXbcLive.mockResolvedValueOnce("312");
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "312": { org_id: "o1", is_test: false } }, []));

    await BookEntry({ searchParams: Promise.resolve({ external_id: LEAD, submissionId: SUB }) });

    expect(leadXbc.readSubmissionLeadIdLive).not.toHaveBeenCalled();
    expect(landingIdentityAllowed).toHaveBeenCalledTimes(1);
  });

  it("over the landing ceiling, shows the default route without asking Salesforce", async () => {
    landingIdentityAllowed.mockResolvedValueOnce(false);
    const asked: string[] = [];
    admin.supabaseAdmin.mockReturnValue(dbByCode({ [CATCHALL_CODE]: { org_id: "o1", is_test: false } }, asked));

    const el = await BookEntry({ searchParams: Promise.resolve({ submissionId: SUB }) });

    expect(leadXbc.readSubmissionLeadIdLive).not.toHaveBeenCalled();
    expect(asked).toEqual([CATCHALL_CODE]);
    expect(bookerElement(el)).toMatchObject({ bucketCode: CATCHALL_CODE });
  });

  it("throws to the error boundary when the submission read fails, never showing the catch-all", async () => {
    leadXbc.readSubmissionLeadIdLive.mockRejectedValueOnce(new Error("SF query failed: 503"));
    admin.supabaseAdmin.mockReturnValue(dbByCode({ [CATCHALL_CODE]: { org_id: "o1", is_test: false } }, []));

    await expect(BookEntry({ searchParams: Promise.resolve({ submissionId: SUB }) })).rejects.toThrow(/temporary issue/);
  });
});

// #3718: widget.js's inline embed asks for the compact card with `layout=inline`.
describe("/book layout (#3718)", () => {
  it("hands the Booker the inline layout when the address asks for it", async () => {
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "111": { org_id: "o1", is_test: false } }, []));
    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "111", embed: "1", layout: "inline" }) });
    expect(bookerElement(el)).toMatchObject({ layout: "inline" });
  });

  it("hands it no layout otherwise, and none for a value it does not know", async () => {
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "111": { org_id: "o1", is_test: false } }, []));
    const plain = await BookEntry({ searchParams: Promise.resolve({ xbc: "111", embed: "1" }) });
    expect(bookerElement(plain).layout).toBeUndefined();
    const odd = await BookEntry({ searchParams: Promise.resolve({ xbc: "111", layout: "month_view" }) });
    expect(bookerElement(odd).layout).toBeUndefined();
  });
});

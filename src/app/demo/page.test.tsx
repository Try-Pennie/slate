// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEMO_BUCKET_CODE } from "@/lib/embed/public-test-bucket";

// #3424: `/demo` is the link sent to somebody outside Pennie. It draws the booker
// on the demo bucket, in test mode, prefilled with a made up person of its OWN for
// every visit, and hands the Booker the pass the public test routes demand, which
// on `/book` only an approved host page earns. What matters here is what the
// Booker is handed, so the props are read off the element.

const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/components/Booker", () => ({ default: () => null }));
vi.mock("@/components/StandaloneBookerShell", () => ({
  default: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("@/components/ClientErrorBeacon", () => ({ ClientErrorBeacon: () => null }));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 14) }));
vi.mock("@/lib/booking/reason-options", () => ({
  loadReasonOptions: vi.fn(async () => ({ reschedule: { active: [] }, cancel: { active: [] } })),
}));

import DemoPage from "./page";
import Booker from "@/components/Booker";
import { verifyTestPass } from "@/lib/embed/test-pass";

const SECRET = "d".repeat(64);

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

/** The `buckets` read, answering per code and recording which code was asked. */
function bucketRows(rows: Record<string, { is_test: boolean }>, asked: string[]) {
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

async function render(sp: Record<string, string> = {}) {
  const el = await DemoPage({ searchParams: Promise.resolve(sp) });
  const booker = findByType(el, Booker as unknown);
  if (!booker) throw new Error("the page rendered no Booker");
  return booker;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMBED_TEST_PASS_SECRET", SECRET);
});

describe("/demo (#3424)", () => {
  it("draws the booker on the demo bucket, in test mode, with a pass the routes accept", async () => {
    const asked: string[] = [];
    admin.supabaseAdmin.mockReturnValue(bucketRows({ [DEMO_BUCKET_CODE]: { is_test: true } }, asked));
    const b = await render();
    expect(b.bucketCode).toBe(DEMO_BUCKET_CODE);
    expect(asked).toEqual([DEMO_BUCKET_CODE]);
    expect(b.isTest).toBe(true);
    expect(b.embedded).toBe(false);
    const pass = b.testPass as string | null;
    expect(pass).not.toBeNull();
    expect(verifyTestPass({ pass, code: DEMO_BUCKET_CODE, secret: SECRET, nowMs: Date.now() })).toEqual({ ok: true });
  });

  it("prefills a made up person, complete, so the visitor only picks a time", async () => {
    admin.supabaseAdmin.mockReturnValue(bucketRows({ [DEMO_BUCKET_CODE]: { is_test: true } }, []));
    const b = await render();
    const attendee = b.attendee as { name: string; email: string; phone: string };
    expect(attendee.name).toBe("Demo Lead");
    expect(attendee.email).toMatch(/^demo\+[a-z0-9]+@trypennie\.com$/);
    expect(attendee.phone).toMatch(/555-01\d{2}$/);
    expect(b.salesforceId).toMatch(/^demo-[a-z0-9]+$/);
    expect(b.landingCall).toBeNull();
  });

  it("gives every visit its own person, so two visitors never read as one", async () => {
    admin.supabaseAdmin.mockReturnValue(bucketRows({ [DEMO_BUCKET_CODE]: { is_test: true } }, []));
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const b = await render();
      seen.add((b.attendee as { email: string }).email);
    }
    expect(seen.size).toBe(20);
  });

  it("draws the dark booker when asked, and the light one otherwise", async () => {
    admin.supabaseAdmin.mockReturnValue(bucketRows({ [DEMO_BUCKET_CODE]: { is_test: true } }, []));
    expect((await render({ theme: "dark" })).theme).toBe("dark");
    expect((await render()).theme).toBe("light");
  });

  it("does not claim test mode for a bucket row that is not flagged a test", async () => {
    // The seed always flags it; a row that is not would be a misconfiguration, and
    // the booker must not draw a demo band over it.
    admin.supabaseAdmin.mockReturnValue(bucketRows({ [DEMO_BUCKET_CODE]: { is_test: false } }, []));
    expect((await render()).isTest).toBe(false);
  });

  it("throws on an unreadable bucket rather than drawing a booker that may not be a test", async () => {
    admin.supabaseAdmin.mockReturnValue({
      from: () => {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: null, error: { message: "boom" } }),
        };
        return b;
      },
    });
    await expect(DemoPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/landing page bucket/);
  });
});

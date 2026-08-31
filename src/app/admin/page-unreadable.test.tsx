// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #1629: the admin page read six tables in one `Promise.all` and destructured each
// as `(res.data ?? [])`, so an unreadable table drew exactly the screen an EMPTY
// one draws. On this page every one of those empty pictures is also a legitimate
// and alarming reading (no agents, no buckets, nobody in any pool, nothing ever
// sent to Regal), and two of them sit next to a control that would write the empty
// reading back as fact.
//
// These tests fail one table at a time, and each asserts BOTH halves: the panel
// says it could not be read, and the panel's own empty-state copy is absent. A
// test that only checked for the notice would pass on a page that had simply
// stopped rendering the panel at all.
//
// The access guard tests live in page.test.tsx; these mount the whole page as a
// super admin, so a separate file keeps that one small and this one's heavy fake
// out of its way.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({
  oooOnlyFor: vi.fn(() => false),
  appUrl: vi.fn(() => "https://slate.test"),
  reassignApiKey: vi.fn(() => "key"),
}));
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
const heartbeat = vi.hoisted(() => ({ readAllHeartbeatMs: vi.fn(async () => ({})) }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({
  redirect,
  notFound: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/admin",
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  oooOnlyFor: env.oooOnlyFor,
  appUrl: env.appUrl,
  reassignApiKey: env.reassignApiKey,
}));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
// Async server components RTL cannot render, and the server actions the forms
// point at (which would pull the whole write path in).
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
// Every server action the page (and the panels it mounts) points a <form> at.
// Named individually rather than through a Proxy so a NEW action added to the
// page fails here loudly instead of silently resolving to a no-op.
vi.mock("@/app/admin/actions", () => ({
  createBucket: vi.fn(),
  createEventType: vi.fn(),
  grantStaffAccess: vi.fn(),
  replayFailedWebhooks: vi.fn(),
  resendWebhookDelivery: vi.fn(),
  revokeStaffAccess: vi.fn(),
  startImpersonation: vi.fn(),
  setWebhookEndpoint: vi.fn(),
  syncSalesforceNow: vi.fn(),
  updateBucket: vi.fn(),
}));

import AdminPage from "./page";

const SUPER_ADMIN = {
  id: "s1",
  role: "super_admin",
  org_id: "o1",
  email: "s@x.com",
  name: "Sam",
  theme_preference: null,
  bookable: false,
  avatar_url: null,
};

type Result = { data: unknown; error: { message: string } | null };

/**
 * A roster that is genuinely NOT empty, so "the panel is empty" can never be the
 * correct answer in any case below.
 */
const HEALTHY: Record<string, Result> = {
  users: {
    data: [
      {
        id: "u1",
        org_id: "o1",
        name: "Ada Byron",
        email: "ada@x.com",
        role: "agent",
        bookable: true,
        attributes: { debt_team: "alpha" },
        deactivated_at: null,
        manager_id: null,
        is_test: false,
      },
    ],
    error: null,
  },
  event_types: {
    data: [
      {
        id: "et1",
        org_id: "o1",
        name: "Advisor Call",
        duration_min: 30,
        slot_interval_min: 15,
        min_notice_min: 120,
        buffer_before_min: 0,
        buffer_after_min: 0,
        daily_cap: null,
      },
    ],
    error: null,
  },
  buckets: {
    data: [
      {
        id: "b1",
        org_id: "o1",
        code: "311",
        name: "High tier",
        criteria: {},
        is_test: false,
        fallback_user_id: null,
        event_type_id: "et1",
      },
    ],
    error: null,
  },
  bucket_members: { data: [{ bucket_id: "b1", user_id: "u1", active: true }], error: null },
  webhook_endpoints: {
    data: { id: "w1", org_id: "o1", url: "https://regal.test/events", format: "regal", auth_header: "set" },
    error: null,
  },
  agent_calendars: {
    data: [
      {
        user_id: "u1",
        watch_expiration: new Date(Date.now() + 86_400_000).toISOString(),
        consecutive_failures: 0,
        last_success_at: new Date().toISOString(),
        last_sync_error: null,
        watch_consecutive_failures: 0,
        watch_last_success_at: new Date().toISOString(),
        watch_last_error: null,
      },
    ],
    error: null,
  },
  bookings: { data: [], error: null },
  audit_log: { data: [], error: null },
  webhook_deliveries: { data: [], error: null },
};

/**
 * The webhook_endpoints table is read TWICE with different shapes (the singleton
 * row via maybeSingle, then id+url as a list for the delivery log), so the fake
 * answers by whether `maybeSingle` was reached rather than by table alone.
 */
function mockDb(overrides: Record<string, Result> = {}) {
  const byTable = { ...HEALTHY, ...overrides };
  admin.supabaseAdmin.mockReturnValue({
    from: (table: string) => {
      const result = byTable[table] ?? { data: [], error: null };
      let single = false;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not", "gte", "lte", "order", "limit", "range"]) {
        b[m] = () => b;
      }
      b.maybeSingle = () => {
        single = true;
        return b;
      };
      b.single = b.maybeSingle;
      b.then = (resolve: (r: Result) => unknown) => {
        if (table === "webhook_endpoints" && !single) {
          // The list read for the delivery log: an array, or the same error.
          return Promise.resolve(
            result.error
              ? result
              : { data: result.data ? [{ id: "w1", url: "https://regal.test/events" }] : [], error: null },
          ).then(resolve);
        }
        return Promise.resolve(result).then(resolve);
      };
      return b;
    },
  });
}

const props = { searchParams: Promise.resolve({}) };
const fails = (message: string): Result => ({ data: null, error: { message } });

beforeEach(() => {
  vi.clearAllMocks();
  env.oooOnlyFor.mockReturnValue(false);
  heartbeat.readAllHeartbeatMs.mockResolvedValue({});
  auth.currentUser.mockResolvedValue(SUPER_ADMIN);
});

describe("AdminPage with every read healthy (the control)", () => {
  it("renders each panel's real content and raises no unreadable notice", async () => {
    mockDb();
    render(await AdminPage(props));
    // Without this control every assertion below is satisfied by a page that
    // renders nothing at all (L159).
    expect(screen.getAllByText(/Ada Byron/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Advisor Call/).length).toBeGreaterThan(0);
    expect(screen.getByText(/No deliveries yet/i)).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });
});

describe("AdminPage on an unreadable table (#1629)", () => {
  it("says the event types could not be read instead of listing none", async () => {
    mockDb({ event_types: fails("event_types read exploded") });
    render(await AdminPage(props));
    expect(screen.getAllByText(/event types could not be read/i).length).toBeGreaterThan(0);
    // "None yet." beside a create form is an invitation to make a duplicate.
    expect(screen.queryByText(/^None yet\.$/)).toBeNull();
  });

  it("says the buckets could not be read, and withholds the routing editor", async () => {
    mockDb({ buckets: fails("buckets read exploded") });
    render(await AdminPage(props));
    expect(screen.getByText(/buckets could not be read/i)).toBeTruthy();
    // The editor writes what it shows, so it must not be offered over blanks.
    expect(screen.queryByText(/New bucket/i)).toBeNull();
  });

  it("says the memberships could not be read rather than showing empty pools", async () => {
    mockDb({ bucket_members: fails("bucket_members read exploded") });
    render(await AdminPage(props));
    expect(screen.getByText(/memberships could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/New bucket/i)).toBeNull();
  });

  it("says the recent bookings could not be read, not that nothing was booked", async () => {
    mockDb({ bookings: fails("bookings read exploded") });
    render(await AdminPage(props));
    expect(screen.getByText(/recent bookings could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/How the last .* bookings routed/i)).toBeNull();
  });

  it("withholds the webhook form when the endpoint could not be read", async () => {
    mockDb({ webhook_endpoints: fails("webhook_endpoints read exploded") });
    render(await AdminPage(props));
    expect(screen.getByText(/webhook endpoint could not be read/i)).toBeTruthy();
    // Saving a blank prefill would overwrite the live Regal endpoint.
    expect(screen.queryByLabelText(/Authorization header/i)).toBeNull();
  });

  it("reports push health as unavailable, never as zero watched", async () => {
    mockDb({ agent_calendars: fails("agent_calendars read exploded") });
    render(await AdminPage(props));
    expect(screen.getByText(/push health unavailable/i)).toBeTruthy();
    // "push 0/1 watched" is a fleet-wide push outage that is not happening.
    expect(screen.queryByText(/push \d+\/\d+ watched/)).toBeNull();
    // And the same read feeds the failure list, whose emptiness is an all-clear.
    expect(screen.getByText(/sync health could not be read/i)).toBeTruthy();
  });

  it("says the delivery log could not be read, not that nothing was sent", async () => {
    mockDb({ webhook_deliveries: fails("webhook_deliveries read exploded") });
    render(await AdminPage(props));
    expect(screen.getByText(/delivery log could not be read/i)).toBeTruthy();
    // This panel is opened to check whether a webhook was sent, so "No deliveries
    // yet." off a failed read answers the exact question with a wrong answer.
    expect(screen.queryByText(/No deliveries yet/i)).toBeNull();
  });

  it("reports the roster count as absent, never as zero of zero", async () => {
    mockDb({ users: fails("users read exploded") });
    render(await AdminPage(props));
    expect(screen.getByText(/roster could not be read, so there is no count/i)).toBeTruthy();
    expect(screen.queryByText(/bookable of/)).toBeNull();
  });

  it("one failing read does not blank the panels whose reads succeeded", async () => {
    mockDb({ bookings: fails("bookings read exploded") });
    render(await AdminPage(props));
    // The six sibling reads in the same Promise.all still render their content.
    expect(screen.getAllByText(/Ada Byron/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Advisor Call/).length).toBeGreaterThan(0);
    expect(screen.getByText(/New bucket/i)).toBeTruthy();
  });
});

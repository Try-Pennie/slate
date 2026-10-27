// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

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
  consoleHiddenFor: vi.fn(() => false),
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
  consoleHiddenFor: env.consoleHiddenFor,
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
// #3027: the roster reads advisor photos through its own store; every row holds a
// directory photo here, so these suites judge only what they are about.
vi.mock("@/lib/advisor-photos/store", () => ({
  loadPhotoRecords: async (ids: string[]) =>
    new Map(ids.map((id) => [id, { state: "photo" as const, sha256: "a".repeat(64) }])),
}));
vi.mock("@/app/admin/actions", () => ({
  refreshAdvisorPhotosNow: vi.fn(),
  createBucket: vi.fn(),
  createEventType: vi.fn(),
  setEventTypeGap: vi.fn(),
  setEventTypeNotice: vi.fn(),
  grantStaffAccess: vi.fn(),
  replayFailedWebhooks: vi.fn(),
  resendWebhookDelivery: vi.fn(),
  sendTestWebhook: vi.fn(),
  revokeStaffAccess: vi.fn(),
  startImpersonation: vi.fn(),
  setWebhookEndpoint: vi.fn(),
  setDefaultBucket: vi.fn(),
  syncSalesforceNow: vi.fn(),
  updateBucket: vi.fn(),
}));

import AdminHealthPage from "./page";
import AgentRosterPage from "./agents/page";
import BucketsPage from "./buckets/page";
import EventTypesPage from "./event-types/page";
import RecentRoutingPage from "./routing/page";
import WebhooksPage from "./webhooks/page";

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
  bucket_members: { data: [{ id: "m1", bucket_id: "b1", user_id: "u1", active: true }], error: null },
  webhook_endpoints: {
    data: { id: "w1", org_id: "o1", url: "https://regal.test/events", format: "regal", auth_header: "set" },
    error: null,
  },
  // #1646: this calendar is deliberately FAILING its sync lane. The sync-health
  // panel is drawn only when it has rows, so a fixture whose calendar is clean
  // never draws it in the control either, and a test asserting the panel is gone
  // on a failed read is then satisfied by a state in which it could not have been
  // there anyway (L159). A failing calendar makes the panel a positive control:
  // it renders here, so every case below can be seen to REPLACE it with a notice.
  // The watch lane stays clean, so exactly one row is expected.
  agent_calendars: {
    data: [
      {
        user_id: "u1",
        watch_expiration: new Date(Date.now() + 86_400_000).toISOString(),
        consecutive_failures: 4,
        last_success_at: new Date().toISOString(),
        last_sync_error: "invalid_grant",
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
/**
 * Every `.eq(column, value)` this fake was asked for, grouped BY READ (#1914).
 *
 * The fake does not FILTER, deliberately: it answers each table with a fixed
 * result so a test can fail one read at a time. That means output cannot tell a
 * filtered read from an unfiltered one, and a test written against the rows would
 * pass whichever way the query went (L143). So the filters are recorded and
 * asserted directly.
 *
 * ONE ENTRY PER `from(table)` CALL, not one per table, and that is not tidiness.
 * The buckets page reads `buckets` TWICE (the editor's list and the default
 * bucket picker) and only one of them filtered `is_test`. A recorder keyed on the
 * table alone merges them, so an assertion that `is_test` was applied is answered
 * by the OTHER read: the #1929 filter was removed and the test still passed
 * (L178, an assertion satisfied by a different place in the same haystack proves
 * neither half).
 */
const eqCalls: Record<string, [string, unknown][][]> = {};

/**
 * Every `.in(column, values)` and `.range(from, to)` per read (#1933).
 *
 * The members read is scoped by bucket id and paginated. The fake does neither,
 * so the rows it returns look the same however the query was built, and the only
 * honest assertions are on the query and on whether a SECOND page was asked for.
 */
const inCalls: Record<string, [string, unknown][][]> = {};
const rangeCalls: Record<string, [number, number][]> = {};
/** The keyset filter each later page of a paged read is cut with (2026-10-25). */
const gtCalls: Record<string, [string, unknown][]> = {};

/**
 * A table that answers one array per PAGE, so pagination can be exercised.
 * `pagedByTable.bucket_members = [firstPage, secondPage]` makes the first page
 * request return the first and the second the second, which is what a truncating
 * read cannot do.
 */
const pagedByTable: Record<string, unknown[][]> = {};

/** Every eq filter applied to a table, flattened, when the read does not matter. */
const eqAnyRead = (table: string): [string, unknown][] => (eqCalls[table] ?? []).flat();

/** Whether EVERY read of a table applied this filter, which is the invariant when
 *  two reads of one table must agree about the population they cover. */
const everyReadHas = (table: string, column: string, value: unknown): boolean => {
  const reads = eqCalls[table] ?? [];
  return reads.length > 0 && reads.every((r) => r.some(([c, v]) => c === column && v === value));
};

function mockDb(overrides: Record<string, Result> = {}) {
  const byTable = { ...HEALTHY, ...overrides };
  for (const k of Object.keys(eqCalls)) delete eqCalls[k];
  for (const k of Object.keys(inCalls)) delete inCalls[k];
  for (const k of Object.keys(rangeCalls)) delete rangeCalls[k];
  for (const k of Object.keys(gtCalls)) delete gtCalls[k];
  admin.supabaseAdmin.mockReturnValue({
    from: (table: string) => {
      const result = byTable[table] ?? { data: [], error: null };
      let single = false;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "neq", "in", "not", "gte", "lte", "order", "limit", "range"]) {
        b[m] = () => b;
      }
      // A fresh group per `from(table)` call, so two reads of one table stay apart.
      const thisRead: [string, unknown][] = [];
      (eqCalls[table] ??= []).push(thisRead);
      const thisIn: [string, unknown][] = [];
      (inCalls[table] ??= []).push(thisIn);
      let page = -1;
      b.eq = (column: string, value: unknown) => {
        thisRead.push([column, value]);
        return b;
      };
      b.in = (column: string, values: unknown) => {
        thisIn.push([column, values]);
        return b;
      };
      b.gt = (column: string, value: unknown) => {
        (gtCalls[table] ??= []).push([column, value]);
        return b;
      };
      b.range = (from: number, to: number) => {
        (rangeCalls[table] ??= []).push([from, to]);
        page = rangeCalls[table]!.length - 1;
        return b;
      };
      /** The page this read should answer with, when the table is paged. */
      const pageData = () => {
        const pages = pagedByTable[table];
        if (!pages) return undefined;
        return pages[page] ?? [];
      };
      b.maybeSingle = () => {
        single = true;
        return b;
      };
      b.single = b.maybeSingle;
      b.then = (resolve: (r: Result) => unknown) => {
        const paged = pageData();
        if (paged !== undefined && !result.error) {
          return Promise.resolve({ data: paged, error: null }).then(resolve);
        }
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

/** The same page, opened at the address one of its own actions redirects to. */
const withQuery = (query: Record<string, string>) => ({
  searchParams: Promise.resolve(query),
});

beforeEach(() => {
  vi.clearAllMocks();
  env.consoleHiddenFor.mockReturnValue(false);
  heartbeat.readAllHeartbeatMs.mockResolvedValue({});
  auth.currentUser.mockResolvedValue(SUPER_ADMIN);
});

// #1748 split these panels across five routes. The control has to follow them:
// one control over one page would leave the other four's assertions satisfiable
// by a page that renders nothing at all (L159), which is the whole reason this
// file has a control.
describe("every read healthy (the control)", () => {
  it("draws the health page's real counts and raises no unreadable notice", async () => {
    mockDb();
    render(await AdminHealthPage());
    expect(screen.getByText(/bookable of/)).toBeTruthy();
    // #1646: the sync-health panel's positive control. Every case below asserts
    // this panel is ABSENT and a notice stands in its place, which proves nothing
    // unless the panel is present when every read succeeded.
    expect(screen.getByText(/1 agent with a calendar problem/i)).toBeTruthy();
    expect(screen.getByText(/failing to sync, 4 consecutive failures/i)).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it("draws the roster's real agents and raises no unreadable notice", async () => {
    mockDb();
    render(await AgentRosterPage(props));
    expect(screen.getAllByText(/Ada Byron/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it("draws the real pools and offers the editor", async () => {
    mockDb();
    render(await BucketsPage(props));
    expect(screen.getByText(/New bucket/i)).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it("draws the real event types", async () => {
    mockDb();
    render(await EventTypesPage(props));
    expect(screen.getAllByText(/Advisor Call/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it("draws the delivery log's real empty state", async () => {
    mockDb();
    render(await WebhooksPage(props));
    expect(screen.getByText(/No deliveries yet/i)).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it("draws the recent routing table", async () => {
    mockDb();
    render(await RecentRoutingPage());
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });
});

// #1914. "Routed to" rendered `c0000000` on every row, which is the first eight
// characters of the agent's id, because the name lookup missed.
//
// The cause is that the two reads on that page disagreed about what counts: the
// roster was read with `is_test = false` while the bookings beside it were not
// filtered, and before cutover the only bookings that exist are the SMOKE ones
// (#396), so every visible row's agent was excluded from the very map used to
// name it.
//
// Asserted on the QUERY rather than on the rows, because this fake answers each
// table with a fixed result and does not filter, so the rows look identical
// either way (L143). The two reads have to agree, and that is what is checked.
describe("the routing page's roster covers the bookings it shows (#1914)", () => {
  it("does not read the roster more narrowly than the bookings beside it", async () => {
    mockDb();
    render(await RecentRoutingPage());

    const users = eqAnyRead("users");
    const bookings = eqAnyRead("bookings");
    // The CONTROL: the recording works, so an empty filter list below is a real
    // absence rather than a fake that stopped recording (L98).
    expect(users).toContainEqual(["org_id", "o1"]);
    expect(bookings).toContainEqual(["org_id", "o1"]);

    // Neither read excludes the test agents, so an agent whose booking is shown
    // can always be named.
    expect(users.map(([c]) => c)).not.toContain("is_test");
    expect(bookings.map(([c]) => c)).not.toContain("is_test");
  });
});

// #1929. Two working buckets rendered a red "bookings will fail" on every view,
// because the bucket read did not exclude test buckets while `bucketCoverageByCode`
// does, so the SMOKE buckets arrived with no depth entry and `?? 0` turned
// "excluded from the measurement" into "measured zero".
//
// Asserted on the QUERY, like #1914's twin on the routing page: this fake answers
// each table with a fixed result and does not filter, so the rendered rows look
// identical whichever way the read went (L143).
describe("the buckets page reads the population it measures (#1929)", () => {
  it("excludes test buckets, matching the depth measurement and the default picker", async () => {
    mockDb();
    render(await BucketsPage(props));

    // The CONTROL first: the recording works, and it saw more than one read of
    // this table, so the assertion below is about all of them (L98).
    expect(eqAnyRead("buckets")).toContainEqual(["org_id", "o1"]);
    expect((eqCalls.buckets ?? []).length).toBeGreaterThan(1);

    // EVERY read of `buckets` excludes test buckets. Asserted across all of them
    // rather than "somewhere in this table's filters", because the page reads it
    // twice and only the picker filtered: the merged form was answered by that
    // read and passed with the editor's filter removed.
    expect(everyReadHas("buckets", "is_test", false)).toBe(true);
  });
});

// #1933. The memberships were read as `db.from("bucket_members").select("*")`:
// no scope, no limit, so capped at one 1000 row PostgREST page.
//
// Truncation here does not under-count, it DELETES. `replaceBucketMembers`
// removes every row for a bucket and re-inserts what the form posted, and the
// form posts what the picker was rendered with, which came from this read. A
// membership past the cap is invisible, absent from the form, and removed by the
// next save of that bucket (L211).
describe("the memberships read is scoped and paged (#1933)", () => {
  const member = (i: number) => ({ id: `m${i}`, bucket_id: "b1", user_id: `u${i}`, weight: 1, active: true });

  it("scopes the read to this org's buckets, since the table has no org column", async () => {
    mockDb();
    render(await BucketsPage(props));

    const scoped = (inCalls.bucket_members ?? []).flat();
    expect(scoped.map(([c]) => c)).toContain("bucket_id");
    // The CONTROL: the recorder saw the read at all, so the assertion above is
    // about a read that happened (L98).
    expect((rangeCalls.bucket_members ?? []).length).toBeGreaterThan(0);
  });

  // The behavioural half. A full first page is the only thing that tells a
  // paginating read from a truncating one, and the fake answers per page so the
  // second request has somewhere to come from.
  it("asks for a second page when the first comes back full", async () => {
    pagedByTable.bucket_members = [
      Array.from({ length: 1000 }, (_, i) => member(i)),
      [member(1000)],
    ];
    mockDb();
    render(await BucketsPage(props));

    const ranges = rangeCalls.bucket_members ?? [];
    expect(ranges.length).toBe(2);
    expect(ranges[0]).toEqual([0, 999]);
    // Keyset paging: the second page is the rows after the first page's last id.
    expect(ranges[1]).toEqual([0, 999]);
    expect(gtCalls.bucket_members).toEqual([["id", "m999"]]);
    delete pagedByTable.bucket_members;
  });

  it("stops after a short page rather than paging forever", async () => {
    pagedByTable.bucket_members = [[member(0)]];
    mockDb();
    render(await BucketsPage(props));

    expect((rangeCalls.bucket_members ?? []).length).toBe(1);
    delete pagedByTable.bucket_members;
  });

  // An unreadable BUCKETS read leaves no ids to scope to, so the memberships are
  // unreadable too rather than reported as none: an empty membership list is the
  // reassuring reading and it is the one the #1629 gate exists to refuse.
  it("does not report no memberships when the buckets could not be read", async () => {
    mockDb({ buckets: fails("buckets read exploded") });
    render(await BucketsPage(props));

    expect(screen.getByText(/buckets could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/New bucket/i)).toBeNull();
    // And it never went looking with no ids.
    expect((rangeCalls.bucket_members ?? []).length).toBe(0);
  });
});

describe("an unreadable table (#1629)", () => {
  it("says the event types could not be read instead of listing none", async () => {
    mockDb({ event_types: fails("event_types read exploded") });
    render(await EventTypesPage(props));
    expect(screen.getAllByText(/event types could not be read/i).length).toBeGreaterThan(0);
    // "None yet." beside a create form is an invitation to make a duplicate.
    expect(screen.queryByText(/^None yet\.$/)).toBeNull();
  });

  it("says the buckets could not be read, and withholds the routing editor", async () => {
    mockDb({ buckets: fails("buckets read exploded") });
    render(await BucketsPage(props));
    expect(screen.getByText(/buckets could not be read/i)).toBeTruthy();
    // The editor writes what it shows, so it must not be offered over blanks.
    expect(screen.queryByText(/New bucket/i)).toBeNull();
  });

  it("says the memberships could not be read rather than showing empty pools", async () => {
    mockDb({ bucket_members: fails("bucket_members read exploded") });
    render(await BucketsPage(props));
    expect(screen.getByText(/memberships could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/New bucket/i)).toBeNull();
  });

  it("says the recent bookings could not be read, not that nothing was booked", async () => {
    mockDb({ bookings: fails("bookings read exploded") });
    render(await RecentRoutingPage());
    expect(screen.getByText(/recent bookings could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/How the last .* bookings routed/i)).toBeNull();
  });

  it("withholds the webhook form when the endpoint could not be read", async () => {
    mockDb({ webhook_endpoints: fails("webhook_endpoints read exploded") });
    render(await WebhooksPage(props));
    expect(screen.getByText(/webhook endpoint could not be read/i)).toBeTruthy();
    // Saving a blank prefill would overwrite the live Regal endpoint.
    expect(screen.queryByLabelText(/Authorization header/i)).toBeNull();
  });

  it("reports push health as unavailable, never as zero watched", async () => {
    mockDb({ agent_calendars: fails("agent_calendars read exploded") });
    render(await AdminHealthPage());
    expect(screen.getByText(/push health unavailable/i)).toBeTruthy();
    // "push 0/1 watched" is a fleet-wide push outage that is not happening.
    expect(screen.queryByText(/push \d+\/\d+ watched/)).toBeNull();
    // And the same read feeds the failure list, whose emptiness is an all-clear.
    expect(screen.getByText(/sync health could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/agent with a calendar problem/i)).toBeNull();
  });

  // #1646: the panel is a JOIN of two reads, agent_calendars for the failure
  // streaks and users for who each calendar belongs to, and it was gated on the
  // calendar read alone. With the roster unreadable every failing calendar maps
  // to a row with a null email, dedupeFailingAgents drops each of those, the row
  // count falls to zero and the panel is not drawn. The roster notice renders
  // directly above it, correctly and about the agent list, so the screen looks
  // like it is already saying what went wrong while the calendar panel is
  // silently reading as a clean bill of health (L530).
  it("says calendar sync health could not be measured when the ROSTER read fails", async () => {
    mockDb({ users: fails("users read exploded") });
    render(await AdminHealthPage());
    expect(
      screen.getByText(/failing calendar cannot be matched to the agent/i),
    ).toBeTruthy();
    // The panel itself is gone (the join emptied it), which is exactly why the
    // notice above has to be there: absent panel and healthy panel look the same.
    expect(screen.queryByText(/agent with a calendar problem/i)).toBeNull();
    // The calendar read succeeded, so it must not be blamed for this.
    expect(screen.queryByText(/sync health could not be read/i)).toBeNull();
  });

  it("says the delivery log could not be read, not that nothing was sent", async () => {
    mockDb({ webhook_deliveries: fails("webhook_deliveries read exploded") });
    render(await WebhooksPage(props));
    expect(screen.getByText(/delivery log could not be read/i)).toBeTruthy();
    // This panel is opened to check whether a webhook was sent, so "No deliveries
    // yet." off a failed read answers the exact question with a wrong answer.
    expect(screen.queryByText(/No deliveries yet/i)).toBeNull();
  });

  it("reports the roster count as absent, never as zero of zero", async () => {
    mockDb({ users: fails("users read exploded") });
    render(await AdminHealthPage());
    expect(screen.getByText(/roster could not be read, so there is no count/i)).toBeTruthy();
    expect(screen.queryByText(/bookable of/)).toBeNull();
  });

  it("one failing read does not blank the panels whose reads succeeded", async () => {
    mockDb({ bookings: fails("bookings read exploded") });
    render(await BucketsPage(props));
    // The sibling reads in the same Promise.all still render their content. The
    // BUCKETS read reaches the table directly, as a row per pool.
    expect(screen.getByText("311")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New bucket" })).toBeTruthy();

    // #1896: the roster and the event types now reach the screen only inside an
    // open editor, and only one is ever in the DOM, so the control has to open
    // one. Asserting the closed table alone would leave every "this panel is
    // ABSENT" case in this file satisfiable by a page whose editor renders
    // nothing at all, which is the reason the control exists (L159).
    fireEvent.click(screen.getByRole("button", { name: /Edit 311/ }));
    expect(screen.getAllByText(/Ada Byron/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Advisor Call/).length).toBeGreaterThan(0);
  });
});

// #2385 / #2384. An action says what it did, on the page the person is on.
//
// These are the READING half. The action tests in `actions.test.ts` prove each
// one now redirects to the right route carrying the right sentence; nothing there
// can prove the page at the far end DRAWS it, and a redirect carrying a perfect
// reason to a page that renders nothing is the defect both issues are about
// (L586). So every one of these opens the page at the exact address its own
// action redirects to, and requires the words on screen.
describe("a refusal reaches the page it was refused on (#2385)", () => {
  it("draws a duplicate bucket code as a sentence, not as an error screen", async () => {
    mockDb();
    render(
      await BucketsPage(withQuery({ error: "A bucket with code 412 already exists." })),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/code 412 already exists/i);
  });

  it("draws a refused event type title on the page the add form is on", async () => {
    mockDb();
    render(
      await EventTypesPage(
        withQuery({ error: "An event type called Advisor Call already exists." }),
      ),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/already exists/i);
  });

  // The half that matters most: a refusal must never be drawn beside a
  // confirmation. The action redirects with ONE of the two, and a page that drew
  // both would put "Event type created." over a create that never happened, which
  // is worse than the silence this replaces (L12).
  it("shows no confirmation beside a refusal", async () => {
    mockDb();
    render(
      await EventTypesPage(withQuery({ error: "An event type needs a title." })),
    );
    expect(screen.queryByText(/Event type created/i)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("confirms a created event type on that same page", async () => {
    mockDb();
    render(await EventTypesPage(withQuery({ ok: "event-type-created" })));
    expect(screen.getByRole("status").textContent).toMatch(/Event type created/i);
  });

  // A pasted or bookmarked link carrying a value this page never issues must draw
  // nothing, rather than resolving to some sentence: confirming a save nobody
  // performed on a page that was just opened is the failure the parser exists to
  // prevent (L11).
  it("draws nothing for an outcome it does not recognise", async () => {
    mockDb();
    render(await EventTypesPage(withQuery({ ok: "1" })));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the webhooks page shows what its own buttons did (#2384)", () => {
  it("draws a refused endpoint URL, on the page the form is on", async () => {
    mockDb();
    render(
      await WebhooksPage(
        withQuery({ error: "The endpoint URL has to start with https, so nothing was saved." }),
      ),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/https/i);
  });

  it("confirms a saved endpoint", async () => {
    mockDb();
    render(await WebhooksPage(withQuery({ ok: "webhook-endpoint" })));
    expect(screen.getByRole("status").textContent).toMatch(/Webhook endpoint saved/i);
  });

  it("says what a resend did", async () => {
    mockDb();
    render(await WebhooksPage(withQuery({ resend: "sent" })));
    expect(screen.getByRole("status").textContent).toMatch(/re-sent/i);
  });

  it("says a resend was refused, as something that did not happen", async () => {
    mockDb();
    render(await WebhooksPage(withQuery({ resend: "payload-erased" })));
    expect(screen.getByRole("alert").textContent).toMatch(/retention/i);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says how many a replay queued", async () => {
    mockDb();
    render(await WebhooksPage(withQuery({ replay: "3" })));
    expect(screen.getByRole("status").textContent).toMatch(/3 failed deliveries were queued/i);
  });

  // Zero is the ordinary healthy answer and must not read as a failure, and it
  // must not read as nothing happening either: the press is the moment somebody
  // needs to learn the window they picked held nothing.
  it("says a replay found nothing, rather than saying nothing", async () => {
    mockDb();
    render(await WebhooksPage(withQuery({ replay: "0" })));
    expect(screen.getByRole("status").textContent).toMatch(/No failed deliveries were found/i);
  });

  it("tells a second presser the window was already replayed", async () => {
    mockDb();
    render(await WebhooksPage(withQuery({ replay: "deduped" })));
    expect(screen.getByRole("alert").textContent).toMatch(/already replayed|last few minutes/i);
  });

  it("draws nothing for a replay value it cannot read", async () => {
    mockDb();
    render(await WebhooksPage(withQuery({ replay: "lots" })));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

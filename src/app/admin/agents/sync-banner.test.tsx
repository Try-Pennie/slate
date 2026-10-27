// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// What the roster page says after a sync (#2097).
//
// The job reads two sources now, Salesforce for debt teams and profiles and Twilio
// for the Redistribute tag, and either half can fail while the other works. That
// makes three states this page has to tell apart, and the middle one is the whole
// reason for this file:
//
//   - both halves worked;
//   - Salesforce worked and TWILIO DID NOT, which is a successful run that did not
//     do the thing an admin most likely pressed it for;
//   - the run itself failed.
//
// Before this, a failed Twilio half would have been invisible: the green wash would
// have said the sync was complete, no agent would have been taken out of the
// bookable pool, and the only trace would have been a Slack message an hour later. A
// Twilio half that quietly does nothing has every symptom of a healthy one, and this
// page is where somebody looks.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
const env = vi.hoisted(() => ({ consoleHiddenFor: vi.fn(() => false) }));
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
  usePathname: () => "/admin/agents",
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  consoleHiddenFor: env.consoleHiddenFor,
}));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/app/admin/actions", () => ({
  startImpersonation: vi.fn(),
  syncSalesforceNow: vi.fn(),
  refreshAdvisorPhotosNow: vi.fn(),
}));
// #3027: the roster reads advisor photos through its own store; every row holds a
// directory photo here, so these suites judge only what they are about.
vi.mock("@/lib/advisor-photos/store", () => ({
  loadPhotoRecords: async (ids: string[]) =>
    new Map(ids.map((id) => [id, { state: "photo" as const, sha256: "a".repeat(64) }])),
}));

import AgentRosterPage from "./page";

const ROSTER = [
  { id: "u1", email: "a@x.com", name: "Ada Agent", role: "agent", bookable: true, attributes: {}, deactivated_at: null, manager_id: null, avatar_url: null },
];

function mockDb() {
  admin.supabaseAdmin.mockReturnValue({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "not", "order", "limit", "range"]) b[m] = () => b;
      b.maybeSingle = () => b;
      b.then = (resolve: (r: unknown) => unknown) =>
        Promise.resolve({ data: ROSTER, error: null }).then(resolve);
      return b;
    },
  });
}

const page = async (searchParams: Record<string, string>) => {
  mockDb();
  render(await AgentRosterPage({ searchParams: Promise.resolve(searchParams) }));
};

beforeEach(() => {
  vi.clearAllMocks();
  env.consoleHiddenFor.mockReturnValue(false);
  auth.currentUser.mockResolvedValue({
    id: "me1",
    role: "super_admin",
    org_id: "o1",
    email: "me@x.com",
    name: "Me",
    theme_preference: null,
    bookable: false,
    avatar_url: null,
  });
});

describe("what the roster page says after a sync (#2097)", () => {
  // One vocabulary for the job wherever it is named (L605). It reads two sources,
  // so naming it for one of them is a sentence that is wrong about half the run,
  // and managers are the people who do the tagging in Twilio.
  it("names the control for what it does, not for one of its two sources", async () => {
    await page({});
    const button = screen.getByRole("button", { name: /sync/i });
    expect(button.textContent).toMatch(/Salesforce/);
    expect(button.textContent).toMatch(/Twilio/);
  });

  it("calls a finished run a roster sync in the banner too, matching the control", async () => {
    await page({ synced: "9 agents synced" });
    expect(screen.getByText(/Roster sync complete/i)).toBeTruthy();
    expect(screen.queryByText(/Salesforce sync complete/i)).toBeNull();
  });

  // The state this file exists for.
  it("says the Twilio half did not happen, BESIDE the Salesforce success and not instead of it", async () => {
    await page({
      synced: "9 agents synced",
      twilio_error: "Twilio refused the credentials (401). The API key has to be TaskRouter scoped.",
    });
    // The Salesforce half still reports what it did: those writes committed, and
    // calling the whole run a failure would be a lie.
    expect(screen.getByText(/Roster sync complete/i)).toBeTruthy();
    // And the consequence is stated, which is the part a reader cannot infer: not
    // "Twilio errored" but "nobody was taken out of the pool".
    const notice = screen.getByText(/bookable pool/i);
    expect(notice.textContent).toMatch(/Redistribute/);
    expect(notice.textContent).toMatch(/401/);
    // Announced, not merely coloured: colour is never the only signal.
    expect(notice.closest("[role='alert']")).toBeTruthy();
  });

  it("says nothing about Twilio when the Twilio half worked", async () => {
    // The positive control (L1): a notice that always rendered would satisfy the
    // case above while proving nothing.
    await page({ synced: "9 agents synced" });
    expect(screen.queryByText(/bookable pool/i)).toBeNull();
    expect(screen.queryByText(/Redistribute/i)).toBeNull();
  });

  it("still reports a whole-run failure as a failure", async () => {
    await page({ sync_error: "SF token failed: 522" });
    expect(screen.getByText(/Roster sync failed/i)).toBeTruthy();
    expect(screen.queryByText(/Roster sync complete/i)).toBeNull();
  });
});

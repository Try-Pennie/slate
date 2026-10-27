// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The audit log's Clear control drops the active filters. It has to land back on
// the AUDIT page with no query, and that is the whole rule: it is the only way
// back to the unfiltered trail, so a target that is any other page silently sends
// somebody away from the screen they were reading.
//
// It pointed at /admin#audit, an anchor from when the trail was one section of a
// single stacked page. That address still resolves, to a different screen, which
// is why a route-existence check cannot see this and why it needs its own test:
// the link works, and takes you somewhere wrong.

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
  usePathname: () => "/admin/audit",
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  consoleHiddenFor: env.consoleHiddenFor,
}));
vi.mock("@/lib/supabase/admin", () => admin);

import AuditLogPage from "./page";

function mockDb() {
  admin.supabaseAdmin.mockReturnValue({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "not", "gte", "lte", "order", "range", "limit"]) {
        b[m] = () => b;
      }
      b.maybeSingle = () => b;
      b.then = (resolve: (r: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
      return b;
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb();
  auth.currentUser.mockResolvedValue({
    id: "s1",
    role: "super_admin",
    org_id: "o1",
    email: "s@x.com",
    name: "Sam",
    theme_preference: null,
    bookable: false,
    avatar_url: null,
  });
});

describe("the audit log's Clear control", () => {
  it("returns to the audit log itself, with no filters", async () => {
    render(await AuditLogPage({ searchParams: Promise.resolve({ actor: "u1" }) }));

    const clear = screen.getByRole("link", { name: /^Clear$/i });
    expect(clear.getAttribute("href")).toBe("/admin/audit");
  });

  it("does not send the reader to a different screen", async () => {
    render(await AuditLogPage({ searchParams: Promise.resolve({ actor: "u1" }) }));

    // The failure this replaces: a link that resolves, and lands somewhere else.
    // Asserted as its own case because "the href is not /admin" is the part a
    // route-existence check can never make.
    const href = screen.getByRole("link", { name: /^Clear$/i }).getAttribute("href") ?? "";
    expect(href.split("#")[0]).toBe("/admin/audit");
    expect(href).not.toMatch(/^\/admin(#|$)/);
  });

  it("is offered only when a filter is actually set", async () => {
    // A Clear that is always there invites a press that does nothing.
    render(await AuditLogPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByRole("link", { name: /^Clear$/i })).toBeNull();
  });

  // #3615: a ticked box is a filter too, so Clear is offered when one is the only thing set.
  it.each([["test"], ["routine"]])("is offered when only the %s box is ticked", async (box) => {
    render(await AuditLogPage({ searchParams: Promise.resolve({ [box]: "1" }) }));
    expect(screen.getByRole("link", { name: /^Clear$/i }).getAttribute("href")).toBe("/admin/audit");
  });
});

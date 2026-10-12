// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { BucketSupplyReport, BucketSupplyRow } from "@/lib/admin/bucket-supply";

// Who sees codes on /admin/bucket-availability (2026-10-02). The page decides it
// from the viewer's role through the real `canEditOrgSettings`: admins and super
// admins keep one row per bucket code with the code; managers and team leads see
// one row per pool in words. Auth, the launch flag and the loader are mocked; the
// role check and the table are real.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const loader = vi.hoisted(() => ({ loadBucketSupply: vi.fn() }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  consoleHiddenFor: () => false,
}));
vi.mock("@/lib/admin/bucket-supply-load", () => loader);
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));

import BucketAvailabilityPage from "./page";

const NOW_MS = Date.parse("2026-08-04T15:20:30.000Z");

function row(code: string, name: string): BucketSupplyRow {
  return {
    code,
    name,
    poolKey: "pool-low",
    poolLabel: "Low",
    depth: 9,
    effectiveDepth: 8,
    cacheState: "measured",
    computedAtMs: NOW_MS - 30_000,
    freshness: "fresh",
    offeredLater: false,
    offeredDays: null,
    cells: [{ kind: "counted", booked: 3, capacity: 21, share: 3 / 21 }],
  };
}

const REPORT: BucketSupplyReport = {
  measurable: true,
  zone: "America/New_York",
  horizonDays: 4,
  nowMs: NOW_MS,
  days: [{ iso: "2026-08-04", weekday: 2 }],
  rows: [row("110", "Low | Both | No Legal Param"), row("111", "Low | Both | Legal")],
  tiers: [],
  bucketListReadable: true,
  depthReadable: true,
};

function rowHeads(): string[] {
  return [...document.querySelectorAll("tbody th[scope='row']")].map((n) => n.textContent ?? "");
}

beforeEach(() => {
  cleanup();
  loader.loadBucketSupply.mockResolvedValue(REPORT);
});

describe("/admin/bucket-availability by role", () => {
  for (const role of ["manager", "team_lead"] as const) {
    it(`shows a ${role} one row per pool and no code`, async () => {
      auth.currentUser.mockResolvedValue({ id: "u1", org_id: "org-1", role });
      render(await BucketAvailabilityPage());
      expect(rowHeads()).toEqual(["Low"]);
      expect(document.body.textContent ?? "").not.toMatch(/\b11[01]\b/);
      expect(screen.getByText(/across 1 pool$/)).toBeTruthy();
    });
  }

  for (const role of ["admin", "super_admin"] as const) {
    it(`shows an ${role} one row per code, with the code`, async () => {
      auth.currentUser.mockResolvedValue({ id: "u1", org_id: "org-1", role });
      render(await BucketAvailabilityPage());
      expect(rowHeads()).toEqual(["110Low | Both | No Legal Param", "111Low | Both | Legal"]);
    });
  }
});

// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { badgeCountCls, badgeCountInkCls } from "@/components/ui/styles";
import { render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ path: "/admin" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));

import { HeaderNav, activeTab, type HeaderTab } from "@/components/HeaderNav";
import { PendingBadge } from "@/components/ui/PendingBadge";

const TABS: HeaderTab[] = [
  { href: "/admin", label: "Admin" },
  { href: "/me", label: "My Availability" },
  { href: "/admin/ooo", label: "Team Requests", badge: <PendingBadge count={3} /> },
];

describe("activeTab", () => {
  it("lights the tab you are on", () => {
    expect(activeTab("/me", TABS)).toBe("/me");
  });

  it("lights Team Requests on its own page, not Admin", () => {
    // "/admin" is a prefix of "/admin/ooo", so a plain prefix test lights both
    // and the header says you are in two places at once.
    expect(activeTab("/admin/ooo", TABS)).toBe("/admin/ooo");
  });

  it("keeps the section lit on a page under it", () => {
    expect(activeTab("/admin/buckets", TABS)).toBe("/admin");
    expect(activeTab("/admin/ooo/history", TABS)).toBe("/admin/ooo");
  });

  it("lights nothing on a path no tab covers", () => {
    expect(activeTab("/login", TABS)).toBeNull();
  });
});

// #1847: a tab's badge is a NODE now, not a number. The count is a database read
// and it was the last serial hop in front of every internal page, so it arrives
// under its own boundary; `HeaderNav` renders whatever turns up in the slot and
// no longer knows what a badge looks like. These pass `PendingBadge`, which is
// what the header passes, so the rendering they assert is the shipped one.
describe("HeaderNav", () => {
  it("marks the current tab for assistive tech, not just visually", () => {
    nav.path = "/admin/ooo";
    render(<HeaderNav tabs={TABS} />);

    expect(screen.getByRole("link", { name: /Team Requests/ })).toHaveProperty(
      "ariaCurrent",
      "page",
    );
    expect(screen.getByRole("link", { name: "Admin" }).getAttribute("aria-current")).toBeNull();
  });

  it("says the pending count in words as well as in the badge", () => {
    nav.path = "/admin";
    render(<HeaderNav tabs={TABS} />);

    expect(screen.getByText("(3 requests pending)")).toBeTruthy();
  });

  it("says request in the singular for one", () => {
    nav.path = "/admin";
    render(<HeaderNav tabs={[{ href: "/admin/ooo", label: "Team Requests", badge: <PendingBadge count={1} /> }]} />);

    expect(screen.getByText("(1 request pending)")).toBeTruthy();
  });

  it("shows no badge at all for none waiting", () => {
    nav.path = "/admin";
    render(<HeaderNav tabs={[{ href: "/admin/ooo", label: "Team Requests", badge: <PendingBadge count={0} /> }]} />);

    expect(screen.queryByText(/pending\)/)).toBeNull();
  });
});

// #1881: the count has to be a visible SHAPE, not just a number in a different
// colour. The fill's contrast is measured in scripts/test-contrast.ts, which
// READS these classes out of the shared constant rather than restating them.
// This is the other half of that pair: the badge really does wear the constant,
// so the measurement is about what ships (L63).
describe("the pending count wears the measured badge treatment (#1881)", () => {
  it("renders the count in the shared badge class, not classes of its own", () => {
    nav.path = "/admin";
    render(<HeaderNav tabs={[{ href: "/admin/ooo", label: "Team Requests", badge: <PendingBadge count={3} /> }]} />);

    // The visible pill is aria-hidden (the sr-only sentence beside it carries the
    // meaning), so it is found by its text rather than by a role. The text sits in
    // its own span since #1921, which carries the optical nudge, so the PILL is
    // that span's parent.
    const ink = screen.getByText("3");
    expect(ink.className).toBe(badgeCountInkCls);
    expect(ink.parentElement?.className).toBe(badgeCountCls);
  });

  // #1921: the nudge is on the DIGITS. On the pill it would move the whole badge,
  // which is the thing that is already in the right place.
  it("puts the optical nudge on the digits and not on the pill", () => {
    nav.path = "/admin";
    render(<HeaderNav tabs={[{ href: "/admin/ooo", label: "Team Requests", badge: <PendingBadge count={7} /> }]} />);

    const ink = screen.getByText("7");
    expect(ink.className).toMatch(/translate-y/);
    expect(ink.parentElement?.className).not.toMatch(/translate-y/);
  });

  it("declares no theme override of its own, so the pair cannot drift", () => {
    // One treatment in both themes is what the contrast assertions measure. A
    // `dark:` class here would be a second pair nothing measured (L213).
    expect(badgeCountCls).not.toMatch(/dark:/);
  });

  it("keeps the count from widening the pill out of shape past 99", () => {
    nav.path = "/admin";
    render(<HeaderNav tabs={[{ href: "/admin/ooo", label: "Team Requests", badge: <PendingBadge count={128} /> }]} />);
    expect(screen.getByText("99+")).toBeTruthy();
    // The words still carry the real number, so nobody acts on a capped count.
    expect(screen.getByText("(128 requests pending)")).toBeTruthy();
  });
});

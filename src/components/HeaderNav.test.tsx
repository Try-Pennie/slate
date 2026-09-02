// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ path: "/admin" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));

import { HeaderNav, activeTab, type HeaderTab } from "@/components/HeaderNav";

const TABS: HeaderTab[] = [
  { href: "/admin", label: "Admin" },
  { href: "/me", label: "My Availability" },
  { href: "/admin/ooo", label: "Team Requests", badge: 3 },
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
    render(<HeaderNav tabs={[{ href: "/admin/ooo", label: "Team Requests", badge: 1 }]} />);

    expect(screen.getByText("(1 request pending)")).toBeTruthy();
  });

  it("shows no badge at all for none waiting", () => {
    nav.path = "/admin";
    render(<HeaderNav tabs={[{ href: "/admin/ooo", label: "Team Requests", badge: 0 }]} />);

    expect(screen.queryByText(/pending\)/)).toBeNull();
  });
});

// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { cardCls } from "@/components/ui/styles";

// #1838: the console page header is a card, not a navy band.
//
// Dan, 2026-09-03: "I feel like the dark banner doesn't really fit in light
// mode? Maybe we should change it?" Chosen from five rendered treatments: the
// band becomes a surface card matching the blocks below it, with the always-on
// "Admin" eyebrow dropped.
//
// This REMOVES a special case rather than adding one. The class list already
// ended in `dark:bg-surface`, so dark mode had been drawing an ordinary card
// since it shipped; light mode now does what dark mode already did.
//
// THE TRAP THIS PINS. The text colours were hardcoded for a dark ground
// (`text-pennie-beige`, `text-pennie-beige/75`, `text-pennie-sky`). Swapping
// only the background leaves beige text on a white card, which is invisible
// rather than merely low contrast. That is the pair problem (L213): both halves
// are individually valid, so nothing reports it. These assertions are on the
// FOREGROUND as much as the background, because the background alone is the half
// that is easy to get right.
describe("AdminPageHeader as a card (#1838)", () => {
  const band = (ui: React.ReactElement) =>
    render(ui).container.firstElementChild as HTMLElement;

  it("paints no navy fill, in either theme", () => {
    const cls = band(<AdminPageHeader title="Agent roster" />).className;
    expect(cls, "the light navy fill is gone").not.toMatch(/bg-pennie-navy/);
    expect(cls, "and no dark-only override is left standing in for it").not.toMatch(
      /dark:bg-pennie-navy/,
    );
  });

  it("carries no foreground chosen for a dark ground", () => {
    const el = band(<AdminPageHeader title="Agent roster">Everyone Slate can route to.</AdminPageHeader>);
    const all = el.outerHTML;
    // The three that were hardcoded for navy. Beige on a white card is invisible,
    // and sky on white is the accent failing as body text.
    expect(all, "no beige label on a light card").not.toMatch(/text-pennie-beige/);
    expect(all, "no sky eyebrow").not.toMatch(/text-pennie-sky/);
  });

  it("is the same card the blocks below it are", () => {
    // Reuses the shared constant rather than restating its values, so the header
    // cannot drift from the cards it is meant to match (L41).
    const cls = band(<AdminPageHeader title="Agent roster" />).className;
    for (const part of cardCls.split(/\s+/)) {
      expect(cls, `the header must carry the card's ${part}`).toContain(part);
    }
  });

  it("drops the always-on Admin eyebrow but keeps the title and the description", () => {
    render(
      <AdminPageHeader title="Agent roster">Everyone Slate can route a lead to.</AdminPageHeader>,
    );
    expect(screen.queryByText("Admin")).toBeNull();
    expect(screen.getByRole("heading", { name: "Agent roster" })).toBeTruthy();
    expect(screen.getByText(/Everyone Slate can route a lead to\./)).toBeTruthy();
  });
});

// #1878: an `action` slot, separate from `aside`.
//
// The two are different things and the difference is structural, not cosmetic: a
// pill is a label and an action does something, so they must not share a group,
// and the STATUS group must not be the one pinned to the right edge. The action
// renders conditionally on this component's only caller (an admin cannot view as
// another admin), and a right-pinned status group would slide across the header
// the moment that control disappeared, so the same page would lay out differently
// depending on who was looking at it.
describe("AdminPageHeader action slot (#1878)", () => {
  it("lays out as a row for an action alone, with no aside and no leading", () => {
    // The only path where `action` is the sole reason to be a row. Without it in
    // `asRow` the action would be dropped into a stacked header and float below
    // the title.
    const el = render(
      <AdminPageHeader title="Aria Patel" action={<button type="button">View as Aria</button>} />,
    ).container.firstElementChild as HTMLElement;
    expect(el.className).toContain("flex");
    expect(screen.getByRole("button", { name: "View as Aria" })).toBeTruthy();
  });

  it("pins the action right and leaves the status group where it is", () => {
    render(
      <AdminPageHeader
        title="Aria Patel"
        aside={<span>Bookable</span>}
        action={<button type="button">View as Aria</button>}
      />,
    );
    const statusGroup = screen.getByText("Bookable").closest("div");
    const actionGroup = screen.getByRole("button", { name: "View as Aria" }).closest("div");

    expect(statusGroup).not.toBe(actionGroup);
    expect(actionGroup?.className ?? "").toContain("ml-auto");
    expect(statusGroup?.className ?? "").not.toContain("ml-auto");
  });

  it("renders the status group in the same place when there is no action", () => {
    const withAction = render(
      <AdminPageHeader
        title="Aria Patel"
        aside={<span>Bookable</span>}
        action={<button type="button">View as Aria</button>}
      />,
    );
    const withActionCls = screen.getByText("Bookable").closest("div")?.className;
    withAction.unmount();

    render(<AdminPageHeader title="Aria Patel" aside={<span>Bookable</span>} />);
    expect(screen.getByText("Bookable").closest("div")?.className).toBe(withActionCls);
  });
});

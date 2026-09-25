// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VolumeLearning } from "@/components/admin/VolumeLearning";

// #2739: the ramp end on /admin/alerts. Setting it is the one change on the page
// whose effect lands weeks later, so the confirm must name the consequence from
// the date actually typed, and clearing must say what it gives up.
const action = vi.fn(async () => {});
const coverage = [
  { id: "income-verification", name: "Income Verification Phone Call", open: 72, judged: 60 },
  { id: "application-review-follow-up", name: "Completed Application Review Follow Up", open: 72, judged: 19 },
];

function renderIt(over: Partial<Parameters<typeof VolumeLearning>[0]> = {}) {
  return render(
    <VolumeLearning
      rampEndOn={null}
      detail={["Slate learns nothing from its own bookings until the day the ramp ended is set below."]}
      coverage={coverage}
      sourceNotice={null}
      action={action}
      earliest="2026-09-25"
      minWeeks={4}
      {...over}
    />,
  );
}

describe("VolumeLearning", () => {
  it("shows what learning is doing and every page's coverage", () => {
    const { container } = renderIt();
    expect(container.querySelector("[data-volume-learning-status]")!.textContent).toContain("learns nothing");
    expect(container.querySelectorAll("[data-page-coverage]")).toHaveLength(2);
    const followUp = container.querySelector('[data-page-coverage="application-review-follow-up"]')!;
    expect(followUp.textContent).toContain("19 of 72");
    expect(followUp.textContent).toContain("53");
    // The explanation of an unmeasured hour is said once, not once per page.
    expect(container.textContent!.split("too few of that page").length - 1).toBe(1);
  });

  it("confirms a new ramp end with its consequence, from the date typed", () => {
    renderIt();
    fireEvent.change(screen.getByLabelText("The ramp ended on"), { target: { value: "2026-10-12" } });
    fireEvent.click(screen.getByRole("button", { name: "Set the ramp end" }));
    const alert = screen.getByRole("alert").textContent!;
    expect(alert).toContain("bookings made before Oct 12, 2026 are never used");
    expect(alert).toContain("4 full weeks");
    expect(alert).toContain("never lower than the cal.com floors");
    // Nothing is set yet, so there is nothing to clear.
    expect(screen.queryByRole("button", { name: "Clear the ramp end" })).toBeNull();
  });

  it("names the old date and the new when changing it, and offers clearing", () => {
    renderIt({ rampEndOn: "2026-10-05" });
    fireEvent.change(screen.getByLabelText("The ramp ended on"), { target: { value: "2026-10-12" } });
    fireEvent.click(screen.getByRole("button", { name: "Change the ramp end" }));
    expect(screen.getByRole("alert").textContent).toContain("moves from Oct 5, 2026 to Oct 12, 2026");
  });

  it("says nothing would change when the date is the stored one", () => {
    renderIt({ rampEndOn: "2026-10-05" });
    fireEvent.click(screen.getByRole("button", { name: "Change the ramp end" }));
    expect(screen.getByRole("alert").textContent).toContain("nothing would change");
  });

  it("confirms clearing with what it discards", () => {
    renderIt({ rampEndOn: "2026-10-05" });
    fireEvent.click(screen.getByRole("button", { name: "Clear the ramp end" }));
    expect(screen.getByRole("alert").textContent).toContain("goes back to the cal.com floors");
    expect(screen.getByRole("alert").textContent).toContain("learned since Oct 5, 2026 is discarded");
  });

  // #2765: until every booking carries the page it came from, the pages' own floors
  // are not coverage, so the count is said in their place rather than beside them.
  it("says how many bookings recorded no source instead of showing the pages' floors", () => {
    const notice = "Source not recorded on 12 of 40 bookings in the last 7 days, so a page whose missing bookings could be among them is held rather than paged.";
    const { container } = renderIt({ sourceNotice: notice });
    expect(container.querySelectorAll("[data-page-coverage]")).toHaveLength(0);
    const shown = container.querySelector("[data-page-sources]")!;
    expect(shown.textContent).toBe(notice);
    expect(shown.getAttribute("role")).toBe("status");
    expect(container.textContent).not.toContain("Open hours judged");
  });

  it("shows the pages' floors once every booking carried its source", () => {
    const { container } = renderIt({ sourceNotice: null });
    expect(container.querySelector("[data-page-sources]")).toBeNull();
    expect(container.querySelectorAll("[data-page-coverage]")).toHaveLength(2);
  });

  it("says the week could not be read rather than listing no pages", () => {
    const { container } = renderIt({ coverage: null });
    expect(container.querySelectorAll("[data-page-coverage]")).toHaveLength(0);
    expect(container.textContent).toContain("could not be read");
  });
});

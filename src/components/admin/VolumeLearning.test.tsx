// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VolumeLearning } from "@/components/admin/VolumeLearning";

// #2739: the ramp end on /admin/alerts. Setting it is the one change on the page
// whose effect lands weeks later, so the confirm must name the consequence from
// the date actually typed, and clearing must say what it gives up.
const action = vi.fn(async () => {});
const coverage = [
  { id: "application-review", name: "Completed Application Review", open: 72, judged: 60 },
  { id: "application-review-follow-up", name: "Completed Application Review Follow Up", open: 72, judged: 19 },
];

// #2878: from `pagesNotOnSlateLines()`, a page held off Slate stated in words.
const HELD_OFF = [
  "Income Verification Phone Call is not judged: its leads come from trypennie's /offerportal and /portal, which do not send them to Slate yet.",
];

const TIERS = [
  "Medium: judged against floors learned from its own bookings since the first real Medium booking on Nov 23, 2026, with no cal.com measurement under them, last refit Dec 28 at 3:00am Eastern.",
  "High: no real booking yet, so not carried and not judged.",
];

// From `pilotPageLine()`: why the pages are not judged during a split.
const PILOT_SPLIT = "Per page Low alerts are off while the pilot sends Slate 50% of Low leads. They turn on at 100%.";

function renderIt(over: Partial<Parameters<typeof VolumeLearning>[0]> = {}) {
  return render(
    <VolumeLearning
      rampEndOn={null}
      detail={["Slate learns from its own bookings from the first real Low booking a landing page sends, which has not happened yet."]}
      tiers={TIERS}
      retirement={null}
      lowFloorNote="Low's never go below the cal.com floors."
      coverage={coverage}
      sourceNotice={null}
      sourceSetAside={null}
      pagePilot={null}
      heldOff={HELD_OFF}
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
    expect(container.querySelector("[data-volume-learning-status]")!.textContent).toContain("first real Low booking");
    expect(container.querySelectorAll("[data-page-coverage]")).toHaveLength(2);
    const followUp = container.querySelector('[data-page-coverage="application-review-follow-up"]')!;
    expect(followUp.textContent).toContain("19 of 72");
    expect(followUp.textContent).toContain("53");
    // The explanation of an unmeasured hour is said once, not once per page.
    expect(container.textContent!.split("too few of that page").length - 1).toBe(1);
  });

  // #2878: a page Slate does not carry is named as not judged, whatever else the
  // section is saying, so its absence from the table never reads as an oversight
  // and its silence never reads as a page that stopped.
  it("names each page held off Slate as not judged, beside the table and in place of it", () => {
    for (const over of [{}, { sourceNotice: "Source not recorded on 3 of 40 bookings in the last 7 days." }, { coverage: null }]) {
      const { container, unmount } = renderIt(over);
      const lines = [...container.querySelectorAll("[data-page-held-off]")].map((e) => e.textContent);
      expect(lines).toEqual(HELD_OFF);
      expect(container.querySelector('[data-page-coverage="income-verification"]')).toBeNull();
      unmount();
    }
  });

  it("says nothing about held off pages once every Low page is on Slate", () => {
    const { container } = renderIt({ heldOff: [] });
    expect(container.querySelectorAll("[data-page-held-off]")).toHaveLength(0);
  });

  it("confirms a new ramp end with its consequence, from the date typed", () => {
    renderIt();
    fireEvent.change(screen.getByLabelText("The ramp ended on"), { target: { value: "2026-10-12" } });
    fireEvent.click(screen.getByRole("button", { name: "Set the ramp end" }));
    const alert = screen.getByRole("alert").textContent!;
    expect(alert).toContain("bookings made on or after Oct 12, 2026");
    expect(alert).toContain("4 full weeks");
    expect(alert).toContain("never go below the cal.com floors");
    // Nothing is set yet, so there is nothing to clear.
    expect(screen.queryByRole("button", { name: "Clear the ramp end" })).toBeNull();
  });

  // #3896: what the confirm says about the cal.com floor under Low's floors comes from
  // the same retirement state as the sentence under the tiers, so it stays true.
  it("says the cal.com floor holds Low's floors only until the anchor retires", () => {
    renderIt({
      retirement:
        "cal.com was marked retired on Jan 4, 2027. From Mar 8, 2027, 9 weeks later, its measurement stops holding any floor up, and every tier, Low included, follows Slate's own bookings.",
      lowFloorNote: "Low's never go below the cal.com floors before Mar 8, 2027.",
    });
    fireEvent.change(screen.getByLabelText("The ramp ended on"), { target: { value: "2027-01-11" } });
    fireEvent.click(screen.getByRole("button", { name: "Set the ramp end" }));
    expect(screen.getByRole("alert").textContent).toContain("Low's never go below the cal.com floors before Mar 8, 2027.");
  });

  it("claims no cal.com floor under Low once the anchor has retired", () => {
    renderIt({
      retirement:
        "No cal.com measurement has held any floor up since Mar 8, 2027, 9 weeks after cal.com was marked retired, so every tier, Low included, follows Slate's own bookings.",
      lowFloorNote: null,
    });
    fireEvent.change(screen.getByLabelText("The ramp ended on"), { target: { value: "2027-03-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Set the ramp end" }));
    const alert = screen.getByRole("alert").textContent!;
    expect(alert).toContain("bookings made on or after Mar 15, 2027");
    expect(alert).not.toContain("cal.com");
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
    expect(screen.getByRole("alert").textContent).toContain("goes back to learning from its own first booking");
    expect(screen.getByRole("alert").textContent).toContain("learned from Oct 5, 2026 stops applying");
  });

  // #2874: every other tier gets its own line, so a tier nobody judges is stated
  // rather than missing from the page.
  it("states every other tier, judged or not", () => {
    const { container } = renderIt();
    const items = [...container.querySelectorAll("[data-volume-tiers] li")].map((li) => li.textContent);
    expect(items).toEqual(TIERS);
    expect(container.textContent).toContain("nothing needs setting when another tier");
  });

  // #3896, Dan's design round "Once, under the tiers": the cal.com anchor's retirement
  // is one sentence directly after the tier list, for every tier with Low included.
  it("says the anchor's retirement once, directly under the tier list", () => {
    const sentence =
      "cal.com was marked retired on Nov 9, 2026. From Jan 11, 2027, 9 weeks later, its measurement stops holding any floor up, and every tier, Low included, follows Slate's own bookings.";
    const { container } = renderIt({ retirement: sentence });
    const shown = container.querySelector("[data-volume-anchor-retirement]")!;
    expect(shown.textContent).toBe(sentence);
    expect(container.querySelector("[data-volume-tiers]")!.nextElementSibling).toBe(shown);
    expect(container.textContent!.split("marked retired").length - 1).toBe(1);
  });

  it("says nothing about retirement while cal.com is live", () => {
    const { container } = renderIt({ retirement: null });
    expect(container.querySelector("[data-volume-anchor-retirement]")).toBeNull();
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

  it("shows the coverage table, with no pilot line, while Slate takes every Low lead", () => {
    const { container } = renderIt();
    expect(container.querySelector("[data-page-pilot]")).toBeNull();
    expect(container.querySelectorAll("[data-page-coverage]")).toHaveLength(2);
    expect(container.textContent).not.toContain("scaled to the share");
  });

  it("says the pages are not judged, in place of their coverage, during a split", () => {
    const { container } = renderIt({ pagePilot: PILOT_SPLIT });
    const shown = container.querySelector("[data-page-pilot]")!;
    expect(shown.textContent).toBe(PILOT_SPLIT);
    expect(shown.getAttribute("role")).toBe("status");
    expect(container.querySelectorAll("[data-page-coverage]")).toHaveLength(0);
    expect(container.textContent).not.toContain("Open hours judged");
  });
});

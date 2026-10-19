// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSaveNotice } from "./SettingsSaveNotice";

// #636: the save banner used to render purely from the ?ok=/?error= query
// param, with no role=status and persisting across reloads/bookmarks. It now
// announces to screen readers and strips the param on mount so a reloaded or
// copied URL doesn't re-show a stale "saved".

beforeEach(() => {
  window.history.replaceState(null, "", "/admin/settings");
});

describe("SettingsSaveNotice", () => {
  it("announces a successful save to screen readers via role=status", () => {
    render(<SettingsSaveNotice ok error={undefined} saved="Hours saved." />);
    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/saved/i);
  });

  it("announces a save failure via role=alert with the server message", () => {
    render(
      <SettingsSaveNotice
        ok={false}
        error="Cooldown must be at least 1 minute."
        saved="Alert settings saved."
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/at least 1 minute/i);
  });

  it("renders nothing when there is no outcome to report", () => {
    const { container } = render(<SettingsSaveNotice ok={false} error={undefined} saved="Hours saved." />);
    expect(container.textContent).toBe("");
  });

  it("strips ok/error from the URL after mount so a reload doesn't re-show it", () => {
    window.history.replaceState(null, "", "/admin/business-hours?ok=1");
    render(<SettingsSaveNotice ok error={undefined} saved="Hours saved." />);
    // Banner still visible (React state holds it)...
    expect(screen.getByRole("status")).toBeTruthy();
    // ...but the param is gone, so a copied URL / reload won't re-trigger it.
    expect(window.location.search).not.toContain("ok");
  });

  // #1922: the success sentence is the PAGE's, not a hardcoded one. It read
  // "Alert settings saved." for every page that mounted this, so saving a booking
  // reason confirmed that your alert settings had been saved. Measured on a
  // running server before the fix: /admin/booking-reasons?ok=1 and
  // /admin/buckets?ok=1 both said it.
  it("says what THIS page saved, not a sentence borrowed from another one", () => {
    render(<SettingsSaveNotice ok error={undefined} saved="Booking reasons saved." />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Booking reasons saved.");
    expect(status.textContent).not.toMatch(/alert settings/i);
  });

  // #3100: found by the first browser run. Stopping online booking and then
  // starting it again on the same page left the notice reading "Online booking is
  // stopped" beside a switch saying leads can book, because the second save's
  // redirect re-rendered this component in place rather than mounting it, and the
  // state it captured on mount was never replaced. A second save on the same
  // screen has to say what the SECOND save did.
  it("says what the latest save did when a second save lands on the same page", () => {
    window.history.replaceState(null, "", "/admin/business-hours?ok=booking-paused");
    const { rerender } = render(<SettingsSaveNotice ok error={undefined} saved="Online booking is stopped." />);
    expect(screen.getByRole("status").textContent).toBe("Online booking is stopped.");

    window.history.replaceState(null, "", "/admin/business-hours?ok=booking-resumed");
    rerender(<SettingsSaveNotice ok error={undefined} saved="Online booking is running again." />);
    expect(screen.getByRole("status").textContent).toBe("Online booking is running again.");
    expect(window.location.search, "the second outcome's param is stripped too").not.toContain("ok");

    // A refusal after a success replaces the success rather than sitting under it.
    rerender(<SettingsSaveNotice ok={false} error="The change was refused." saved="" />);
    expect(screen.getByRole("alert").textContent).toBe("The change was refused.");
    expect(screen.queryByRole("status")).toBeNull();
  });

  // Review of #3162: saving the same thing twice (the horizon to 5, then 5 again)
  // brings the same outcome back, so an effect keyed on the outcome never ran a
  // second time and the second `?ok=` stayed in the address bar, where a reload
  // re-shows a confirmation of nothing.
  it("strips the param on every arrival, including a second save with the same outcome", () => {
    window.history.replaceState(null, "", "/admin/business-hours?ok=booking-horizon");
    const { rerender } = render(<SettingsSaveNotice ok error={undefined} saved="Last resort reach saved." />);
    expect(window.location.search).not.toContain("ok");

    window.history.replaceState(null, "", "/admin/business-hours?ok=booking-horizon");
    rerender(<SettingsSaveNotice ok error={undefined} saved="Last resort reach saved." />);
    expect(window.location.search, "the second save's param is stripped too").not.toContain("ok");
    expect(screen.getByRole("status").textContent).toBe("Last resort reach saved.");
  });

  it("keeps the notice once the server re-renders without the stripped param", () => {
    const { rerender } = render(<SettingsSaveNotice ok error={undefined} saved="Hours saved." />);
    rerender(<SettingsSaveNotice ok={false} error={undefined} saved="Hours saved." />);
    expect(screen.getByRole("status").textContent).toBe("Hours saved.");
  });

  it("also strips the error param after mount", () => {
    window.history.replaceState(null, "", "/admin/business-hours?error=Nope");
    render(<SettingsSaveNotice ok={false} error="Nope" saved="Hours saved." />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(window.location.search).not.toContain("error");
  });
});

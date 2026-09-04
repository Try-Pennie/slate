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

  it("also strips the error param after mount", () => {
    window.history.replaceState(null, "", "/admin/business-hours?error=Nope");
    render(<SettingsSaveNotice ok={false} error="Nope" saved="Hours saved." />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(window.location.search).not.toContain("error");
  });
});

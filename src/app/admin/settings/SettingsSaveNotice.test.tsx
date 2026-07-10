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
    render(<SettingsSaveNotice ok error={undefined} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/saved/i);
  });

  it("announces a save failure via role=alert with the server message", () => {
    render(<SettingsSaveNotice ok={false} error="Cooldown must be at least 1 minute." />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/at least 1 minute/i);
  });

  it("renders nothing when there is no outcome to report", () => {
    const { container } = render(<SettingsSaveNotice ok={false} error={undefined} />);
    expect(container.textContent).toBe("");
  });

  it("strips ok/error from the URL after mount so a reload doesn't re-show it", () => {
    window.history.replaceState(null, "", "/admin/settings?ok=1");
    render(<SettingsSaveNotice ok error={undefined} />);
    // Banner still visible (React state holds it)...
    expect(screen.getByRole("status")).toBeTruthy();
    // ...but the param is gone, so a copied URL / reload won't re-trigger it.
    expect(window.location.search).not.toContain("ok");
  });

  it("also strips the error param after mount", () => {
    window.history.replaceState(null, "", "/admin/settings?error=Nope");
    render(<SettingsSaveNotice ok={false} error="Nope" />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(window.location.search).not.toContain("error");
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// #2875: the control behind the "cal.com retired" switch on /admin/alerts. Three
// states, never two: live, retired, and could-not-read. Retiring is the
// destructive direction, so it confirms and names what stops; putting cal.com
// back also confirms, because it restarts the morning import that writes cal.com's
// hours over Slate's.
vi.mock("@/app/admin/actions", () => ({ setCalcomRetired: vi.fn() }));

import { CalcomRetirementSwitch } from "./CalcomRetirementSwitch";

describe("CalcomRetirementSwitch", () => {
  it("says cal.com is live during the parallel run, and offers to retire it", () => {
    render(<CalcomRetirementSwitch retired={false} />);
    expect(screen.getByText(/cal\.com is live/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retire cal\.com/i })).toBeTruthy();
  });

  it("asks before retiring, naming what stops rather than asking generically", () => {
    render(<CalcomRetirementSwitch retired={false} />);
    const opener = screen.getByRole("button", { name: /retire cal\.com/i });
    // The opener submits nothing: a switch that stopped every cal.com write on one
    // press is one somebody trips by accident.
    expect(opener.getAttribute("type")).not.toBe("submit");
    fireEvent.click(opener);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/comparison/i);
    expect(alert.textContent).toMatch(/hours/i);
    expect(alert.textContent).toMatch(/time off/i);
    const confirm = screen.getByRole("button", { name: /retire cal\.com/i });
    expect(confirm.getAttribute("type")).toBe("submit");
    // It posts the state it wants, never a toggle (L60).
    const hidden = document.querySelector('input[name="retired"]') as HTMLInputElement | null;
    expect(hidden?.value).toBe("true");
  });

  it("marks the retired state with a treatment the live state does not use (L623)", () => {
    const { container: retired } = render(<CalcomRetirementSwitch retired={true} />);
    const { container: live } = render(<CalcomRetirementSwitch retired={false} />);
    expect(retired.querySelector('[data-state="retired"]')).toBeTruthy();
    expect(live.querySelector('[data-state="retired"]')).toBeNull();
  });

  it("says cal.com is retired, and asks before putting it back, naming the hours import", () => {
    render(<CalcomRetirementSwitch retired={true} />);
    expect(screen.getByText(/cal\.com is retired/i)).toBeTruthy();
    const opener = screen.getByRole("button", { name: /put cal\.com back/i });
    expect(opener.getAttribute("type")).not.toBe("submit");
    fireEvent.click(opener);
    expect(screen.getByRole("alert").textContent).toMatch(/hours/i);
    const hidden = document.querySelector('input[name="retired"]') as HTMLInputElement | null;
    expect(hidden?.value).toBe("false");
  });

  it("says when it could not read the switch, and offers neither direction", () => {
    render(<CalcomRetirementSwitch retired={null} />);
    expect(screen.getByText(/could not read/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retire cal\.com/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /put cal\.com back/i })).toBeNull();
  });

  it("shows the outcome of a press beside the control, where it was pressed (L608)", () => {
    render(<CalcomRetirementSwitch retired={true} notice={<p>Saved just now.</p>} />);
    expect(screen.getByText(/Saved just now/)).toBeTruthy();
  });
});

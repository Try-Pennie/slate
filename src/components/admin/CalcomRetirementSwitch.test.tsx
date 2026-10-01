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
    render(<CalcomRetirementSwitch retired={false} putBack={{ copy: null, remove: null }} />);
    expect(screen.getByText(/cal\.com is live/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retire cal\.com/i })).toBeTruthy();
  });

  it("asks before retiring, naming what stops rather than asking generically", () => {
    render(<CalcomRetirementSwitch retired={false} putBack={{ copy: null, remove: null }} />);
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
    const { container: retired } = render(<CalcomRetirementSwitch retired={true} putBack={{ copy: 0, remove: 0 }} />);
    const { container: live } = render(<CalcomRetirementSwitch retired={false} putBack={{ copy: null, remove: null }} />);
    expect(retired.querySelector('[data-state="retired"]')).toBeTruthy();
    expect(live.querySelector('[data-state="retired"]')).toBeNull();
  });

  it("says cal.com is retired, and asks before putting it back, naming the hours import", () => {
    render(<CalcomRetirementSwitch retired={true} putBack={{ copy: 0, remove: 0 }} />);
    expect(screen.getByText(/cal\.com is retired/i)).toBeTruthy();
    const opener = screen.getByRole("button", { name: /put cal\.com back/i });
    expect(opener.getAttribute("type")).not.toBe("submit");
    fireEvent.click(opener);
    expect(screen.getByRole("alert").textContent).toMatch(/hours/i);
    const hidden = document.querySelector('input[name="retired"]') as HTMLInputElement | null;
    expect(hidden?.value).toBe("false");
  });

  it("says when it could not read the switch, and offers neither direction", () => {
    render(<CalcomRetirementSwitch retired={null} putBack={{ copy: null, remove: null }} />);
    expect(screen.getByText(/could not read/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retire cal\.com/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /put cal\.com back/i })).toBeNull();
  });

  it("shows the outcome of a press beside the control, where it was pressed (L608)", () => {
    render(<CalcomRetirementSwitch retired={true} putBack={{ copy: 0, remove: 0 }} notice={<p>Saved just now.</p>} />);
    expect(screen.getByText(/Saved just now/)).toBeTruthy();
  });

  // #2890: the confirmation names how many approved time off requests made during
  // retirement will be copied into cal.com, so the admin knows before pressing.
  it("names the time off to copy in and the blocks to take out in the put back confirmation", () => {
    render(<CalcomRetirementSwitch retired={true} putBack={{ copy: 4, remove: 2 }} />);
    fireEvent.click(screen.getByRole("button", { name: /put cal\.com back/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/4 approved time off requests/);
    expect(screen.getByRole("alert").textContent).toMatch(/2 blocks for time off cancelled or changed/);
  });

  it("says it could not count, rather than inventing a number, when the count is unreadable", () => {
    render(<CalcomRetirementSwitch retired={true} putBack={{ copy: null, remove: null }} />);
    fireEvent.click(screen.getByRole("button", { name: /put cal\.com back/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/could not/i);
  });
});

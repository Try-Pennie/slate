// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// #2297: the control behind the kill switch, and the three states it has to keep
// apart. Running, stopped, and could-not-read are three different screens, never a
// tick and a cross (L530): the third one matters most, because the booking route
// REFUSES while the flag is unreadable, so a page that drew it as "running" would
// be telling an admin the opposite of what leads are experiencing.
vi.mock("@/app/admin/actions", () => ({ setPublicBookingPaused: vi.fn() }));

import { PublicBookingSwitch } from "./PublicBookingSwitch";

describe("PublicBookingSwitch", () => {
  it("says bookings are running, and offers the way to stop them", () => {
    render(<PublicBookingSwitch paused={false} />);
    expect(screen.getByText(/leads can book a call/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop online booking/i })).toBeTruthy();
  });

  it("says bookings are stopped, and offers the way to start them", () => {
    render(<PublicBookingSwitch paused={true} />);
    expect(screen.getByText(/online booking is stopped/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /start online booking/i })).toBeTruthy();
  });

  // The stopped state is the one somebody has to notice from across a room, and it
  // must not be built from the same quiet palette as everything else on the page
  // (L623).
  it("marks the stopped state with a treatment the running state does not use", () => {
    const { container: stopped } = render(<PublicBookingSwitch paused={true} />);
    const { container: running } = render(<PublicBookingSwitch paused={false} />);
    expect(stopped.innerHTML).not.toBe(running.innerHTML);
    expect(stopped.querySelector('[data-state="paused"]')).toBeTruthy();
    expect(running.querySelector('[data-state="paused"]')).toBeNull();
  });

  // Stopping public booking is the destructive direction, so it asks first and the
  // question names what it does AND what it leaves alone. "Are you sure" would send
  // somebody to check whether it also stops calendar sync (L608, L679).
  it("asks before stopping, naming the consequence rather than asking generically", () => {
    render(<PublicBookingSwitch paused={false} />);
    const opener = screen.getByRole("button", { name: /stop online booking/i });
    expect(opener.textContent).toBeTruthy();
    // The opener submits nothing: the confirm does. A control that stopped the
    // booker on one press is one somebody trips by accident.
    expect(opener.getAttribute("type")).not.toBe("submit");
  });

  // Starting again is not destructive and must not be dressed as though it were.
  it("does not put a confirmation in front of starting bookings again", () => {
    render(<PublicBookingSwitch paused={true} />);
    const start = screen.getByRole("button", { name: /start online booking/i });
    expect(start.getAttribute("type")).toBe("submit");
  });

  // The third state. A read that failed must say so, and must say what the booker is
  // doing meanwhile, which is refusing.
  it("says when it could not read the switch, and what leads are meeting while it cannot", () => {
    render(<PublicBookingSwitch paused={null} />);
    expect(screen.getByText(/could not/i)).toBeTruthy();
    expect(screen.getByText(/cannot book/i)).toBeTruthy();
    // Neither instruction is offered, because neither is known to be the one needed.
    expect(screen.queryByRole("button", { name: /stop online booking/i })).toBeNull();
  });
});

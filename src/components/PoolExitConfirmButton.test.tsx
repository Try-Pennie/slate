// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// #1215: deactivating an agent and reassigning that agent's upcoming bookings are
// two independent actions, and nothing connected them. An admin who deactivated
// and forgot the coverage panel left customers booked with someone who had left.
//
// This is a CONFIRM, not a block (L54): an agent genuinely can leave mid-notice
// with the appointments placed afterwards, and the coverage panel works fine on an
// already-deactivated agent. A guard may refuse only what the system cannot do.
import PoolExitConfirmButton, { type PoolExitAction } from "./PoolExitConfirmButton";

const submitted = vi.fn();

// Record the submit instead of letting jsdom navigate (it cannot).
function Harness({
  upcomingBookings,
  action = "deactivate",
}: {
  upcomingBookings: number | null;
  action?: PoolExitAction;
}) {
  return (
    <form
      action=""
      onSubmit={(e) => {
        e.preventDefault();
        submitted();
      }}
    >
      <PoolExitConfirmButton
        action={action}
        agentId="u1"
        agentName="Dana Ruiz"
        upcomingBookings={upcomingBookings}
      />
    </form>
  );
}

beforeEach(() => vi.clearAllMocks());

describe("PoolExitConfirmButton, deactivate (#1215)", () => {
  it("deactivates in one click when the agent holds no upcoming appointments", async () => {
    render(<Harness upcomingBookings={0} />);
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("does not deactivate on the first click when appointments are still held", async () => {
    render(<Harness upcomingBookings={4} />);
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    expect(submitted).not.toHaveBeenCalled();
  });

  it("says how many appointments are at stake and who they belong to", async () => {
    render(<Harness upcomingBookings={4} />);
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    const warning = screen.getByRole("alert");
    expect(warning.textContent).toMatch(/4 upcoming appointments/i);
    expect(warning.textContent).toMatch(/Dana Ruiz/);
  });

  it("reads correctly for a single appointment", async () => {
    render(<Harness upcomingBookings={1} />);
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    const warning = screen.getByRole("alert");
    expect(warning.textContent).toMatch(/1 upcoming appointment\b/i);
    expect(warning.textContent).not.toMatch(/1 upcoming appointments/i);
  });

  it("points at the coverage panel that fixes it", async () => {
    render(<Harness upcomingBookings={4} />);
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/coverage/i);
  });

  // The whole point: it warns, then lets the admin through.
  it("deactivates once the admin confirms anyway", async () => {
    render(<Harness upcomingBookings={4} />);
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    await userEvent.click(screen.getByRole("button", { name: /deactivate anyway/i }));
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("backs out without deactivating when the admin cancels", async () => {
    render(<Harness upcomingBookings={4} />);
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(submitted).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /deactivate account/i })).toBeTruthy();
  });

  // The button that opened the confirm unmounts with it, so without this focus
  // lands on the document body and a keyboard or screen-reader user is dropped
  // out of the flow they just started, in front of a warning they cannot reach
  // by continuing to tab forward.
  it("moves focus into the confirm so a keyboard user is not dropped", async () => {
    render(<Harness upcomingBookings={4} />);
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /deactivate anyway/i }));
  });

  it("returns focus to the deactivate button when the admin cancels", async () => {
    render(<Harness upcomingBookings={4} />);
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /deactivate account/i }),
    );
  });

  // An unreadable count is not zero (L11 / #1169). Waving the admin through on a
  // failed read is the same defect as an all-clear off a query that never ran: it
  // claims "nothing is booked" having measured nothing.
  it("still asks for a confirm when the count could not be read, and says so", async () => {
    render(<Harness upcomingBookings={null} />);
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    expect(submitted).not.toHaveBeenCalled();
    const warning = screen.getByRole("alert");
    expect(warning.textContent).toMatch(/could not|couldn't/i);
    // It must not invent a number it does not have.
    expect(warning.textContent).not.toMatch(/\b0 upcoming/i);
  });
});

// Taking an agent out of the pool via the bookable toggle strands their booked
// appointments exactly as deactivating does: the pool-exit cleanup prunes their
// cached busy time either way, and the booker stops offering them. So the person
// who flips the toggle gets asked the same question, in that control's own words.
describe("PoolExitConfirmButton, make not bookable (#1215)", () => {
  it("flips in one click when the agent holds no upcoming appointments", async () => {
    render(<Harness action="not_bookable" upcomingBookings={0} />);
    await userEvent.click(screen.getByRole("button", { name: /make not bookable/i }));
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("does not flip on the first click when appointments are still held", async () => {
    render(<Harness action="not_bookable" upcomingBookings={2} />);
    await userEvent.click(screen.getByRole("button", { name: /make not bookable/i }));
    expect(submitted).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/2 upcoming appointments/i);
  });

  // The confirm must speak in the language of the control that was pressed. A
  // toggle that warns about "deactivating" reads as the wrong dialog.
  it("words the confirm for the toggle, not for deactivation", async () => {
    render(<Harness action="not_bookable" upcomingBookings={2} />);
    await userEvent.click(screen.getByRole("button", { name: /make not bookable/i }));
    expect(screen.getByRole("button", { name: /make not bookable anyway/i })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).not.toMatch(/deactivat/i);
  });

  it("flips once the admin confirms anyway", async () => {
    render(<Harness action="not_bookable" upcomingBookings={2} />);
    await userEvent.click(screen.getByRole("button", { name: /make not bookable/i }));
    await userEvent.click(screen.getByRole("button", { name: /make not bookable anyway/i }));
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("still confirms when the count could not be read", async () => {
    render(<Harness action="not_bookable" upcomingBookings={null} />);
    await userEvent.click(screen.getByRole("button", { name: /make not bookable/i }));
    expect(submitted).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/could not|couldn't/i);
  });
});

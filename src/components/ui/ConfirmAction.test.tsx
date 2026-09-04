// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmAction } from "./ConfirmAction";
import { btnDangerCls, btnSecondaryCls } from "@/components/ui/styles";

// #1873. The open, confirm, cancel and focus handling behind an in place confirm,
// extracted from the pool exit controls (#1215) so applying company default hours
// could ask the same way without a second copy of it.
//
// The FOCUS assertions are the reason this file exists rather than resting on the
// two callers' tests. The opener and the confirm swap places in the DOM, so
// without moving focus deliberately it lands on the document body: a keyboard or
// screen reader user is dropped out of the flow they just started, and cannot tab
// forward to the message because it sits ABOVE where they now are. Nothing on
// screen reports that, so it is the half a second copy would drift on first.

const save = vi.fn(async () => {});
const other = vi.fn(async () => {});

const subject = (props: Partial<React.ComponentProps<typeof ConfirmAction>> = {}) => (
  <form action={save}>
    <ConfirmAction
      label="Apply company default hours"
      confirmLabel="Apply company hours anyway"
      pendingLabel="Applying company hours"
      className="pn-btn"
      message="This replaces the stored week with Monday to Friday, 9am to 5pm."
      {...props}
    />
  </form>
);

const opener = () => screen.getByRole("button", { name: "Apply company default hours" });
const confirm = () => screen.getByRole("button", { name: "Apply company hours anyway" });

beforeEach(() => {
  save.mockClear();
  other.mockClear();
});

describe("ConfirmAction (#1873)", () => {
  it("submits nothing on the first press, and says what the action would replace", async () => {
    const user = userEvent.setup();
    render(subject());

    await user.click(opener());
    expect(save).not.toHaveBeenCalled();
    // Announced rather than left to be found: the message appears above where the
    // reader's focus now is.
    expect(screen.getByRole("alert").textContent).toMatch(/Monday to Friday, 9am to 5pm/);
  });

  it("focuses nothing on the first render, so the page does not steal focus on load", () => {
    render(subject());
    expect(document.activeElement).toBe(document.body);
  });

  it("moves focus into the confirm, rather than dropping it on the body", async () => {
    const user = userEvent.setup();
    render(subject());

    await user.click(opener());
    expect(document.activeElement).toBe(confirm());
  });

  it("returns focus to the opener when the reader backs out", async () => {
    const user = userEvent.setup();
    render(subject());

    await user.click(opener());
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener());
  });

  it("submits the enclosing form to its own action when no other is given", async () => {
    const user = userEvent.setup();
    render(subject());

    await user.click(opener());
    await user.click(confirm());
    expect(save).toHaveBeenCalledTimes(1);
  });

  // The reason `formAction` exists: a control that discards a form's unsaved
  // edits has to sit inside that form to know they are there, and must not run
  // the form's save.
  it("submits to a DIFFERENT action when one is given, never the form's own", async () => {
    const user = userEvent.setup();
    render(subject({ formAction: other }));

    await user.click(opener());
    await user.click(confirm());
    expect(other).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("renders an extra way out beside Cancel", async () => {
    const user = userEvent.setup();
    render(subject({ extra: <a href="/admin#coverage">Go to Coverage</a> }));

    await user.click(opener());
    expect(screen.getByRole("link", { name: "Go to Coverage" })).toBeTruthy();
  });
});

// #1875: the destructive treatment reaches the opener and the confirm, and never
// Cancel. Backing out is not the destructive choice, and painting the safe way
// out in the warning colour is how a reader stops reading the colour at all.
describe("ConfirmAction keeps Cancel neutral (#1875)", () => {
  it("dresses the opener and the confirm in the caller's treatment", async () => {
    const user = userEvent.setup();
    render(subject({ className: btnDangerCls }));

    expect(opener().className).toBe(btnDangerCls);
    await user.click(opener());
    expect(confirm().className).toBe(btnDangerCls);
  });

  it("leaves Cancel in the neutral treatment, whatever the caller passed", async () => {
    const user = userEvent.setup();
    render(subject({ className: btnDangerCls }));

    await user.click(opener());
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.className).toBe(btnSecondaryCls);
    expect(cancel.className).not.toContain("danger");
  });
});

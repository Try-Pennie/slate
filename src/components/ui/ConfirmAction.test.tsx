// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmAction, ConfirmQuestion } from "./ConfirmAction";
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
// #2124: a confirm that offers TWO ways to go ahead, not one.
//
// Deactivating an agent who holds upcoming bookings has to ask whether to move
// them, because doing it either way without asking is the defect: sweeping
// silently moves customers' appointments out from under the admin, and not
// sweeping strands those customers with an advisor who has left. So the press
// asks, and both answers are a way FORWARD rather than a way out.
describe("ConfirmAction offers a second decision when one is given (#2124)", () => {
  const withAlternative = {
    alternative: {
      label: "Deactivate and leave them",
      pendingLabel: "Deactivating",
      name: "coverage",
      value: "leave",
    },
  };

  it("renders both decisions, and Cancel is still separate from either", async () => {
    const user = userEvent.setup();
    render(subject(withAlternative));
    await user.click(opener());

    expect(confirm()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deactivate and leave them" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  // The two answers must be TELLABLE APART by the server, or the choice is
  // decoration: the browser posts the pressed button's name and value and no
  // other's.
  it("gives the alternative its own name and value, and leaves the primary bare", async () => {
    const user = userEvent.setup();
    render(
      subject({
        ...withAlternative,
        confirmName: "coverage",
        confirmValue: "move",
      }),
    );
    await user.click(opener());

    const move = confirm() as HTMLButtonElement;
    const leave = screen.getByRole("button", { name: "Deactivate and leave them" }) as HTMLButtonElement;
    expect([move.name, move.value]).toEqual(["coverage", "move"]);
    expect([leave.name, leave.value]).toEqual(["coverage", "leave"]);
  });

  it("submits the form from the alternative too, not only from the primary", async () => {
    const user = userEvent.setup();
    render(subject(withAlternative));
    await user.click(opener());
    await user.click(screen.getByRole("button", { name: "Deactivate and leave them" }));

    expect(save).toHaveBeenCalledTimes(1);
  });

  // Both go ahead, so both wear the caller's treatment. Cancel is the only
  // neutral one, which is the #1875 rule: backing out is never the destructive
  // choice, and painting one of two ways FORWARD as the safe way out would be a
  // lie about what it does.
  it("dresses both decisions in the caller's treatment, and only Cancel neutrally", async () => {
    const user = userEvent.setup();
    render(subject({ ...withAlternative, className: btnDangerCls }));
    await user.click(opener());

    expect(confirm().className).toBe(btnDangerCls);
    expect(
      screen.getByRole("button", { name: "Deactivate and leave them" }).className,
    ).toBe(btnDangerCls);
    expect(screen.getByRole("button", { name: "Cancel" }).className).toBe(btnSecondaryCls);
  });

  // `useFormStatus` reports the FORM, not the button, so both submits go pending
  // together and each would swap to ITS OWN pending label. Pressing "leave" would
  // then make the other button read "Moving them and deactivating", which claims
  // the opposite of what is happening, on the one screen where the difference is
  // the whole decision (L11).
  it("shows only the decision that was taken once one is pressed", async () => {
    const user = userEvent.setup();
    render(subject(withAlternative));
    await user.click(opener());
    await user.click(screen.getByRole("button", { name: "Deactivate and leave them" }));

    expect(screen.queryByRole("button", { name: "Apply company hours anyway" })).toBeNull();
    expect(screen.getByRole("button", { name: /Deactivating|Deactivate and leave them/ })).toBeTruthy();
  });

  it("keeps the primary and drops the alternative when the primary is taken", async () => {
    const user = userEvent.setup();
    render(subject(withAlternative));
    await user.click(opener());
    await user.click(confirm());

    expect(screen.queryByRole("button", { name: "Deactivate and leave them" })).toBeNull();
  });

  // And backing out has to put both back, or a reader who cancels and reopens is
  // offered only the choice they abandoned.
  it("offers both again after a cancel and a second open", async () => {
    const user = userEvent.setup();
    render(subject(withAlternative));
    await user.click(opener());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(opener());

    expect(confirm()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deactivate and leave them" })).toBeTruthy();
  });

  it("offers exactly one decision when no alternative is given", async () => {
    const user = userEvent.setup();
    render(subject());
    await user.click(opener());

    const submits = screen
      .getAllByRole("button")
      .filter((b) => (b as HTMLButtonElement).type === "submit");
    expect(submits).toHaveLength(1);
  });

  // Focus still lands on the FIRST decision, which is the one a reader should
  // take: the alternative must not steal the focus move that makes this usable
  // from a keyboard.
  it("still moves focus to the first decision, not to the alternative", async () => {
    const user = userEvent.setup();
    render(subject(withAlternative));
    await user.click(opener());

    expect(document.activeElement).toBe(confirm());
  });
});

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

// #4264: a design's preview frame draws the question open (docs/design/coordinator-admin.html,
// f-confirm-on), and a list asking about one row draws the question under that row rather than in
// the opener's place (D12). Both use the question itself, ConfirmQuestion, so there is still one
// drawing of it.
describe("ConfirmAction drawn open, and the question on its own (#4264)", () => {
  it("draws the question open when asked to, without taking focus on load", () => {
    render(subject({ initiallyOpen: true }));
    expect(screen.getByRole("alert").textContent).toContain("This replaces the stored week");
    expect(confirm()).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("goes back to the opener from an open question, and focuses it", async () => {
    const user = userEvent.setup();
    render(subject({ initiallyOpen: true }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(opener());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("draws the question alone, with the confirm first and Cancel neutral, and says when it is cancelled", async () => {
    const user = userEvent.setup();
    const cancelled = vi.fn();
    render(
      <form action={save}>
        <ConfirmQuestion
          message="Aisha Bello will no longer be able to sign in."
          confirmLabel="Remove Aisha Bello"
          pendingLabel="Removing"
          className={btnDangerCls}
          onCancel={cancelled}
        />
      </form>,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Remove Aisha Bello", "Cancel"]);
    expect(buttons[1]?.className).toBe(btnSecondaryCls);
    await user.click(buttons[1]!);
    expect(cancelled).toHaveBeenCalledTimes(1);
    await user.click(buttons[0]!);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

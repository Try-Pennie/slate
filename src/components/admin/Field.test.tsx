// @vitest-environment jsdom
//
// The label belongs to the input, and a hint is announced with it (#1950).
//
// `Field` used to render a bare `<label>` with no `htmlFor` and put
// `aria-label={label}` on the input separately. That works, in the sense that
// the field has an accessible name, and it hides two faults: clicking the label
// does not move focus, and the visible text and the announced name are two
// independent facts about one field, so they can drift with nothing reporting
// it. Both are invisible to a static read of the JSX, which is why this mounts
// the real component.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field } from "./Field";

describe("Field associates its label with its input (#1950)", () => {
  it("finds the input BY its visible label text", () => {
    render(<Field name="min_notice_min" label="Notice (m)" />);
    // getByLabelText resolves through htmlFor/id, aria-labelledby or aria-label,
    // so this alone does not prove the association is the real one.
    expect(screen.getByLabelText("Notice (m)")).toBe(
      screen.getByRole("textbox", { name: "Notice (m)" }),
    );
  });

  it("wires the label to the input through htmlFor, not a duplicate aria-label", () => {
    const { container } = render(<Field name="grid" label="Grid (m)" />);
    const label = container.querySelector("label")!;
    const input = container.querySelector("input")!;
    expect(input.id).toBeTruthy();
    expect(label.getAttribute("for")).toBe(input.id);
    // The duplicate is what makes drift possible: an aria-label WINS over the
    // visible text, so the two saying different things is unreportable.
    expect(input.getAttribute("aria-label")).toBeNull();
  });

  it("announces the hint with the field rather than only placing it nearby", () => {
    const { container } = render(
      <Field name="daily_cap" label="Daily cap" hint="Most calls one agent takes in a day." />,
    );
    const input = container.querySelector("input")!;
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(container.querySelector(`#${describedBy}`)?.textContent).toBe(
      "Most calls one agent takes in a day.",
    );
  });

  it("leaves no describedby pointing at nothing when there is no hint", () => {
    const { container } = render(<Field name="duration_min" label="Duration (m)" />);
    expect(container.querySelector("input")!.getAttribute("aria-describedby")).toBeNull();
  });

  // A placeholder is how a suggested value is shown WITHOUT being submitted. A
  // defaultValue would submit untouched, which is the defect this whole change
  // exists to remove, so the two must not be confused at the call site.
  it("shows a placeholder without giving the field a value", () => {
    const { container } = render(
      <Field name="duration_min" label="Duration (m)" placeholder="30" />,
    );
    const input = container.querySelector("input")! as HTMLInputElement;
    expect(input.placeholder).toBe("30");
    expect(input.value).toBe("");
  });

  it("marks a required field as required to a screen reader too", () => {
    render(<Field name="name" label="Title" required />);
    const input = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    expect(input.required).toBe(true);
  });
});

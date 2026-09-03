// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectField, type SelectOption } from "@/components/ui/SelectField";

// #1849: a native `<select>` was doing four things for free, and a replacement
// that drops any one of them trades a plain looking control for a broken one.
// These are those four, asserted separately so a failure names which contract
// was lost. The keyboard MODEL is pinned as pure rules in
// scripts/test-listbox-navigation.ts; this asserts the component is wired to it.

const OPTIONS: SelectOption[] = [
  { value: "et", label: "Eastern" },
  { value: "ct", label: "Central" },
  { value: "mt", label: "Mountain" },
  { value: "pt", label: "Pacific" },
];

function Field(props: Partial<React.ComponentProps<typeof SelectField>> = {}) {
  return (
    <SelectField
      name="zone"
      value="ct"
      options={OPTIONS}
      ariaLabel="Timezone"
      {...props}
    />
  );
}

const trigger = () => screen.getByRole("combobox", { name: "Timezone" });

describe("SelectField (#1849)", () => {
  it("posts with the form, which is what a native select carried for free", () => {
    const { container } = render(<Field />);
    const hidden = container.querySelector('input[type="hidden"][name="zone"]');
    expect(hidden, "a form containing this must still submit a value").toBeTruthy();
    expect((hidden as HTMLInputElement).value).toBe("ct");
  });

  it("submits nothing extra when it is not a form control", () => {
    const { container } = render(<Field name={undefined} />);
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
  });

  it("shows the current option, not the raw value", () => {
    render(<Field />);
    expect(trigger().textContent).toContain("Central");
  });

  it("says so rather than looking empty when the value matches no option", () => {
    // The timezone list becomes a fixed set, so a stored value outside it is a
    // real state and must not render as a blank control (or, worse, as whatever
    // happens to be first, which silently moves somebody's hours).
    render(<Field value="Europe/Berlin" placeholder="Not a US zone" />);
    expect(trigger().textContent).toContain("Not a US zone");
  });

  describe("the keyboard contract", () => {
    it("opens on ArrowDown with the highlight on the current value", async () => {
      const user = userEvent.setup();
      render(<Field />);
      trigger().focus();
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("listbox", { name: "Timezone" })).toBeTruthy();
      // AT the current value, not past it. That is the combobox pattern, and it
      // is also what stops the first keypress silently changing the answer.
      expect(trigger().getAttribute("aria-activedescendant")).toBe(
        screen.getByRole("option", { name: "Central" }).id,
      );
      // A second press then walks the list.
      await user.keyboard("{ArrowDown}");
      expect(trigger().getAttribute("aria-activedescendant")).toBe(
        screen.getByRole("option", { name: "Mountain" }).id,
      );
    });

    it("commits on Enter and gives focus back to the trigger", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Field onChange={onChange} />);
      trigger().focus();
      await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
      expect(onChange).toHaveBeenCalledWith("mt");
      expect(document.activeElement).toBe(trigger());
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("Escape dismisses without committing", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Field onChange={onChange} />);
      trigger().focus();
      await user.keyboard("{ArrowDown}{Escape}");
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("jumps by typing, the way a native select does", async () => {
      const user = userEvent.setup();
      render(<Field />);
      trigger().focus();
      await user.keyboard("p");
      expect(trigger().getAttribute("aria-activedescendant")).toBe(
        screen.getByRole("option", { name: "Pacific" }).id,
      );
    });
  });

  describe("what assistive tech is told", () => {
    it("is a combobox owning its list, and points at the highlighted row", async () => {
      const user = userEvent.setup();
      render(<Field />);
      const t = trigger();
      expect(t.getAttribute("aria-haspopup")).toBe("listbox");
      expect(t.getAttribute("aria-expanded")).toBe("false");
      await user.click(t);
      expect(t.getAttribute("aria-expanded")).toBe("true");
      expect(t.getAttribute("aria-controls")).toBe(
        screen.getByRole("listbox", { name: "Timezone" }).id,
      );
      // Focus STAYS on the trigger; the list is pointed at, not entered.
      expect(document.activeElement).toBe(t);
    });

    it("marks the selected option, so it is not colour alone", async () => {
      const user = userEvent.setup();
      render(<Field />);
      await user.click(trigger());
      expect(screen.getByRole("option", { name: "Central" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("option", { name: "Eastern" }).getAttribute("aria-selected")).toBe("false");
    });
  });

  describe("the panel", () => {
    it("is portalled, so no scrolling ancestor can clip it", async () => {
      const user = userEvent.setup();
      render(
        <div className="overflow-x-auto" data-testid="clipper">
          <Field />
        </div>,
      );
      await user.click(trigger());
      const list = screen.getByRole("listbox", { name: "Timezone" });
      expect(screen.getByTestId("clipper").contains(list)).toBe(false);
      // The positive control: the trigger really is inside it.
      expect(screen.getByTestId("clipper").contains(trigger())).toBe(true);
    });

    it("bounds its own height and scrolls inside, rather than growing to fit", async () => {
      const user = userEvent.setup();
      const many = Array.from({ length: 400 }, (_, i) => ({ value: `z${i}`, label: `Zone ${i}` }));
      render(<Field options={many} value="z0" />);
      await user.click(trigger());
      const list = screen.getByRole("listbox", { name: "Timezone" });
      expect(list.className, "a list of 400 must not take the whole window").toMatch(/max-h-/);
      expect(list.className).toMatch(/overflow-y-auto/);
    });

    it("closes when the page behind it scrolls", async () => {
      const user = userEvent.setup();
      render(<Field />);
      await user.click(trigger());
      fireEvent.scroll(window);
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });
});

// The uncontrolled form, which is what a plain server rendered form needs: no
// state to drive it, and the value has to reach the POST.
describe("uncontrolled, in a form that just submits (#1849)", () => {
  it("starts at defaultValue and posts what was chosen", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SelectField name="zone" defaultValue="ct" options={OPTIONS} ariaLabel="Timezone" />,
    );
    const hidden = () => container.querySelector('input[name="zone"]') as HTMLInputElement;
    expect(hidden().value).toBe("ct");
    expect(trigger().textContent).toContain("Central");

    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: "Pacific" }));

    expect(hidden().value, "the form must post the new value, not the original").toBe("pt");
    expect(trigger().textContent).toContain("Pacific");
  });
});

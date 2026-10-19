// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DaysOfferedFields } from "./DaysOfferedFields";
import {
  EXTRA_DAYS_HINT,
  EXTRA_DAYS_LABEL,
  FURTHEST_DAY_TERM,
  OFFERED_DAYS_HINT,
  OFFERED_DAYS_LABEL,
} from "@/lib/admin/days-offered-copy";

// #3922, the settled design (docs/design/days-offered.html): two of Slate's own
// dropdowns listing bare numbers, the extra days' choices shrinking as the offered
// days grow so the furthest day can never pass 7, and a fact line stating the
// furthest day with the sum that makes it.

afterEach(cleanup);

const offered = () => screen.getByRole("combobox", { name: OFFERED_DAYS_LABEL });
const extra = () => screen.getByRole("combobox", { name: EXTRA_DAYS_LABEL });
const posted = (name: string) =>
  (document.querySelector(`input[type="hidden"][name="${name}"]`) as HTMLInputElement | null)?.value;
const fact = () => screen.getByText(FURTHEST_DAY_TERM).parentElement!;

async function optionsOf(control: HTMLElement): Promise<string[]> {
  await userEvent.click(control);
  const list = await screen.findByRole("listbox");
  const labels = within(list).getAllByRole("option").map((o) => o.textContent ?? "");
  await userEvent.keyboard("{Escape}");
  return labels;
}

describe("DaysOfferedFields (#3922)", () => {
  it("draws two of Slate's own dropdowns holding today's values, and posts both", () => {
    render(<DaysOfferedFields offered={3} extra={1} />);
    expect(offered().textContent).toBe("3");
    expect(extra().textContent).toBe("1");
    expect(posted("offered_open_days")).toBe("3");
    expect(posted("last_resort_extra_days")).toBe("1");
    // Nothing native: no select and no number box.
    expect(document.querySelector("select")).toBeNull();
    expect(document.querySelector("input[type='number']")).toBeNull();
  });

  it("lists bare numbers: 1 to 7 offered, and extra only up to what keeps the sum at 7", async () => {
    render(<DaysOfferedFields offered={3} extra={1} />);
    expect(await optionsOf(offered())).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(await optionsOf(extra())).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("shrinks the extra choices as the offered days grow, and keeps the furthest day at 7 or less", async () => {
    render(<DaysOfferedFields offered={3} extra={4} />);
    await userEvent.click(offered());
    await userEvent.click(await screen.findByRole("option", { name: "6" }));
    expect(await optionsOf(extra())).toEqual(["0", "1"]);
    // The 4 extra no longer fits, so it comes down to the most that does, and the
    // fact line says what that makes.
    expect(extra().textContent).toBe("1");
    expect(posted("last_resort_extra_days")).toBe("1");
    expect(fact().textContent).toContain("Day 7");
  });

  it("states the furthest day with the sum that makes it, and follows each change", async () => {
    render(<DaysOfferedFields offered={3} extra={1} />);
    expect(fact().textContent).toBe(`${FURTHEST_DAY_TERM}Day 4 (3 offered + 1 extra)`);
    await userEvent.click(offered());
    await userEvent.click(await screen.findByRole("option", { name: "4" }));
    expect(fact().textContent).toBe(`${FURTHEST_DAY_TERM}Day 5 (4 offered + 1 extra)`);
  });

  it("explains each term once, on the control, where a screen reader hears it", () => {
    render(<DaysOfferedFields offered={3} extra={1} />);
    const hintOf = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent;
    expect(hintOf(offered())).toBe(OFFERED_DAYS_HINT);
    expect(hintOf(extra())).toBe(EXTRA_DAYS_HINT);
  });

  it("draws both controls the same narrow width with the value centred", () => {
    render(<DaysOfferedFields offered={3} extra={1} />);
    const wrapOf = (el: HTMLElement) => el.parentElement!.className;
    expect(wrapOf(offered())).toBe(wrapOf(extra()));
    expect(wrapOf(offered())).toContain("w-21");
    expect(offered().querySelector("span")?.className).toContain("text-center");
  });

  it("commits a choice with Enter without submitting the form", async () => {
    let submitted = 0;
    render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitted += 1;
        }}
      >
        <DaysOfferedFields offered={3} extra={1} />
      </form>,
    );
    offered().focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(offered().textContent).toBe("4");
    expect(submitted).toBe(0);
  });
});

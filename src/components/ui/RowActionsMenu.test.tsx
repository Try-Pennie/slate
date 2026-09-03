// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RowActionsMenu } from "@/components/ui/RowActionsMenu";

// #1794: the roster's per row controls spelled the agent's whole name into a
// narrow column ("View as Kenneth Johnson" wrapped to three lines), so every row
// was a different height. Collapsing them into one menu fixes the raggedness, but
// only if the menu is a real menu.

function Menu({ label = "Actions for Ada Lovelace" }: { label?: string } = {}) {
  return (
    <RowActionsMenu label={label}>
      <button type="button" role="menuitem" data-first>
        View as Ada
      </button>
      <a href="/x" role="menuitem" data-second>
        Manage
      </a>
    </RowActionsMenu>
  );
}

const trigger = () => screen.getByRole("button", { name: /Actions for/i });

describe("RowActionsMenu", () => {
  it("names the row in the trigger, even though the glyph does not", () => {
    // A table of identical "More" buttons is a control addressed by position
    // rather than identity (L237). On screen the row gives the context; to a
    // screen reader 136 buttons called "More" give none.
    render(<Menu />);
    expect(trigger().getAttribute("aria-label")).toBe("Actions for Ada Lovelace");
    expect(trigger().textContent).not.toMatch(/Ada/);
  });

  it("declares itself a menu, and says whether it is open", () => {
    render(<Menu />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on click and puts focus on the first item", async () => {
    render(<Menu />);
    await userEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "View as Ada" }));
  });

  it("opens from the keyboard too", async () => {
    render(<Menu />);
    trigger().focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "View as Ada" }));
  });

  it("moves between items with the arrow keys, and wraps", async () => {
    render(<Menu />);
    await userEvent.click(trigger());
    const [first, second] = screen.getAllByRole("menuitem");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(second);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(first);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(second);
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    render(<Menu />);
    await userEvent.click(trigger());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when you click outside it", async () => {
    render(
      <div>
        <Menu />
        <button type="button">elsewhere</button>
      </div>,
    );
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stays open while an item's action is in flight", async () => {
    // "View as" is a form submission, not a link, and it is the action where
    // losing the pending state matters most, since it swaps who you are logged in
    // as. Closing on activation would unmount the submit button mid flight.
    const onClick = vi.fn();
    render(
      <RowActionsMenu label="Actions for Ada Lovelace">
        <button type="button" role="menuitem" onClick={onClick}>
          View as Ada
        </button>
      </RowActionsMenu>,
    );
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitem", { name: "View as Ada" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("gives the trigger a 44px target", async () => {
    // jsdom cannot compute Tailwind, so the class is the only evidence here.
    render(<Menu />);
    expect(trigger().className).toContain("min-h-11");
    expect(trigger().className).toContain("min-w-11");
  });

  it("hides the glyph from assistive tech, since the label carries the meaning", () => {
    render(<Menu />);
    expect(trigger().querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
});

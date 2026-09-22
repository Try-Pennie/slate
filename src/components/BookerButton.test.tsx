// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BookerButton } from "@/components/BookerButton";
import { bookerButtonClass, type BookerButtonPalette } from "@/components/booker-button";

// The booker's twelve hand written button class strings became one component
// (#2562). These pin what a call site can ask for and what it gets back, so a
// change to the shared geometry is a change to one thing rather than a file wide
// find and replace with a site left behind (L613).

const palette: BookerButtonPalette = {
  toggleBorder: "border-border",
  body: "text-fg",
  navHover: "hover:bg-fg/10",
  confirm: "bg-accent text-fg-on-sky hover:bg-accent-hover",
  muted: "text-fg-muted",
};

const classesFor = (variant: Parameters<typeof bookerButtonClass>[0]["variant"], size: Parameters<typeof bookerButtonClass>[0]["size"]) =>
  bookerButtonClass({ palette, variant, size }).split(/\s+/);

describe("bookerButtonClass", () => {
  it("gives every button the same box, whatever it is for", () => {
    for (const variant of ["primary", "secondary", "danger", "quiet"] as const) {
      const tokens = classesFor(variant, "md");
      expect(tokens).toContain("inline-flex");
      expect(tokens).toContain("items-center");
      expect(tokens).toContain("justify-center");
      expect(tokens).toContain("font-semibold");
      expect(tokens).toContain("disabled:opacity-60");
    }
  });

  it("sizes carry the target height, the padding and the radius the booker shipped", () => {
    expect(classesFor("secondary", "sm")).toEqual(
      expect.arrayContaining(["min-h-11", "px-4", "text-sm", "rounded-lg"]),
    );
    expect(classesFor("primary", "md")).toEqual(
      expect.arrayContaining(["min-h-12", "px-5", "text-sm", "rounded-lg"]),
    );
    expect(classesFor("primary", "lg")).toEqual(
      expect.arrayContaining(["min-h-14", "px-4", "text-base", "rounded-xl"]),
    );
  });

  it("every size clears the 44px touch target", () => {
    // min-h-11 is 2.75rem = 44px, the smallest the booker offers.
    for (const size of ["sm", "md", "lg"] as const) {
      const height = classesFor("primary", size).find((t) => /^min-h-\d+$/.test(t));
      // Asserted before it is compared: a token this cannot read gives NaN, and
      // every comparison with NaN is false, so the check would fail with no
      // word about why rather than saying the height could not be read (L50).
      expect(height, `${size} carries a readable min height`).toBeDefined();
      expect(Number(height!.replace("min-h-", ""))).toBeGreaterThanOrEqual(11);
    }
  });

  it("takes its colour from the palette it is given, not from a copy of its own", () => {
    expect(classesFor("primary", "md")).toEqual(expect.arrayContaining(palette.confirm.split(" ")));
    expect(classesFor("secondary", "md")).toEqual(
      expect.arrayContaining(["border", palette.toggleBorder, palette.body, palette.navHover]),
    );
    expect(classesFor("quiet", "md")).toEqual(
      expect.arrayContaining(["underline", "underline-offset-2", "hover:no-underline", palette.muted]),
    );
  });

  it("the destructive variant is the only one that looks destructive", () => {
    const danger = classesFor("danger", "md");
    expect(danger).toContain("bg-[var(--error)]");
    expect(danger).toContain("text-white");
    for (const other of ["primary", "secondary", "quiet"] as const) {
      expect(classesFor(other, "md")).not.toContain("bg-[var(--error)]");
    }
  });

  it("keeps the caller's own layout classes", () => {
    expect(classesFor("primary", "md")).not.toContain("mt-6");
    expect(
      bookerButtonClass({ palette, variant: "primary", size: "md", className: "mt-6 w-full" }).split(/\s+/),
    ).toEqual(expect.arrayContaining(["mt-6", "w-full", "inline-flex"]));
  });
});

describe("BookerButton", () => {
  it("renders a button carrying the composed class string", () => {
    render(
      <BookerButton palette={palette} variant="primary" size="md">
        Confirm booking
      </BookerButton>,
    );
    const btn = screen.getByRole("button", { name: "Confirm booking" });
    expect(btn.className).toBe(bookerButtonClass({ palette, variant: "primary", size: "md" }));
  });

  it("passes the press, the disabled state and the brand style straight through", () => {
    render(
      <BookerButton
        palette={palette}
        variant="primary"
        size="lg"
        disabled
        style={{ backgroundColor: "rgb(1, 2, 3)" }}
        data-testid="panel-primary"
        aria-label="Book"
      >
        Book
      </BookerButton>,
    );
    const btn = screen.getByTestId("panel-primary") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.style.backgroundColor).toBe("rgb(1, 2, 3)");
    expect(btn.getAttribute("aria-label")).toBe("Book");
  });

  it("sets no type of its own, so a submit inside a form still submits", () => {
    // The converted sites include one `type="submit"` inside the phone form and
    // several plain buttons outside any form. A default here would change what
    // a press DOES, which a class consolidation must not.
    render(
      <BookerButton palette={palette} variant="secondary" size="sm">
        Cancel
      </BookerButton>,
    );
    expect(screen.getByRole("button").getAttribute("type")).toBe(null);
  });

  it("shows a moving cue while it is working, on the button the lead just pressed", () => {
    render(
      <BookerButton palette={palette} variant="primary" busy>
        Booking your call…
      </BookerButton>,
    );

    // Every time taking action has to keep three states visibly apart: started,
    // still alive, and failed. A label swap alone is one picture that does not
    // change again, so a lead cannot tell a request in flight from one that died
    // (Dan, 2026-09-22: "the loading felt stuck after I submitted my time. it
    // wasn't stuck, it worked, but it didn't feel like it was moving").
    expect(document.querySelector("[data-bob-dots]")).not.toBeNull();
  });

  it("carries no cue when it is not working, so the box does not move on every render", () => {
    render(
      <BookerButton palette={palette} variant="primary">
        Confirm booking
      </BookerButton>,
    );

    expect(document.querySelector("[data-bob-dots]")).toBeNull();
  });

  it("draws the cue in the button's own text colour, never the accent", () => {
    render(
      <BookerButton palette={palette} variant="primary" busy>
        Booking your call…
      </BookerButton>,
    );

    // The primary button is FILLED with the accent, so accent dots on it are
    // invisible. They take `currentColor`, which is the label's colour on every
    // variant, so the cue can never disappear into its own button.
    const dot = document.querySelector("[data-bob-dot]");
    expect(dot!.className).toContain("bg-current");
    expect(dot!.className).not.toContain("bg-accent");
  });
});

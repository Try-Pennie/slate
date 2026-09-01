// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Pill } from "./Pill";

// #1054: a Pill on a band that paints its OWN dark fill.
//
// Found by an axe run against the agent detail page, where two pills in the navy
// identity band drew a graphite label on navy at 1.28:1. Not low contrast: invisible.
//
// The cause is the pair problem (L213). The transparent variants draw their label in
// `--fg`, which follows the PAGE theme, so they are legible on the page's own
// background and nowhere else. A call site that overrides only the BACKGROUND keeps the
// base variant's foreground, and nothing reports it because both halves are
// individually correct: the token contrast guard checks pairings, and this was a
// composition of two valid tokens.
//
// So `onDark` overrides the pair. These tests pin the rule rather than the exact
// classes: what must hold is that a transparent variant on a dark band does not keep
// the theme-following foreground, and that a variant carrying its own fill is left
// alone (overriding one of those would break the fill it depends on).

const TRANSPARENT = ["role-agent", "outline"] as const;
const SELF_CONTAINED = [
  "role-manager",
  "role-admin",
  "role-super_admin",
  "status-ok",
  "status-pending",
] as const;

describe("Pill onDark", () => {
  it("drops the theme-following foreground on the transparent variants", () => {
    for (const variant of TRANSPARENT) {
      const { container } = render(
        <Pill variant={variant} onDark>
          label
        </Pill>,
      );
      const cls = container.firstElementChild!.className;
      expect(cls, `${variant} must not keep text-fg on a dark band`).not.toMatch(/\btext-fg\b/);
      expect(cls, `${variant} needs the band's own foreground`).toMatch(/text-pennie-beige/);
    }
  });

  it("keeps the theme-following foreground when NOT on a dark band", () => {
    // The positive control. Without it, a fix that hardcoded beige everywhere would
    // pass the test above while making every pill on a beige page unreadable.
    for (const variant of TRANSPARENT) {
      const { container } = render(<Pill variant={variant}>label</Pill>);
      expect(container.firstElementChild!.className).toMatch(/\btext-fg\b/);
    }
  });

  it("leaves a variant that paints its own fill untouched", () => {
    // These carry a background AND a foreground chosen together, so overriding half of
    // one is the very mistake this prop exists to fix.
    for (const variant of SELF_CONTAINED) {
      const plain = render(<Pill variant={variant}>label</Pill>).container.firstElementChild!
        .className;
      const dark = render(
        <Pill variant={variant} onDark>
          label
        </Pill>,
      ).container.firstElementChild!.className;
      expect(dark, `${variant} is self-contained and must not change`).toBe(plain);
    }
  });

  it("renders its children and any caller class either way", () => {
    const { container } = render(
      <Pill variant="outline" onDark className="ml-2">
        Deactivated
      </Pill>,
    );
    const el = container.firstElementChild!;
    expect(el.textContent).toBe("Deactivated");
    expect(el.className).toMatch(/ml-2/);
  });
});

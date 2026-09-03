// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Pill, PILL_TEXT_INSET_PX, ALL_VARIANTS, type PillVariant } from "./Pill";

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

// #1821: a Pill in a table cell put its label 9px right of the column header's,
// so the header lined up with the pill's rounded edge instead of with its word.
//
// Dan, on the Bookable column: "the alignment is from the B in the column header
// to the left edge of the green bubble, not to the B in the value. So the words
// aren't align, the header and the bubble are aligned and that's awkward".
//
// He noticed it there because the header and the value were the same word, which
// made the two positions directly comparable. The defect is the pill's, so it was
// in every column that uses one.
describe("Pill in a table cell", () => {
  const cls = (el: HTMLElement) => el.firstElementChild!.className;

  it("knows its own left inset, and it is the border plus the padding", () => {
    // Derived rather than typed, so the cancellation below cannot drift if the
    // padding changes. The classes are asserted too, or these numbers would be a
    // description of something that is no longer true.
    expect(PILL_TEXT_INSET_PX).toBe(9);
    const { container } = render(<Pill variant="status-ok">Yes</Pill>);
    expect(cls(container as unknown as HTMLElement)).toContain("px-2");
    expect(cls(container as unknown as HTMLElement)).toContain("border");
  });

  it("cancels exactly that inset when told to align to the column", () => {
    const { container } = render(
      <Pill variant="status-ok" alignToColumn>
        Yes
      </Pill>,
    );
    expect(cls(container as unknown as HTMLElement)).toContain(`-ml-[${PILL_TEXT_INSET_PX}px]`);
  });

  it("keeps its inset everywhere else, which is correct in a sentence or a row", () => {
    const { container } = render(<Pill variant="status-ok">Yes</Pill>);
    expect(cls(container as unknown as HTMLElement)).not.toMatch(/-ml-/);
  });

  it("pulls only the first pill, so two in one cell still read as two", () => {
    // The time off page puts two side by side. Only the one at the column's start
    // is being aligned to the header; pulling the second would eat the gap.
    const { container } = render(
      <>
        <Pill variant="status-ok" alignToColumn>
          Yes
        </Pill>
        <Pill variant="outline">No</Pill>
      </>,
    );
    const [first, second] = Array.from(container.children) as HTMLElement[];
    expect(first!.className).toContain(`-ml-[${PILL_TEXT_INSET_PX}px]`);
    expect(second!.className).not.toMatch(/-ml-/);
  });

  it("does not change anything else about the pill", () => {
    const plain = render(<Pill variant="status-ok">Yes</Pill>);
    const aligned = render(
      <Pill variant="status-ok" alignToColumn>
        Yes
      </Pill>,
    );
    const strip = (c: string) => c.replace(`-ml-[${PILL_TEXT_INSET_PX}px]`, "").replace(/\s+/g, " ").trim();
    expect(strip(aligned.container.firstElementChild!.className)).toBe(
      strip(plain.container.firstElementChild!.className),
    );
  });
});

// #1844: the ROLE LADDER, and the fact that agent is its floor.
//
// Dan, 2026-09-03, on the agent roster: "agent is too bold, soften it so it reads
// like the manager column". The roster's least informative value carried the
// heaviest text treatment on essentially every row, because agent is the
// overwhelming majority of a 117 person roster and the four elevated roles are
// the ones worth spotting.
//
// The five role variants are an ORDERED set (agent, manager, team lead, admin,
// super admin), each reading as more elevated than the last. Changing one member
// of an ordered set for an unrelated reason is how the ordering breaks while
// every member stays individually valid (L545), so this asserts the ORDERING
// rule rather than agent's exact colour: agent is the only role that draws no
// pill chrome, and every role above it does.
//
// The list is DERIVED from the variant union rather than typed out beside it, so
// a sixth role cannot be silently exempt from the rule (L96).
describe("the role ladder (#1844)", () => {
  const ROLE_VARIANTS = ALL_VARIANTS.filter((v) => v.startsWith("role-"));

  it("enumerates every role the type allows", () => {
    // The positive control on the derivation above. Without it a filter that
    // matched nothing would make every assertion below vacuously true (L98).
    expect(ROLE_VARIANTS).toEqual([
      "role-agent",
      "role-manager",
      "role-team_lead",
      "role-admin",
      "role-super_admin",
    ]);
  });

  const clsOf = (v: PillVariant) =>
    render(<Pill variant={v}>label</Pill>).container.firstElementChild!.className;

  it("draws agent as plain muted text: no weight, no border, no fill", () => {
    const cls = clsOf("role-agent");
    expect(cls, "agent must not be bold").not.toMatch(/font-semibold/);
    expect(cls, "agent must read like the Manager column").toMatch(/text-fg-muted/);
    expect(cls, "agent must not draw a visible border").not.toMatch(/border-border/);
    expect(cls, "agent must not paint a fill").not.toMatch(/\bbg-/);
  });

  it("keeps every role ABOVE agent visibly elevated", () => {
    for (const v of ROLE_VARIANTS.filter((r) => r !== "role-agent")) {
      const cls = clsOf(v);
      expect(cls, `${v} sits above agent and must stay bold`).toMatch(/font-semibold/);
      expect(cls, `${v} must draw its own chrome, a fill or a border`).toMatch(
        /\bbg-|\bborder-(?!transparent)/,
      );
    }
  });

  it("still holds up on a dark band, where muting it would make it vanish", () => {
    // The muting is a decision about DENSITY on a long table, not about the role.
    // On a band that paints its own dark fill there is exactly one of these, and
    // graphite-muted on navy is the invisible pill `onDark` exists to prevent
    // (L213), so agent takes the shared on-dark pairing like any other
    // transparent variant.
    const cls = render(
      <Pill variant="role-agent" onDark>
        label
      </Pill>,
    ).container.firstElementChild!.className;
    expect(cls).toMatch(/text-pennie-beige/);
    expect(cls).not.toMatch(/text-fg-muted/);
  });
});

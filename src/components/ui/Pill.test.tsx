// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  Pill,
  PILL_TEXT_INSET_PX,
  PILL_MARK_TEXT_INSET_PX,
  PILL_LABEL_OPTICAL_NUDGE_PX,
  ALL_VARIANTS,
  type PillVariant,
} from "./Pill";

// #1054 USED TO BE PINNED HERE, and #1838 consumed it.
//
// A Pill inside the agent detail page's navy identity band drew a graphite label
// on navy at 1.28:1, so `onDark` overrode the foreground and background as a pair
// (L213). #1838 turned every page header into an ordinary card, which left that
// prop with no call sites anywhere, so the prop is gone and the tests that
// required it are DELETED rather than adjusted: a test whose whole content is a
// behaviour that has been reversed stops being coverage and becomes the guard
// defending the rejected behaviour (L252).
//
// What survives is in `scripts/test-contrast.ts`, which still holds graphite on
// navy as a FORBIDDEN pairing. The navy surfaces that remain (the login brand
// panel, the impersonation banner and its dropped session notice, the time off
// stat grid) render no Pill, so nothing today needs the remedy; the record of
// why it would be needed is what is kept.

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

  // #2082: the cancellation aligns whatever comes FIRST inside the pill, and
  // wherever a mark leads that is the mark. In the roster's Bookable column the
  // header lined up with the dot and the word sat 12px right, while the Role column
  // beside it lined up correctly, which is the drift `alignToColumn` exists to
  // remove.
  it("cancels the mark and the gap too, so the LABEL is what lines up", () => {
    expect(PILL_MARK_TEXT_INSET_PX).toBe(21);
    const { container } = render(
      <Pill variant="status-ok" alignToColumn mark={<span data-mark="" />}>
        Yes
      </Pill>,
    );
    expect(cls(container as unknown as HTMLElement)).toContain(`-ml-[${PILL_MARK_TEXT_INSET_PX}px]`);
    // And not the no-mark cancellation, which would leave the word 12px right.
    expect(cls(container as unknown as HTMLElement)).not.toContain(`-ml-[${PILL_TEXT_INSET_PX}px]`);
  });

  it("gives the mark a box of a size it knows, so that arithmetic is possible at all", () => {
    // The pill cannot measure an arbitrary node, and asking every call site to
    // declare a width is the "every call site has to remember" this component
    // exists to end (L550, L621). 8px box plus the pill's own 4px gap is the 12
    // the sum above adds to the text inset.
    const { container } = render(
      <Pill variant="status-ok" mark={<span data-mark="" />}>
        Yes
      </Pill>,
    );
    const box = container.querySelector("[data-pill-mark]") as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.className).toContain("h-2");
    expect(box.className).toContain("w-2");
    expect(box.className).toContain("shrink-0");
    expect(box.querySelector("[data-mark]")).toBeTruthy();
    expect(cls(container as unknown as HTMLElement)).toContain("gap-1");
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

});

// #2081: the dot and the word in the Bookable pill are not centred on each other.
//
// `items-center` centres each child's BOX. A word's box is its line box, whose
// centre sits below the centre of the letters themselves, because the box
// reserves descender space that "Yes" and "No" never use (L591). Measured in
// Chrome on the pill's own type (PP Mori SemiBold 13px, ascent 10, descent 3,
// cap height 9.1) the word read 1.05px high of the mark, in both states.
//
// The word is the half that moves: putting the mark on the word's centre instead
// would leave the pair riding high in the oval. Moving the label down lands the
// word's optical centre on the pill's centre, which is where the mark already is,
// so both are centred in the oval AND on each other.
describe("optical centring of the label (#2081)", () => {
  it("knows how far the label has to move, and why", () => {
    // Measured, not chosen: offset = (ascent - descent - capHeight) / 2.
    // Re-measure with a canvas TextMetrics read on the rendered pill if the
    // pill's font, weight or size ever changes.
    const ascent = 10;
    const descent = 3;
    const capHeight = 9.1;
    const opticalError = (ascent - descent - capHeight) / 2; // -1.05px, word high
    expect(Math.round(-opticalError)).toBe(PILL_LABEL_OPTICAL_NUDGE_PX);
  });

  it("moves the label, and only the label", () => {
    const { container } = render(
      <Pill variant="status-ok" mark={<span data-testid="mark" className="h-2 w-2" />}>
        Yes
      </Pill>,
    );

    const label = container.querySelector("[data-pill-label]");
    expect(label?.textContent).toBe("Yes");
    expect(label?.className).toContain(`top-[${PILL_LABEL_OPTICAL_NUDGE_PX}px]`);

    // The mark is already on the pill's centre, so it must stay outside the
    // nudge. A pair moved together is the same pair.
    const mark = container.querySelector('[data-testid="mark"]');
    expect(mark).toBeTruthy();
    expect(label?.contains(mark!)).toBe(false);
  });

  it("centres the word in every pill, not only the one with a mark", () => {
    // Otherwise a bookable pill's word would sit a pixel below the role pill
    // beside it in the same row, which is a new misalignment rather than a fix.
    const { container } = render(<Pill variant="outline">Deactivated</Pill>);

    expect(container.querySelector("[data-pill-label]")?.className).toContain(
      `top-[${PILL_LABEL_OPTICAL_NUDGE_PX}px]`,
    );
  });
});

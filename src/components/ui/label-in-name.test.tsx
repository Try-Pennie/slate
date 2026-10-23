// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { labelInNameMismatches } from "@/components/ui/label-in-name.test-support";

// #3917 (L786): the check every label in name test leans on, shown catching the
// defect and passing the fixes, so a component test asserting `[]` is not green
// because the check cannot see anything.

describe("labelInNameMismatches", () => {
  it("flags a name that replaced the visible words", () => {
    const { container } = render(<button aria-label="Account and settings">AD</button>);
    expect(labelInNameMismatches(container)).toEqual([
      `"Account and settings" does not contain the visible words "ad"`,
    ]);
  });

  it("flags visible words left out of the name, even when some are in it", () => {
    const { container } = render(
      <button aria-label="Remove Ada from this pool">
        <span>Ada</span>
        <span>(not on the current roster)</span>
      </button>,
    );
    expect(labelInNameMismatches(container)).toHaveLength(1);
  });

  it("passes a name that keeps the visible words and adds context around them", () => {
    const { container } = render(
      <>
        <button aria-label="Edit 100">Edit</button>
        <button aria-label="AD, account and settings">AD</button>
        <a href="/x" aria-label="Back to time selection">
          {"‹"} Back
        </a>
      </>,
    );
    expect(labelInNameMismatches(container)).toEqual([]);
  });

  it("counts drawn text hidden from screen readers, and not text only screen readers get", () => {
    const flagged = render(
      <button aria-label="Open the menu">
        <span aria-hidden="true">DW</span>
      </button>,
    );
    expect(labelInNameMismatches(flagged.container)).toHaveLength(1);
    const passed = render(
      <button aria-label="Remove Ada">
        Ada<span className="sr-only">, removes her from the pool</span>
      </button>,
    );
    expect(labelInNameMismatches(passed.container)).toEqual([]);
  });

  it("ignores a glyph nobody could say, and a control its content names", () => {
    const { container } = render(
      <>
        <button aria-label="Remove the second window">
          <span aria-hidden="true">{"×"}</span>
        </button>
        <button>Save</button>
      </>,
    );
    expect(labelInNameMismatches(container)).toEqual([]);
  });

  it("reads a name given by aria-labelledby", () => {
    const { container } = render(
      <>
        <span id="who">Account</span>
        <button aria-labelledby="who">AD</button>
      </>,
    );
    expect(labelInNameMismatches(container)).toHaveLength(1);
  });
});

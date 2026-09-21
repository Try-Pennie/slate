// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ClockIcon, GlobeIcon, PhoneOutlineIcon, XIcon } from "@/components/icons";

// #2572: the booker and the manage page each drew their own 15px stroke icons,
// seven copies of one <svg> opener. They live here now, beside the other icons,
// with the same attributes the sites carried: hidden from assistive tech, drawn in
// the current colour, sized by the caller.

const glyphs = {
  ClockIcon,
  GlobeIcon,
  PhoneOutlineIcon,
  XIcon,
} as const;

const drawing = (svg: SVGSVGElement) =>
  [...svg.querySelectorAll("path, circle")].map((el) => el.outerHTML).join("|");

describe("booker line icons", () => {
  for (const [name, Icon] of Object.entries(glyphs)) {
    it(`${name} is decorative and sized by the caller`, () => {
      const { container } = render(<Icon width={15} height={15} />);
      const svg = container.querySelector("svg") as SVGSVGElement;
      expect(svg).not.toBeNull();
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("focusable")).toBe("false");
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("fill")).toBe("none");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("width")).toBe("15");
      expect(svg.getAttribute("height")).toBe("15");
      expect(drawing(svg).length).toBeGreaterThan(0);
    });
  }

  it("draws four different glyphs", () => {
    const drawn = Object.values(glyphs).map((Icon) => {
      const { container } = render(<Icon />);
      return drawing(container.querySelector("svg") as SVGSVGElement);
    });
    expect(new Set(drawn).size).toBe(4);
  });

  it("keeps the strokes the booker drew", () => {
    const clock = render(<ClockIcon />).container.querySelector("path")!;
    expect(clock.getAttribute("d")).toBe("M12 7v5l3 2");
    const globe = render(<GlobeIcon />).container.querySelector("path")!;
    expect(globe.getAttribute("d")).toBe("M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18");
    const x = render(<XIcon />).container.querySelector("path")!;
    expect(x.getAttribute("d")).toBe("M6 6l12 12M18 6L6 18");
    const phone = render(<PhoneOutlineIcon />).container.querySelector("path")!;
    expect(phone.getAttribute("d")).toBe(
      "M5 4h3l2 5-2 1a12 12 0 005 5l1-2 5 2v3a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z",
    );
  });
});

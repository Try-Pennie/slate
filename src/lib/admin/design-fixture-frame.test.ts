import { describe, expect, it } from "vitest";
import { designFixtureFrame } from "./design-fixture-frame";

const frames = {
  "f-on": { theme: "light", extra: 1 },
  "d-on": { theme: "dark", extra: 2 },
  "f-odd": { theme: "sepia", extra: 3 },
};

describe("designFixtureFrame", () => {
  it("returns the frame the fixture names", () => {
    expect(designFixtureFrame(frames, "d-on")).toEqual({ theme: "dark", extra: 2 });
  });

  it("refuses a frame the fixture does not hold, by name", () => {
    expect(() => designFixtureFrame(frames, "f-missing")).toThrow('the fixture names no frame "f-missing"');
  });

  it("refuses an inherited key rather than reading it as a frame", () => {
    expect(() => designFixtureFrame(frames, "toString")).toThrow('the fixture names no frame "toString"');
  });

  it("refuses a theme that is neither light nor dark", () => {
    expect(() => designFixtureFrame(frames, "f-odd")).toThrow('frame "f-odd" has no theme named sepia');
  });
});

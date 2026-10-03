import { describe, it, expect } from "vitest";
import { submittedTimezone } from "./submitted-timezone";

const form = (tz?: string) => {
  const f = new FormData();
  if (tz !== undefined) f.set("timezone", tz);
  return f;
};

describe("submittedTimezone", () => {
  it("is null when the form sent no zone, or only spaces", () => {
    expect(submittedTimezone(form())).toBeNull();
    expect(submittedTimezone(form("   "))).toBeNull();
  });

  it("passes the zone on without surrounding spaces, so it reads as the zone it names", () => {
    expect(submittedTimezone(form(" America/Phoenix "))).toBe("America/Phoenix");
    expect(submittedTimezone(form("America/Phoenix"))).toBe("America/Phoenix");
  });
});

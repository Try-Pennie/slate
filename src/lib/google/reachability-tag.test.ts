// #4206: the placeholder seat check runs the activation gate's calendar probe from the
// monitor lane, and a failed probe's log line must name that caller rather than read as
// an activation attempt. The tag defaults to the activation gate's own.
import { it, expect, vi } from "vitest";

const cal = vi.hoisted(() => ({ listCalendars: vi.fn() }));
vi.mock("@/lib/google/calendar", () => cal);
const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { warn, error: vi.fn(), info: vi.fn() } }));

import { classifyCalendarReachability } from "@/lib/google/reachability";

it("logs a failed probe under the activation gate's tag by default", async () => {
  cal.listCalendars.mockRejectedValue(new Error("network down"));
  expect(await classifyCalendarReachability("a@b.com")).toBe("transient");
  expect(warn).toHaveBeenLastCalledWith("bookable-api", expect.objectContaining({ email: "a@b.com", kind: "transient" }));
});

it("logs a failed probe under the caller's tag when one is given", async () => {
  cal.listCalendars.mockRejectedValue(new Error("network down"));
  expect(await classifyCalendarReachability("m@b.com", "placeholder-seat")).toBe("transient");
  expect(warn).toHaveBeenLastCalledWith("placeholder-seat", expect.objectContaining({ email: "m@b.com", kind: "transient" }));
});

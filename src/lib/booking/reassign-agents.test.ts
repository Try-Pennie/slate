import { describe, it, expect } from "vitest";
import { rankReassignAgents, type ReassignAgent } from "./reassign-agents";

const A: ReassignAgent[] = [
  { id: "1", name: "Zoe Adams", email: "zoe@x.com", bookable: true },
  { id: "2", name: "Lead Lou", email: "lou@x.com", bookable: false },
  { id: "3", name: "Amy Brown", email: "amy@x.com", bookable: true },
  { id: "4", name: null, email: "nameless@x.com", bookable: true },
];

// #546: the reassign agent picker. In-pool (bookable) agents sort to the top; the
// booking's current agent is excluded; the query matches name OR email.
describe("rankReassignAgents", () => {
  it("excludes the booking's current agent", () => {
    const out = rankReassignAgents(A, "", "1");
    expect(out.find((a) => a.id === "1")).toBeUndefined();
  });

  it("sorts in-pool (bookable) agents above out-of-pool ones", () => {
    const out = rankReassignAgents(A, "", null);
    const lastBookable = out.findIndex((a) => !a.bookable);
    // every agent before the first non-bookable is bookable
    expect(out.slice(0, lastBookable).every((a) => a.bookable)).toBe(true);
    expect(out[out.length - 1].bookable).toBe(false); // Lead Lou last
  });

  it("matches the query against name or email, case-insensitively", () => {
    expect(rankReassignAgents(A, "amy", null).map((a) => a.id)).toEqual(["3"]);
    expect(rankReassignAgents(A, "LOU@", null).map((a) => a.id)).toEqual(["2"]);
  });

  it("returns everyone (minus current) when the query is empty", () => {
    expect(rankReassignAgents(A, "  ", "1").length).toBe(3);
  });
});

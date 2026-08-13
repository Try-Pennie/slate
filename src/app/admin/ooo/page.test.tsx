// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Access guard for the OOO queue page (#676): unauthenticated to /login, and a
// below-manager caller gets the deny notice instead of the request queue. Real
// canManageAgents is exercised; only auth and the navigation redirect are mocked.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));

import OooQueuePage from "./page";

const props = { searchParams: Promise.resolve({}) };

beforeEach(() => vi.clearAllMocks());

describe("OooQueuePage guard", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(OooQueuePage(props)).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("shows the deny notice to a below-manager caller", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    render(await OooQueuePage(props));
    expect(screen.getByText(/manager or admin account to review time off/i)).toBeTruthy();
  });
});

// #1477: the failed calendar steps used to live in a title attribute, so the
// page named a problem and offered no way to read it on a phone, to a screen
// reader, or from the keyboard. A static read of the component cannot tell a
// tooltip from text, so this mounts the real thing and asserts on the DOM.
import { FailedSteps } from "./FailedSteps";
import { describeEffects } from "@/lib/ooo/effect-copy";

describe("FailedSteps (#1477)", () => {
  const steps = describeEffects({
    manager_event: "ok",
    agent_event:
      'failed: Error: events.insert failed: 503 {"error":{"errors":[{"reason":"backendError"}],"code":503}}',
    busy_block: "ok (slate fallback)",
  }).failed;

  it("names the failed step, and its reason, as text on the page", () => {
    const { container } = render(<FailedSteps steps={steps} />);

    expect(container.textContent).toMatch(
      /not in place: the event on the agent.s own calendar/i,
    );
    expect(container.textContent).toMatch(/503 backendError/);
  });

  it("puts nothing in a tooltip, which is unreachable without a pointer", () => {
    const { container } = render(<FailedSteps steps={steps} />);

    expect(container.querySelector("[title]")).toBeNull();
  });

  it("says nothing about the steps that are in place", () => {
    const { container } = render(<FailedSteps steps={steps} />);

    expect(container.textContent).not.toMatch(/manager.s OOO calendar entry/i);
  });

  it("renders nothing at all when every step landed", () => {
    const { container } = render(<FailedSteps steps={[]} />);

    expect(container.textContent).toBe("");
  });
});

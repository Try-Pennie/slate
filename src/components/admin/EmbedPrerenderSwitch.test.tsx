// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// #3706: the control behind building Slate's booker as a partner page loads, built like
// the shared confirm line's. Three states kept apart (L530): on, off, and could-not-read,
// which must draw neither answer and offer no press. Each state says what it means for
// the lead, never what the control is (L604). Neither direction is destructive (a page
// that cannot prerender loads the booker on the tap, as it always has), so each is one
// press posting the state it wants, never a toggle.
vi.mock("@/app/admin/actions", () => ({ setEmbedPrerender: vi.fn() }));

import { EmbedPrerenderSwitch } from "./EmbedPrerenderSwitch";

describe("EmbedPrerenderSwitch", () => {
  it("off: says the booker loads on the tap, and offers the way to turn it on", () => {
    const { container } = render(<EmbedPrerenderSwitch on={false} />);
    expect(container.querySelector('[data-state="off"]')).toBeTruthy();
    expect(screen.getByText(/loads when a lead taps/i)).toBeTruthy();
    const press = screen.getByRole("button", { name: /load the booker with the page/i });
    expect(press.getAttribute("type")).toBe("submit");
    expect((container.querySelector('input[name="on"]') as HTMLInputElement).value).toBe("true");
  });

  it("on: says what the lead gets, and offers the way to turn it off", () => {
    const { container } = render(<EmbedPrerenderSwitch on={true} />);
    expect(container.querySelector('[data-state="on"]')).toBeTruthy();
    expect(screen.getByText(/sees times at once/i)).toBeTruthy();
    const press = screen.getByRole("button", { name: /load the booker on the tap/i });
    expect(press.getAttribute("type")).toBe("submit");
    expect((container.querySelector('input[name="on"]') as HTMLInputElement).value).toBe("false");
  });

  it("could not read: says so and what pages do meanwhile, with no press", () => {
    const { container } = render(<EmbedPrerenderSwitch on={null} />);
    expect(container.querySelector('[data-state="unreadable"]')).toBeTruthy();
    expect(screen.getByText(/could not read/i)).toBeTruthy();
    expect(screen.getByText(/when a lead taps/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

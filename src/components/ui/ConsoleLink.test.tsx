// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CONSOLE_COMING_SOON_ID,
  ConsoleComingSoonNote,
  ConsoleLink,
} from "@/components/ui/ConsoleLink";

// A control whose destination is hidden before launch (#2119).
//
// On Team Time Off, an approved request with a coverage sweep carried a
// `View the coverage sweep` button pointing into the console. Every console
// route redirects a manager back to `/admin/ooo`, which is the page they were
// already on, so for everyone below super admin the button did not refuse and
// did not explain: it appeared to do nothing. Pressing it again was the only
// diagnosis available (L109, L148).
//
// The rule this pins is the CLASS, not that one button: a control whose
// destination a viewer cannot reach says so on its face, and the reason is
// reachable by a keyboard and a screen reader rather than living in a title
// attribute nobody can open on a phone (#1477).

describe("ConsoleLink when the console is open to this viewer", () => {
  it("is an ordinary link to the destination", async () => {
    render(<ConsoleLink href="/admin/agents/a1#coverage" consoleHidden={false}>View the coverage sweep</ConsoleLink>);
    const link = screen.getByRole("link", { name: "View the coverage sweep" });
    expect(link.getAttribute("href")).toBe("/admin/agents/a1#coverage");
    expect(link.getAttribute("aria-disabled")).toBeNull();
    expect(document.body.textContent).not.toMatch(/coming soon/i);
  });
});

describe("ConsoleLink when the destination is hidden", () => {
  it("is not a link at all, so nothing navigates", () => {
    render(<ConsoleLink href="/admin/agents/a1#coverage" consoleHidden>View the coverage sweep</ConsoleLink>);
    expect(screen.queryByRole("link")).toBeNull();
    // The address must not survive as an href on some other element either: a
    // dead destination that is still in the markup is one a middle click, a
    // right click or a copy-link still reaches.
    expect(document.querySelector("[href]")).toBeNull();
  });

  it("says Coming soon on its face", () => {
    render(<ConsoleLink href="/admin/agents/a1" consoleHidden>View the coverage sweep</ConsoleLink>);
    // Both halves: what it WOULD do, so the reader knows what is coming, and
    // that it is not open yet.
    expect(screen.getByText(/view the coverage sweep/i)).toBeTruthy();
    expect(screen.getByText(/coming soon/i)).toBeTruthy();
  });

  // The whole point of the issue: a dead control with no reason is worse than a
  // refusal, because pressing it again is the only diagnosis available.
  it("carries a reason a keyboard user can reach", async () => {
    render(
      <>
        <ConsoleLink href="/admin/agents/a1" consoleHidden>View the coverage sweep</ConsoleLink>
        <ConsoleComingSoonNote />
      </>,
    );
    const control = screen.getByRole("button", { name: /view the coverage sweep/i });

    // Focusable, which a `disabled` button is NOT: the reason has to be reachable
    // by somebody driving with a keyboard, and a disabled control is skipped by
    // every tab order.
    await userEvent.tab();
    expect(document.activeElement).toBe(control);

    // Announced as unavailable rather than merely looking it, and the reason is
    // tied to the control rather than sitting loose beside it.
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.getAttribute("aria-describedby")).toBe(CONSOLE_COMING_SOON_ID);
    expect(document.getElementById(CONSOLE_COMING_SOON_ID)?.textContent).toMatch(
      /marked Coming soon opens when agent scheduling goes live/i,
    );
  });

  it("shows the reason on screen, not only to a screen reader", () => {
    render(<ConsoleComingSoonNote />);
    const reason = screen.getByText(/marked Coming soon opens when agent scheduling goes live/i);
    // #1477: detail that lives in a title attribute names a problem and offers no
    // way to read it on a phone, from the keyboard, or to a screen reader.
    expect(reason.className).not.toMatch(/sr-only/);
    expect(document.querySelector("[title]")).toBeNull();
  });

  // #2119, caught by screenshotting at the real count rather than by any
  // assertion. These appear once per approved request with a sweep, so a reason
  // attached to the CONTROL became a wall of the identical sentence down the page
  // (L579). One fact belongs once on the surface (L605).
  it("says the reason once, however many controls are on the page", () => {
    render(
      <>
        <ConsoleLink href="/admin/agents/a1" consoleHidden>First</ConsoleLink>
        <ConsoleLink href="/admin/agents/a2" consoleHidden>Second</ConsoleLink>
        <ConsoleLink href="/admin/agents/a3" consoleHidden>Third</ConsoleLink>
        <ConsoleComingSoonNote />
      </>,
    );
    expect(screen.getAllByRole("button").length).toBe(3);
    expect(screen.getAllByText(/marked Coming soon opens when agent scheduling goes live/i).length).toBe(1);
    // And every one of them still HAS the reason, which is the half that must not
    // be traded away for the tidiness.
    for (const b of screen.getAllByRole("button")) {
      expect(b.getAttribute("aria-describedby")).toBe(CONSOLE_COMING_SOON_ID);
    }
    // Each still says it on its own face, so the state is legible per control.
    // Counted on the CONTROLS, not on the page: the note names the phrase too,
    // and a count over the whole document would pass on two controls and a note.
    for (const b of screen.getAllByRole("button")) {
      expect(b.textContent).toMatch(/coming soon/i);
    }
  });

  it("does nothing when pressed, and never submits a form it sits in", async () => {
    let submitted = false;
    render(
      <form onSubmit={() => { submitted = true; }}>
        <ConsoleLink href="/admin/agents/a1" consoleHidden>View the coverage sweep</ConsoleLink>
      </form>,
    );
    const control = screen.getByRole("button", { name: /view the coverage sweep/i });
    // `type="button"`, or a control that explains why it cannot act would submit
    // the form it happens to be inside.
    expect(control.getAttribute("type")).toBe("button");
    await userEvent.click(control);
    expect(submitted).toBe(false);
  });

  // The note carries the wording, so a call site has no reason prop to forget and
  // no id to invent that points at nothing. A page that renders the control
  // without the note is caught by scripts/test-console-hidden-links.ts, because a
  // rule each call site has to remember is enforced by nothing (L621, L27).
  it("carries its own default wording, so no call site writes the sentence", () => {
    render(<ConsoleComingSoonNote />);
    expect(
      document.getElementById(CONSOLE_COMING_SOON_ID)?.textContent?.trim(),
    ).toBeTruthy();
  });
});

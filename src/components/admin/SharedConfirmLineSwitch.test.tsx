// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// #3325: the control behind the shared confirm line, built like the frame lock's. Three
// states kept apart (L530): on, off, and could-not-read, which must not draw either
// answer. Turning it on changes how every confirm for a time is lined up, so it asks
// first and the question says when it takes hold, quoting the same TTL constant the
// reader uses rather than a vague "in seconds". Turning it off goes back to how confirms
// have always run, so it is one press.
vi.mock("@/app/admin/actions", () => ({ setSharedConfirmLine: vi.fn() }));

import { SharedConfirmLineSwitch } from "./SharedConfirmLineSwitch";
import { SHARED_LINE_SWITCH_TTL_SECONDS } from "@/lib/booking/shared-line-switch-core";

describe("SharedConfirmLineSwitch", () => {
  it("says the line is off, and offers the way to turn it on", () => {
    const { container } = render(<SharedConfirmLineSwitch on={false} />);
    expect(container.querySelector('[data-state="off"]')).toBeTruthy();
    expect(screen.getByText(/each server keeps its own line/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /turn on the shared line/i })).toBeTruthy();
  });

  it("says the line is on, and offers the way to turn it off", () => {
    const { container } = render(<SharedConfirmLineSwitch on={true} />);
    expect(container.querySelector('[data-state="on"]')).toBeTruthy();
    expect(screen.getByText(/one line shared by every server/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /turn off the shared line/i })).toBeTruthy();
  });

  it("asks before turning it on, and the question says when it takes hold, from the TTL constant", async () => {
    render(<SharedConfirmLineSwitch on={false} />);
    const opener = screen.getByRole("button", { name: /turn on the shared line/i });
    // The opener submits nothing: the confirm does.
    expect(opener.getAttribute("type")).not.toBe("submit");
    await userEvent.click(opener);
    const question = screen.getByRole("alert");
    expect(question.textContent).toContain(`${SHARED_LINE_SWITCH_TTL_SECONDS} seconds`);
    expect(question.textContent).not.toMatch(/in seconds/i);
    const confirm = screen.getByRole("button", { name: /turn on the shared line/i });
    expect(confirm.getAttribute("type")).toBe("submit");
  });

  it("posts the state it wants, never a toggle", async () => {
    const { container: off } = render(<SharedConfirmLineSwitch on={false} />);
    expect((off.querySelector('input[name="on"]') as HTMLInputElement).value).toBe("true");
    const { container: on } = render(<SharedConfirmLineSwitch on={true} />);
    expect((on.querySelector('input[name="on"]') as HTMLInputElement).value).toBe("false");
  });

  it("does not put a confirmation in front of turning it off", () => {
    render(<SharedConfirmLineSwitch on={true} />);
    expect(screen.getByRole("button", { name: /turn off the shared line/i }).getAttribute("type")).toBe("submit");
  });

  it("says when it could not read the switch, what servers do meanwhile, and offers neither instruction", () => {
    const { container } = render(<SharedConfirmLineSwitch on={null} />);
    expect(container.querySelector('[data-state="unreadable"]')).toBeTruthy();
    expect(screen.getByText(/could not read/i)).toBeTruthy();
    expect(screen.getByText(/last read/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminError from "./error";
import { BOUNDARY_TITLE } from "@/lib/errors/boundary-copy";

// #1970: there was no boundary in this product at all, so an unhandled error
// showed the framework's own unstyled screen. Dan met it twice while saving an
// agent's hours.
const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { error: logError, warn: vi.fn(), info: vi.fn() } }));

const err = (digest?: string) => Object.assign(new Error("boom"), { digest });

describe("the admin error boundary (#1970)", () => {
  it("says what happened, in Pennie's own words", () => {
    render(<AdminError error={err()} retry={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain(BOUNDARY_TITLE);
  });

  // The button is the whole point of `retry`, and a boundary whose button does
  // nothing is the framework screen with better type.
  it("retries when asked", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(<AdminError error={err()} retry={retry} />);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("offers a way back into the app, so the screen is not a dead end", () => {
    render(<AdminError error={err()} retry={() => {}} />);
    expect(screen.getByRole("link", { name: /admin overview/i })).toHaveProperty(
      "href",
      expect.stringContaining("/admin"),
    );
  });

  // The digest is the only thing tying what a person reads to a line in the
  // Worker's logs, so both halves have to exist: shown, and logged.
  it("shows the reference and logs it", () => {
    render(<AdminError error={err("d1g3st")} retry={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("d1g3st");
    expect(logError).toHaveBeenCalled();
    const fields = logError.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(fields.digest).toBe("d1g3st");
  });

  it("shows no reference at all when there is no digest", () => {
    render(<AdminError error={err()} retry={() => {}} />);
    expect(screen.getByRole("alert").textContent).not.toContain("Reference");
  });

  // It must not claim the save did not happen, because it cannot know that.
  it("does not tell anybody their change was not saved", () => {
    render(<AdminError error={err()} retry={() => {}} />);
    const text = screen.getByRole("alert").textContent!.toLowerCase();
    expect(text).not.toContain("nothing was saved");
    expect(text).not.toContain("were not saved");
    expect(text).toContain("check whether it went through");
  });
});

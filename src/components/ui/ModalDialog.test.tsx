// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { useRef, useState } from "react";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { ModalDialog, MODAL_DIALOG_PANEL_CLASS, MODAL_DIALOG_SCRIM_CLASS } from "./ModalDialog";

// The one modal dialog in Slate (#3081, #4205): UnsavedGuard's native modal, extracted so
// the coordinator page's confirmation and the unsaved edits guard are one component.

afterEach(cleanup);

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} onClick={() => setOpen(true)}>
        Open it
      </button>
      <ModalDialog
        open={open}
        labelledBy="t"
        describedBy="b"
        initialFocusRef={first}
        returnFocusRef={opener}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      >
        <h2 id="t">The question</h2>
        <p id="b">What it means</p>
        <button ref={first}>Go back</button>
      </ModalDialog>
    </>
  );
}

describe("ModalDialog", () => {
  it("draws nothing while closed, so it takes no place in the page", () => {
    render(<Harness />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("opens as a labelled alert dialog, wearing the scrim and the panel, with focus on the safe choice", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open it"));
    const d = screen.getByRole("alertdialog");
    expect(d.tagName).toBe("DIALOG");
    expect(d.hasAttribute("open")).toBe(true);
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.getAttribute("aria-labelledby")).toBe("t");
    expect(d.getAttribute("aria-describedby")).toBe("b");
    expect(d.className).toBe(MODAL_DIALOG_SCRIM_CLASS);
    expect((d.firstElementChild as HTMLElement).className).toBe(MODAL_DIALOG_PANEL_CLASS);
    expect(document.activeElement).toBe(screen.getByText("Go back"));
  });

  it("closes on Escape and on the platform's cancel, and puts focus back where it came from", () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      render(<Harness onClose={onClose} />);
      fireEvent.click(screen.getByText("Open it"));
      const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      act(() => {
        screen.getByRole("alertdialog").dispatchEvent(esc);
      });
      expect(esc.defaultPrevented).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      act(() => {
        vi.runAllTimers();
      });
      expect(document.activeElement).toBe(screen.getByText("Open it"));

      fireEvent.click(screen.getByText("Open it"));
      const cancel = new Event("cancel", { cancelable: true });
      act(() => {
        screen.getByRole("alertdialog").dispatchEvent(cancel);
      });
      expect(cancel.defaultPrevented).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves closing to the caller, so one that refuses (a booking being placed) stays open", () => {
    function Stubborn() {
      return (
        <ModalDialog open labelledBy="t" onClose={() => {}}>
          <h2 id="t">Placing</h2>
        </ModalDialog>
      );
    }
    render(<Stubborn />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});

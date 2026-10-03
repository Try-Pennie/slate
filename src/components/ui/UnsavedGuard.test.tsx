// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnsavedGuard } from "./UnsavedGuard";

// #1966: Dan changed his working hours, refreshed, and lost them with nothing
// warning him. He asked for it swept across every form somebody can type into.
//
// The assertions are written both ways round throughout: a guard that ALWAYS
// fires passes any test that only checks it appears, and it is also the guard
// people learn to click through, at which point it protects nothing (L36, L159).

// The guard navigates with `window.location.assign` rather than the app router,
// so nothing about next/navigation needs mocking here, and no OTHER test of a
// form that mounts it does either. That is the point of the choice.
const push = vi.hoisted(() => vi.fn());

// jsdom has HTMLDialogElement but implements neither showModal nor close, so
// both are stood in for here, doing the one thing the component can observe:
// the `open` attribute.
const showModal = vi.fn(function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
});
HTMLDialogElement.prototype.showModal = showModal;
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
  this.removeAttribute("open");
};

/** A page with a guarded form and a sidebar link out of it. */
function Page({ initial = "08:00" }: { initial?: string } = {}) {
  return (
    <div>
      <a href="/admin/buckets">Buckets</a>
      <a href="/admin/hours#today">Today</a>
      <a href="https://example.invalid/out">Somewhere else</a>
      <form action={() => {}}>
        <UnsavedGuard what="changes to these hours" formName="f" />
        <label htmlFor="start">Monday start</label>
        <input id="start" name="start" defaultValue={initial} />
        <a href="/admin/inside-the-form">A link inside the form</a>
        <button type="submit">Save</button>
      </form>
    </div>
  );
}

/**
 * A CONTROLLED form, which is what the real hours forms are.
 *
 * This exists because the uncontrolled `Page` above cannot test the snapshot
 * reset at all: React clears an uncontrolled field after a form action, so the
 * form reads as unedited again whether the guard resets its snapshot or not, and
 * a test written on it passed with the reset deleted (L1). Here the typed value
 * survives the submit, so being quiet afterwards can only be the reset.
 */
function ControlledPage() {
  const [value, setValue] = useState("08:00");
  return (
    <div>
      <a href="/admin/buckets">Buckets</a>
      <form action={() => {}}>
        <UnsavedGuard what="changes to these hours" formName="f" />
        <label htmlFor="c-start">Monday start</label>
        <input id="c-start" name="start" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit">Save</button>
      </form>
    </div>
  );
}

const dialog = () => screen.queryByRole("alertdialog");

describe("UnsavedGuard (#1966)", () => {
  beforeEach(() => {
    push.mockClear();
    showModal.mockClear();
    // jsdom refuses a real navigation, so the one call is captured instead.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign: push, href: "http://localhost/admin/hours" },
    });
  });

  it("says nothing when nothing has been edited", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    expect(dialog()).toBeNull();
  });

  // THE HALF THAT WOULD OTHERWISE SHIP UNTESTED. `beforeunload` never sees a
  // click on a link inside the app, which in an admin console is the commonest
  // way to lose work.
  it("stops an in app navigation once something is edited, and names what", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByLabelText("Monday start"), "9");
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("changes to these hours");
    // Stopped, not merely warned about.
    expect(push).not.toHaveBeenCalled();
  });

  it("stays put when Stay is chosen, and keeps the edits", async () => {
    const user = userEvent.setup();
    render(<Page />);
    const field = screen.getByLabelText("Monday start");
    await user.type(field, "9");
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    await user.click(screen.getByRole("button", { name: "Stay on this page" }));
    expect(dialog()).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect((field as HTMLInputElement).value).toBe("08:009");
  });

  it("goes where it was asked to when leaving is chosen", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByLabelText("Monday start"), "9");
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    await user.click(screen.getByRole("button", { name: "Leave, and keep it for later" }));
    expect(push).toHaveBeenCalledWith("/admin/buckets");
  });

  // Focus lands on staying, never on the button that throws the work away.
  it("puts focus on the safe choice", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByLabelText("Monday start"), "9");
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stay on this page" }));
  });

  it("closes on Escape without navigating", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByLabelText("Monday start"), "9");
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    await user.keyboard("{Escape}");
    expect(dialog()).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  // Editing and then putting the value BACK is not unsaved work. This is what
  // comparing against the saved values buys over a flag set by each handler: a
  // flag would still read as dirty here.
  it("says nothing again once the value is typed back to what was saved", async () => {
    const user = userEvent.setup();
    render(<Page />);
    const field = screen.getByLabelText("Monday start");
    await user.clear(field);
    await user.type(field, "09:00");
    await user.clear(field);
    await user.type(field, "08:00");
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    expect(dialog()).toBeNull();
  });

  // Driven on the CONTROLLED form, where the typed value survives the submit, so
  // this can only pass because the guard re-snapshotted. On the uncontrolled
  // form React clears the field itself and the assertion holds either way.
  it("says nothing after the form has been submitted", async () => {
    const user = userEvent.setup();
    render(<ControlledPage />);
    const field = screen.getByLabelText("Monday start");
    await user.type(field, "9");
    expect((field as HTMLInputElement).value).toBe("08:009");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // The value is still there, so the form is not quiet by having been emptied.
    expect((field as HTMLInputElement).value).toBe("08:009");
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    expect(dialog()).toBeNull();
  });

  it("warns again about an edit made AFTER a save", async () => {
    const user = userEvent.setup();
    render(<ControlledPage />);
    const field = screen.getByLabelText("Monday start");
    await user.type(field, "9");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(field, "5");
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    expect(dialog()).not.toBeNull();
  });

  // A link INSIDE the guarded form is part of the form, not a way out of it.
  it("leaves a link inside the form alone", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByLabelText("Monday start"), "9");
    await user.click(screen.getByRole("link", { name: "A link inside the form" }));
    expect(dialog()).toBeNull();
  });

  // An external destination leaves through the browser's own guard, which this
  // cannot intercept and must not pretend to.
  it("leaves an external link to the browser", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByLabelText("Monday start"), "9");
    await user.click(screen.getByRole("link", { name: "Somewhere else" }));
    expect(dialog()).toBeNull();
  });

  // #3081: a div with aria-modal="true" PROMISED a modal and delivered none of
  // it: Tab walked out into the page behind, the page stayed clickable, and
  // closing it dropped focus on the body. A native dialog opened with
  // showModal() is what makes the rest of the page inert and keeps focus inside,
  // and jsdom implements neither, so what is asserted is that the platform
  // modal is what gets asked for.
  describe("as a modal (#3081)", () => {
    it("opens as a native dialog through showModal, so the page behind is inert", async () => {
      const user = userEvent.setup();
      render(<Page />);
      await user.type(screen.getByLabelText("Monday start"), "9");
      await user.click(screen.getByRole("link", { name: "Buckets" }));
      expect(dialog()!.tagName).toBe("DIALOG");
      expect(showModal).toHaveBeenCalledTimes(1);
    });

    it("puts focus back on the link it stopped, after Stay", async () => {
      const user = userEvent.setup();
      render(<Page />);
      await user.type(screen.getByLabelText("Monday start"), "9");
      const link = screen.getByRole("link", { name: "Buckets" });
      await user.click(link);
      expect(document.activeElement).not.toBe(link);
      await user.click(screen.getByRole("button", { name: "Stay on this page" }));
      expect(document.activeElement).toBe(link);
    });

    it("puts focus back on the link it stopped, after Escape", async () => {
      const user = userEvent.setup();
      render(<Page />);
      await user.type(screen.getByLabelText("Monday start"), "9");
      const link = screen.getByRole("link", { name: "Buckets" });
      await user.click(link);
      await user.keyboard("{Escape}");
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(link);
    });

    // The platform's own Escape route (and a phone's back gesture) arrives as a
    // `cancel` event rather than a keydown, and must stay just the same.
    it("treats the dialog's own cancel as Stay", async () => {
      const user = userEvent.setup();
      render(<Page />);
      await user.type(screen.getByLabelText("Monday start"), "9");
      await user.click(screen.getByRole("link", { name: "Buckets" }));
      const cancel = new Event("cancel", { cancelable: true });
      act(() => {
        dialog()!.dispatchEvent(cancel);
      });
      expect(dialog()).toBeNull();
      expect(push).not.toHaveBeenCalled();
    });
  });

  // A click the person has told the browser to handle differently keeps this
  // page, and its edits, so there is nothing to warn about.
  it("leaves a command click alone", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByLabelText("Monday start"), "9");
    await user.keyboard("{Meta>}");
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    await user.keyboard("{/Meta}");
    expect(dialog()).toBeNull();
  });

  describe("the browser half", () => {
    it("asks the browser to confirm a refresh once something is edited", async () => {
      const user = userEvent.setup();
      render(<Page />);
      await user.type(screen.getByLabelText("Monday start"), "9");
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
    });

    it("does not ask when nothing has been edited", () => {
      render(<Page />);
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    });
  });
});

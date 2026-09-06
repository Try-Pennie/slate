// @vitest-environment jsdom
import { Component, useState, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The predicate is the one thing that decides whether a failure is swallowed or
// sent on, so it is the seam. The REAL one is pinned separately against the
// installed Next by scripts/test-stale-action.ts, because a double agrees with
// our assumption about the interface by construction (L52) and that assumption
// is the part at risk on a version bump.
const stale = vi.hoisted(() => ({ is: vi.fn((_e: unknown) => false) }));
vi.mock("@/lib/stale-action", async () => {
  const real = await vi.importActual<typeof import("@/lib/stale-action")>("@/lib/stale-action");
  return { ...real, isStaleActionError: (e: unknown) => stale.is(e) };
});

import { SaveForm } from "./SaveForm";
import { TimeField } from "./TimeField";
import { SelectField } from "./SelectField";
import { restoreKey } from "@/lib/form-restore";

beforeEach(() => {
  vi.clearAllMocks();
  stale.is.mockReturnValue(false);
  window.sessionStorage.clear();
});

/**
 * Stands in for the app's real error boundary.
 *
 * A failure the wrapper passes through has to land SOMEWHERE, and letting it
 * escape the test leaves an unhandled rejection that fails the run while every
 * assertion passes: the suite reported 2936 passed and one error, which is the
 * shape of a green run that is not green (L184). Catching it here also makes the
 * assertion stronger than "no alert appeared": it names the error that arrived.
 */
class CatchHere extends Component<{ children: ReactNode; onError: (e: unknown) => void }> {
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  state = { dead: false };
  static getDerivedStateFromError() {
    return { dead: true };
  }
  render() {
    return this.state.dead ? <p>the boundary caught it</p> : this.props.children;
  }
}

describe("SaveForm survives a deploy landing under the page (#1994)", () => {
  it("says what happened, instead of letting the save reach the error boundary", async () => {
    const user = userEvent.setup();
    stale.is.mockReturnValue(true);
    const action = vi.fn(async () => {
      throw new Error("Failed to find Server Action");
    });
    render(
      <SaveForm action={action} name="hours">
        <input name="start_1" defaultValue="08:00" aria-label="start" />
        <button type="submit">Save</button>
      </SaveForm>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    const said = screen.getByRole("alert").textContent ?? "";
    // The three facts, and the first is the one that matters: the person needs
    // to know their week is not half written.
    expect(said).toMatch(/nothing was saved/i);
    expect(said).toMatch(/reload/i);
    expect(said).toMatch(/kept/i);
  });

  it("keeps what was typed, so the reload it asks for costs nothing", async () => {
    const user = userEvent.setup();
    stale.is.mockReturnValue(true);
    const action = vi.fn(async () => {
      throw new Error("Failed to find Server Action");
    });
    render(
      <SaveForm action={action} name="hours">
        <input name="start_1" defaultValue="08:00" aria-label="start" />
        <button type="submit">Save</button>
      </SaveForm>,
    );
    const box = screen.getByLabelText("start") as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "09:30");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Stashed under this page and this form, so another page cannot pick it up.
    const raw = window.sessionStorage.getItem(restoreKey(window.location.pathname, "hours"));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).start_1).toEqual(["09:30"]);
  });

  // EVERY OTHER FAILURE STILL GOES WHERE IT WENT, and this is the assertion that
  // stops the wrapper becoming a blanket catch. A genuine refusal turned into
  // "reload and try again" is advice that can never work (L111), and a redirect
  // travels as a thrown error too, so swallowing everything would break every
  // save that succeeds.
  it("passes a genuine refusal straight through", async () => {
    const user = userEvent.setup();
    stale.is.mockReturnValue(false);
    const refusal = new Error("Tuesday's windows overlap each other");
    const action = vi.fn(async () => {
      throw refusal;
    });
    const caught: unknown[] = [];
    render(
      <CatchHere onError={(e) => caught.push(e)}>
        <SaveForm action={action} name="hours">
          <button type="submit">Save</button>
        </SaveForm>
      </CatchHere>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    // It reached the boundary, which is exactly where a refusal the wrapper does
    // not understand belongs. Asserting only that no notice appeared would pass
    // over a wrapper that swallowed it into nothing at all.
    expect(caught).toContain(refusal);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("says nothing at all when the save works", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => {});
    render(
      <SaveForm action={action} name="hours">
        <button type="submit">Save</button>
      </SaveForm>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(action).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });
});

// #1998: the menu forms, where a notice cannot go and would say nothing useful.
describe("SaveForm reloads instead, where that is the whole recovery (#1998)", () => {
  it("reloads rather than drawing an alert inside a menu", async () => {
    const user = userEvent.setup();
    stale.is.mockReturnValue(true);
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload, pathname: "/admin" },
    });
    const action = vi.fn(async () => {
      throw new Error("Failed to find Server Action");
    });
    render(
      <SaveForm action={action} name="sign-out" onStale="reload">
        <button type="submit">Sign out</button>
      </SaveForm>,
    );
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(reload).toHaveBeenCalledTimes(1);
    // No alert, because there is nowhere in a menu to put one and nothing it
    // would say that the reload does not say better.
    expect(screen.queryByRole("alert")).toBeNull();
    // And nothing stashed: there was nothing typed to keep.
    expect(window.sessionStorage.length).toBe(0);
  });

  // THE LOOP GUARD. A reload makes the page current, so a second stale save in
  // the same load can only mean a deploy landed in those few seconds. Reloading
  // again would be a loop, so the error is let through instead: the quiet fix
  // was tried, it did not help, and hiding that is worse than showing it.
  it("does not reload twice for the same page load", async () => {
    const user = userEvent.setup();
    stale.is.mockReturnValue(true);
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload, pathname: "/admin" },
    });
    const failure = new Error("Failed to find Server Action");
    const action = vi.fn(async () => {
      throw failure;
    });
    const caught: unknown[] = [];
    render(
      <CatchHere onError={(e) => caught.push(e)}>
        <SaveForm action={action} name="sign-out" onStale="reload">
          <button type="submit">Sign out</button>
        </SaveForm>
      </CatchHere>,
    );
    const press = () => user.click(screen.getByRole("button", { name: "Sign out" }));
    await press();
    await press();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(caught).toContain(failure);
  });

  it("still draws the notice on a form that has something to say", async () => {
    const user = userEvent.setup();
    stale.is.mockReturnValue(true);
    const action = vi.fn(async () => {
      throw new Error("Failed to find Server Action");
    });
    render(
      <SaveForm action={action} name="hours">
        <input name="start_1" defaultValue="08:00" aria-label="start" />
        <button type="submit">Save</button>
      </SaveForm>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toMatch(/nothing was saved/i);
  });
});

describe("SaveForm puts back what was typed (#1994)", () => {
  it("restores a plain field and says it did", () => {
    window.sessionStorage.setItem(
      restoreKey(window.location.pathname, "hours"),
      JSON.stringify({ note: ["half written"] }),
    );
    render(
      <SaveForm action={vi.fn()} name="hours">
        <input name="note" defaultValue="" aria-label="note" />
      </SaveForm>,
    );
    expect((screen.getByLabelText("note") as HTMLInputElement).value).toBe("half written");
    expect(screen.getByRole("status").textContent).toMatch(/put back/i);
  });

  // THE ONE THAT MATTERS, and the reason the restore reaches the FIELD rather
  // than the DOM. `TimeField` holds the typed text in React state and renders a
  // hidden input from it, so a value written onto that hidden input from outside
  // is overwritten by the next render and the form submits the stored value
  // instead. It has to be the field's initial state.
  it("restores a typed time, whose value lives in React state", () => {
    window.sessionStorage.setItem(
      restoreKey(window.location.pathname, "hours"),
      JSON.stringify({ start_1: ["09:30"] }),
    );
    const { container } = render(
      <SaveForm action={vi.fn()} name="hours">
        <TimeField name="start_1" ariaLabel="Monday start time" defaultValue="08:00" />
      </SaveForm>,
    );
    // What the person sees, and what the form would post.
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("9:30am");
    const hidden = container.querySelector('input[name="start_1"]') as HTMLInputElement;
    expect(hidden.value).toBe("09:30");
  });

  // #2008: the SAME mechanism on a second control, so the pattern is shown to be
  // the pattern rather than one component's trick. The timezone picker renders
  // its hidden input from state exactly as the time field does, so the blanket
  // restore could never have reached it either.
  it("restores a picker whose value also lives in React state", () => {
    window.sessionStorage.setItem(
      restoreKey(window.location.pathname, "hours"),
      JSON.stringify({ timezone: ["America/Denver"] }),
    );
    const { container } = render(
      <SaveForm action={vi.fn()} name="hours">
        <SelectField
          name="timezone"
          ariaLabel="Your timezone"
          defaultValue="America/New_York"
          options={[
            { value: "America/New_York", label: "Eastern" },
            { value: "America/Denver", label: "Mountain" },
          ]}
        />
      </SaveForm>,
    );
    const hidden = container.querySelector('input[name="timezone"]') as HTMLInputElement;
    expect(hidden.value).toBe("America/Denver");
    expect(screen.getByRole("combobox").textContent).toMatch(/Mountain/);
  });

  // AND THE NEGATIVE, which is what makes the two above mean anything: a field
  // holding its own state that does NOT opt in is shown not to restore. Without
  // it, a guard demanding the opt in would be enforcing a rule nobody had
  // measured the effect of.
  it("does not restore a stateful field that never opted in", () => {
    window.sessionStorage.setItem(
      restoreKey(window.location.pathname, "hours"),
      JSON.stringify({ own: ["restored"] }),
    );
    function NotOptedIn() {
      const [value] = useState("stored");
      return <input type="hidden" name="own" value={value} readOnly />;
    }
    const { container } = render(
      <SaveForm action={vi.fn()} name="hours">
        <NotOptedIn />
      </SaveForm>,
    );
    const hidden = container.querySelector('input[name="own"]') as HTMLInputElement;
    expect(hidden.value).toBe("stored");
  });

  it("falls back to the stored value when nothing was stashed for that field", () => {
    render(
      <SaveForm action={vi.fn()} name="hours">
        <TimeField name="start_1" ariaLabel="Monday start time" defaultValue="08:00" />
      </SaveForm>,
    );
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("8:00am");
    expect(screen.queryByRole("status")).toBeNull();
  });

  // Cleared once the values are back, or a later reload silently re-applies
  // values the person has since changed.
  it("clears the stash once it has been used", async () => {
    window.sessionStorage.setItem(
      restoreKey(window.location.pathname, "hours"),
      JSON.stringify({ note: ["x"] }),
    );
    render(
      <SaveForm action={vi.fn()} name="hours">
        <input name="note" defaultValue="" aria-label="note" />
      </SaveForm>,
    );
    expect(
      window.sessionStorage.getItem(restoreKey(window.location.pathname, "hours")),
    ).toBeNull();
  });
});

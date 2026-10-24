// @vitest-environment jsdom
import { Component, useState, type ReactNode } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { SaveForm, holdsAView } from "./SaveForm";
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
      <SaveForm unsaved="changes" action={action} name="hours">
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
      <SaveForm unsaved="changes" action={action} name="hours">
        <input name="start_1" defaultValue="08:00" aria-label="start" />
        <button type="submit">Save</button>
      </SaveForm>,
    );
    const box = screen.getByLabelText("start") as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "09:30");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Stashed under this page and this form, so another page cannot pick it up.
    // The stash is an envelope since #2077, so the page can say WHY a draft came
    // back and can refuse one too old to mean anything.
    const raw = window.sessionStorage.getItem(restoreKey(window.location.pathname, "hours"));
    expect(raw).toBeTruthy();
    const envelope = JSON.parse(raw!);
    expect(envelope.form.start_1).toEqual(["09:30"]);
    expect(envelope.why).toBe("stale-save");
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
        <SaveForm unsaved="changes" action={action} name="hours">
          <button type="submit">Save</button>
        </SaveForm>
      </CatchHere>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    // It reached the boundary, which is exactly where a refusal the wrapper does
    // not understand belongs. Asserting only that no notice appeared would pass
    // over a wrapper that swallowed it into nothing at all. Waited for, not read
    // straight after the click: React delivers the action's error to the boundary
    // a few ticks later, and on a loaded runner the read came first (main at
    // 732b445, attempt 2, 2026-10-24: `expected [] to include Error`).
    await waitFor(() => expect(caught).toContain(refusal));
    expect(window.sessionStorage.length).toBe(0);
  });

  it("says nothing at all when the save works", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => {});
    render(
      <SaveForm unsaved="changes" action={action} name="hours">
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
      <SaveForm unsaved="changes" action={action} name="sign-out" onStale="reload">
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
        <SaveForm unsaved="changes" action={action} name="sign-out" onStale="reload">
          <button type="submit">Sign out</button>
        </SaveForm>
      </CatchHere>,
    );
    const press = () => user.click(screen.getByRole("button", { name: "Sign out" }));
    await press();
    await press();

    // Waited for, like the refusal above: the boundary hears of the second
    // press's error a few ticks after the click returns.
    await waitFor(() => expect(caught).toContain(failure));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still draws the notice on a form that has something to say", async () => {
    const user = userEvent.setup();
    stale.is.mockReturnValue(true);
    const action = vi.fn(async () => {
      throw new Error("Failed to find Server Action");
    });
    render(
      <SaveForm unsaved="changes" action={action} name="hours">
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
      <SaveForm unsaved="changes" action={vi.fn()} name="hours">
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
      <SaveForm unsaved="changes" action={vi.fn()} name="hours">
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
      <SaveForm unsaved="changes" action={vi.fn()} name="hours">
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
      <SaveForm unsaved="changes" action={vi.fn()} name="hours">
        <NotOptedIn />
      </SaveForm>,
    );
    const hidden = container.querySelector('input[name="own"]') as HTMLInputElement;
    expect(hidden.value).toBe("stored");
  });

  it("falls back to the stored value when nothing was stashed for that field", () => {
    render(
      <SaveForm unsaved="changes" action={vi.fn()} name="hours">
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
      <SaveForm unsaved="changes" action={vi.fn()} name="hours">
        <input name="note" defaultValue="" aria-label="note" />
      </SaveForm>,
    );
    expect(
      window.sessionStorage.getItem(restoreKey(window.location.pathname, "hours")),
    ).toBeNull();
  });
});

// #2076: the guard is SaveForm's, not each caller's. Dan lost fourteen alert
// floors he had typed by clicking a link, on one of the eleven call sites that had
// never opted in.
// #2075: the restored draft notice on a form with nothing to type.
// #2077: leaving with unsaved edits KEEPS them. A warning is still one click away
// from losing the work, and Dan's framing was stronger than a warning: "I should
// never be able to lose something I typed by going to another page."
describe("leaving a dirty form keeps the draft (#2077)", () => {
  // The guard really navigates on the way out, and jsdom answers a real
  // `location.assign` with an unhandled TypeError: the suite still passes and the
  // run still exits non-zero, which is a red that says nothing about the code.
  let assign: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  });
  afterEach(() => assign.mockRestore());

  const leaveVia = async (href: string) => {
    const away = document.createElement("a");
    away.setAttribute("href", href);
    document.body.appendChild(away);
    away.click();
    await screen.findByRole("alertdialog");
  };

  it("stashes what was typed, and says so when the page is opened again", async () => {
    render(
      <SaveForm action={async () => {}} name="alerts" unsaved="changes to these alert settings">
        <input name="floor" defaultValue="20" aria-label="floor" />
        <button type="submit">Save</button>
      </SaveForm>,
    );
    fireEvent.change(screen.getByLabelText("floor"), { target: { value: "35" } });
    await leaveVia("/admin/buckets");
    fireEvent.click(screen.getByRole("button", { name: /keep it for later/i }));

    const raw = window.sessionStorage.getItem(restoreKey(window.location.pathname, "alerts"));
    expect(raw).toBeTruthy();
    const envelope = JSON.parse(raw!);
    expect(envelope.form.floor).toEqual(["35"]);
    // The reason travels with it, because the sentence on the way back differs.
    expect(envelope.why).toBe("navigation");

    cleanup();
    render(
      <SaveForm action={async () => {}} name="alerts" unsaved="changes to these alert settings">
        <input name="floor" defaultValue="20" aria-label="floor" />
        <button type="submit">Save</button>
      </SaveForm>,
    );
    expect((screen.getByLabelText("floor") as HTMLInputElement).value).toBe("35");
    expect(document.body.textContent).toMatch(/when you left this page/i);
    // And NOT the other sentence: a save that died under a deploy is something
    // that happened TO them, and one message answering for both reads as a fault
    // report about an action they took on purpose (L11).
    expect(document.body.textContent).not.toMatch(/before the last reload/i);
  });

  it("keeps them on the page when the browser will not keep the draft", async () => {
    // The dialog has just promised to keep it, so a storage that refuses must not
    // let them leave on a promise nothing kept (L12).
    const setItem = vi.spyOn(window.sessionStorage.__proto__, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      render(
        <SaveForm action={async () => {}} name="alerts" unsaved="changes to these alert settings">
          <input name="floor" defaultValue="20" aria-label="floor" />
          <button type="submit">Save</button>
        </SaveForm>,
      );
      fireEvent.change(screen.getByLabelText("floor"), { target: { value: "35" } });
      await leaveVia("/admin/buckets");
      fireEvent.click(screen.getByRole("button", { name: /keep it for later/i }));

      expect(assign).not.toHaveBeenCalled();
      expect(screen.getByRole("alertdialog").textContent).toMatch(/would not let us keep/i);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("SaveForm only announces a restore that restored something (#2075)", () => {
  const NOTICE = /put back/i;

  it("says nothing over a form of one button", () => {
    // The agents header is a one line row, heading left and Sync right. A
    // paragraph inside the action slot pushed the button off the line beside the
    // heading every time it fired, and it was telling the reader about a state
    // that cannot exist for a form with no fields (L604).
    window.sessionStorage.setItem(
      restoreKey(window.location.pathname, "salesforce-sync"),
      JSON.stringify({}),
    );
    render(
      <SaveForm action={async () => {}} name="salesforce-sync" unsaved="nothing typed here">
        <button type="submit">Sync from Salesforce</button>
      </SaveForm>,
    );
    expect(document.body.textContent).not.toMatch(NOTICE);
  });

  it("says nothing when every restored value is empty", () => {
    // A cleared field and an untouched one are the same thing to somebody reading
    // "what you had typed has been put back".
    window.sessionStorage.setItem(
      restoreKey(window.location.pathname, "blank"),
      JSON.stringify({ note: [""], other: ["  "] }),
    );
    render(
      <SaveForm action={async () => {}} name="blank" unsaved="changes">
        <input name="note" defaultValue="" />
        <button type="submit">Save</button>
      </SaveForm>,
    );
    expect(document.body.textContent).not.toMatch(NOTICE);
  });

  it("still says it when something really was typed", () => {
    // THE CONTROL. Without it, a version that never rendered the notice at all
    // would satisfy both cases above while losing the whole point of the restore
    // (L1).
    window.sessionStorage.setItem(
      restoreKey(window.location.pathname, "typed"),
      JSON.stringify({ note: ["a week of hours"] }),
    );
    render(
      <SaveForm action={async () => {}} name="typed" unsaved="changes">
        <input name="note" defaultValue="" />
        <button type="submit">Save</button>
      </SaveForm>,
    );
    expect(document.body.textContent).toMatch(NOTICE);
  });
});

describe("every SaveForm guards unsaved work by default (#2076)", () => {
  it("warns before an in app navigation once something has been typed", async () => {
    render(
      <SaveForm action={async () => {}} name="f" unsaved="changes to these alert settings">
        <input name="floor" defaultValue="20" />
        <button type="submit">Save</button>
      </SaveForm>,
    );
    // A link OUTSIDE the form, which is what a sidebar is.
    const away = document.createElement("a");
    away.setAttribute("href", "/admin/buckets");
    document.body.appendChild(away);

    fireEvent.change(screen.getByDisplayValue("20"), { target: { value: "35" } });
    away.click();

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(document.body.textContent).toContain("changes to these alert settings");
  });

  it("says nothing when a form holds only a button, with no exception written for it", () => {
    // Dirtiness is MEASURED, not declared, so a form that cannot be dirty is
    // silent on its own: no list of button-only forms has to be maintained.
    render(
      <SaveForm action={async () => {}} name="f" unsaved="nothing typed here">
        <input type="hidden" name="id" value="u1" />
        <button type="submit">Sync</button>
      </SaveForm>,
    );
    const away = document.createElement("a");
    away.setAttribute("href", "/admin/buckets");
    document.body.appendChild(away);
    away.click();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("says nothing when a re-render changes a value nobody touched", () => {
    // THE CASE THAT MADE THIS THE DEFAULT DANGEROUS. A toggle carries the OPPOSITE
    // of the current state in a hidden field, so every save flips it. Against a
    // snapshot alone that form reads as permanently edited and warns on the next
    // link click about work nobody did.
    function Toggle() {
      const [bookable, setBookable] = useState(true);
      return (
        <>
          <SaveForm action={async () => {}} name="f" unsaved="this bookable change">
            <input type="hidden" name="bookable" value={String(!bookable)} />
            <button type="submit">Save</button>
          </SaveForm>
          {/* OUTSIDE the form, which is the real shape: another form's action on
              the same page revalidates and this one re-renders. */}
          <button type="button" onClick={() => setBookable((b) => !b)}>
            Something else saved
          </button>
          <a href="/admin/buckets">Buckets</a>
        </>
      );
    }
    render(<Toggle />);
    // The re-render, driven from outside the form the way a revalidate is.
    fireEvent.click(screen.getByText("Something else saved"));
    fireEvent.click(screen.getByText("Buckets"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("mounts no guard at all on a form that holds a view", () => {
    render(
      <SaveForm action={async () => {}} name="f" unsaved={holdsAView("a filter row holds a view, not work")}>
        <input name="q" defaultValue="" />
        <button type="submit">Search</button>
      </SaveForm>,
    );
    const away = document.createElement("a");
    away.setAttribute("href", "/admin/buckets");
    document.body.appendChild(away);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "dana" } });
    away.click();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("SaveForm never lets the browser restore an unsaved edit (#2718)", () => {
  // A browser putting back the controls somebody changed (a reload in Safari and
  // Firefox, back and forward everywhere) draws them over the `defaultChecked`
  // the page took from the stored value, so an alarm nobody saved reads as
  // armed on the very refresh done to check it (L732).
  it("turns form state restoration off on the form it renders", () => {
    const { container } = render(
      <SaveForm unsaved="changes to these alert settings" action={async () => {}} name="alerts">
        <input type="checkbox" name="armed" defaultChecked={false} aria-label="armed" />
      </SaveForm>,
    );
    expect(container.querySelector("form")?.getAttribute("autocomplete")).toBe("off");
  });

  it("keeps it off whatever a call site spreads onto the form", () => {
    // The props type refuses `autoComplete`; this is the runtime half, for a
    // spread that got past the type (a cast, a props object built loosely).
    const loose = { autoComplete: "on" } as unknown as Record<string, never>;
    const { container } = render(
      <SaveForm unsaved="changes" action={async () => {}} name="loose" {...loose}>
        <input name="x" defaultValue="1" aria-label="x" />
      </SaveForm>,
    );
    expect(container.querySelector("form")?.getAttribute("autocomplete")).toBe("off");
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SaveForm } from "@/components/ui/SaveForm";
import { restoreKey } from "@/lib/form-restore";
import type { SlackChannelListing, SlackChannelOption } from "@/lib/notify/slack-channel-input";
import { SlackChannelField } from "./SlackChannelField";

// #2438: the Slack channel field on /admin/alerts.
//
// It was a text box with a native `<datalist>`, which failed twice. Chrome drew
// its own black popup that no Slate style can reach (L607), and picking
// `#statuspage` put `C08A3BYMB29` in the box, because a datalist option's VALUE is
// what the browser writes and the name lived only in its label. This field shows
// the name, submits the id through a hidden input, and still takes a pasted id
// for a private channel the list cannot see.

const statuspage: SlackChannelOption = { id: "C08A3BYMB29", name: "statuspage", isMember: true };
const systems: SlackChannelOption = { id: "C09F4L6PLQP", name: "dan-systems-test", isMember: true };
const random: SlackChannelOption = { id: "C024BE91L", name: "random", isMember: false };

/** About 150 channels: the scale the list is built for, so ordering and scrolling show (L606). */
const many: SlackChannelOption[] = [
  statuspage,
  systems,
  ...Array.from({ length: 147 }, (_, i) => ({
    id: `C0${String(i).padStart(9, "0")}`,
    name: `channel-${String(i).padStart(3, "0")}`,
    isMember: i % 3 === 0,
  })),
  random,
];
const readable: SlackChannelListing = { readable: true, channels: many, complete: true };

const box = () => screen.getByRole("combobox", { name: "Handoff channel" }) as HTMLInputElement;
const submitted = () =>
  (document.querySelector('input[type="hidden"][name="handoff_channel"]') as HTMLInputElement).value;

/** Render the field under a visible label, the way the page does, inside a form. */
function renderField(
  props: {
    defaultValue?: string;
    listing?: Promise<SlackChannelListing>;
    names?: Promise<Record<string, string>>;
  } = {},
  onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault()),
) {
  const listing = props.listing ?? Promise.resolve(readable);
  const names = props.names ?? Promise.resolve({});
  const utils = render(
    <form onSubmit={onSubmit}>
      <label htmlFor="handoff_channel">Handoff channel</label>
      <SlackChannelField
        id="handoff_channel"
        name="handoff_channel"
        defaultValue={props.defaultValue ?? ""}
        listing={listing}
        names={names}
        placeholder="pick the channel sales reads"
      />
      <button type="submit">Save</button>
    </form>,
  );
  return { ...utils, onSubmit, listing };
}

/** Let the listing promise settle and React apply it. */
async function settleListing() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("SlackChannelField (#2438)", () => {
  it("renders no datalist: the list is Slate's own", async () => {
    const { container } = renderField();
    await settleListing();
    expect(container.querySelector("datalist")).toBeNull();
    expect(box().getAttribute("list")).toBeNull();
  });

  it("shows a stored id by name once the list arrives, and submits the id", async () => {
    renderField({ defaultValue: "C08A3BYMB29" });
    // Before the list is read the id is all there is, and it is never guessed at.
    expect(box().value).toBe("C08A3BYMB29");
    await settleListing();
    expect(box().value).toBe("#statuspage");
    expect(submitted()).toBe("C08A3BYMB29");
  });

  it("shows a stored id the list does not hold as the bare id", async () => {
    renderField({ defaultValue: "G01PRIVATE9" });
    await settleListing();
    expect(box().value).toBe("G01PRIVATE9");
    expect(submitted()).toBe("G01PRIVATE9");
  });

  // THE REAL STORED VALUE on 2026-10-22: Info and Handoff hold C09F4L6PLQP, the
  // PRIVATE #dan-systems-test, which the list never holds. Its name comes from
  // Slack's own answer about that id, which the page already asked for.
  it("shows a stored private channel by the name Slack gave, and still submits the id", async () => {
    const publicOnly: SlackChannelListing = {
      readable: true,
      complete: true,
      channels: [statuspage, random],
    };
    renderField({
      defaultValue: "C09F4L6PLQP",
      listing: Promise.resolve(publicOnly),
      names: Promise.resolve({ C09F4L6PLQP: "dan-systems-test" }),
    });
    await settleListing();
    expect(box().value).toBe("#dan-systems-test");
    expect(submitted()).toBe("C09F4L6PLQP");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the stored id bare while nothing has named it", async () => {
    renderField({
      defaultValue: "C09F4L6PLQP",
      listing: Promise.resolve({ readable: true, complete: true, channels: [statuspage] }),
      names: new Promise<Record<string, string>>(() => {}),
    });
    await settleListing();
    expect(box().value).toBe("C09F4L6PLQP");
  });

  it("offers every channel by name, marking the ones Slate is not in", async () => {
    const user = userEvent.setup();
    renderField();
    await settleListing();
    await user.click(box());
    const list = screen.getByRole("listbox");
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(150);
    expect(options[0].textContent).toBe("#statuspage");
    // The mark is words, not a colour, and it belongs to the option's name.
    const rnd = within(list).getByRole("option", { name: /#random/ });
    expect(rnd.textContent).toMatch(/Slate is not in it/);
  });

  // THE BUG DAN REPORTED: picking a channel used to put its id in the box.
  it("picking a channel shows its NAME in the box and submits its id", async () => {
    const user = userEvent.setup();
    renderField();
    await settleListing();
    await user.click(box());
    await user.type(box(), "sta");
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["#statuspage"]);
    await user.click(within(list).getByRole("option", { name: "#statuspage" }));
    expect(box().value).toBe("#statuspage");
    expect(box().value).not.toMatch(/C08A3BYMB29/);
    expect(submitted()).toBe("C08A3BYMB29");
  });

  it("walks the list from the keyboard, and Enter picks without submitting the form", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderField();
    await settleListing();
    await user.click(box());
    await user.type(box(), "dan");
    await user.keyboard("{ArrowDown}");
    const active = box().getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)?.textContent).toBe("#dan-systems-test");
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box().value).toBe("#dan-systems-test");
    expect(submitted()).toBe("C09F4L6PLQP");
    expect(box().getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes the list and puts back what was there", async () => {
    const user = userEvent.setup();
    renderField({ defaultValue: "C08A3BYMB29" });
    await settleListing();
    await user.click(box());
    await user.clear(box());
    await user.type(box(), "rand");
    await user.keyboard("{Escape}");
    expect(box().value).toBe("#statuspage");
    expect(submitted()).toBe("C08A3BYMB29");
  });

  it("takes a typed name without a pick, shows it as a name and submits its id", async () => {
    const user = userEvent.setup();
    renderField();
    await settleListing();
    await user.click(box());
    await user.type(box(), "Dan-Systems-Test");
    // Even before leaving the field, what the form would post is the id.
    expect(submitted()).toBe("C09F4L6PLQP");
    await user.tab();
    expect(box().value).toBe("#dan-systems-test");
    expect(submitted()).toBe("C09F4L6PLQP");
  });

  // THE REASON IT IS TYPEABLE: a private channel is never in the list.
  it("keeps a pasted id the list cannot see, with no complaint", async () => {
    const user = userEvent.setup();
    renderField();
    await settleListing();
    await user.click(box());
    await user.paste("G01PRIVATE9");
    await user.tab();
    expect(box().value).toBe("G01PRIVATE9");
    expect(submitted()).toBe("G01PRIVATE9");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(box().getAttribute("aria-invalid")).toBeNull();
  });

  it("shows a pasted id of a listed channel by its name", async () => {
    const user = userEvent.setup();
    renderField();
    await settleListing();
    await user.click(box());
    await user.paste("C08A3BYMB29");
    await user.tab();
    expect(box().value).toBe("#statuspage");
    expect(submitted()).toBe("C08A3BYMB29");
  });

  // FAILURE PATH: a name matching nothing. Refused at the field with the same
  // sentence the save would give, and it blocks the save the way a required field
  // does, rather than colouring red and letting the save fail a page load later.
  it("refuses a name that matches nothing, says why, and blocks the save", async () => {
    const user = userEvent.setup();
    const { container } = renderField();
    await settleListing();
    await user.click(box());
    await user.type(box(), "stauspage");
    await user.tab();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Slate cannot find a public channel called #stauspage/);
    expect(alert.textContent).toMatch(/bottom of the About tab/);
    expect(box().getAttribute("aria-invalid")).toBe("true");
    expect(box().getAttribute("aria-describedby")).toBe(alert.id);
    expect((container.querySelector("form") as HTMLFormElement).checkValidity()).toBe(false);
  });

  it("lifts the refusal once the name is corrected", async () => {
    const user = userEvent.setup();
    const { container } = renderField();
    await settleListing();
    await user.click(box());
    await user.type(box(), "stauspage");
    await user.tab();
    await user.click(box());
    await user.clear(box());
    await user.type(box(), "statuspage");
    await user.tab();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((container.querySelector("form") as HTMLFormElement).checkValidity()).toBe(true);
    expect(submitted()).toBe("C08A3BYMB29");
  });

  // BLANK IS A REAL CHOICE: it means use the default above.
  it("can be cleared, which submits blank and complains about nothing", async () => {
    const user = userEvent.setup();
    const { container } = renderField({ defaultValue: "C08A3BYMB29" });
    await settleListing();
    await user.click(box());
    await user.clear(box());
    await user.tab();
    expect(box().value).toBe("");
    expect(submitted()).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((container.querySelector("form") as HTMLFormElement).checkValidity()).toBe(true);
  });

  // FAILURE PATH: the list could not be read. The field still works for an id,
  // says so in the list, and a typed name is told the real cause.
  it("says when Slack's channel list could not be read, and still takes an id", async () => {
    const user = userEvent.setup();
    const { container } = renderField({
      listing: Promise.resolve({ readable: false, why: "missing_scope" }),
    });
    await settleListing();
    await user.click(box());
    expect(screen.getByRole("listbox").textContent).toMatch(/could not read Slack's channel list/);
    await user.paste("C08A3BYMB29");
    await user.tab();
    expect(submitted()).toBe("C08A3BYMB29");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(box());
    await user.clear(box());
    await user.type(box(), "statuspage");
    await user.tab();
    expect(screen.getByRole("alert").textContent).toMatch(/cannot look up #statuspage by name/);
    // Not blocked here: the save reads the list again and decides.
    expect((container.querySelector("form") as HTMLFormElement).checkValidity()).toBe(true);
  });

  it("says it is reading the list while the list is on its way", async () => {
    const user = userEvent.setup();
    renderField({ listing: new Promise<SlackChannelListing>(() => {}) });
    await user.click(box());
    expect(screen.getByRole("listbox").textContent).toMatch(/Reading Slack's channels/);
  });

  it("says when a typed query matches no channel, and that an id can be pasted", async () => {
    const user = userEvent.setup();
    renderField();
    await settleListing();
    await user.click(box());
    await user.type(box(), "zzzz");
    const list = screen.getByRole("listbox");
    expect(within(list).queryAllByRole("option")).toHaveLength(0);
    expect(list.textContent).toMatch(/No channel matches/);
    expect(list.textContent).toMatch(/paste its ID/);
  });

  it("says when the picked channel does not have Slate in it", async () => {
    const user = userEvent.setup();
    renderField();
    await settleListing();
    await user.click(box());
    await user.type(box(), "random");
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: /#random/ }));
    expect(screen.getByText(/Invite the Slate app to #random before saving/)).toBeTruthy();
  });

  // #1994: a save killed by a deploy puts back what was typed, through the field's
  // own state, because a value written onto its hidden input would be overwritten.
  it("restores the value a stale save stashed", async () => {
    window.sessionStorage.setItem(
      restoreKey(window.location.pathname, "alerts"),
      JSON.stringify({ handoff_channel: ["C09F4L6PLQP"] }),
    );
    render(
      <SaveForm unsaved="changes" action={vi.fn()} name="alerts">
        <SlackChannelField
          id="handoff_channel"
          name="handoff_channel"
          defaultValue="C08A3BYMB29"
          listing={Promise.resolve(readable)}
          ariaLabel="Handoff channel"
        />
      </SaveForm>,
    );
    await settleListing();
    expect(submitted()).toBe("C09F4L6PLQP");
    expect(box().value).toBe("#dan-systems-test");
  });
});

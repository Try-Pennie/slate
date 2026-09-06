// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

// #1896: the table that replaced sixty stacked editors.
//
// The reading of a pool is pinned offline in `scripts/test-bucket-table.ts`.
// What is pinned HERE is the thing no pure test can see: that only ONE editor is
// ever in the DOM. That is not a nicety. `BucketForm` carries two pickers and a
// roster sized fallback control, and rendering sixty of them is exactly the cost
// #1760 and #1784 were spent removing (9,450 inputs, then 8,755 options). A table
// that rendered all sixty and hid them with CSS would look identical on screen
// and put every one of those nodes back.
import { BucketTable } from "./BucketTable";
import { bucketRow, type BucketRow } from "@/lib/admin/bucket-table";
import type { Bucket } from "@/lib/db/types";

const bucket = (code: string, over: Partial<Bucket> = {}): Bucket => ({
  id: `id-${code}`,
  org_id: "o1",
  code,
  name: `Pool ${code}`,
  event_type_id: "e1",
  assignment: "round_robin",
  criteria: {},
  routing_form_id: null,
  fallback_user_id: null,
  is_test: false,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

const CODES = ["100", "101", "120", "432"];
const rows: BucketRow[] = CODES.map((c) =>
  bucketRow(bucket(c), c === "120" ? 0 : 5, 0),
);
// A stand in for the server rendered editor, carrying a marker input so the test
// can count what actually reached the DOM.
const forms = Object.fromEntries(
  CODES.map((c) => [`id-${c}`, <input key={c} data-testid={`editor-${c}`} defaultValue={c} />]),
);
const newForm = <input data-testid="new-editor" />;

const draw = () => render(<BucketTable rows={rows} forms={forms} newForm={newForm} />);

describe("BucketTable", () => {
  it("draws a row per pool and no editor at all", () => {
    const { container } = draw();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(container.querySelectorAll("[data-testid^='editor-']")).toHaveLength(0);
    // The create form is not sitting open either: a pool is made rarely and
    // edited often, so making one is something you ask for.
    expect(screen.queryByTestId("new-editor")).toBeNull();
  });

  // THE MEASUREMENT THAT MATTERS. Only the open editor is in the DOM.
  it("puts exactly one editor in the DOM, and only when asked", () => {
    const { container } = draw();
    fireEvent.click(screen.getByRole("button", { name: /Edit 101/ }));
    expect(screen.getByTestId("editor-101")).toBeTruthy();
    expect(container.querySelectorAll("[data-testid^='editor-']")).toHaveLength(1);
  });

  // ONE AT A TIME. Two open editors on a page whose fields share names is a
  // person about to save the wrong pool.
  it("closes the open editor when another is opened", () => {
    const { container } = draw();
    fireEvent.click(screen.getByRole("button", { name: /Edit 101/ }));
    fireEvent.click(screen.getByRole("button", { name: /Edit 432/ }));
    expect(screen.queryByTestId("editor-101")).toBeNull();
    expect(screen.getByTestId("editor-432")).toBeTruthy();
    expect(container.querySelectorAll("[data-testid^='editor-']")).toHaveLength(1);
  });

  it("closes an editor when its own control is pressed again", () => {
    draw();
    fireEvent.click(screen.getByRole("button", { name: /Edit 100/ }));
    fireEvent.click(screen.getByRole("button", { name: /Close 100/ }));
    expect(screen.queryByTestId("editor-100")).toBeNull();
  });

  it("closes the open editor when the create form is opened", () => {
    draw();
    fireEvent.click(screen.getByRole("button", { name: /Edit 100/ }));
    fireEvent.click(screen.getByRole("button", { name: "New bucket" }));
    expect(screen.queryByTestId("editor-100")).toBeNull();
    expect(screen.getByTestId("new-editor")).toBeTruthy();
  });

  it("says which row is expanded, for a screen reader", () => {
    draw();
    const control = screen.getByRole("button", { name: /Edit 100/ });
    expect(control.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(control);
    expect(screen.getByRole("button", { name: /Close 100/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("filters as you type, and clearing brings every pool back", () => {
    const { container } = draw();
    fireEvent.change(screen.getByLabelText("Find a pool"), { target: { value: "432" } });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Find a pool"), { target: { value: "" } });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
  });

  // A FILTER THAT HIDES EVERYTHING is a different fact from having no pools, and
  // it must say how many there really are (L10).
  it("explains an empty result rather than drawing an empty table", () => {
    draw();
    fireEvent.change(screen.getByLabelText("Find a pool"), { target: { value: "zzzz" } });
    expect(screen.getByText(/No pool matches that text\. 4 pools in all\./)).toBeTruthy();
  });

  it("narrows to the pools that can take no booking", () => {
    const { container } = draw();
    fireEvent.click(screen.getByLabelText(/Only the 1 that can take no booking/));
    const shown = container.querySelectorAll("tbody tr");
    expect(shown).toHaveLength(1);
    expect(within(shown[0] as HTMLElement).getByText("120")).toBeTruthy();
  });

  // A CONTROL THAT CAN ONLY EVER EMPTY THE TABLE has no use, and reads as though
  // the page is hiding something.
  it("does not offer the narrowing when nothing is short of agents", () => {
    const healthy = CODES.map((c) => bucketRow(bucket(c), 5, 0));
    render(<BucketTable rows={healthy} forms={forms} newForm={newForm} />);
    expect(screen.queryByLabelText(/can take no booking/)).toBeNull();
  });

  // The Members column is drawn only when somebody has named a person by hand:
  // on production every one of the sixty pools routes by attribute, and a column
  // reading 0 sixty times down pushes the ones that vary further right.
  it("hides the members column when no pool has a hand picked member", () => {
    draw();
    expect(screen.queryByRole("columnheader", { name: "Members" })).toBeNull();
  });

  it("shows the members column as soon as one pool has one", () => {
    const withMembers = CODES.map((c) => bucketRow(bucket(c), 5, c === "100" ? 2 : 0));
    render(<BucketTable rows={withMembers} forms={forms} newForm={newForm} />);
    expect(screen.getByRole("columnheader", { name: "Members" })).toBeTruthy();
  });
});

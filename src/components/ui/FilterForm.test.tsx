// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { FilterForm } from "@/components/ui/FilterForm";
import { AutoSubmitSelect } from "@/components/ui/AutoSubmitSelect";

// #951: changing a roster filter must NOT hard-reload the page. FilterForm
// intercepts the (native GET) submit and does a scroll-preserving client
// transition instead, keeping the filter state in the URL.
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

describe("FilterForm (#951)", () => {
  beforeEach(() => replace.mockClear());

  it("navigates client-side on submit instead of reloading, preserving scroll", () => {
    const { container } = render(
      <FilterForm action="/admin">
        <input name="q" defaultValue="ada" />
        <input name="role" defaultValue="manager" />
        <button type="submit">Search</button>
      </FilterForm>,
    );
    const form = container.querySelector("form")!;
    // A native submit would reload the document; assert it's prevented and
    // routed client-side instead.
    const evt = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/admin?q=ada&role=manager", {
      scroll: false,
    });
  });

  it("omits empty filter fields from the query string", () => {
    const { container } = render(
      <FilterForm action="/admin">
        <input name="q" defaultValue="" />
        <input name="role" defaultValue="agent" />
        <input name="team" defaultValue="  " />
      </FilterForm>,
    );
    fireEvent.submit(container.querySelector("form")!);
    expect(replace).toHaveBeenCalledWith("/admin?role=agent", { scroll: false });
  });

  it("navigates to the bare action when no filters are set", () => {
    const { container } = render(
      <FilterForm action="/admin">
        <input name="q" defaultValue="" />
      </FilterForm>,
    );
    fireEvent.submit(container.querySelector("form")!);
    expect(replace).toHaveBeenCalledWith("/admin", { scroll: false });
  });

  it("routes when an AutoSubmitSelect inside it changes (auto-submit path)", () => {
    const { container } = render(
      <FilterForm action="/admin">
        <AutoSubmitSelect name="bookable" defaultValue="" ariaLabel="Filter by bookable">
          <option value="">Any status</option>
          <option value="yes">Bookable</option>
        </AutoSubmitSelect>
      </FilterForm>,
    );
    const select = container.querySelector("select")!;
    fireEvent.change(select, { target: { value: "yes" } });
    expect(replace).toHaveBeenCalledWith("/admin?bookable=yes", { scroll: false });
  });

  it("degrades gracefully: still a GET form pointed at the action", () => {
    const { container } = render(
      <FilterForm action="/admin">
        <input name="q" defaultValue="" />
      </FilterForm>,
    );
    const form = container.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/admin");
  });
});

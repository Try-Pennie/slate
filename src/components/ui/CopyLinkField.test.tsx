// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyLinkField, COPY_LINK_COPY } from "@/components/ui/CopyLinkField";

// #2073: the agent's own booking link, shown with a copy control. The press must
// say what it did, and a copy the browser refused must say so rather than look
// like it worked (L608).

const URL_VALUE = "https://slate.test/book/advisor/abc";

afterEach(() => vi.restoreAllMocks());

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("CopyLinkField", () => {
  it("shows the link in a labelled read only field", () => {
    render(<CopyLinkField label="Your booking link" url={URL_VALUE} />);
    const field = screen.getByLabelText("Your booking link") as HTMLInputElement;
    expect(field.value).toBe(URL_VALUE);
    expect(field.readOnly).toBe(true);
  });

  it("copies the link and says it did", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    render(<CopyLinkField label="Your booking link" url={URL_VALUE} />);
    await userEvent.click(screen.getByRole("button", { name: COPY_LINK_COPY.copy }));
    expect(writeText).toHaveBeenCalledWith(URL_VALUE);
    expect((await screen.findByRole("status")).textContent).toBe(COPY_LINK_COPY.copied);
  });

  it("says so when the browser refuses the copy, and selects the link to copy by hand", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    render(<CopyLinkField label="Your booking link" url={URL_VALUE} />);
    await userEvent.click(screen.getByRole("button", { name: COPY_LINK_COPY.copy }));
    expect((await screen.findByRole("status")).textContent).toBe(COPY_LINK_COPY.failed);
    const field = screen.getByLabelText("Your booking link") as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(URL_VALUE.length);
  });
});

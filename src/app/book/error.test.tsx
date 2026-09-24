// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BookError from "./error";
import { BOUNDARY_TITLE } from "@/lib/errors/boundary-copy";
import { EMBED_MESSAGE, LINK_FAILED } from "@/lib/embed/lifecycle-events";

// #2658: the booker's own error boundary. A crash inside the embedded booker used
// to fall through to the root backstop, which replaces the whole document and
// says nothing to the host page, so the host's funnel saw a lead who viewed the
// booker and vanished. This boundary announces the crash as `linkFailed` to the
// parent origin, and only there.
const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { error: logError, warn: vi.fn(), info: vi.fn() } }));

const search = vi.hoisted(() => ({ current: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.current),
  usePathname: () => "/book",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const reportBoundaryCatch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/errors/report-boundary", () => ({ reportBoundaryCatch }));

const err = (digest?: string) => Object.assign(new Error("boom"), { digest });

beforeEach(() => {
  vi.clearAllMocks();
  search.current = "";
});
afterEach(() => vi.restoreAllMocks());

describe("the booker error boundary (#2658)", () => {
  it("says what happened, in Pennie's own words, with no way into the admin", () => {
    render(<BookError error={err()} retry={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain(BOUNDARY_TITLE);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("retries when asked", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(<BookError error={err()} retry={retry} />);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("logs and reports the catch, so a deploy that breaks the booker for everybody is seen", () => {
    render(<BookError error={err("d1g3st")} retry={() => {}} />);
    expect(logError).toHaveBeenCalled();
    expect(reportBoundaryCatch).toHaveBeenCalledWith(
      expect.objectContaining({ page: "/book", digest: "d1g3st" }),
    );
  });

  it("announces the crash to the host page as linkFailed, to the declared parent origin only", () => {
    search.current = "embed=1&parentOrigin=https%3A%2F%2Fhost.test&xbc=411";
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(<BookError error={err()} retry={() => {}} />);
    const posted = postSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === EMBED_MESSAGE.linkFailed,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]![0]).toEqual({ type: EMBED_MESSAGE.linkFailed, data: LINK_FAILED.bookerCrashed });
    expect(posted[0]![1]).toBe("https://host.test");
    expect(postSpy.mock.calls.some((c) => (c[1] as unknown) === "*")).toBe(false);
  });

  it("announces nothing outside an embed", () => {
    search.current = "xbc=411";
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(<BookError error={err()} retry={() => {}} />);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("announces nothing when the parent origin is unknown, rather than broadcasting", () => {
    // embed=1 with no parentOrigin, and jsdom's referrer is empty: no origin to target.
    search.current = "embed=1";
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(<BookError error={err()} retry={() => {}} />);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("carries no stack and no raw error text in what it announces", () => {
    search.current = "embed=1&parentOrigin=https%3A%2F%2Fhost.test";
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(<BookError error={Object.assign(new Error("dana@example.com typed this"), {})} retry={() => {}} />);
    const text = JSON.stringify(postSpy.mock.calls[0]?.[0] ?? {});
    expect(text).not.toContain("dana@example.com");
    expect(text).not.toContain("at ");
  });
});

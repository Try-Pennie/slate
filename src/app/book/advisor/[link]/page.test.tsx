// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// #2073: the page an agent's own booking link opens. It draws the ordinary
// booker for that one agent, or ONE unavailable panel for every way the link can
// book nobody, and it never falls back to a pool.

const store = vi.hoisted(() => ({ resolveAgentLink: vi.fn(), agentLinkPoolCode: vi.fn() }));
vi.mock("@/lib/agent-link/store", () => store);
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/Booker", () => ({ default: () => null }));
vi.mock("@/components/StandaloneBookerShell", () => ({
  default: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("@/components/ClientErrorBeacon", () => ({ ClientErrorBeacon: () => null }));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 14) }));
vi.mock("@/lib/booking/reason-options", () => ({
  loadReasonOptions: vi.fn(async () => ({ reschedule: { active: [] }, cancel: { active: [] } })),
}));
const service = vi.hoisted(() => ({
  landingAttendee: vi.fn(async (_identity: unknown, link: unknown) => link),
}));
vi.mock("@/lib/booking/service", () => service);

import AgentLinkPage, { metadata } from "./page";
import Booker from "@/components/Booker";
import { AgentLinkUnavailable } from "@/components/AgentLinkUnavailable";
import { log } from "@/lib/log";

const TOKEN = "ab".repeat(32);

function findByType(node: unknown, type: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } & Record<string, unknown> };
  if (el.type === type) return el.props ?? {};
  return findByType(el.props?.children, type);
}

function render(sp: Record<string, string> = {}, link = TOKEN) {
  return AgentLinkPage({ params: Promise.resolve({ link }), searchParams: Promise.resolve(sp) });
}

const bookable = {
  ok: true,
  agent: { id: "u1", name: "Jane Doe", email: "jane@x.com", bookable: true, deactivated_at: null },
  bucketCode: "411",
  bucket: { code: "411", is_test: false },
};

beforeEach(() => vi.clearAllMocks());

describe("/book/advisor/[link] (#2073, #3026)", () => {
  it("draws the booker for the named agent, naming the link and never the bucket", async () => {
    store.resolveAgentLink.mockResolvedValue(bookable);
    const tree = await render({ name: "Dana", email: "dana@example.com" });
    const booker = findByType(tree, Booker);
    expect(booker).not.toBeNull();
    expect(booker!.agentLink).toBe(TOKEN);
    expect(booker!.bucketCode).toBe("");
    expect(booker!.isTest).toBe(false);
    expect(booker!.landingCall).toBeNull();
    expect(findByType(tree, AgentLinkUnavailable)).toBeNull();
  });

  it("books through a readable name exactly as through an old token (#3026)", async () => {
    store.resolveAgentLink.mockResolvedValue(bookable);
    const booker = findByType(await render({}, "rdaboub"), Booker);
    expect(store.resolveAgentLink).toHaveBeenCalledWith("rdaboub");
    expect(booker!.agentLink).toBe("rdaboub");
    expect(booker!.bucketCode).toBe("");
  });

  it("draws the same panel for a refused name, and never logs the name (#3026)", async () => {
    store.resolveAgentLink.mockResolvedValue({ ok: false, why: "unknown" });
    store.agentLinkPoolCode.mockResolvedValue(null);
    const tree = await render({}, "rdaboub");
    expect(findByType(tree, Booker)).toBeNull();
    expect(findByType(tree, AgentLinkUnavailable)!.href).toBe("/book");
    const logged = JSON.stringify((log.info as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).toContain("unknown");
    expect(logged).not.toContain("rdaboub");
  });

  it("records the page as an advisor's direct link unless the link names its own source", async () => {
    store.resolveAgentLink.mockResolvedValue(bookable);
    expect((findByType(await render(), Booker)!.prefill as Record<string, string>).source).toBe("agent-direct");
    expect((findByType(await render({ source: "offerhub" }), Booker)!.prefill as Record<string, string>).source).toBe("offerhub");
  });

  it("carries a test agent's link in test mode", async () => {
    store.resolveAgentLink.mockResolvedValue({ ...bookable, bucket: { code: "SMOKE", is_test: true }, bucketCode: "SMOKE" });
    const booker = findByType(await render(), Booker);
    expect(booker!.isTest).toBe(true);
  });

  it("draws the same panel for every way the link books nobody, and no booker", async () => {
    for (const why of ["unknown", "departed", "not_bookable", "no_bucket"]) {
      store.resolveAgentLink.mockResolvedValue({ ok: false, why });
      store.agentLinkPoolCode.mockResolvedValue(null);
      const tree = await render();
      expect(findByType(tree, Booker)).toBeNull();
      const panel = findByType(tree, AgentLinkUnavailable);
      expect(panel).not.toBeNull();
      // Only the way on, never the cause: nothing else about the link reaches
      // the page (#2831). Every refusal carries it, so its presence says nothing.
      expect(Object.keys(panel!).filter((k) => k !== "children")).toEqual(["href"]);
      expect(panel!.href).toBe("/book");
    }
    // The cause goes to the log, and never the token.
    const logged = JSON.stringify((log.info as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).toContain("departed");
    expect(logged).not.toContain(TOKEN);
  });

  it("offers a known advisor's own pool, asked with the refusal's cause and the token (#2831)", async () => {
    store.resolveAgentLink.mockResolvedValue({ ok: false, why: "departed" });
    store.agentLinkPoolCode.mockResolvedValue("411");
    const tree = await render({ name: "Dana", email: "dana@example.com", embed: "1", theme: "dark" });
    expect(store.agentLinkPoolCode).toHaveBeenCalledWith(TOKEN, "departed");
    const href = findByType(tree, AgentLinkUnavailable)!.href as string;
    const url = new URL(href, "https://slate.example");
    expect(url.pathname).toBe("/book");
    expect(url.searchParams.get("xbc")).toBe("411");
    // The lead's details and the embed settings travel with them.
    expect(url.searchParams.get("name")).toBe("Dana");
    expect(url.searchParams.get("email")).toBe("dana@example.com");
    expect(url.searchParams.get("embed")).toBe("1");
    expect(url.searchParams.get("theme")).toBe("dark");
    // The token never leaves the advisor link's own address.
    expect(href).not.toContain(TOKEN);
  });

  it("lets an unreadable pool reach the error boundary rather than guess at the catch all", async () => {
    store.resolveAgentLink.mockResolvedValue({ ok: false, why: "not_bookable" });
    store.agentLinkPoolCode.mockRejectedValue(new Error("buckets down"));
    await expect(render()).rejects.toThrow("buckets down");
  });

  it("lets an unreadable link reach the error boundary rather than claim the advisor is unavailable", async () => {
    store.resolveAgentLink.mockRejectedValue(new Error("db down"));
    await expect(render()).rejects.toThrow("db down");
  });

  it("keeps the link out of search engines and out of the Referer it sends", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("same-origin");
  });
});

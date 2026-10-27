import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ host: "localhost:3000" as string | null }));
vi.mock("next/headers", () => ({ headers: async () => new Map([["host", hdrs.host]]) }));

import { readDesignFixture } from "./design-fixture-read";

afterEach(() => {
  delete process.env.SLATE_DESIGN_FIXTURES;
  hdrs.host = "localhost:3000";
});

describe("readDesignFixture", () => {
  it("reads the committed fixture for a frame, under the flag, on this machine", async () => {
    process.env.SLATE_DESIGN_FIXTURES = "1";
    const fixture = await readDesignFixture<{ about: string }>("on", "coordinator-admin");
    expect(fixture?.about).toMatch(/^The Coordinator booking admin page design/);
  });

  it("is null when no frame was asked for", async () => {
    process.env.SLATE_DESIGN_FIXTURES = "1";
    expect(await readDesignFixture(undefined, "coordinator-admin")).toBeNull();
  });

  it("is null without the flag", async () => {
    expect(await readDesignFixture("on", "coordinator-admin")).toBeNull();
  });

  it("is null for a request to any other host, flag or not", async () => {
    process.env.SLATE_DESIGN_FIXTURES = "1";
    hdrs.host = "slate.trypennie.com";
    expect(await readDesignFixture("on", "coordinator-admin")).toBeNull();
    hdrs.host = null;
    expect(await readDesignFixture("on", "coordinator-admin")).toBeNull();
  });

  it("throws, rather than drawing an empty frame, when the fixture is missing", async () => {
    process.env.SLATE_DESIGN_FIXTURES = "1";
    await expect(readDesignFixture("on", "no-such-fixture")).rejects.toThrow();
  });
});
